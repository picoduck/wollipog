#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <unistd.h>

static char *term_path;
static void terminated(int signum) {
  (void)signum;
  int fd = open(term_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd >= 0) { (void)write(fd, "term", 4); close(fd); }
  _exit(0);
}

/* Re-exec with an empty environment: clearenv alone does not clear /proc/pid/environ. */
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  if (!strncmp(argv[1], "--park", 6)) goto park;
  pid_t child = fork();
  if (child < 0) return 3;
  if (child > 0) return 0;
  if (setsid() < 0) _exit(4);
  child = fork();
  if (child < 0) _exit(5);
  if (child > 0) _exit(0);
  if (clearenv()) _exit(6);
  char *args[] = { argv[0], !strcmp(argv[1], "nondumpable") ? "--park-nondumpable" :
    !strcmp(argv[1], "term") ? "--park-term" : "--park", argv[2], NULL };
  char *empty[] = { NULL };
  execve(argv[0], args, empty);
  _exit(10);
park:
  if (!strcmp(argv[1], "--park-nondumpable") &&
      (prctl(PR_SET_DUMPABLE, 0) || prctl(PR_GET_DUMPABLE) != 0)) _exit(7);
  if (!strcmp(argv[1], "--park-term")) {
    if (asprintf(&term_path, "%s.term", argv[2]) < 0) _exit(11);
    if (signal(SIGTERM, terminated) == SIG_ERR) _exit(12);
  }
  int fd = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) _exit(8);
  if (dprintf(fd, "%ld\n", (long)getpid()) < 0) _exit(9);
  close(fd);
  close(0); close(1); close(2);
  for (;;) pause();
}
