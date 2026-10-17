// Run a command that cannot create symlinks, FIFOs, sockets or device nodes except beneath the
// directories named with --allow (#3316).
//
// A protected launch binds one directory writable whose regular file host Git later opens and
// rewrites by following its name. A special file planted there would redirect that host write, so
// the sandbox may create only regular files and directories in it. Landlock grants rights beneath a
// hierarchy and cannot carve a subtree out of a granted one, so the runner passes every other
// writable root as --allow and omits that directory. Read-only mounts need no rule.
//
// Any Landlock ruleset also denies renaming or hard-linking a file into another directory unless
// LANDLOCK_ACCESS_FS_REFER is granted there, so the allowed roots get REFER too. That needs ABI 2
// (Linux 5.19); on ABI 1 every cross-directory rename would fail, so the helper refuses instead.
//
// usage: landlock-special-files --probe DIR
//        landlock-special-files --allow DIR [--allow DIR ...] -- COMMAND [ARG ...]
//
// --probe proves enforcement on this kernel with a child restricted to DIR/allowed: a symlink and a
// cross-directory rename succeed there, and a symlink in DIR/denied is refused. DIR must be empty.
// Any failure exits 125 without running anything; COMMAND never runs unrestricted.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

// Kernel UAPI values, defined here so the static build does not depend on the host's headers.
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif
#define CREATE_RULESET_VERSION (1U << 0)
#define RULE_PATH_BENEATH 1
#define MAKE_CHAR (1ULL << 6)
#define MAKE_SOCK (1ULL << 9)
#define MAKE_FIFO (1ULL << 10)
#define MAKE_BLOCK (1ULL << 11)
#define MAKE_SYM (1ULL << 12)
#define REFER (1ULL << 13)
#define SPECIAL (MAKE_CHAR | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM)
#define HANDLED (SPECIAL | REFER)

struct ruleset_attr { uint64_t handled_access_fs; };
struct path_beneath_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));

static int refuse(const char *what, int error) {
  fprintf(stderr, "landlock-special-files: %s: %s\n", what, error ? strerror(error) : "refused");
  return 125;
}

static int create_ruleset(void) {
  struct ruleset_attr attr = { .handled_access_fs = HANDLED };
  return (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
}

static int allow(int ruleset, const char *directory) {
  int fd = open(directory, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct path_beneath_attr rule = { .allowed_access = HANDLED, .parent_fd = fd };
  int result = (int)syscall(__NR_landlock_add_rule, ruleset, RULE_PATH_BENEATH, &rule, 0);
  int saved = errno;
  close(fd);
  errno = saved;
  return result;
}

static int path(char *buffer, size_t size, const char *directory, const char *name) {
  return snprintf(buffer, size, "%s/%s", directory, name) < (int)size ? 0 : -1;
}

static int enforce(int ruleset) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return (int)syscall(__NR_landlock_restrict_self, ruleset, 0);
}

static int probe(const char *directory) {
  if (directory[0] != '/') return refuse("usage", 0);
  char allowed[4096], denied[4096], from[4096], to[4096], file[4096], link[4096], blocked[4096];
  if (path(allowed, sizeof allowed, directory, "allowed") || path(denied, sizeof denied, directory, "denied") ||
      path(from, sizeof from, allowed, "from") || path(to, sizeof to, allowed, "to") ||
      path(file, sizeof file, from, "file") || path(link, sizeof link, allowed, "link") ||
      path(blocked, sizeof blocked, denied, "link")) return refuse("usage", 0);
  int fd;
  if (mkdir(allowed, 0700) || mkdir(denied, 0700) || mkdir(from, 0700) || mkdir(to, 0700) ||
      (fd = open(file, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600)) < 0) return refuse("probe layout", errno);
  close(fd);
  pid_t child = fork();
  if (child < 0) return refuse("fork", errno);
  if (child == 0) {
    int ruleset = create_ruleset();
    if (ruleset < 0 || allow(ruleset, allowed) != 0 || enforce(ruleset) != 0) _exit(2);
    char moved[4096];
    if (path(moved, sizeof moved, to, "file") || rename(file, moved) != 0) _exit(3);
    if (symlink("target", link) != 0) _exit(4);
    if (symlink("target", blocked) == 0) _exit(5);
    _exit(errno == EACCES ? 0 : 6);
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child) return refuse("wait", errno);
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return refuse("ruleset is not enforced as required", 0);
  return 0;
}

int main(int argc, char **argv) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, CREATE_RULESET_VERSION);
  if (abi < 1) return refuse("Landlock is unavailable", errno);
  if (abi < 2) return refuse("Landlock ABI 2 is required for cross-directory renames", 0);
  if (argc == 3 && strcmp(argv[1], "--probe") == 0) return probe(argv[2]);
  if (argc < 4) return refuse("usage", 0);

  int ruleset = create_ruleset();
  if (ruleset < 0) return refuse("create ruleset", errno);
  int i = 1;
  for (; i < argc && strcmp(argv[i], "--") != 0; i += 2) {
    if (strcmp(argv[i], "--allow") != 0 || i + 1 >= argc || argv[i + 1][0] != '/') return refuse("usage", 0);
    if (allow(ruleset, argv[i + 1]) != 0) return refuse(argv[i + 1], errno);
  }
  if (i >= argc - 1) return refuse("usage", 0);
  if (enforce(ruleset) != 0) return refuse("restrict", errno);
  close(ruleset);
  execvp(argv[i + 1], &argv[i + 1]);
  return refuse(argv[i + 1], errno);
}
