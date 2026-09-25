/* Fixed Linux helper for guarded skill adoption. Node has no rename that refuses to replace its
 * destination, so the runner passes the two directories it already holds as descriptors 3 and 4
 * and this helper makes exactly one system call:
 *
 *   renameat2(3, <from>, 4, <to>, RENAME_NOREPLACE)
 *
 * Both endpoints stay anchored to the runner's pinned descriptors, and an entry that appears at the
 * destination is never replaced. A kernel or filesystem without RENAME_NOREPLACE fails the call,
 * so nothing moves. Exit status: 0 renamed, 1 not renamed, 2 invalid arguments. */
#define _GNU_SOURCE
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_renameat2
#error "linux-skill-rename requires the Linux renameat2 system call number"
#endif
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

/* A single entry name inside the held directory; never a path. */
static int valid_name(const char *name) {
  size_t length = strlen(name);
  return length > 0 && length < 256 && strcmp(name, ".") && strcmp(name, "..") && !strchr(name, '/');
}

int main(int argc, char **argv) {
  if (argc != 3 || !valid_name(argv[1]) || !valid_name(argv[2])) return 2;
  return syscall(SYS_renameat2, 3, argv[1], 4, argv[2], RENAME_NOREPLACE) == 0 ? 0 : 1;
}
