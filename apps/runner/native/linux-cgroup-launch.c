#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/statfs.h>
#include <unistd.h>

/* fd 3 is the runner's already-open cgroup directory, fd 4 its admission pipe.
 * No provider code (including shell startup) runs before migration succeeds. */
int main(int argc, char **argv) {
  if (argc < 2) return 125;
  struct statfs fs;
  if (fstatfs(3, &fs) || fs.f_type != 0x63677270) goto refused;
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
  execvp(argv[1], &argv[1]);
  int code = errno == ENOENT ? 127 : 126;
  fprintf(stderr, "[runner] contained provider exec failed: %s\n", strerror(errno));
  return code;
refused:
  fputs("[runner] provider cgroup admission failed; provider was not executed\n", stderr);
  return 125;
}
