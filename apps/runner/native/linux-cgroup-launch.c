#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/statfs.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#include <unistd.h>

/* Private startup journal IPC. Acquire the kernel handle before checking identity: even an
 * exit/PID reuse between inspection and signalling can then affect only the old handle. */
static int process_identity(long pid, unsigned long long *started, uid_t *uid) {
  char path[64], bytes[4096];
  if (snprintf(path, sizeof(path), "/proc/%ld/stat", pid) >= (int)sizeof(path)) return -1;
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return errno == ENOENT || errno == ESRCH ? 0 : -1;
  struct stat stat;
  ssize_t length = read(fd, bytes, sizeof(bytes) - 1);
  int okay = !fstat(fd, &stat);
  close(fd);
  if (!okay || length <= 0) return -1;
  bytes[length] = 0;
  char *tail = strrchr(bytes, ')');
  if (!tail || tail[1] != ' ') return -1;
  char *save = NULL, *part = strtok_r(tail + 2, " ", &save);
  for (unsigned field = 3; field < 22 && part; field++) part = strtok_r(NULL, " ", &save);
  if (!part) return -1;
  char *end = NULL;
  errno = 0;
  *started = strtoull(part, &end, 10);
  if (errno || !*started || !end || (*end && *end != '\n')) return -1;
  if (snprintf(path, sizeof(path), "/proc/%ld/status", pid) >= (int)sizeof(path)) return -1;
  FILE *status = fopen(path, "re");
  if (!status) return errno == ENOENT || errno == ESRCH ? 0 : -1;
  unsigned long real, effective;
  int found = 0;
  while (fgets(bytes, sizeof(bytes), status)) {
    if (sscanf(bytes, "Uid: %lu %lu", &real, &effective) != 2) continue;
    if (real == effective && (unsigned long)(uid_t)real == real) { *uid = (uid_t)real; found = 1; }
    break;
  }
  fclose(status);
  if (!found) return -1;
  return 1;
}

static int retire_process(void) {
  char boot[38], current[38], extra;
  long pid, runner;
  unsigned long uid;
  unsigned long long started, runner_started, observed;
  if (scanf("%37s %ld %llu %lu %ld %llu %c", boot, &pid, &started, &uid, &runner, &runner_started, &extra) != 6 ||
      pid <= 1 || pid > INT_MAX || runner <= 1 || runner > INT_MAX || pid == getpid() || pid == getppid() ||
      uid != getuid() || getuid() != geteuid() || !started || !runner_started) return 3;
  int handle = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
  if (handle < 0) return errno == ESRCH ? 4 : 3;
  FILE *file = fopen("/proc/sys/kernel/random/boot_id", "re");
  int valid_boot = file && fgets(current, sizeof(current), file);
  if (file) fclose(file);
  if (!valid_boot) { close(handle); return 3; }
  current[strcspn(current, "\n")] = 0;
  if (strcmp(boot, current)) { close(handle); return 4; }
  uid_t owner;
  int state = process_identity(runner, &observed, &owner);
  if (state < 0 || (state == 1 && observed == runner_started)) { close(handle); return 3; }
  state = process_identity(pid, &observed, &owner);
  if (state == 0 || (state == 1 && observed != started)) { close(handle); return 4; }
  if (state < 0 || owner != (uid_t)uid) { close(handle); return 3; }
  if (syscall(SYS_pidfd_send_signal, handle, SIGTERM, NULL, 0) && errno != ESRCH) { close(handle); return 3; }
  (void)syscall(SYS_pidfd_send_signal, handle, SIGCONT, NULL, 0);
  struct pollfd exited = { .fd = handle, .events = POLLIN };
  int done = poll(&exited, 1, 500);
  if (done == 0) {
    if (syscall(SYS_pidfd_send_signal, handle, SIGKILL, NULL, 0) && errno != ESRCH) { close(handle); return 3; }
    done = poll(&exited, 1, 2000);
  }
  close(handle);
  return done > 0 && (exited.revents & POLLIN) ? 0 : 3;
}

/* PID reuse between the cgroup listing and pidfd_open cannot authorize an unrelated signal:
 * membership is checked AFTER opening the pidfd. A PID recycled after that check leaves a dead
 * pidfd, never a handle to its replacement. Deliberate same-user migration is outside this
 * lifecycle boundary's contract. No process environment or global process listing is read. */
static int belongs_to_boundary(long pid, const char *boundary) {
  char path[64], line[8192];
  if (snprintf(path, sizeof(path), "/proc/%ld/cgroup", pid) >= (int)sizeof(path)) return 0;
  FILE *file = fopen(path, "re");
  if (!file) return 0;
  int belongs = 0;
  while (fgets(line, sizeof(line), file)) {
    if (strncmp(line, "0::", 3)) continue;
    line[strcspn(line, "\n")] = 0;
    size_t length = strlen(boundary);
    belongs = !strncmp(line + 3, boundary, length) &&
      (line[3 + length] == 0 || line[3 + length] == '/');
    break;
  }
  fclose(file);
  return belongs;
}

/* Startup has a stronger contract than live shutdown: no cgroup.kill, and no signal to a
 * member until its pidfd, boot, UID, start time and recorded containment are all proven.
 * cgroup v2 forbids renaming, so the pinned inode remains the recorded lifecycle boundary.
 * Deliberate same-user migration is outside that boundary's lifecycle contract. */
static int prior_owner_dead(const char *boot, long runner, unsigned long long runner_started) {
  char current[38];
  FILE *file = fopen("/proc/sys/kernel/random/boot_id", "re");
  int valid = file && fgets(current, sizeof(current), file);
  if (file) fclose(file);
  if (!valid) return 0;
  current[strcspn(current, "\n")] = 0;
  if (strcmp(boot, current)) return 0;
  unsigned long long observed;
  uid_t owner;
  int state = process_identity(runner, &observed, &owner);
  return state == 0 || (state == 1 && observed != runner_started);
}

static int retire_members(int directory, const char *boundary, const char *boot,
    long runner, unsigned long long runner_started, unsigned depth, unsigned *budget) {
  if (depth > 32 || !*budget) return -1;
  --*budget;
  int procs = openat(directory, "cgroup.procs", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (procs < 0) return -1;
  FILE *file = fdopen(procs, "r");
  if (!file) { close(procs); return -1; }
  long pid;
  unsigned count = 0;
  int result = 0;
  while (fscanf(file, "%ld", &pid) == 1) {
    if (++count > 32768 || pid <= 1 || pid > INT_MAX || pid == getpid() || pid == getppid()) { result = -1; break; }
    int handle = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
    if (handle < 0) { if (errno != ESRCH) result = -1; continue; }
    unsigned long long before, after;
    uid_t owner, after_owner;
    int state = process_identity(pid, &before, &owner);
    if (state == 1 && owner == getuid() && belongs_to_boundary(pid, boundary) &&
        prior_owner_dead(boot, runner, runner_started) &&
        process_identity(pid, &after, &after_owner) == 1 && before == after && owner == after_owner) {
      if (syscall(SYS_pidfd_send_signal, handle, SIGKILL, NULL, 0) && errno != ESRCH) result = -1;
    } else if (state != 0) result = -1;
    close(handle);
  }
  if (ferror(file)) result = -1;
  fclose(file);
  int copy = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (copy < 0) return -1;
  DIR *children = fdopendir(copy);
  if (!children) { close(copy); return -1; }
  struct dirent *entry;
  while ((entry = readdir(children))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat stat;
    if (fstatat(directory, entry->d_name, &stat, AT_SYMLINK_NOFOLLOW)) { result = -1; continue; }
    if (!S_ISDIR(stat.st_mode)) continue;
    int child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (child < 0) { result = -1; continue; }
    if (retire_members(child, boundary, boot, runner, runner_started, depth + 1, budget)) result = -1;
    close(child);
  }
  closedir(children);
  return result;
}

static int retire_boundary(void) {
  char boot[38], boundary[4096], extra;
  long pid, runner;
  unsigned long uid;
  unsigned long long started, runner_started, inode;
  if (scanf("%37s %ld %llu %lu %ld %llu %llu\n", boot, &pid, &started, &uid, &runner, &runner_started, &inode) != 7 ||
      !fgets(boundary, sizeof(boundary), stdin) || scanf(" %c", &extra) == 1 ||
      uid != getuid() || getuid() != geteuid() || runner <= 1 || runner > INT_MAX ||
      runner == getpid() || runner == getppid() || pid <= 1 || pid > INT_MAX ||
      pid == getpid() || pid == getppid() || !started || !runner_started) return 3;
  boundary[strcspn(boundary, "\n")] = 0;
  if (boundary[0] != '/' || strstr(boundary, "/../") || belongs_to_boundary(getppid(), boundary)) return 3;
  struct stat stat;
  if (fstat(3, &stat) || (unsigned long long)stat.st_ino != inode || !stat.st_nlink ||
      stat.st_uid != (uid_t)uid || !prior_owner_dead(boot, runner, runner_started)) return 3;
  // Stop the recorded launcher as well: a crash can precede its join-before-exec ack.
  // An empty leaf cannot prove that this still-unjoined launcher will never enter it.
  int root = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
  if (root < 0 && errno != ESRCH) return 3;
  if (root >= 0) {
    unsigned long long observed;
    uid_t owner;
    int state = process_identity(pid, &observed, &owner);
    if (state < 0 || (state == 1 && observed == started && owner != (uid_t)uid)) { close(root); return 3; }
    if (state == 1 && observed == started) {
      if (!prior_owner_dead(boot, runner, runner_started) ||
          (syscall(SYS_pidfd_send_signal, root, SIGKILL, NULL, 0) && errno != ESRCH)) { close(root); return 3; }
      struct pollfd exited = { .fd = root, .events = POLLIN };
      if (poll(&exited, 1, 2000) <= 0 || !(exited.revents & POLLIN)) { close(root); return 3; }
    }
    close(root);
  }
  // A bounded traversal is repeated to catch forks made before their proven parents exit.
  // Completion requires recursive kernel emptiness; no empty listing is sufficient.
  for (unsigned round = 0; round < 200; round++) {
    unsigned budget = 512;
    if (retire_members(3, boundary, boot, runner, runner_started, 0, &budget)) return 3;
    int events = openat(3, "cgroup.events", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (events < 0) return 3;
    char bytes[4096];
    ssize_t length = read(events, bytes, sizeof(bytes) - 1);
    close(events);
    if (length <= 0) return 3;
    bytes[length] = 0;
    if ((!strncmp(bytes, "populated 0\n", 12) || strstr(bytes, "\npopulated 0\n")) &&
        !fstat(3, &stat) && stat.st_nlink && (unsigned long long)stat.st_ino == inode &&
        prior_owner_dead(boot, runner, runner_started)) return 0;
    usleep(20000);
  }
  return 3;
}

static int term_members(int directory, const char *boundary, unsigned depth, unsigned *budget) {
  if (depth > 32 || !*budget) return -1;
  --*budget;
  int procs = openat(directory, "cgroup.procs", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (procs < 0) return -1;
  FILE *file = fdopen(procs, "r");
  if (!file) { close(procs); return -1; }
  long pid;
  unsigned processes = 0;
  int result = 0;
  while (fscanf(file, "%ld", &pid) == 1) {
    if (++processes > 32768) { result = -1; break; }
    if (pid <= 1 || pid > INT_MAX) continue;
    int handle = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
    if (handle < 0) { if (errno != ESRCH) result = -1; continue; }
    if (belongs_to_boundary(pid, boundary)) {
      if (syscall(SYS_pidfd_send_signal, handle, SIGTERM, NULL, 0) && errno != ESRCH) result = -1;
      (void)syscall(SYS_pidfd_send_signal, handle, SIGCONT, NULL, 0);
    }
    close(handle);
  }
  fclose(file);
  int copy = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (copy < 0) return -1;
  DIR *children = fdopendir(copy);
  if (!children) { close(copy); return -1; }
  struct dirent *entry;
  while ((entry = readdir(children))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") || entry->d_type != DT_DIR) continue;
    int child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (child < 0) { if (errno != ENOENT) result = -1; continue; }
    if (term_members(child, boundary, depth + 1, budget)) result = -1;
    close(child);
  }
  closedir(children);
  return result;
}

/* fd 3 is an already-open cgroup directory. Normal launch uses private admission fd 4 and an
 * exec-error fd 5 closed by the kernel on successful exec. Infrastructure modes never exec. */
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--retire-process")) return retire_process();
  if (argc < 2) return 125;
  struct statfs fs;
  if (fstatfs(3, &fs) || fs.f_type != 0x63677270) goto refused;
  if (argc == 2 && !strcmp(argv[1], "--retire-boundary")) return retire_boundary();
  if (argc == 2 && !strcmp(argv[1], "--delegation-probe")) {
    char marker[2];
    return fgetxattr(3, "user.delegate", marker, sizeof(marker)) == 1 && marker[0] == '1' ? 0 : 3;
  }
  if (argc == 3 && !strcmp(argv[1], "--term")) {
    if (argv[2][0] != '/' || strstr(argv[2], "/../")) return 125;
    unsigned budget = 512;
    return term_members(3, argv[2], 0, &budget) ? 3 : 0;
  }
  if (argc < 3 || strcmp(argv[1], "--exec")) goto refused;
  int flags = fcntl(5, F_GETFD);
  if (flags < 0 || fcntl(5, F_SETFD, flags | FD_CLOEXEC)) goto refused;
  int procs = openat(3, "cgroup.procs", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (procs < 0) goto refused;
  ssize_t result;
  do { result = write(procs, "0", 1); } while (result < 0 && errno == EINTR);
  close(procs);
  if (result != 1) goto refused;
  close(3);
  do { result = write(4, "1", 1); } while (result < 0 && errno == EINTR);
  close(4);
  if (result != 1) return 125;
  execvp(argv[2], &argv[2]);
  int error = errno;
  unsigned char message[4] = { error & 255, (error >> 8) & 255, (error >> 16) & 255, (error >> 24) & 255 };
  do { result = write(5, message, sizeof(message)); } while (result < 0 && errno == EINTR);
  close(5);
  fprintf(stderr, "[runner] contained provider exec failed: %s\n", strerror(error));
  return error == ENOENT ? 127 : 126;
refused:
  fputs("[runner] provider cgroup admission failed; provider was not executed\n", stderr);
  return 125;
}
