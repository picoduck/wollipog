#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Bounded inert provider. Its child changes only the requested POSIX boundary shape. */
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  alarm(30);
  pid_t child = fork();
  if (child < 0) return 3;
  if (child == 0) {
    alarm(30);
    if (!strcmp(argv[1], "group") && setpgid(0, 0)) return 4;
    if (!strcmp(argv[1], "session") && setsid() < 0) return 5;
    char *pending;
    if (asprintf(&pending, "%s.pending", argv[2]) < 0) return 6;
    FILE *file = fopen(pending, "wx");
    if (!file) return 7;
    if (fprintf(file, "{\"pid\":%ld,\"pgid\":%ld,\"sid\":%ld}", (long)getpid(), (long)getpgrp(), (long)getsid(0)) < 0 ||
        fclose(file) || rename(pending, argv[2])) return 8;
    free(pending);
  }
  close(0); close(1); close(2);
  for (;;) pause();
}
