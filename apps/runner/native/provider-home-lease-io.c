/* Fixed lease I/O transaction plus separately dispatched profile directory metadata modes.
 * JSON and ownership transitions are verified by the runner;
 * this helper pins no-follow ancestry, fences publishers, and compares the exact verified bytes
 * before publishing or retiring anything. Binary input/output is bounded independently here. */
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif
#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <signal.h>
#include <sys/prctl.h>
#include <sys/vfs.h>
#include <sys/xattr.h>
#elif defined(__APPLE__)
#include <sys/mount.h>
#include <sys/acl.h>
#endif

#define MAX_ENTRIES 8208U
#define MAX_BYTES (64U * 1024U * 1024U)
#define MAX_FILE (2U * 1024U * 1024U)
#define MAX_WORK (256U * 1024U * 1024U)
#define MAX_READS 131072U
#define GUARD "protocol-v4.json"
#define ANCHOR "mutable-home.recovery.json"
static uint32_t fence_wait_ms;
static uint64_t monotonic_ms(void) {
  struct timespec now; if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) exit(1);
  return (uint64_t)now.tv_sec * 1000U + (uint64_t)now.tv_nsec / 1000000U;
}

typedef struct { unsigned dir; char *name; char *dev; char *ino; char *stamp;
  unsigned mode, links, uid; uint32_t size; unsigned char *raw; unsigned optional; } Entry;
typedef struct { char *name; unsigned char *raw; uint32_t size; unsigned copies_owner;
  uint32_t *retire; uint32_t count; } Job;
static uint64_t work_bytes;
static uint32_t work_reads, allowed_reads;
static uint64_t allowed_bytes;
static pid_t parent;
static int root_fd = -1, lock_fd = -1, guard_fd = -1, anchor_fd = -1;
static int legacy_anchor_absent;
static char *root_path, *barrier, *barrier_stage;
static int ancestry_fds[1024];
static char *ancestry_names[1024];
static struct stat ancestry_ids[1024];
static unsigned ancestry_count;
static struct stat root_identity, lock_identity, guard_identity, anchor_identity;

static void out8(unsigned value) { unsigned char b = (unsigned char)value; if (fwrite(&b, 1, 1, stdout) != 1) _exit(1); }
static void out32(uint32_t value) { for (unsigned i = 0; i < 4; i++) out8(value >> (8 * i)); }
static void out64(uint64_t value) { for (unsigned i = 0; i < 8; i++) out8((unsigned)(value >> (8 * i))); }
static void out_blob(const void *value, uint32_t size) { out32(size); if (size && fwrite(value, 1, size, stdout) != size) _exit(1); }
static void out_text(const char *value) { out_blob(value, (uint32_t)strlen(value)); }
static void fail(unsigned code, const char *message) {
  out8('E'); out8(code); out_text(message); fflush(stdout); _exit(1);
}
static void require(int value, const char *message) { if (!value) fail(1, message); }
static void alive(void) { require(getppid() == parent, "lease helper parent exited; preserve all evidence"); }
static void input(void *value, size_t size) { require(fread(value, 1, size, stdin) == size, "truncated lease I/O input"); }
static unsigned in8(void) { unsigned char b; input(&b, 1); return b; }
static uint32_t in32(void) { uint32_t value = 0; for (unsigned i = 0; i < 4; i++) value |= (uint32_t)in8() << (8 * i); return value; }
static uint64_t in64(void) { uint64_t value = 0; for (unsigned i = 0; i < 8; i++) value |= (uint64_t)in8() << (8 * i); return value; }
static unsigned char *in_blob(uint32_t maximum, uint32_t *size) {
  *size = in32(); require(*size <= maximum, "lease I/O input byte limit exceeded");
  unsigned char *value = calloc((size_t)*size + 1, 1); require(value != NULL, "lease I/O allocation failed");
  input(value, *size); return value;
}
static char *in_text(uint32_t maximum) { uint32_t size; unsigned char *value = in_blob(maximum, &size);
  require(!memchr(value, 0, size), "invalid lease I/O string"); return (char *)value; }
static void decimal(uint64_t value, char result[32]) { snprintf(result, 32, "%" PRIu64, value); }
static char *identity_text(uint64_t value) { char buffer[32]; decimal(value, buffer); return strdup(buffer); }
static void stamp(const struct stat *info, char result[160]) {
#ifdef __APPLE__
  snprintf(result, 160, "%" PRId64 ":%ld:%" PRId64 ":%ld:%" PRId64 ":%u",
    (int64_t)info->st_ctimespec.tv_sec, info->st_ctimespec.tv_nsec,
    (int64_t)info->st_mtimespec.tv_sec, info->st_mtimespec.tv_nsec, (int64_t)info->st_size, (unsigned)info->st_nlink);
#else
  snprintf(result, 160, "%" PRId64 ":%ld:%" PRId64 ":%ld:%" PRId64 ":%u",
    (int64_t)info->st_ctim.tv_sec, info->st_ctim.tv_nsec,
    (int64_t)info->st_mtim.tv_sec, info->st_mtim.tv_nsec, (int64_t)info->st_size, (unsigned)info->st_nlink);
#endif
}
static int same_identity(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static int same_stamp(const struct stat *a, const struct stat *b) { char x[160], y[160]; stamp(a, x); stamp(b, y); return same_identity(a, b) && !strcmp(x, y); }
static void sync_fd(int fd) {
  alive(); require(fsync(fd) == 0, "durable lease fsync unavailable");
#ifdef __APPLE__
  struct stat info; require(fstat(fd, &info) == 0, "lease descriptor unavailable");
  if (S_ISREG(info.st_mode)) require(fcntl(fd, F_FULLFSYNC) == 0, "durable lease full fsync unavailable");
#endif
}
static int directory(unsigned dir) { require(dir < 2 && (dir == 0 || lock_fd >= 0), "invalid lease directory"); return dir ? lock_fd : root_fd; }
static void coherent_filesystem(void) {
  struct statfs filesystem;
  require(fstatfs(root_fd, &filesystem) == 0, "lease filesystem identity unavailable");
#ifdef __linux__
  unsigned long kind = (unsigned long)filesystem.f_type;
  require(kind == 0xef53UL || kind == 0x01021994UL || kind == 0x9123683eUL || kind == 0x794c7630UL ||
    kind == 0x58465342UL || kind == 0x2fc12fc1UL || kind == 0xf2f52010UL, "checkpoint requires a supported coherent local filesystem");
#else
  require(!strcmp(filesystem.f_fstypename, "apfs") || !strcmp(filesystem.f_fstypename, "hfs"), "checkpoint requires coherent local APFS or HFS");
#endif
}
static int valid_name(const char *name) {
  size_t length = strlen(name); if (!length || length > 255 || !strcmp(name, ".") || !strcmp(name, "..")) return 0;
  for (size_t i = 0; i < length; i++) if (!((name[i] >= 'a' && name[i] <= 'z') ||
      (name[i] >= '0' && name[i] <= '9') || name[i] == '-' || name[i] == '.' || name[i] == '_')) return 0;
  return 1;
}
static int slot(const char *name) { return !strcmp(name, ".mutable-home.checkpoint.pending") || !strcmp(name, ".mutable-home.checkpoint.pending-2"); }
static int retirement_name(unsigned dir, const char *name) {
  if (!valid_name(name) || !strcmp(name, GUARD) || !strcmp(name, ANCHOR)) return 0;
  if (!dir) return !strncmp(name, "next-", 5) || slot(name) || !strcmp(name, ".mutable-home.retired");
  return !strncmp(name, "next-", 5) || !strncmp(name, "lease-", 6) || !strcmp(name, "checkpoint.json");
}
static void pinned(void) {
  alive(); struct stat info;
  for (unsigned i = 0; i < ancestry_count; i++) require(fstatat(ancestry_fds[i], ancestry_names[i], &info, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(info.st_mode) && same_identity(&info, &ancestry_ids[i]), "pinned lease ancestry changed");
  require(fstat(root_fd, &info) == 0 && same_identity(&info, &root_identity), "lease root identity changed");
  require(lstat(root_path, &info) == 0 && S_ISDIR(info.st_mode) && same_identity(&info, &root_identity), "lease root ancestry changed");
  if (lock_fd >= 0) require(fstatat(root_fd, "mutable-home.lock", &info, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISDIR(info.st_mode) && same_identity(&info, &lock_identity), "lease lock identity changed");
  if (guard_fd >= 0) require(fstatat(lock_fd, GUARD, &info, AT_SYMLINK_NOFOLLOW) == 0 && same_stamp(&info, &guard_identity), "permanent lease fence changed");
  if (anchor_fd >= 0) require(fstatat(root_fd, ANCHOR, &info, AT_SYMLINK_NOFOLLOW) == 0 && same_stamp(&info, &anchor_identity), "selected checkpoint changed");
  if (legacy_anchor_absent) require(fstatat(root_fd, ANCHOR, &info, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT, "legacy checkpoint appeared before selection");
}
static int open_root(const char *path) {
  require(path[0] == '/' && strlen(path) < 32768, "invalid lease root");
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC); require(current >= 0, "lease root unavailable");
  char *copy = strdup(path + 1), *context = NULL; require(copy != NULL, "lease path allocation failed");
  for (char *part = strtok_r(copy, "/", &context); part; part = strtok_r(NULL, "/", &context)) {
    require(strcmp(part, ".") && strcmp(part, ".."), "unsafe lease ancestry");
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    require(next >= 0 && ancestry_count < 1024, "unsafe or unavailable lease ancestry");
    ancestry_fds[ancestry_count] = current; ancestry_names[ancestry_count] = strdup(part);
    require(ancestry_names[ancestry_count] && fstat(next, &ancestry_ids[ancestry_count]) == 0, "lease ancestry unavailable"); ancestry_count++; current = next;
  }
  free(copy); return current;
}
static int publication_temporary(unsigned dir, const char *name) {
  if (dir || strlen(name) != 61 || strncmp(name, ".provider-home-lease-", 21) || strcmp(name + 57, ".tmp")) return 0;
  for (unsigned i = 21; i < 57; i++) if (!((name[i] >= '0' && name[i] <= '9') || (name[i] >= 'a' && name[i] <= 'f') || name[i] == '-')) return 0;
  return 1;
}
static Entry read_entry(unsigned dir, const char *name) {
  require(valid_name(name), "invalid lease entry name"); alive();
  int temporary = publication_temporary(dir, name);
  int fd = openat(directory(dir), name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0 && temporary && errno == ENOENT) return (Entry){0};
  require(fd >= 0, "lease record unavailable or linked"); struct stat before, after, named;
  require(fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_size >= 0 && before.st_size <= MAX_FILE &&
    (before.st_nlink >= 1 || temporary) && before.st_nlink <= 3 && before.st_uid == getuid() && !(before.st_mode & 0022), "unsafe lease record");
  require(before.st_size <= 4096 || (!dir && (slot(name) || !strcmp(name, ANCHOR) || !strcmp(name, ".mutable-home.retired"))), "ordinary lease record byte limit exceeded");
  if (temporary && before.st_nlink == 0) { close(fd); return (Entry){0}; }
  int named_status = fstatat(directory(dir), name, &named, AT_SYMLINK_NOFOLLOW);
  if (named_status != 0 && temporary && errno == ENOENT) { close(fd); return (Entry){0}; }
  require(named_status == 0 && same_identity(&before, &named), "lease record identity changed");
  struct stat guard;
  int immutable = !temporary || (guard_fd >= 0 && fstat(guard_fd, &guard) == 0 && same_identity(&before, &guard));
  // Staging is mutable and removed by the writer after publication. It carries no ownership
  // authority: validate its metadata and charge its maximum size, without reading its bytes.
  // A staging alias of the permanent format guard is an immutable witness, retaining exact bytes.
  uint32_t size = immutable ? (uint32_t)before.st_size : 4096;
  require(++work_reads <= allowed_reads && (work_bytes += size) <= allowed_bytes, "lease verification work limit exceeded");
  unsigned char *raw = calloc((size_t)size + 1, 1); require(raw != NULL, "lease read allocation failed");
  if (immutable) {
    uint32_t offset = 0; while (offset < size) { ssize_t n = read(fd, raw + offset, size - offset); require(n > 0, "lease record changed during read"); offset += (uint32_t)n; }
    unsigned char extra; require(read(fd, &extra, 1) == 0 && fstat(fd, &after) == 0 && same_stamp(&before, &after), "lease record changed during read");
    require(fstatat(directory(dir), name, &named, AT_SYMLINK_NOFOLLOW) == 0 && same_stamp(&before, &named), "lease record pathname changed");
  }
  close(fd); char fingerprint[160]; stamp(&before, fingerprint);
  Entry result = {dir, strdup(name), identity_text((uint64_t)before.st_dev), identity_text((uint64_t)before.st_ino), strdup(fingerprint),
    (unsigned)before.st_mode, (unsigned)before.st_nlink, (unsigned)before.st_uid, size, raw, 0}; return result;
}
static void free_entry(Entry *entry) { free(entry->name); free(entry->dev); free(entry->ino); free(entry->stamp); free(entry->raw); }
static int compare_entry(const void *a, const void *b) { return strcmp(((const Entry *)a)->name, ((const Entry *)b)->name); }
static uint32_t entries(unsigned dir, Entry *values, uint32_t offset) {
  int fd = openat(directory(dir), ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); require(fd >= 0, "lease enumeration unavailable");
  DIR *stream = fdopendir(fd); require(stream != NULL, "lease enumeration unavailable"); uint32_t count = 0, raw_count = 0;
  errno = 0; struct dirent *item;
  while ((item = readdir(stream)) != NULL) {
    if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, "..")) continue;
    require(++raw_count <= 4104 && offset + count < MAX_ENTRIES, "lease directory scan limit exceeded");
    if (!dir && !strcmp(item->d_name, "mutable-home.lock")) continue;
    values[offset + count] = read_entry(dir, item->d_name); if (values[offset + count].name) count++; errno = 0;
  }
  require(errno == 0, "lease enumeration failed"); closedir(stream);
  qsort(values + offset, count, sizeof(Entry), compare_entry); return count;
}
static void fence(int exclusive) {
  if (guard_fd < 0) {
    guard_fd = openat(lock_fd, GUARD, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (guard_fd < 0 && errno == ENOENT && !exclusive) return;
    coherent_filesystem();
    require(guard_fd >= 0, "permanent lease fence unavailable");
    require(fstat(guard_fd, &guard_identity) == 0 && S_ISREG(guard_identity.st_mode) && guard_identity.st_nlink >= 1 && guard_identity.st_nlink <= 3 &&
      guard_identity.st_uid == getuid() && !(guard_identity.st_mode & 0022), "unsafe permanent lease fence");
  }
  uint64_t deadline = monotonic_ms() + fence_wait_ms;
  while (flock(guard_fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB) != 0) {
    int error = errno;
    alive();
    require(error == EWOULDBLOCK || error == EAGAIN || error == EINTR, "permanent lease fence unavailable");
    if (monotonic_ms() >= deadline) fail(2, "provider HOME already in use: checkpoint publication is in progress; retry");
    struct timespec delay = {0, 10000000}; nanosleep(&delay, NULL);
  }
}
static void boundary(const char *stage) {
  pinned();
  if (barrier_stage && *barrier_stage && !strcmp(stage, barrier_stage)) {
    int fd = open(barrier, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    require(fd >= 0 && write(fd, "ready", 5) == 5, "lease test barrier unavailable"); close(fd);
    for (;;) { alive(); struct timespec delay = {0, 10000000}; nanosleep(&delay, NULL); }
  }
}
static void write_new(unsigned dir, const char *name, const unsigned char *raw, uint32_t size, int guard) {
  pinned(); require(valid_name(name) && size <= MAX_FILE, "invalid lease publication");
  int fd = openat(directory(dir), name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  require(fd >= 0, "lease staging slot unavailable"); uint32_t offset = 0;
  while (offset < size) { alive(); ssize_t n = write(fd, raw + offset, size - offset); require(n > 0, "lease publication failed"); offset += (uint32_t)n; }
  boundary(guard ? "guard-temp-written" : "candidate-written"); sync_fd(fd);
  boundary(guard ? "guard-file-durable" : "candidate-file-durable"); close(fd); sync_fd(directory(dir));
}
static void expected_identity(const struct stat *info, const char *dev, const char *ino) {
  char a[32], b[32]; decimal((uint64_t)info->st_dev, a); decimal((uint64_t)info->st_ino, b);
  require(!strcmp(a, dev) && !strcmp(b, ino), "lease directory identity changed");
}
static int entry_equal(const Entry *a, const Entry *b) {
  return a->name && b->name && a->dir == b->dir && !strcmp(a->name, b->name) && !strcmp(a->dev, b->dev) && !strcmp(a->ino, b->ino) &&
    a->size == b->size && (!a->size || !memcmp(a->raw, b->raw, a->size));
}
static int compare_pointer(const void *a, const void *b) {
  const Entry *x = *(const Entry *const *)a, *y = *(const Entry *const *)b;
  if (x->dir != y->dir) return x->dir < y->dir ? -1 : 1;
  return strcmp(x->name, y->name);
}
static Entry *find_expected(Entry **values, uint32_t count, const Entry *key) {
  uint32_t low = 0, high = count;
  while (low < high) { uint32_t middle = low + (high - low) / 2; const Entry *value = values[middle];
    int order = value->dir != key->dir ? (value->dir < key->dir ? -1 : 1) : strcmp(value->name, key->name);
    if (!order) return values[middle];
    if (order < 0) low = middle + 1; else high = middle;
  }
  return NULL;
}
/* Independently correlate a destructive transaction to its actual parent process, without
 * treating that PID as acquisition authority: the runner must also supply its held token and
 * the complete exact preimage, and the helper fences and verifies that preimage. */
static void actor_pid(const unsigned char *raw, uint32_t size) {
  unsigned depth = 0, found = 0; int key = 0;
  for (uint32_t i = 0; i < size; i++) {
    unsigned char c = raw[i];
    if (c == '"') { uint32_t begin = ++i; int escaped = 0;
      for (; i < size && raw[i] != '"'; i++) if (raw[i] == '\\') { escaped = 1; i++; }
      require(i < size, "invalid acquired lease JSON");
      if (depth == 1 && key) {
        key = 0;
        if (!escaped && i - begin == 3 && !memcmp(raw + begin, "pid", 3)) {
          uint32_t at = i + 1; while (at < size && (raw[at] == ' ' || raw[at] == '\n' || raw[at] == '\r' || raw[at] == '\t')) at++;
          require(at < size && raw[at++] == ':', "invalid acquired PID");
          while (at < size && (raw[at] == ' ' || raw[at] == '\n' || raw[at] == '\r' || raw[at] == '\t')) at++;
          uint64_t value = 0; unsigned digits = 0;
          while (at < size && raw[at] >= '0' && raw[at] <= '9') { value = value * 10 + raw[at++] - '0'; require(++digits <= 10, "invalid acquired PID"); }
          require(digits && value == (uint64_t)parent && !found++, "acquired token does not belong to the helper parent");
        }
      }
    } else if (c == '{' || c == '[') { depth++; if (depth == 1) key = 1; }
    else if (c == '}' || c == ']') { require(depth > 0, "invalid acquired lease JSON"); depth--; }
    else if (c == ',' && depth == 1) key = 1;
  }
  require(found == 1 && depth == 0, "acquired token PID could not be proven");
}
static void verify_entry(const Entry *expected, int optional) {
  struct stat info;
  if (fstatat(directory(expected->dir), expected->name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
    require(optional && errno == ENOENT, "verified lease evidence disappeared"); return;
  }
  Entry actual = read_entry(expected->dir, expected->name); require(entry_equal(expected, &actual), "verified lease evidence changed"); free_entry(&actual);
}
static void owned(const Entry *tip, const char *future, int copied) {
  pinned(); struct stat info;
  require(fstatat(root_fd, future, &info, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT, "acquired lease has a future successor");
  if (tip->dir == 1) require(fstatat(lock_fd, future, &info, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT, "legacy acquired lease has a future successor");
  if (!copied) verify_entry(tip, 0);
}
static void select_checkpoint(const char *name) {
  pinned(); int fd = openat(root_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); require(fd >= 0, "checkpoint candidate unavailable");
  sync_fd(fd); close(fd); sync_fd(root_fd); boundary("before-selection");
  require(renameat(root_fd, name, root_fd, ANCHOR) == 0, "checkpoint selection failed");
  legacy_anchor_absent = 0;
  if (anchor_fd >= 0) close(anchor_fd);
  anchor_fd = openat(root_fd, ANCHOR, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  require(anchor_fd >= 0 && fstat(anchor_fd, &anchor_identity) == 0, "selected checkpoint unavailable");
  boundary("selection-published"); sync_fd(root_fd); boundary("selection-durable");
}
/* Metadata-only root maintenance. This does not enter the lease transaction, enumerate a
 * directory, or read credentials. The public CLI must obtain human confirmation first. */
static int profile_root_result(const char *component, const char *reason) {
  printf("{\"ok\":false,\"component\":\"%s\",\"reason\":\"%s\",\"repairable\":false}\n", component, reason);
  return 0;
}
static int profile_root_acl_clear(int fd) {
#ifdef __linux__
  const char *names[] = { "system.posix_acl_access", "system.posix_acl_default" };
  for (unsigned i = 0; i < 2; i++) {
    errno = 0;
    if (fgetxattr(fd, names[i], NULL, 0) >= 0 || errno != ENODATA) return 0;
  }
  return 1;
#elif defined(__APPLE__)
  /* macOS ACL entry APIs have different return semantics from Linux. Until the
   * descriptor ACL refusal has platform regression coverage, maintenance stays read-only. */
  (void)fd; return 0;
#else
  (void)fd; return 0;
#endif
}
static const char *profile_root_stat_reason(const struct stat *info) {
  if (S_ISLNK(info->st_mode)) return "symlink";
  if (!S_ISDIR(info->st_mode)) return "not_directory";
  if (info->st_uid != getuid()) return "wrong_owner";
  return NULL;
}
static void profile_root_token(const struct stat *info, char token[320]) {
  char time[160]; stamp(info, time);
  snprintf(token, 320, "%" PRIu64 ":%" PRIu64 ":%u:%u:%s", (uint64_t)info->st_dev,
    (uint64_t)info->st_ino, (unsigned)info->st_uid, (unsigned)(info->st_mode & 07777), time);
}
static int profile_root_pinned(void) {
  struct stat current;
  if (getppid() != parent) return 0;
  for (unsigned i = 0; i < ancestry_count; i++)
    if (fstatat(ancestry_fds[i], ancestry_names[i], &current, AT_SYMLINK_NOFOLLOW) ||
        !S_ISDIR(current.st_mode) || !same_identity(&current, &ancestry_ids[i])) return 0;
  return !lstat(root_path, &current) && S_ISDIR(current.st_mode) && same_identity(&current, &root_identity);
}
static int profile_root_barrier(const char *stage) {
#ifdef WOLLIPOG_PROFILE_ROOT_TEST_BARRIER
  const char *requested = getenv("WOLLIPOG_PROFILE_ROOT_TEST_BARRIER");
  if (requested && !strcmp(requested, stage)) {
    printf("{\"barrier\":\"%s\"}\n", stage); fflush(stdout);
    return getchar() == '1';
  }
#else
  (void)stage;
#endif
  return 1;
}
static int profile_root_command(int argc, char **argv) {
  /* Only the two fixed components under the supplied OS home can ever be selected. */
  const char *component = "manager_root";
  if (argc < 5 || (strcmp(argv[4], "manager_root") && strcmp(argv[4], "profiles_root")))
    return profile_root_result(component, "unsupported_layout");
  component = argv[4];
  int repair = !strcmp(argv[2], "repair");
  if ((!repair && strcmp(argv[2], "inspect")) || argc != (repair ? 6 : 5))
    return profile_root_result(component, "unsupported_layout");
  parent = getppid(); root_path = argv[3]; root_fd = open_root(root_path);
  if (fstat(root_fd, &root_identity) || root_identity.st_uid != getuid() || (root_identity.st_mode & 0022))
    return profile_root_result("os_home", "unsafe_ancestry");
  if (!profile_root_acl_clear(root_fd)) return profile_root_result("os_home", "unsupported_acl");
  struct stat manager, target;
  if (fstatat(root_fd, ".agent-manager", &manager, AT_SYMLINK_NOFOLLOW)) return profile_root_result(component, "unavailable");
  const char *reason = profile_root_stat_reason(&manager);
  if (reason) return profile_root_result("manager_root", reason);
  int manager_fd = openat(root_fd, ".agent-manager", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (manager_fd < 0 || fstat(manager_fd, &target) || !same_identity(&manager, &target))
    return profile_root_result("manager_root", "identity_changed");
  manager = target;
  reason = profile_root_stat_reason(&manager);
  if (reason) return profile_root_result("manager_root", reason);
  int target_fd = manager_fd, container_fd = root_fd; const char *name = ".agent-manager";
  if (!strcmp(component, "profiles_root")) {
    if (manager.st_mode & 0022) return profile_root_result("manager_root", "group_or_other_write");
    if (!profile_root_acl_clear(manager_fd)) return profile_root_result("manager_root", "unsupported_acl");
    container_fd = manager_fd; name = "profiles";
    if (fstatat(container_fd, name, &target, AT_SYMLINK_NOFOLLOW)) return profile_root_result(component, "unavailable");
    reason = profile_root_stat_reason(&target);
    if (reason) return profile_root_result(component, reason);
    target_fd = openat(container_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat opened;
    if (target_fd < 0 || fstat(target_fd, &opened) || !same_identity(&target, &opened))
      return profile_root_result(component, "identity_changed");
    target = opened;
  }
  reason = profile_root_stat_reason(&target);
  if (reason) return profile_root_result(component, reason);
  char identity[320]; profile_root_token(&target, identity);
  if (repair && strcmp(identity, argv[5])) return profile_root_result(component, "identity_changed");
  if (target.st_mode & 07000) return profile_root_result(component, "unsupported_layout");
  if (!profile_root_acl_clear(target_fd)) return profile_root_result(component, "unsupported_acl");
  if (!repair) {
    printf("{\"ok\":%s,\"component\":\"%s\",\"reason\":\"%s\",\"repairable\":%s,\"identity\":\"%s\"}\n",
      target.st_mode & 0022 ? "false" : "true", component,
      target.st_mode & 0022 ? "group_or_other_write" : "private", target.st_mode & 0022 ? "true" : "false", identity);
    return 0;
  }
  if (!(target.st_mode & 0022)) return profile_root_result(component, "identity_changed");
  /* Compile-time-only rejection probe. Packaged helpers contain no test barrier. */
  if (!profile_root_barrier("before")) return profile_root_result(component, "identity_changed");
  /* Revalidate the complete pinned ancestry and the exact target immediately before fchmod.
   * A renamed/replaced path never redirects the descriptor to an unapproved object. */
  struct stat current, named, manager_now, home_now;
  if (!profile_root_pinned() || fstat(root_fd, &home_now) || !same_stamp(&home_now, &root_identity) || !profile_root_acl_clear(root_fd) ||
      fstatat(root_fd, ".agent-manager", &manager_now, AT_SYMLINK_NOFOLLOW) || !same_stamp(&manager_now, &manager) ||
      fstat(target_fd, &current) || !same_stamp(&current, &target) ||
      fstatat(container_fd, name, &named, AT_SYMLINK_NOFOLLOW) || !same_stamp(&named, &target))
    return profile_root_result(component, "identity_changed");
  if (!profile_root_acl_clear(target_fd)) return profile_root_result(component, "unsupported_acl");
  /* Once attempted, an error or lost named binding cannot promise no mutation. */
  if (fchmod(target_fd, target.st_mode & 07777 & ~0022)) return profile_root_result(component, "may_have_changed");
  if (!profile_root_barrier("after")) return profile_root_result(component, "may_have_changed");
  if (!profile_root_pinned() || fstatat(root_fd, ".agent-manager", &manager_now, AT_SYMLINK_NOFOLLOW) ||
      !same_identity(&manager_now, &manager) || manager_now.st_uid != getuid() || (manager_now.st_mode & 0022) ||
      !profile_root_acl_clear(manager_fd) || fstat(root_fd, &home_now) || home_now.st_uid != getuid() || (home_now.st_mode & 0022) ||
      !profile_root_acl_clear(root_fd) || !profile_root_acl_clear(target_fd) ||
      fstat(target_fd, &current) || !same_identity(&current, &target) || current.st_uid != target.st_uid ||
      (current.st_mode & 07777) != (target.st_mode & 07777 & ~0022) ||
      fstatat(container_fd, name, &named, AT_SYMLINK_NOFOLLOW) || !same_identity(&named, &target))
    return profile_root_result(component, "may_have_changed");
  printf("{\"ok\":true,\"component\":\"%s\",\"reason\":\"repaired\",\"repairable\":false}\n", component);
  return 0;
}
/* Fixed managed-profile creation, separate from repair and WPLL4. No payload I/O,
 * cleanup, permission changes or caller-selected descendant names. */
static int profile_create_result(const char *component, const char *reason, int changed) {
  printf("{\"ok\":false,\"component\":\"%s\",\"reason\":\"%s\"", component, changed ? "may_have_changed" : reason);
  if (changed) printf(",\"failureReason\":\"%s\"", reason);
  puts("}");
  return 0;
}
static int profile_create_id(const char *id) {
  if (strlen(id) != 36) return 0;
  for (unsigned i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return 0; }
    else if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return 0;
  }
  return id[14] == '4' && (id[19] == '8' || id[19] == '9' || id[19] == 'a' || id[19] == 'b');
}
/* Unlike the lease transaction's binary-error opener, creation has a path-free JSON
 * error contract even when the OS home or an ancestor cannot be opened. */
static int profile_create_open_home(const char *path) {
  if (path[0] != '/' || strlen(path) >= 32768) return -1;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) return -1;
  char *copy = strdup(path + 1), *context = NULL;
  if (!copy) return -1;
  for (char *part = strtok_r(copy, "/", &context); part; part = strtok_r(NULL, "/", &context)) {
    if (!strcmp(part, ".") || !strcmp(part, "..") || ancestry_count >= 1024) { free(copy); return -1; }
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) { free(copy); return -1; }
    ancestry_fds[ancestry_count] = current; ancestry_names[ancestry_count] = strdup(part);
    if (!ancestry_names[ancestry_count] || fstat(next, &ancestry_ids[ancestry_count])) { free(copy); return -1; }
    ancestry_count++; current = next;
  }
  free(copy); return current;
}
/* Creation-only Darwin ACL admission. Repair deliberately keeps its separate unsupported
 * Darwin gate. A deny ACE cannot grant a foreign principal write/delete rights. Inheritance
 * of known deny flags preserves that property; allow ACEs and deferred/unknown flags do not.
 * No ACL is edited and no principal names or ACL bytes leave this helper. */
#ifdef __APPLE__
static int profile_create_acl_fault(const char *point) {
#ifdef WOLLIPOG_PROFILE_CREATE_DARWIN_TEST
  const char *fault = getenv("WOLLIPOG_PROFILE_CREATE_DARWIN_FAULT");
  return fault && !strcmp(fault, point);
#else
  (void)point; return 0;
#endif
}
static int profile_create_darwin_acl(int fd) {
  struct stat before, metadata, after; struct statfs filesystem;
  if (fstat(fd, &before) || fstatfs(fd, &filesystem) ||
      (strcmp(filesystem.f_fstypename, "apfs") && strcmp(filesystem.f_fstypename, "hfs"))) return 0;
  filesec_t security = filesec_init();
  if (!security) return 0;
  acl_t acl = NULL, empty = NULL, one = NULL; int safe = 0, present = 0;
  if (profile_create_acl_fault("stat") || fstatx_np(fd, &metadata, security) || !same_stamp(&before, &metadata) ||
      before.st_uid != metadata.st_uid || before.st_mode != metadata.st_mode) goto done;
  /* Successful metadata plus an explicit property query establishes absence. Neither NULL
   * from acl_get_fd_np nor an errno by itself establishes that an ACL is absent. */
  if (profile_create_acl_fault("query") || filesec_query_property(security, FILESEC_ACL, &present)) goto done;
  if (!present) { safe = 1; goto done; }
  if (profile_create_acl_fault("property") || filesec_get_property(security, FILESEC_ACL, &acl) ||
      !acl || (void *)acl == _FILESEC_REMOVE_ACL || acl_valid(acl)) goto done;
#ifdef WOLLIPOG_PROFILE_CREATE_DARWIN_TEST
  if (profile_create_acl_fault("empty")) { acl_free(acl); acl = acl_init(0); if (!acl) goto done; }
#endif
  acl_flagset_t flags;
  if (acl_get_flagset_np(acl, &flags)) goto done;
#ifdef WOLLIPOG_PROFILE_CREATE_DARWIN_TEST
  if (profile_create_acl_fault("unknown_flags") && acl_add_flag_np(flags, (acl_flag_t)(1U << 30))) goto done;
  if (profile_create_acl_fault("deferred") && acl_add_flag_np(flags, ACL_FLAG_DEFER_INHERIT)) goto done;
#endif
  if (acl_get_flag_np(flags, (acl_flag_t)~(unsigned)ACL_FLAG_NO_INHERIT) != 0) goto done;
  /* Derive the entry count from public serialized sizes, not iterator exhaustion/errno or
   * private structure layout. Every expected entry must be retrieved and classified. */
  empty = acl_init(0); one = acl_init(1); acl_entry_t sample;
  if (!empty || !one || acl_create_entry(&one, &sample)) goto done;
  ssize_t base = acl_size(empty), unit = acl_size(one) - base, size = acl_size(acl);
  if (base < 0 || unit <= 0 || size < base || (size - base) % unit || (size - base) / unit > ACL_MAX_ENTRIES) goto done;
  unsigned count = (unsigned)((size - base) / unit);
  acl_permset_mask_t supported;
  if (acl_maximal_permset_mask_np(&supported)) goto done;
  unsigned known_flags = ACL_ENTRY_INHERITED | ACL_ENTRY_FILE_INHERIT | ACL_ENTRY_DIRECTORY_INHERIT |
    ACL_ENTRY_LIMIT_INHERIT | ACL_ENTRY_ONLY_INHERIT;
  for (unsigned i = 0; i < count; i++) {
    acl_entry_t entry; acl_tag_t tag; acl_permset_mask_t permissions;
    if (profile_create_acl_fault("entry") || acl_get_entry(acl, (int)i, &entry) ||
        acl_get_tag_type(entry, &tag) || tag != ACL_EXTENDED_DENY ||
        acl_get_flagset_np(entry, &flags) || acl_get_flag_np(flags, (acl_flag_t)~known_flags) != 0 ||
        acl_get_permset_mask_np(entry, &permissions) || (permissions & ~supported)) goto done;
  }
  safe = 1;
done:
  if (one) acl_free(one);
  if (empty) acl_free(empty);
  if (acl && (void *)acl != _FILESEC_REMOVE_ACL) acl_free(acl);
  filesec_free(security);
  return safe && !fstat(fd, &after) && same_stamp(&before, &after) &&
    before.st_uid == after.st_uid && before.st_mode == after.st_mode;
}
#endif
static int profile_create_acl_clear(int fd) {
#ifdef __APPLE__
  return profile_create_darwin_acl(fd);
#else
  return profile_root_acl_clear(fd);
#endif
}
static const char *profile_create_safe(int fd, struct stat *info) {
  if (fstat(fd, info)) return "unavailable";
  const char *reason = profile_root_stat_reason(info);
  if (reason) return reason;
  if (info->st_mode & 0022) return "group_or_other_write";
  if (info->st_mode & 07000) return "unsupported_layout";
  if (!profile_create_acl_clear(fd)) return "unsupported_acl";
  return NULL;
}
/* A failed check after any successful mkdir cannot imply a clean refusal. */
static const char *profile_create_check(int *fds, const char **names, struct stat *ids, unsigned count,
    const char **components, const char **component) {
  struct stat opened, named;
  *component = "os_home";
  if (!profile_root_pinned()) return "identity_changed";
  for (unsigned i = 0; i < count; i++) {
    *component = components[i];
    const char *reason = profile_create_safe(fds[i], &opened);
    if (reason) return reason;
    if (!same_identity(&opened, &ids[i])) return "identity_changed";
    if (i && (fstatat(fds[i - 1], names[i], &named, AT_SYMLINK_NOFOLLOW) ||
        !same_identity(&opened, &named) || !S_ISDIR(named.st_mode))) return "identity_changed";
  }
  return NULL;
}
static int profile_create_command(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[2], "--capabilities")) {
#if defined(__linux__) || defined(__APPLE__)
    puts("{\"version\":1,\"supported\":true}");
#else
    puts("{\"version\":1,\"supported\":false}");
#endif
    return 0;
  }
  if (argc != 4 || !profile_create_id(argv[3])) return profile_create_result("profile_home", "unsupported_layout", 0);
#if !defined(__linux__) && !defined(__APPLE__)
  return profile_create_result("os_home", "unsupported_platform", 0);
#endif
  parent = getppid(); root_path = argv[2]; root_fd = profile_create_open_home(root_path);
  if (root_fd < 0 || fstat(root_fd, &root_identity)) return profile_create_result("os_home", "unavailable", 0);
  int fds[4] = { root_fd, -1, -1, -1 }, changed = 0;
  const char *names[4] = { "", ".agent-manager", "profiles", argv[3] };
  const char *components[4] = { "os_home", "manager_root", "profiles_root", "profile_home" };
  const char *stages[4] = { "", "create-after-manager", "create-after-profiles", "create-after-profile" };
  struct stat ids[4]; ids[0] = root_identity;
  for (unsigned i = 1; i < 4; i++) {
    const char *component = components[i], *failed_component = component;
    if (i == 3 && !profile_root_barrier("create-before-profile")) return profile_create_result(component, "identity_changed", changed);
    const char *reason = profile_create_check(fds, names, ids, i, components, &failed_component);
    if (reason) return profile_create_result(failed_component, reason, changed);
    if (i == 3 && !profile_root_barrier("create-before-mkdir-profile")) return profile_create_result(component, "identity_changed", changed);
    struct stat named, opened;
    int found = fstatat(fds[i - 1], names[i], &named, AT_SYMLINK_NOFOLLOW);
    if (!found && i == 3) return profile_create_result(component, "already_exists", changed);
    if (found) {
      if (errno != ENOENT) return profile_create_result(component, "unavailable", changed);
      /* mkdirat does not return an inode/descriptor. Observe and pin immediately; a
       * same-UID writer can still replace a directory before this first observation.
       * No root is group/other writable, and no open follows a link. */
      if (mkdirat(fds[i - 1], names[i], 0700)) {
        if (errno != EEXIST) {
          /* Definite local admission/resource failures cannot have created this directory.
           * An ambiguous I/O/interruption result still preserves uncertainty. */
          int definite = errno == EACCES || errno == EPERM || errno == EROFS || errno == ENOSPC || errno == EDQUOT ||
            errno == ENOENT || errno == ENOTDIR || errno == ELOOP || errno == ENAMETOOLONG || errno == EMLINK;
          return profile_create_result(component, "unavailable", changed || !definite);
        }
        if (i == 3) return profile_create_result(component, "already_exists", changed);
      } else changed = 1;
      if (fstatat(fds[i - 1], names[i], &named, AT_SYMLINK_NOFOLLOW)) return profile_create_result(component, "unavailable", changed);
    }
    reason = profile_root_stat_reason(&named);
    if (reason) return profile_create_result(component, reason, changed);
    fds[i] = openat(fds[i - 1], names[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fds[i] < 0 || fstat(fds[i], &opened) || !same_identity(&opened, &named))
      return profile_create_result(component, "identity_changed", changed);
    ids[i] = opened;
    if (!profile_root_barrier(stages[i])) return profile_create_result(component, "identity_changed", changed);
    reason = profile_create_check(fds, names, ids, i + 1, components, &failed_component);
    if (reason) return profile_create_result(failed_component, reason, changed);
  }
  puts("{\"ok\":true,\"component\":\"profile_home\",\"reason\":\"created\"}");
  return 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--probe")) return 0;
  if (argc >= 2 && !strcmp(argv[1], "--profile-root")) return profile_root_command(argc, argv);
  if (argc >= 2 && !strcmp(argv[1], "--profile-create")) return profile_create_command(argc, argv);
  require(argc == 1, "unsupported lease helper arguments");
  unsigned char magic[5]; input(magic, sizeof(magic)); require(!memcmp(magic, "WPLL4", 5), "invalid lease I/O protocol");
  unsigned operation = in8(); parent = (pid_t)in32(); allowed_reads = in32(); allowed_bytes = in64(); fence_wait_ms = in32(); require((fence_wait_ms == 0 || fence_wait_ms == 10000) && allowed_reads <= MAX_READS && allowed_bytes <= MAX_WORK, "invalid remaining lease work budget"); alive(); root_path = in_text(32768);
#ifdef __linux__
  require(prctl(PR_SET_PDEATHSIG, SIGKILL) == 0, "lease helper parent lifecycle protection unavailable"); alive();
#endif
  root_fd = open_root(root_path); require(fstat(root_fd, &root_identity) == 0 && root_identity.st_uid == getuid() && !(root_identity.st_mode & 0022), "unsafe lease root ownership");
  lock_fd = openat(root_fd, "mutable-home.lock", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (lock_fd < 0) require(errno == ENOENT, "unsafe lease lock");
  if (lock_fd >= 0) require(fstat(lock_fd, &lock_identity) == 0 && lock_identity.st_uid == getuid() && !(lock_identity.st_mode & 0022), "unsafe lease lock ownership");
  Entry *actual = calloc(MAX_ENTRIES, sizeof(Entry)); require(actual != NULL, "lease snapshot allocation failed");
  if (!operation) {
    if (lock_fd >= 0) fence(0);
    uint32_t count = entries(0, actual, 0); if (lock_fd >= 0) count += entries(1, actual, count); pinned();
    out8('S'); char value[32]; decimal((uint64_t)root_identity.st_dev, value); out_text(value); decimal((uint64_t)root_identity.st_ino, value); out_text(value);
    out8(lock_fd >= 0); if (lock_fd >= 0) { decimal((uint64_t)lock_identity.st_dev, value); out_text(value); decimal((uint64_t)lock_identity.st_ino, value); out_text(value); }
    out32(count); for (uint32_t i = 0; i < count; i++) { Entry *e = &actual[i]; out8(e->dir); out_text(e->name); out_text(e->dev); out_text(e->ino); out_text(e->stamp);
      out32(e->mode); out32(e->links); out32(e->uid); out_blob(e->raw, e->size); }
    out32(work_reads); out64(work_bytes); require(fflush(stdout) == 0, "lease snapshot output failed"); return 0;
  }
  require(operation >= 1 && operation <= 3 && lock_fd >= 0, "invalid lease publication operation");
  char *root_dev = in_text(20), *root_ino = in_text(20), *lock_dev = in_text(20), *lock_ino = in_text(20);
  expected_identity(&root_identity, root_dev, root_ino); expected_identity(&lock_identity, lock_dev, lock_ino);
  barrier_stage = in_text(64); barrier = in_text(32768);
  uint32_t guard_size; unsigned char *guard_raw = in_blob(4096, &guard_size); char *guard_temp = in_text(255);
  uint32_t count = in32(); require(count <= 16384, "lease snapshot entry limit exceeded");
  Entry *expected = calloc(count, sizeof(Entry)); require(expected != NULL || !count, "lease input allocation failed");
  uint64_t input_bytes = 0;
  for (uint32_t i = 0; i < count; i++) { Entry *e = &expected[i]; e->dir = in8(); e->optional = in8(); require(e->optional <= 1, "invalid optional mirror flag"); e->name = in_text(255); e->dev = in_text(20); e->ino = in_text(20);
    e->stamp = in_text(160); e->mode = in32(); e->links = in32(); e->uid = in32(); e->raw = in_blob(MAX_FILE, &e->size);
    require(e->dir < 2 && valid_name(e->name) && (input_bytes += e->size) <= MAX_BYTES, "invalid lease snapshot input"); }
  uint32_t tip_index = in32(); require(tip_index < count, "invalid acquired lease reference"); Entry *tip = &expected[tip_index];
  char *future = in_text(255); require(valid_name(future) && !strncmp(future, "next-", 5), "invalid lease successor name");
  uint32_t jobs_count = in32(); require(jobs_count <= 4, "lease transaction job limit exceeded"); Job jobs[4]; memset(jobs, 0, sizeof(jobs));
  for (uint32_t i = 0; i < jobs_count; i++) { Job *j = &jobs[i]; j->name = in_text(255); require(operation == 1 ? (!*j->name || slot(j->name)) : valid_name(j->name), "invalid checkpoint slot");
    j->raw = in_blob(MAX_FILE, &j->size); input_bytes += j->size; require(input_bytes <= MAX_BYTES, "lease transaction byte limit exceeded");
    j->copies_owner = in8(); require(j->copies_owner <= 1, "invalid checkpoint authority"); j->count = in32(); require(j->count <= MAX_ENTRIES, "lease retirement limit exceeded");
    if (operation == 1 && j->copies_owner && j->size) actor_pid(j->raw, j->size);
    j->retire = calloc(j->count, sizeof(uint32_t)); require(j->retire != NULL || !j->count, "lease manifest allocation failed");
    for (uint32_t k = 0; k < j->count; k++) { j->retire[k] = in32(); require(j->retire[k] < count, "invalid retirement reference");
      Entry *e = &expected[j->retire[k]]; require(retirement_name(e->dir, e->name) && strcmp(e->name, future), "unsafe retirement path"); }
  }
  require(fgetc(stdin) == EOF, "extra lease I/O input");
  if (operation == 1) actor_pid(tip->raw, tip->size);
  if (operation == 2) { require(jobs_count == 1 && !strncmp(jobs[0].name, "next-", 5) && !strcmp(jobs[0].name, future) && !jobs[0].count && jobs[0].size <= 4096, "invalid canonical successor publication"); actor_pid(jobs[0].raw, jobs[0].size); }
  if (operation == 3) require(jobs_count == 1 && !jobs[0].count &&
    (tip->dir == 0 ? (!strcmp(jobs[0].name, tip->name) || !strcmp(jobs[0].name, "checkpoint.json") || !strncmp(jobs[0].name, "lease-", 6)) :
      !strcmp(jobs[0].name, tip->name) && !strncmp(tip->name, "next-", 5)), "invalid canonical mirror publication");
  struct stat guard_stat; int new_guard = fstatat(lock_fd, GUARD, &guard_stat, AT_SYMLINK_NOFOLLOW) != 0;
  if (new_guard) {
    coherent_filesystem();
    require(operation == 1, "canonical writer requires its existing permanent fence");
    require(errno == ENOENT && guard_size > 0 && valid_name(guard_temp) && !strncmp(guard_temp, ".provider-home-lease-", 21), "invalid format guard publication");
    boundary("before-guard"); write_new(0, guard_temp, guard_raw, guard_size, 1);
    pinned(); require(linkat(root_fd, guard_temp, lock_fd, GUARD, 0) == 0, "permanent format fence changed during creation");
    boundary("guard-published"); sync_fd(lock_fd); sync_fd(root_fd);
    require(unlinkat(root_fd, guard_temp, 0) == 0, "format staging cleanup failed"); sync_fd(root_fd);
  }
  fence(1); if (new_guard) boundary("guard-durable");
  Entry guard = read_entry(1, GUARD); require(guard.size == guard_size && !memcmp(guard.raw, guard_raw, guard_size), "permanent format guard changed"); free_entry(&guard);
  uint32_t actual_count = entries(0, actual, 0); actual_count += entries(1, actual, actual_count);
  Entry **sorted = calloc(count, sizeof(Entry *)); unsigned char *seen = calloc(count, 1);
  require((sorted && seen) || !count, "lease index allocation failed");
  for (uint32_t i = 0; i < count; i++) sorted[i] = &expected[i];
  qsort(sorted, count, sizeof(Entry *), compare_pointer);
  for (uint32_t i = 1; i < count; i++) require(compare_pointer(&sorted[i-1], &sorted[i]) != 0, "duplicate lease snapshot preimage");
  for (uint32_t i = 0; i < actual_count; i++) { Entry *e = &actual[i]; if (new_guard && e->dir == 1 && !strcmp(e->name, GUARD)) continue;
    Entry *wanted = find_expected(sorted, count, e); require(wanted && entry_equal(e, wanted), "lease snapshot changed before publication"); seen[(size_t)(wanted - expected)] = 1; }
  for (uint32_t i = 0; i < count; i++) require(seen[i] || expected[i].optional, "verified lease snapshot evidence disappeared");
  anchor_fd = openat(root_fd, ANCHOR, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (anchor_fd < 0) {
    require(errno == ENOENT && (operation == 1 || operation == 3) && tip->dir == 1, "selected checkpoint unavailable");
    legacy_anchor_absent = 1;
  } else require(fstat(anchor_fd, &anchor_identity) == 0, "selected checkpoint unavailable");
  if (operation == 3) {
    require(tip->dir == 0 || legacy_anchor_absent, "reverse mirror requires an unselected legacy journal");
    verify_entry(tip, 0); pinned();
    unsigned target = 1 - tip->dir;
    if (linkat(directory(tip->dir), tip->name, directory(target), jobs[0].name, 0) != 0) { require(errno == EEXIST, "canonical mirror publication failed"); Entry mirror = read_entry(target, jobs[0].name);
      require(mirror.size == tip->size && !memcmp(mirror.raw, tip->raw, tip->size) &&
        (tip->dir == 0 || (!strcmp(mirror.dev, tip->dev) && !strcmp(mirror.ino, tip->ino))), "canonical mirror conflicts with immutable source"); free_entry(&mirror); }
    sync_fd(directory(target)); out8('D'); out32(work_reads); out64(work_bytes); fflush(stdout); return 0;
  }
  int copied = 0; owned(tip, future, copied);
  if (operation == 2) {
    write_new(0, guard_temp, jobs[0].raw, jobs[0].size, 0); owned(tip, future, 0);
    pinned(); require(linkat(root_fd, guard_temp, root_fd, jobs[0].name, 0) == 0, "canonical successor changed during publication");
    sync_fd(root_fd); require(unlinkat(root_fd, guard_temp, 0) == 0, "successor staging cleanup failed"); sync_fd(root_fd);
    out8('D'); out32(work_reads); out64(work_bytes); fflush(stdout); return 0;
  }
  for (uint32_t i = 0; i < jobs_count; i++) { Job *j = &jobs[i];
    if (*j->name) {
      struct stat info; int exists = fstatat(root_fd, j->name, &info, AT_SYMLINK_NOFOLLOW) == 0;
      if (exists) { Entry candidate = read_entry(0, j->name); require(candidate.size == j->size && !memcmp(candidate.raw, j->raw, j->size), "completed checkpoint candidate changed"); free_entry(&candidate); }
      else { require(errno == ENOENT, "unsafe checkpoint candidate"); boundary("before-candidate"); write_new(0, j->name, j->raw, j->size, 0); boundary("candidate-durable"); }
      owned(tip, future, copied); select_checkpoint(j->name); if (j->copies_owner) copied = 1;
    }
    for (uint32_t k = 0; k < j->count; k++) { Entry *e = &expected[j->retire[k]]; struct stat info;
      if (fstatat(directory(e->dir), e->name, &info, AT_SYMLINK_NOFOLLOW) != 0) { require(errno == ENOENT, "retirement evidence unavailable"); continue; }
      require(copied || strcmp(e->name, tip->name) || e->dir != tip->dir, "cannot retire the acquired active tip before selecting its checkpoint");
      owned(tip, future, copied); boundary("before-retire"); owned(tip, future, copied); verify_entry(e, 0);
      require(unlinkat(directory(e->dir), e->name, 0) == 0, "checkpoint evidence retirement failed"); sync_fd(directory(e->dir)); boundary("after-retire");
    }
    boundary("retirement-durable");
  }
  out8('D'); out32(work_reads); out64(work_bytes); fflush(stdout); return 0;
}
