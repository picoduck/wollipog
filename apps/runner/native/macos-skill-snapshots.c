/* Fixed native macOS skill filesystem helper. `list` and `read` are read-only snapshot operations.
 * `adopt`, `inspect`, and `restore` implement the recoverable adoption transaction with the same
 * descriptor-anchored, no-follow, exclusive-publication rules as the Linux runner module. */
#define _DARWIN_C_SOURCE
#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_RAW_ENTRIES 4096
#define MAX_ENTRIES 256
#define MAX_FILES 64
#define MAX_FILE_BYTES (512 * 1024)
#define MAX_TOTAL_BYTES (2 * 1024 * 1024)
#define MAX_DEPTH 16
#define MAX_OUTPUT_BYTES (3 * 1024 * 1024)

struct bytes {
  unsigned char *data;
  size_t length;
  size_t capacity;
};

struct name_entry {
  char *name;
  unsigned char kind;
};

struct snapshot_state {
  struct bytes output;
  uint32_t files;
  uint32_t entries;
  size_t total_bytes;
};

static void fail(void) {
  fputs("macOS skill snapshot helper failed\n", stderr);
  exit(1);
}

static void append(struct bytes *buffer, const void *data, size_t length) {
  if (length > MAX_OUTPUT_BYTES || buffer->length > MAX_OUTPUT_BYTES - length) fail();
  size_t needed = buffer->length + length;
  if (needed > buffer->capacity) {
    size_t next = buffer->capacity ? buffer->capacity : 4096;
    while (next < needed) next *= 2;
    if (next > MAX_OUTPUT_BYTES) next = MAX_OUTPUT_BYTES;
    unsigned char *grown = realloc(buffer->data, next);
    if (!grown) fail();
    buffer->data = grown;
    buffer->capacity = next;
  }
  memcpy(buffer->data + buffer->length, data, length);
  buffer->length += length;
}

static void append_u8(struct bytes *buffer, unsigned char value) {
  append(buffer, &value, 1);
}

static void append_u32(struct bytes *buffer, uint32_t value) {
  unsigned char encoded[4] = {
    (unsigned char)(value & 0xff),
    (unsigned char)((value >> 8) & 0xff),
    (unsigned char)((value >> 16) & 0xff),
    (unsigned char)((value >> 24) & 0xff),
  };
  append(buffer, encoded, sizeof(encoded));
}

static void patch_u32(struct bytes *buffer, size_t offset, uint32_t value) {
  if (offset + 4 > buffer->length) fail();
  buffer->data[offset] = (unsigned char)(value & 0xff);
  buffer->data[offset + 1] = (unsigned char)((value >> 8) & 0xff);
  buffer->data[offset + 2] = (unsigned char)((value >> 16) & 0xff);
  buffer->data[offset + 3] = (unsigned char)((value >> 24) & 0xff);
}

static void append_blob(struct bytes *buffer, const void *data, size_t length) {
  if (length > UINT32_MAX) fail();
  append_u32(buffer, (uint32_t)length);
  append(buffer, data, length);
}

static int same_stat(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
    left->st_size == right->st_size && left->st_nlink == right->st_nlink &&
    left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
    left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec &&
    left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
    left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec;
}

static int compare_names(const void *left, const void *right) {
  const struct name_entry *a = left;
  const struct name_entry *b = right;
  return strcmp(a->name, b->name);
}

static void free_names(struct name_entry *entries, size_t count) {
  for (size_t index = 0; index < count; index++) free(entries[index].name);
  free(entries);
}

static struct name_entry *directory_entries(int fd, size_t limit, size_t *count) {
  /* dup() shares one directory offset with fd on Darwin. Reopen "." relative to the pinned
   * descriptor so generation and snapshot passes each receive an independent cursor. */
  int duplicate = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (duplicate < 0) fail();
  DIR *directory = fdopendir(duplicate);
  if (!directory) {
    close(duplicate);
    fail();
  }
  struct name_entry *entries = calloc(limit ? limit : 1, sizeof(*entries));
  if (!entries) fail();
  size_t found = 0;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (found >= limit) {
      closedir(directory);
      free_names(entries, found);
      fail();
    }
    struct stat stat_value;
    if (fstatat(fd, entry->d_name, &stat_value, AT_SYMLINK_NOFOLLOW) != 0) {
      closedir(directory);
      free_names(entries, found);
      fail();
    }
    entries[found].name = strdup(entry->d_name);
    if (!entries[found].name) fail();
    entries[found].kind = S_ISDIR(stat_value.st_mode) ? 1 : S_ISREG(stat_value.st_mode) ? 2 : 3;
    found++;
    errno = 0;
  }
  if (errno != 0 || closedir(directory) != 0) {
    free_names(entries, found);
    fail();
  }
  qsort(entries, found, sizeof(*entries), compare_names);
  *count = found;
  return entries;
}

static void hash_u64(CC_SHA256_CTX *context, uint64_t value) {
  unsigned char encoded[8];
  for (int index = 0; index < 8; index++) encoded[index] = (unsigned char)(value >> (index * 8));
  CC_SHA256_Update(context, encoded, sizeof(encoded));
}

static void generation(int fd, char output[65]) {
  struct stat root;
  if (fstat(fd, &root) != 0 || !S_ISDIR(root.st_mode)) fail();
  size_t count = 0;
  struct name_entry *entries = directory_entries(fd, MAX_ENTRIES, &count);
  CC_SHA256_CTX hash;
  CC_SHA256_Init(&hash);
  hash_u64(&hash, (uint64_t)root.st_dev);
  hash_u64(&hash, (uint64_t)root.st_ino);
  hash_u64(&hash, (uint64_t)root.st_ctimespec.tv_sec);
  hash_u64(&hash, (uint64_t)root.st_ctimespec.tv_nsec);
  hash_u64(&hash, (uint64_t)root.st_mtimespec.tv_sec);
  hash_u64(&hash, (uint64_t)root.st_mtimespec.tv_nsec);
  for (size_t index = 0; index < count; index++) {
    size_t length = strlen(entries[index].name);
    hash_u64(&hash, (uint64_t)length);
    CC_SHA256_Update(&hash, entries[index].name, (CC_LONG)length);
    CC_SHA256_Update(&hash, &entries[index].kind, 1);
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &hash);
  for (size_t index = 0; index < sizeof(digest); index++) {
    snprintf(output + index * 2, 3, "%02x", digest[index]);
  }
  output[64] = '\0';
  free_names(entries, count);
}

/** Candidate-local validation runs in a short child so one unsupported sibling is skipped
 * instead of aborting the complete bounded discovery response. */
static int try_generation(int fd, char output[65]) {
  int channel[2];
  if (pipe(channel) != 0) fail();
  pid_t pid = fork();
  if (pid < 0) fail();
  if (pid == 0) {
    close(channel[0]);
    char digest[65];
    generation(fd, digest);
    size_t offset = 0;
    while (offset < 64) {
      ssize_t sent = write(channel[1], digest + offset, 64 - offset);
      if (sent <= 0) _exit(1);
      offset += (size_t)sent;
    }
    close(channel[1]);
    _exit(0);
  }
  close(channel[1]);
  size_t offset = 0;
  while (offset < 64) {
    ssize_t received = read(channel[0], output + offset, 64 - offset);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) break;
    offset += (size_t)received;
  }
  close(channel[0]);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0) if (errno != EINTR) fail();
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0 || offset != 64) return 0;
  output[64] = '\0';
  return 1;
}

static int open_home(const char *home) {
  char *resolved = realpath(home, NULL);
  if (!resolved) fail();
  int fd = open(resolved, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  free(resolved);
  if (fd < 0) fail();
  return fd;
}

/* Resolve a fixed relative directory through pinned no-follow parents. A durable walk flushes each
 * parent before descending, matching the Linux adoption transaction. */
static int open_relative(int root, const char *relative, int durable) {
  char *copy = strdup(relative);
  if (!copy) fail();
  int current = dup(root);
  if (current < 0) fail();
  char *state = NULL;
  char *segment = strtok_r(copy, "/", &state);
  if (!segment) fail();
  while (segment) {
    if (!strcmp(segment, ".") || !strcmp(segment, "..") || strchr(segment, '\\')) fail();
    int next = openat(current, segment, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) {
      close(current);
      free(copy);
      return -1;
    }
    if (durable && fsync(current) != 0) fail();
    close(current);
    current = next;
    segment = strtok_r(NULL, "/", &state);
  }
  free(copy);
  return current;
}

static int private_journal(const char *name) {
  static const char prefix[] = ".wollipog-adoption-";
  return strncmp(name, prefix, sizeof(prefix) - 1) == 0;
}

static int valid_skill_name(const char *name) {
  size_t length = strlen(name);
  if (length == 0 || length > 64 || !((name[0] >= 'a' && name[0] <= 'z') ||
      (name[0] >= '0' && name[0] <= '9'))) return 0;
  for (size_t index = 1; index < length; index++) {
    unsigned char current = (unsigned char)name[index];
    if (!((current >= 'a' && current <= 'z') || (current >= '0' && current <= '9') ||
        current == '.' || current == '_' || current == '-')) return 0;
  }
  return 1;
}

static void list_candidates(int argc, char **argv) {
  if (argc < 4) fail();
  int home = open_home(argv[2]);
  struct bytes output = {0};
  append(&output, "WMS1L", 5);
  size_t count_offset = output.length;
  append_u32(&output, 0);
  uint32_t candidates = 0;
  for (int argument = 3; argument < argc && candidates < 64; argument++) {
    int source = open_relative(home, argv[argument], 0);
    if (source < 0) continue;
    int duplicate = openat(source, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (duplicate < 0) fail();
    DIR *directory = fdopendir(duplicate);
    if (!directory) fail();
    int raw = 0;
    int useful = 0;
    struct dirent *entry;
    while (candidates < 64) {
      errno = 0;
      entry = readdir(directory);
      if (!entry) {
        if (errno != 0) fail();
        break;
      }
      if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
      if (++raw > MAX_RAW_ENTRIES) break;
      if (private_journal(entry->d_name)) continue;
      if (++useful > MAX_ENTRIES) break;
      if (!valid_skill_name(entry->d_name)) continue;
      int child = openat(source, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (child < 0) continue;
      int manifest = openat(child, "SKILL.md", O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      struct stat manifest_stat;
      if (manifest < 0 || fstat(manifest, &manifest_stat) != 0 ||
          !S_ISREG(manifest_stat.st_mode) || manifest_stat.st_nlink != 1) {
        if (manifest >= 0) close(manifest);
        close(child);
        continue;
      }
      close(manifest);
      char digest[65];
      if (!try_generation(child, digest)) {
        close(child);
        continue;
      }
      close(child);
      append_blob(&output, argv[argument], strlen(argv[argument]));
      append_blob(&output, entry->d_name, strlen(entry->d_name));
      append_blob(&output, digest, 64);
      candidates++;
    }
    if (closedir(directory) != 0) fail();
    close(source);
  }
  close(home);
  patch_u32(&output, count_offset, candidates);
  if (fwrite(output.data, 1, output.length, stdout) != output.length) fail();
  free(output.data);
}

static void snapshot_directory(int fd, const unsigned char *prefix, size_t prefix_length,
    int depth, struct snapshot_state *state) {
  if (depth > MAX_DEPTH) fail();
  size_t count = 0;
  struct name_entry *entries = directory_entries(fd, MAX_ENTRIES, &count);
  for (size_t index = 0; index < count; index++) {
    if (++state->entries > MAX_ENTRIES) fail();
    size_t name_length = strlen(entries[index].name);
    size_t path_length = prefix_length + name_length;
    if (path_length == 0 || path_length > 1024) fail();
    unsigned char *path = malloc(path_length + 2);
    if (!path) fail();
    memcpy(path, prefix, prefix_length);
    memcpy(path + prefix_length, entries[index].name, name_length);
    path[path_length] = '\0';
    if (entries[index].kind == 1) {
      int child = openat(fd, entries[index].name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (child < 0) fail();
      path[path_length] = '/';
      snapshot_directory(child, path, path_length + 1, depth + 1, state);
      close(child);
      free(path);
      continue;
    }
    if (entries[index].kind != 2 || state->files >= MAX_FILES) fail();
    int child = openat(fd, entries[index].name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (child < 0) fail();
    struct stat before;
    if (fstat(child, &before) != 0 || !S_ISREG(before.st_mode) || before.st_nlink != 1 ||
        before.st_size < 0 || before.st_size > MAX_FILE_BYTES ||
        state->total_bytes > MAX_TOTAL_BYTES - (size_t)before.st_size) fail();
    size_t size = (size_t)before.st_size;
    unsigned char *content = malloc(size ? size : 1);
    if (!content) fail();
    size_t offset = 0;
    while (offset < size) {
      ssize_t received = pread(child, content + offset, size - offset, (off_t)offset);
      if (received <= 0) fail();
      offset += (size_t)received;
    }
    unsigned char extra;
    if (pread(child, &extra, 1, (off_t)size) != 0) fail();
    struct stat after;
    if (fstat(child, &after) != 0 || !same_stat(&before, &after)) fail();
    close(child);
    append_blob(&state->output, path, path_length);
    append_u8(&state->output, (before.st_mode & 0111) ? 1 : 0);
    append_blob(&state->output, content, size);
    state->files++;
    state->total_bytes += size;
    free(content);
    free(path);
  }
  free_names(entries, count);
}

static void read_candidate(int argc, char **argv) {
  if (argc != 5 || !argv[4][0] || strchr(argv[4], '/') || strchr(argv[4], '\\') ||
      !strcmp(argv[4], ".") || !strcmp(argv[4], "..")) fail();
  int home = open_home(argv[2]);
  int source = open_relative(home, argv[3], 0);
  if (source < 0) fail();
  int root = openat(source, argv[4], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (root < 0) fail();
  char before[65];
  generation(root, before);
  struct snapshot_state state = {0};
  append(&state.output, "WMS1R", 5);
  append_blob(&state.output, before, 64);
  size_t count_offset = state.output.length;
  append_u32(&state.output, 0);
  snapshot_directory(root, (const unsigned char *)"", 0, 0, &state);
  char after[65];
  generation(root, after);
  if (strcmp(before, after) != 0) fail();
  patch_u32(&state.output, count_offset, state.files);
  close(root);
  close(source);
  close(home);
  if (fwrite(state.output.data, 1, state.output.length, stdout) != state.output.length) fail();
  free(state.output.data);
}

/* ------------------------------------------------------------------------------------------ */
/* Recoverable adoption                                                                        */

#define JOURNAL_PREFIX ".wollipog-adoption-"
#define MAX_JOURNAL_BYTES 8192
#define MAX_RECOVERY_OPERATIONS 64
#define MAX_PATH_UNITS 256
#define MAX_PATH_PARTS 8
#define DIRECTORY_FLAGS (O_RDONLY | O_DIRECTORY | O_NOFOLLOW)

enum path_kind { PATH_ABSENT = 0, PATH_DIRECTORY = 1, PATH_LINK = 2, PATH_OTHER = 3 };
enum link_role { LINK_NONE = 0, LINK_MANAGED = 1, LINK_RECOVERY = 2, LINK_FOREIGN = 3 };

struct manifest_entry {
  char *path;
  uint16_t units[MAX_PATH_UNITS];
  size_t unit_count;
  unsigned char sha256[CC_SHA256_DIGEST_LENGTH];
  uint64_t size;
};

struct manifest {
  struct manifest_entry *items;
  size_t count;
  uint32_t entries;
  size_t total_bytes;
};

static void write_all(int fd, const void *data, size_t length) {
  const unsigned char *cursor = data;
  while (length) {
    ssize_t written = write(fd, cursor, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) fail();
    cursor += written;
    length -= (size_t)written;
  }
}

/* Journal records and directory entries use F_FULLFSYNC where available: on macOS plain fsync()
 * does not force the drive cache, so it would be weaker than the Linux transaction's flushes. */
static void flush(int fd) {
#ifdef F_FULLFSYNC
  if (fcntl(fd, F_FULLFSYNC) == 0) return;
#endif
  if (fsync(fd) != 0) fail();
}

/* Unbuffered progress line. "journal" precedes the first mutation, so the runner reports recovery
 * rather than a clean rejection whenever the helper stops after it. */
static void emit(const char *line) {
  write_all(STDOUT_FILENO, line, strlen(line));
}

/* Test-only fault injection. The runner launches mutating operations with an empty environment,
 * so production invocations never pause here. */
static void checkpoint(const char *stage) {
  const char *selected = getenv("WOLLIPOG_SKILL_ADOPTION_TEST_CHECKPOINT");
  if (!selected || strcmp(selected, stage) != 0) return;
  emit("checkpoint\n");
  char command = 0;
  ssize_t received;
  do received = read(STDIN_FILENO, &command, 1); while (received < 0 && errno == EINTR);
  if (received != 1 || command == 'f') fail();
  if (command == 'k') kill(getpid(), SIGKILL);
}

static int hex64(const char *value) {
  if (strlen(value) != 64) return 0;
  for (const char *cursor = value; *cursor; cursor++) {
    if (!((*cursor >= '0' && *cursor <= '9') || (*cursor >= 'a' && *cursor <= 'f'))) return 0;
  }
  return 1;
}

static int valid_uuid(const char *value) {
  if (strlen(value) != 36) return 0;
  for (size_t index = 0; index < 36; index++) {
    char current = value[index];
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (current != '-') return 0;
    } else if (!((current >= '0' && current <= '9') || (current >= 'a' && current <= 'f'))) return 0;
  }
  return value[14] >= '1' && value[14] <= '8' &&
    (value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'b');
}

static int valid_relative_directory(const char *value) {
  size_t length = strlen(value);
  if (length == 0 || length > 64 || value[0] == '/' || value[length - 1] == '/') return 0;
  const char *segment = value;
  for (const char *cursor = value;; cursor++) {
    if (*cursor == '/' || *cursor == '\0') {
      size_t size = (size_t)(cursor - segment);
      if (size == 0 || (size == 1 && segment[0] == '.') || (size == 2 && segment[0] == '.' && segment[1] == '.')) return 0;
      if (*cursor == '\0') return 1;
      segment = cursor + 1;
      continue;
    }
    if (!((*cursor >= 'a' && *cursor <= 'z') || (*cursor >= 'A' && *cursor <= 'Z') ||
        (*cursor >= '0' && *cursor <= '9') || *cursor == '.' || *cursor == '_' || *cursor == '-')) return 0;
  }
}

static int valid_account(const char *value) {
  size_t length = strlen(value);
  if (length == 0 || length > 128 || !((value[0] >= 'a' && value[0] <= 'z') ||
      (value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= '0' && value[0] <= '9'))) return 0;
  for (const char *cursor = value; *cursor; cursor++) {
    if (!((*cursor >= 'a' && *cursor <= 'z') || (*cursor >= 'A' && *cursor <= 'Z') ||
        (*cursor >= '0' && *cursor <= '9') || *cursor == '.' || *cursor == '_' || *cursor == '-')) return 0;
  }
  return 1;
}

static int valid_identity(const char *value) {
  const char *separator = strchr(value, ':');
  if (!separator || separator == value || !separator[1] || strlen(value) > 47) return 0;
  for (const char *cursor = value; *cursor; cursor++) {
    if (cursor != separator && !(*cursor >= '0' && *cursor <= '9')) return 0;
  }
  return 1;
}

static char *join_path(const char *left, const char *right) {
  size_t left_length = strlen(left), right_length = strlen(right);
  char *result = malloc(left_length + right_length + 2);
  if (!result) fail();
  memcpy(result, left, left_length);
  result[left_length] = '/';
  memcpy(result + left_length + 1, right, right_length + 1);
  return result;
}

static int nested(const char *outer, const char *inner) {
  size_t length = strlen(outer);
  return strncmp(outer, inner, length) == 0 && inner[length] == '/';
}

static void identity(int fd, char output[48]) {
  struct stat value;
  if (fstat(fd, &value) != 0 || !S_ISDIR(value.st_mode)) fail();
  snprintf(output, 48, "%llu:%llu", (unsigned long long)(uint32_t)value.st_dev,
    (unsigned long long)value.st_ino);
}

/* Decode strict UTF-8 into UTF-16 code units so paths order exactly like JavaScript strings. */
static size_t utf16_units(const char *text, uint16_t *units, size_t limit) {
  const unsigned char *bytes = (const unsigned char *)text;
  size_t count = 0;
  for (size_t index = 0; bytes[index];) {
    uint32_t point = bytes[index];
    size_t extra = point < 0x80 ? 0 : (point & 0xe0) == 0xc0 ? 1 : (point & 0xf0) == 0xe0 ? 2 :
      (point & 0xf8) == 0xf0 ? 3 : 4;
    if (extra == 4) fail();
    if (extra) point &= extra == 1 ? 0x1f : extra == 2 ? 0x0f : 0x07;
    for (size_t next = 1; next <= extra; next++) {
      unsigned char byte = bytes[index + next];
      if ((byte & 0xc0) != 0x80) fail();
      point = (point << 6) | (byte & 0x3f);
    }
    if ((extra == 1 && point < 0x80) || (extra == 2 && point < 0x800) || (extra == 3 && point < 0x10000) ||
        point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail();
    index += extra + 1;
    if (point >= 0x10000) {
      if (count + 2 > limit) fail();
      point -= 0x10000;
      units[count++] = (uint16_t)(0xd800 | (point >> 10));
      units[count++] = (uint16_t)(0xdc00 | (point & 0x3ff));
    } else {
      if (count + 1 > limit) fail();
      units[count++] = (uint16_t)point;
    }
  }
  return count;
}

/* Mirrors validSkillFilePath; the exact path participates in the canonical version digest. */
static size_t valid_skill_path(const char *path, uint16_t units[MAX_PATH_UNITS]) {
  size_t count = utf16_units(path, units, MAX_PATH_UNITS);
  if (count == 0 || path[0] == '/') fail();
  if (((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1] == ':') fail();
  size_t parts = 1;
  for (const unsigned char *cursor = (const unsigned char *)path; *cursor; cursor++) {
    if (*cursor < 0x20 || *cursor == 0x7f || *cursor == '\\') fail();
    if (*cursor == '/') parts++;
  }
  if (parts > MAX_PATH_PARTS) fail();
  return count;
}

static void hash_file(int fd, uint64_t size, unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char buffer[65536];
  uint64_t offset = 0;
  while (offset < size) {
    size_t wanted = size - offset < sizeof(buffer) ? (size_t)(size - offset) : sizeof(buffer);
    ssize_t received = pread(fd, buffer, wanted, (off_t)offset);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) fail();
    CC_SHA256_Update(&context, buffer, (CC_LONG)received);
    offset += (uint64_t)received;
  }
  unsigned char extra;
  if (pread(fd, &extra, 1, (off_t)size) != 0) fail();
  CC_SHA256_Final(digest, &context);
}

static void collect_manifest(int fd, const char *prefix, size_t prefix_length, int depth,
    struct manifest *manifest, int reject_executable, int durable) {
  if (depth > MAX_DEPTH) fail();
  size_t count = 0;
  struct name_entry *entries = directory_entries(fd, MAX_ENTRIES, &count);
  for (size_t index = 0; index < count; index++) {
    if (++manifest->entries > MAX_ENTRIES) fail();
    size_t name_length = strlen(entries[index].name);
    char *path = malloc(prefix_length + name_length + 2);
    if (!path) fail();
    memcpy(path, prefix, prefix_length);
    memcpy(path + prefix_length, entries[index].name, name_length + 1);
    uint16_t units[MAX_PATH_UNITS];
    size_t unit_count = valid_skill_path(path, units);
    if (entries[index].kind == 1) {
      int child = openat(fd, entries[index].name, DIRECTORY_FLAGS);
      if (child < 0) fail();
      path[prefix_length + name_length] = '/';
      path[prefix_length + name_length + 1] = '\0';
      collect_manifest(child, path, prefix_length + name_length + 1, depth + 1, manifest,
        reject_executable, durable);
      close(child);
      free(path);
      continue;
    }
    if (entries[index].kind != 2 || manifest->count >= MAX_FILES) fail();
    int child = openat(fd, entries[index].name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (child < 0) fail();
    struct stat before;
    if (fstat(child, &before) != 0 || !S_ISREG(before.st_mode) || before.st_nlink != 1 ||
        before.st_size < 0 || before.st_size > MAX_FILE_BYTES ||
        manifest->total_bytes > MAX_TOTAL_BYTES - (size_t)before.st_size) fail();
    if (reject_executable && (before.st_mode & 0111)) fail();
    struct manifest_entry *entry = &manifest->items[manifest->count];
    hash_file(child, (uint64_t)before.st_size, entry->sha256);
    struct stat after;
    if (fstat(child, &after) != 0 || !same_stat(&before, &after)) fail();
    if (durable && fsync(child) != 0) fail();
    close(child);
    entry->path = path;
    memcpy(entry->units, units, unit_count * sizeof(uint16_t));
    entry->unit_count = unit_count;
    entry->size = (uint64_t)before.st_size;
    manifest->count++;
    manifest->total_bytes += (size_t)before.st_size;
  }
  free_names(entries, count);
  if (durable && fsync(fd) != 0) fail();
}

static int compare_manifest_entries(const void *left, const void *right) {
  const struct manifest_entry *a = left;
  const struct manifest_entry *b = right;
  size_t shared = a->unit_count < b->unit_count ? a->unit_count : b->unit_count;
  for (size_t index = 0; index < shared; index++) {
    if (a->units[index] != b->units[index]) return a->units[index] < b->units[index] ? -1 : 1;
  }
  return a->unit_count < b->unit_count ? -1 : a->unit_count > b->unit_count ? 1 : 0;
}

static void hex(const unsigned char *bytes, size_t length, char *output) {
  static const char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < length; index++) {
    output[index * 2] = digits[bytes[index] >> 4];
    output[index * 2 + 1] = digits[bytes[index] & 0x0f];
  }
  output[length * 2] = '\0';
}

/* Mirrors skillVersionDigest: SHA-256 over {"files":[{"path","sha256","size"}]} sorted by UTF-16
 * code units. Validated paths contain no control characters or backslashes, so a double quote is
 * the only character JSON.stringify escapes. */
static void tree_digest(int fd, int reject_executable, int durable, char output[65]) {
  struct manifest manifest = {0};
  manifest.items = calloc(MAX_FILES, sizeof(*manifest.items));
  if (!manifest.items) fail();
  collect_manifest(fd, "", 0, 0, &manifest, reject_executable, durable);
  qsort(manifest.items, manifest.count, sizeof(*manifest.items), compare_manifest_entries);
  int instructions = 0;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, "{\"files\":[", 10);
  for (size_t index = 0; index < manifest.count; index++) {
    struct manifest_entry *entry = &manifest.items[index];
    if (!strcmp(entry->path, "SKILL.md")) instructions = 1;
    if (index) CC_SHA256_Update(&context, ",", 1);
    CC_SHA256_Update(&context, "{\"path\":\"", 9);
    for (const char *cursor = entry->path; *cursor; cursor++) {
      if (*cursor == '"') CC_SHA256_Update(&context, "\\\"", 2);
      else CC_SHA256_Update(&context, cursor, 1);
    }
    char sha[65];
    hex(entry->sha256, sizeof(entry->sha256), sha);
    char tail[128];
    int length = snprintf(tail, sizeof(tail), "\",\"sha256\":\"%s\",\"size\":%llu}", sha,
      (unsigned long long)entry->size);
    if (length <= 0 || (size_t)length >= sizeof(tail)) fail();
    CC_SHA256_Update(&context, tail, (CC_LONG)length);
    free(entry->path);
  }
  CC_SHA256_Update(&context, "]}", 2);
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  free(manifest.items);
  if (!instructions) fail();
  hex(digest, sizeof(digest), output);
}

/* Two bounded, flushed passes must both match the approved digest while the directory generation
 * stays fixed, as in the Linux transaction. */
static void check_content(int fd, const char *digest, int reject_executable) {
  char before[65], first[65], second[65], after[65];
  generation(fd, before);
  tree_digest(fd, reject_executable, 1, first);
  tree_digest(fd, reject_executable, 1, second);
  generation(fd, after);
  if (strcmp(first, digest) || strcmp(second, digest) || strcmp(before, after)) fail();
}

/* Open an already-resolved absolute path without following any component. Each root is resolved
 * once, so the pinned descriptor names exactly the directory whose path becomes link text. */
static int open_real(const char *real) {
  if (real[0] != '/') return -1;
  int current = open("/", O_RDONLY | O_DIRECTORY);
  if (current < 0) fail();
  if (!real[1]) return current;
  int next = open_relative(current, real + 1, 0);
  close(current);
  return next;
}

static void check_path(const char *root, const char *relative, const char *expected) {
  int base = open_real(root);
  if (base < 0) fail();
  int fd = open_relative(base, relative, 0);
  if (fd < 0) fail();
  char actual[48];
  identity(fd, actual);
  if (strcmp(actual, expected)) fail();
  close(fd);
  close(base);
}

static int link_equals(int parent, const char *name, const char *expected) {
  char buffer[PATH_MAX + 1];
  ssize_t length = readlinkat(parent, name, buffer, sizeof(buffer) - 1);
  if (length < 0 || (size_t)length >= sizeof(buffer) - 1) return 0;
  buffer[length] = '\0';
  return strcmp(buffer, expected) == 0;
}

static enum path_kind entry_kind(int parent, const char *name) {
  struct stat value;
  if (fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return PATH_ABSENT;
    fail();
  }
  return S_ISDIR(value.st_mode) ? PATH_DIRECTORY : S_ISLNK(value.st_mode) ? PATH_LINK : PATH_OTHER;
}

static void record(int parent, const char *name, const char *content) {
  int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) fail();
  write_all(fd, content, strlen(content));
  flush(fd);
  close(fd);
  flush(parent);
}

static char *read_small_file(int parent, const char *name, size_t *length) {
  int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return NULL;
  struct stat value;
  if (fstat(fd, &value) != 0 || !S_ISREG(value.st_mode) || value.st_size < 0 ||
      value.st_size > MAX_JOURNAL_BYTES) {
    close(fd);
    return NULL;
  }
  size_t size = (size_t)value.st_size;
  char *content = malloc(size + 1);
  if (!content) fail();
  size_t offset = 0;
  while (offset < size) {
    ssize_t received = pread(fd, content + offset, size - offset, (off_t)offset);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) break;
    offset += (size_t)received;
  }
  close(fd);
  if (offset != size) {
    free(content);
    return NULL;
  }
  content[size] = '\0';
  *length = size;
  return content;
}

/* Write-once, retry-safe checkpoint: an existing record is accepted only with identical bytes. */
static void record_once(int parent, const char *name, const char *content) {
  int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) {
    if (errno != EEXIST) fail();
    size_t length = 0;
    char *existing = read_small_file(parent, name, &length);
    if (!existing || length != strlen(content) || memcmp(existing, content, length) != 0) fail();
    free(existing);
    return;
  }
  write_all(fd, content, strlen(content));
  flush(fd);
  close(fd);
  flush(parent);
}

static void json_string(struct bytes *buffer, const char *value) {
  append(buffer, "\"", 1);
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor++) {
    if (*cursor == '"' || *cursor == '\\') {
      char escaped[2] = { '\\', (char)*cursor };
      append(buffer, escaped, 2);
    } else if (*cursor < 0x20) {
      char escaped[7];
      snprintf(escaped, sizeof(escaped), "\\u%04x", *cursor);
      append(buffer, escaped, 6);
    } else {
      append(buffer, cursor, 1);
    }
  }
  append(buffer, "\"", 1);
}

static void check_source(const char *home, const char *local, const char *source_relative,
    const char *parent_id, const char *source_id, int source, const char *expected_generation,
    const char *digest) {
  check_path(home, local, parent_id);
  check_path(home, source_relative, source_id);
  char current[65];
  generation(source, current);
  if (strcmp(current, expected_generation)) fail();
  check_content(source, digest, 1);
  generation(source, current);
  if (strcmp(current, expected_generation)) fail();
}

/* adopt HOME LOCAL SOURCE_DIRECTORY NAME GENERATION DIGEST DATA_DIR OPERATION [ACCOUNT]
 * Preserve the original by same-filesystem rename into a private journal, then exclusively
 * publish an untransformed store-target symlink. Nothing is unlinked, overwritten, or restored
 * automatically; an interrupted run leaves its journal and the original for recovery. */
static void adopt_candidate(int argc, char **argv) {
  if (argc != 10 && argc != 11) fail();
  const char *home = argv[2], *local = argv[3], *source_directory = argv[4], *name = argv[5];
  const char *expected_generation = argv[6], *digest = argv[7], *data = argv[8], *operation = argv[9];
  const char *account = argc == 11 ? argv[10] : NULL;
  if (!valid_relative_directory(local) || !valid_relative_directory(source_directory) ||
      !valid_skill_name(name) || !hex64(expected_generation) || !hex64(digest) || !valid_uuid(operation) ||
      (account && !valid_account(account))) fail();
  char *home_real = realpath(home, NULL);
  char *data_real = realpath(data, NULL);
  if (!home_real || !data_real) fail();
  char target_relative[160];
  snprintf(target_relative, sizeof(target_relative), "skills/store/%s/%s", name, digest);
  char *parent_path = join_path(home_real, local);
  char *source_path = join_path(parent_path, name);
  char *target_path = join_path(data_real, target_relative);
  char *source_relative = join_path(local, name);
  if (!strcmp(source_path, target_path) || nested(source_path, target_path) ||
      nested(target_path, source_path)) fail();

  int home_fd = open_real(home_real);
  if (home_fd < 0) fail();
  int parent = open_relative(home_fd, local, 1);
  if (parent < 0) fail();
  int source = openat(parent, name, DIRECTORY_FLAGS);
  if (source < 0) fail();
  int data_fd = open_real(data_real);
  if (data_fd < 0) fail();
  int target = open_relative(data_fd, target_relative, 1);
  if (target < 0) fail();
  char parent_id[48], source_id[48], target_id[48];
  identity(parent, parent_id);
  identity(source, source_id);
  identity(target, target_id);
  check_source(home_real, local, source_relative, parent_id, source_id, source, expected_generation, digest);
  check_content(target, digest, 0);

  char backup_name[64];
  snprintf(backup_name, sizeof(backup_name), "%s%s", JOURNAL_PREFIX, operation);
  emit("journal\n");
  if (mkdirat(parent, backup_name, 0700) != 0) fail();
  int backup = openat(parent, backup_name, DIRECTORY_FLAGS);
  if (backup < 0) fail();
  char intent[1024];
  int length = account
    ? snprintf(intent, sizeof(intent), "{\"format\":2,\"operationId\":\"%s\",\"sourceDirectory\":\"%s\","
        "\"localSourceDirectory\":\"%s\",\"providerAccountId\":\"%s\",\"name\":\"%s\",\"digest\":\"%s\","
        "\"generation\":\"%s\",\"sourceIdentity\":\"%s\",\"parentIdentity\":\"%s\",\"targetIdentity\":\"%s\","
        "\"targetRelative\":\"%s\"}", operation, source_directory, local, account, name, digest,
        expected_generation, source_id, parent_id, target_id, target_relative)
    : snprintf(intent, sizeof(intent), "{\"format\":1,\"operationId\":\"%s\",\"sourceDirectory\":\"%s\","
        "\"name\":\"%s\",\"digest\":\"%s\",\"generation\":\"%s\",\"sourceIdentity\":\"%s\","
        "\"parentIdentity\":\"%s\",\"targetIdentity\":\"%s\",\"targetRelative\":\"%s\"}", operation,
        source_directory, name, digest, expected_generation, source_id, parent_id, target_id, target_relative);
  if (length <= 0 || (size_t)length >= sizeof(intent)) fail();
  record(backup, "intent.json", intent);
  flush(parent);
  checkpoint("intent_durable");

  /* Both rename endpoints are anchored to held descriptors, so a concurrently renamed parent
   * cannot redirect the move; the path checks detect it and stop before publication. */
  check_source(home_real, local, source_relative, parent_id, source_id, source, expected_generation, digest);
  check_path(data_real, target_relative, target_id);
  if (renameatx_np(parent, name, backup, "original", RENAME_EXCL) != 0) fail();
  flush(backup);
  flush(parent);
  checkpoint("source_preserved");
  int preserved = openat(backup, "original", DIRECTORY_FLAGS);
  if (preserved < 0) fail();
  char preserved_id[48];
  identity(preserved, preserved_id);
  if (strcmp(preserved_id, source_id)) fail();
  check_content(preserved, digest, 1);
  char receipt[256];
  snprintf(receipt, sizeof(receipt), "{\"sourceIdentity\":\"%s\",\"digest\":\"%s\"}", source_id, digest);
  record(backup, "preserved.json", receipt);
  check_path(home_real, local, parent_id);
  check_path(data_real, target_relative, target_id);
  check_content(target, digest, 0);
  /* symlinkat() fails with EEXIST rather than replacing anything created during the rename gap. */
  if (symlinkat(target_path, parent, name) != 0) fail();
  flush(parent);
  checkpoint("link_created");
  check_path(home_real, local, parent_id);
  check_path(data_real, target_relative, target_id);
  check_content(target, digest, 0);
  if (!link_equals(parent, name, target_path)) fail();
  snprintf(receipt, sizeof(receipt), "{\"digest\":\"%s\"}", digest);
  record(backup, "linked.json", receipt);
  emit("adopted\n");
}

static int extract_field(const char *json, const char *field, char *output, size_t limit) {
  char marker[32];
  snprintf(marker, sizeof(marker), "\"%s\":\"", field);
  const char *start = strstr(json, marker);
  if (!start) return 0;
  start += strlen(marker);
  const char *end = strchr(start, '"');
  if (!end || (size_t)(end - start) >= limit) return 0;
  memcpy(output, start, (size_t)(end - start));
  output[end - start] = '\0';
  return 1;
}

/* inspect HOME LOCAL DATA_DIR [OPERATION]
 * Report descriptor-anchored facts for each bounded journal. The runner parses the journal and
 * decides the recovery state; this helper never mutates anything. */
static void inspect_recovery(int argc, char **argv) {
  if (argc != 5 && argc != 6) fail();
  const char *home = argv[2], *local = argv[3], *data = argv[4];
  const char *only = argc == 6 ? argv[5] : NULL;
  if (!valid_relative_directory(local) || (only && !valid_uuid(only))) fail();
  struct bytes output = {0};
  append(&output, "WMS1I", 5);
  char *home_real = realpath(home, NULL);
  char *data_real = realpath(data, NULL);
  int home_fd = home_real ? open_real(home_real) : -1;
  int parent = home_fd >= 0 ? open_relative(home_fd, local, 0) : -1;
  if (parent < 0) {
    append_blob(&output, "", 0);
    append_u32(&output, 0);
    append_u8(&output, 0);
    write_all(STDOUT_FILENO, output.data, output.length);
    return;
  }
  char parent_id[48];
  identity(parent, parent_id);
  append_blob(&output, parent_id, strlen(parent_id));
  size_t count_offset = output.length;
  append_u32(&output, 0);
  uint32_t operations = 0;
  unsigned char truncated = 0;
  int duplicate = openat(parent, ".", DIRECTORY_FLAGS);
  if (duplicate < 0) fail();
  DIR *directory = fdopendir(duplicate);
  if (!directory) fail();
  int raw = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) {
      if (errno != 0) fail();
      break;
    }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++raw > MAX_RAW_ENTRIES) {
      truncated = 1;
      break;
    }
    if (strncmp(entry->d_name, JOURNAL_PREFIX, strlen(JOURNAL_PREFIX)) != 0) continue;
    const char *operation = entry->d_name + strlen(JOURNAL_PREFIX);
    if (!valid_uuid(operation) || (only && strcmp(operation, only) != 0)) continue;
    if (operations >= MAX_RECOVERY_OPERATIONS) {
      truncated = 1;
      break;
    }
    int backup = openat(parent, entry->d_name, DIRECTORY_FLAGS);
    if (backup < 0) continue;
    size_t intent_length = 0;
    char *intent = read_small_file(backup, "intent.json", &intent_length);
    if (!intent) {
      close(backup);
      continue;
    }
    char skill[65] = "", digest[65] = "";
    if (!extract_field(intent, "name", skill, sizeof(skill)) || !valid_skill_name(skill) ||
        !extract_field(intent, "digest", digest, sizeof(digest)) || !hex64(digest)) {
      skill[0] = '\0';
      digest[0] = '\0';
    }
    char original_id[48] = "";
    int original = openat(backup, "original", DIRECTORY_FLAGS);
    if (original >= 0) {
      identity(original, original_id);
      close(original);
    }
    unsigned char kind = PATH_OTHER, role = LINK_NONE;
    char source_id[48] = "";
    if (skill[0]) {
      kind = (unsigned char)entry_kind(parent, skill);
      if (kind == PATH_DIRECTORY) {
        int source = openat(parent, skill, DIRECTORY_FLAGS);
        if (source >= 0) {
          identity(source, source_id);
          close(source);
        }
      } else if (kind == PATH_LINK) {
        char managed[PATH_MAX], recovery[PATH_MAX];
        if (!data_real || snprintf(managed, sizeof(managed), "%s/skills/store/%s/%s", data_real, skill, digest) >=
            (int)sizeof(managed)) managed[0] = '\0';
        if (snprintf(recovery, sizeof(recovery), "%s/%s/%s/original", home_real, local, entry->d_name) >=
            (int)sizeof(recovery)) fail();
        role = managed[0] && link_equals(parent, skill, managed) ? LINK_MANAGED
          : link_equals(parent, skill, recovery) ? LINK_RECOVERY : LINK_FOREIGN;
      }
    }
    append_blob(&output, operation, strlen(operation));
    append_blob(&output, intent, intent_length);
    append_blob(&output, skill, strlen(skill));
    append_blob(&output, digest, strlen(digest));
    append_blob(&output, original_id, strlen(original_id));
    append_u8(&output, kind);
    append_blob(&output, source_id, strlen(source_id));
    append_u8(&output, role);
    free(intent);
    close(backup);
    operations++;
  }
  if (closedir(directory) != 0) fail();
  patch_u32(&output, count_offset, operations);
  append_u8(&output, truncated);
  write_all(STDOUT_FILENO, output.data, output.length);
}

/* restore HOME LOCAL DATA_DIR OPERATION NAME DIGEST PARENT_IDENTITY SOURCE_IDENTITY
 * Expose only the exact inode/content preserved by a validated journal. The managed link is first
 * moved into the journal, then an exclusive recovery link publishes `original` at the source name.
 * Nothing at that name is unlinked or overwritten; every boundary can be retried. */
static void restore_recovery(int argc, char **argv) {
  if (argc != 10) fail();
  const char *home = argv[2], *local = argv[3], *data = argv[4], *operation = argv[5], *name = argv[6];
  const char *digest = argv[7], *parent_expected = argv[8], *source_expected = argv[9];
  if (!valid_relative_directory(local) || !valid_uuid(operation) || !valid_skill_name(name) ||
      !hex64(digest) || !valid_identity(parent_expected) || !valid_identity(source_expected)) fail();
  char *home_real = realpath(home, NULL);
  char *data_real = realpath(data, NULL);
  if (!home_real || !data_real) fail();
  int home_fd = open_real(home_real);
  if (home_fd < 0) fail();
  int parent = open_relative(home_fd, local, 1);
  if (parent < 0) fail();
  char actual[48];
  identity(parent, actual);
  if (strcmp(actual, parent_expected)) fail();
  char backup_name[64];
  snprintf(backup_name, sizeof(backup_name), "%s%s", JOURNAL_PREFIX, operation);
  int backup = openat(parent, backup_name, DIRECTORY_FLAGS);
  if (backup < 0) fail();
  int original = openat(backup, "original", DIRECTORY_FLAGS);
  if (original < 0) fail();
  char current[65];
  identity(original, actual);
  tree_digest(original, 0, 1, current);
  if (strcmp(actual, source_expected) || strcmp(current, digest)) fail();
  char receipt[512];
  snprintf(receipt, sizeof(receipt), "{\"operationId\":\"%s\",\"sourceIdentity\":\"%s\"}", operation, source_expected);
  record_once(backup, "restore-intent.json", receipt);
  checkpoint("restore_intent_durable");

  char managed[PATH_MAX], recovery[PATH_MAX];
  if (snprintf(managed, sizeof(managed), "%s/skills/store/%s/%s", data_real, name, digest) >= (int)sizeof(managed) ||
      snprintf(recovery, sizeof(recovery), "%s/%s/%s/original", home_real, local, backup_name) >=
        (int)sizeof(recovery)) fail();
  enum path_kind source_kind = entry_kind(parent, name);
  enum path_kind preserved_kind = entry_kind(backup, "managed-link");
  if (source_kind == PATH_LINK) {
    if (preserved_kind != PATH_ABSENT || !link_equals(parent, name, managed)) fail();
    if (renameatx_np(parent, name, backup, "managed-link", RENAME_EXCL) != 0) fail();
    flush(parent);
    flush(backup);
    source_kind = PATH_ABSENT;
    preserved_kind = PATH_LINK;
  }
  if (preserved_kind == PATH_LINK) {
    if (!link_equals(backup, "managed-link", managed)) fail();
    struct bytes preserved = {0};
    append(&preserved, "{\"target\":", 10);
    json_string(&preserved, managed);
    append(&preserved, "}", 2); /* includes the terminator so the record is a C string */
    record_once(backup, "managed-link-preserved.json", (const char *)preserved.data);
    free(preserved.data);
    checkpoint("managed_link_preserved");
  } else if (preserved_kind != PATH_ABSENT) fail();
  if (source_kind != PATH_ABSENT) fail();
  /* symlinkat() is the no-replace primitive: any last-instant occupant makes it fail untouched. */
  if (symlinkat(recovery, parent, name) != 0) fail();
  flush(parent);
  checkpoint("recovery_link_created");
  identity(original, actual);
  tree_digest(original, 0, 1, current);
  if (!link_equals(parent, name, recovery) || strcmp(actual, source_expected) || strcmp(current, digest)) fail();
  snprintf(receipt, sizeof(receipt), "{\"sourceIdentity\":\"%s\",\"digest\":\"%s\"}", source_expected, digest);
  record_once(backup, "restored.json", receipt);
  emit("restored\n");
}

int main(int argc, char **argv) {
  if (argc < 2) fail();
  if (!strcmp(argv[1], "list")) list_candidates(argc, argv);
  else if (!strcmp(argv[1], "read")) read_candidate(argc, argv);
  else if (!strcmp(argv[1], "adopt")) adopt_candidate(argc, argv);
  else if (!strcmp(argv[1], "inspect")) inspect_recovery(argc, argv);
  else if (!strcmp(argv[1], "restore")) restore_recovery(argc, argv);
  else fail();
  return 0;
}
