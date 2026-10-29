#define _GNU_SOURCE
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <unistd.h>

/* A test-owned sibling of both runners, outside their provider boundaries. Record signals
 * without exiting so the assertion detects attempted cleanup as well as successful kills. */
static int signals_fd = -1;
static void observed(int number) {
  unsigned char value = (unsigned char)number;
  if (write(signals_fd, &value, 1) != 1) _exit(4);
}

int main(int argc, char **argv) {
  if (argc != 3 || prctl(PR_SET_DUMPABLE, 0) || prctl(PR_GET_DUMPABLE) != 0) return 2;
  signals_fd = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_APPEND, 0600);
  if (signals_fd < 0) return 3;
  const int watched[] = { SIGTERM, SIGHUP, SIGINT, SIGQUIT, SIGUSR1, SIGUSR2, SIGPIPE, SIGALRM, SIGCONT };
  for (unsigned i = 0; i < sizeof(watched) / sizeof(watched[0]); i++) {
    if (signal(watched[i], observed) == SIG_ERR) return 5;
  }
  int ready = open(argv[1], O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (ready < 0 || dprintf(ready, "%ld\n", (long)getpid()) < 0) return 6;
  close(ready);
  for (;;) pause();
}
