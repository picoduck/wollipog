#define _DARWIN_C_SOURCE
#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
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

static int open_relative(int root, const char *relative) {
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
    int source = open_relative(home, argv[argument]);
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
  int source = open_relative(home, argv[3]);
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

int main(int argc, char **argv) {
  if (argc < 2) fail();
  if (!strcmp(argv[1], "list")) list_candidates(argc, argv);
  else if (!strcmp(argv[1], "read")) read_candidate(argc, argv);
  else fail();
  return 0;
}
