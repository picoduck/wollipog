/* Fixed lease-only I/O transaction. JSON and ownership transitions are verified by the runner;
 * this helper pins no-follow ancestry, fences publishers, and compares the exact verified bytes
 * before publishing or retiring anything. Binary input/output is bounded independently here. */
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
#elif defined(__APPLE__)
#include <sys/mount.h>
#endif

#define MAX_ENTRIES 8192U
#define MAX_BYTES (64U * 1024U * 1024U)
#define MAX_FILE (2U * 1024U * 1024U)
#define MAX_WORK (256U * 1024U * 1024U)
#define MAX_READS 131072U
#define GUARD "protocol-v4.json"
#define ANCHOR "mutable-home.recovery.json"

typedef struct { unsigned dir; char *name; char *dev; char *ino; char *stamp;
  unsigned mode, links, uid; uint32_t size; unsigned char *raw; unsigned optional; } Entry;
typedef struct { char *name; unsigned char *raw; uint32_t size; unsigned copies_owner;
  uint32_t *retire; uint32_t count; } Job;
static uint64_t work_bytes;
static uint32_t work_reads, allowed_reads;
static uint64_t allowed_bytes;
static pid_t parent;
static int root_fd = -1, lock_fd = -1, guard_fd = -1, anchor_fd = -1;
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
static Entry read_entry(unsigned dir, const char *name) {
  require(valid_name(name), "invalid lease entry name"); alive();
  int fd = openat(directory(dir), name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  require(fd >= 0, "lease record unavailable or linked"); struct stat before, after, named;
  require(fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_size >= 0 && before.st_size <= MAX_FILE &&
    before.st_nlink >= 1 && before.st_nlink <= 3 && before.st_uid == getuid() && !(before.st_mode & 0022), "unsafe lease record");
  require(before.st_size <= 4096 || (!dir && (slot(name) || !strcmp(name, ANCHOR) || !strcmp(name, ".mutable-home.retired"))), "ordinary lease record byte limit exceeded");
  require(fstatat(directory(dir), name, &named, AT_SYMLINK_NOFOLLOW) == 0 && same_identity(&before, &named), "lease record identity changed");
  require(++work_reads <= allowed_reads && (work_bytes += (uint64_t)before.st_size) <= allowed_bytes, "lease verification work limit exceeded");
  uint32_t size = (uint32_t)before.st_size; unsigned char *raw = calloc((size_t)size + 1, 1); require(raw != NULL, "lease read allocation failed");
  uint32_t offset = 0; while (offset < size) { ssize_t n = read(fd, raw + offset, size - offset); require(n > 0, "lease record changed during read"); offset += (uint32_t)n; }
  unsigned char extra; require(read(fd, &extra, 1) == 0 && fstat(fd, &after) == 0 && same_stamp(&before, &after), "lease record changed during read");
  require(fstatat(directory(dir), name, &named, AT_SYMLINK_NOFOLLOW) == 0 && same_stamp(&before, &named), "lease record pathname changed");
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
    require(++raw_count <= 4096 && offset + count < MAX_ENTRIES, "lease directory scan limit exceeded");
    if (!dir && !strcmp(item->d_name, "mutable-home.lock")) continue;
    values[offset + count++] = read_entry(dir, item->d_name); errno = 0;
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
  if (flock(guard_fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB) != 0) fail(2, "provider HOME already in use: checkpoint publication is in progress; retry");
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
  return a->dir == b->dir && !strcmp(a->name, b->name) && !strcmp(a->dev, b->dev) && !strcmp(a->ino, b->ino) &&
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
  if (!copied) verify_entry(tip, 0);
}
static void select_checkpoint(const char *name) {
  pinned(); int fd = openat(root_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); require(fd >= 0, "checkpoint candidate unavailable");
  sync_fd(fd); close(fd); sync_fd(root_fd); boundary("before-selection");
  require(renameat(root_fd, name, root_fd, ANCHOR) == 0, "checkpoint selection failed");
  if (anchor_fd >= 0) close(anchor_fd);
  anchor_fd = openat(root_fd, ANCHOR, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  require(anchor_fd >= 0 && fstat(anchor_fd, &anchor_identity) == 0, "selected checkpoint unavailable");
  boundary("selection-published"); sync_fd(root_fd); boundary("selection-durable");
}
int main(void) {
  unsigned char magic[5]; input(magic, sizeof(magic)); require(!memcmp(magic, "WPLL4", 5), "invalid lease I/O protocol");
  unsigned operation = in8(); parent = (pid_t)in32(); allowed_reads = in32(); allowed_bytes = in64(); require(allowed_reads <= MAX_READS && allowed_bytes <= MAX_WORK, "invalid remaining lease work budget"); alive(); root_path = in_text(32768);
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
  if (operation == 3) require(jobs_count == 1 && !jobs[0].count && tip->dir == 0 &&
    (!strcmp(jobs[0].name, tip->name) || !strcmp(jobs[0].name, "checkpoint.json") || !strncmp(jobs[0].name, "lease-", 6)), "invalid canonical mirror publication");
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
  require(anchor_fd >= 0 && fstat(anchor_fd, &anchor_identity) == 0, "selected checkpoint unavailable");
  if (operation == 3) {
    verify_entry(tip, 0); pinned();
    if (linkat(root_fd, tip->name, lock_fd, jobs[0].name, 0) != 0) { require(errno == EEXIST, "canonical mirror publication failed"); Entry mirror = read_entry(1, jobs[0].name);
      require(mirror.size == tip->size && !memcmp(mirror.raw, tip->raw, tip->size), "canonical mirror conflicts with immutable source"); free_entry(&mirror); }
    sync_fd(lock_fd); out8('D'); out32(work_reads); out64(work_bytes); fflush(stdout); return 0;
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
