#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <unistd.h>

/* Deliberately lose both observational ownership sources before the runner can poll. */
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  pid_t child = fork();
  if (child < 0) return 3;
  if (child > 0) return 0;
  if (setsid() < 0) _exit(4);
  child = fork();
  if (child < 0) _exit(5);
  if (child > 0) _exit(0);
  if (clearenv()) _exit(6);
  if (!strcmp(argv[1], "nondumpable") &&
      (prctl(PR_SET_DUMPABLE, 0) || prctl(PR_GET_DUMPABLE) != 0)) _exit(7);
  int fd = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) _exit(8);
  if (dprintf(fd, "%ld\n", (long)getpid()) < 0) _exit(9);
  close(fd);
  close(0); close(1); close(2);
  for (;;) pause();
}
