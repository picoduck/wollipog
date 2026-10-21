#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#include <unistd.h>

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
  if (argc < 2) return 125;
  struct statfs fs;
  if (fstatfs(3, &fs) || fs.f_type != 0x63677270) goto refused;
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
