#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef SYS_openat2
#error "wsl-bwrap-launcher requires a Linux openat2 syscall number"
#endif

#define MAX_BINDS 64
#define MAX_PATH_BYTES 4096

typedef struct {
  char text[96];
} Identity;

typedef struct {
  const char *source;
  const char *expected_source;
  const char *target;
  const char *expected_target;
  bool readonly;
  int source_fd;
} Bind;

static volatile sig_atomic_t child_group = -1;

static void fail(const char *message) {
  fprintf(stderr, "wsl-bwrap-launcher: %s\n", message);
  exit(125);
}

static void fail_path(const char *message, const char *path) {
  fprintf(stderr, "wsl-bwrap-launcher: %s: %s\n", message, path);
  exit(125);
}

static void require_path_shape(const char *path) {
  if (!path || path[0] != '/' || strlen(path) >= MAX_PATH_BYTES) fail("path must be a bounded absolute path");
  if (path[1] != '\0' && path[strlen(path) - 1] == '/') fail_path("path has a trailing separator", path);
  const char *p = path + 1;
  while (*p) {
    const char *end = strchr(p, '/');
    size_t length = end ? (size_t)(end - p) : strlen(p);
    if (length == 0 || (length == 1 && p[0] == '.') ||
        (length == 2 && p[0] == '.' && p[1] == '.')) {
      fail_path("path contains an empty or traversal component", path);
    }
    p = end ? end + 1 : p + length;
  }
}

static int open_component(int parent, const char *name, bool create) {
  struct open_how how = {
    .flags = O_PATH | O_DIRECTORY | O_CLOEXEC,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
  };
  int fd = (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
  if (fd >= 0 || !create || errno != ENOENT) return fd;
  if (mkdirat(parent, name, 0700) != 0 && errno != EEXIST) return -1;
  return (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
}

/** Resolve one absolute directory a component at a time. Every untrusted component is the final
 * component of an openat2 call, so neither it nor an ancestor can be a symlink. Mount crossings
 * intentionally remain permitted for WSL worktrees under /mnt. */
static int open_directory(const char *path, bool create) {
  require_path_shape(path);
  int current = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) fail("cannot open target root");
  if (strcmp(path, "/") == 0) return current;

  char *copy = strdup(path + 1);
  if (!copy) fail("out of memory");
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    int next = open_component(current, part, create);
    if (next < 0) {
      int saved = errno;
      close(current);
      free(copy);
      errno = saved;
      return -1;
    }
    close(current);
    current = next;
  }
  free(copy);
  return current;
}

static Identity identity_for_fd(int fd) {
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode)) fail("path identity is not a directory");
  uint64_t mount_id = 0;
#ifdef STATX_MNT_ID
  struct statx sx;
  memset(&sx, 0, sizeof(sx));
  if (statx(fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT, STATX_INO | STATX_TYPE | STATX_MNT_ID, &sx) == 0 &&
      (sx.stx_mask & STATX_MNT_ID) != 0) {
    mount_id = sx.stx_mnt_id;
  }
#endif
  Identity result;
  int written = snprintf(result.text, sizeof(result.text), "%" PRIxMAX ":%" PRIxMAX ":%" PRIx64,
    (uintmax_t)st.st_dev, (uintmax_t)st.st_ino, mount_id);
  if (written <= 0 || (size_t)written >= sizeof(result.text)) fail("path identity overflow");
  return result;
}

static void require_identity(int fd, const char *expected, const char *label) {
  Identity actual = identity_for_fd(fd);
  if (!expected || strcmp(actual.text, expected) != 0) {
    fprintf(stderr, "wsl-bwrap-launcher: %s identity changed (expected %s, got %s)\n",
      label, expected ? expected : "<missing>", actual.text);
    exit(125);
  }
}

static bool help_has_option(const char *output, const char *option) {
  size_t length = strlen(option);
  for (const char *found = output; (found = strstr(found, option)); found += length) {
    char before = found == output ? '\n' : found[-1];
    char after = found[length];
    if ((before == ' ' || before == '\t' || before == '\n') &&
        (after == '\0' || after == ' ' || after == '\t' || after == '\n')) return true;
  }
  return false;
}

static char *canonical_path(int fd) {
  char proc[64];
  if (snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd) >= (int)sizeof(proc)) fail("fd path overflow");
  char value[MAX_PATH_BYTES];
  ssize_t length = readlink(proc, value, sizeof(value) - 1);
  if (length <= 0 || length >= (ssize_t)sizeof(value) - 1) fail("cannot read canonical path");
  value[length] = '\0';
  if (value[0] != '/' || strstr(value, " (deleted)")) fail("canonical path is unavailable");
  return strdup(value);
}

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    switch (*p) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\b': fputs("\\b", stdout); break;
      case '\f': fputs("\\f", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*p < 0x20) printf("\\u%04x", *p);
        else putchar(*p);
    }
  }
  putchar('"');
}

static int open_attested_file(const char *path, bool executable, bool readable, const char *label) {
  require_path_shape(path);
  int parent = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (parent < 0) fail("cannot open target root");
  char *copy = strdup(path + 1);
  if (!copy) fail("out of memory");
  char *save = NULL;
  char *part = strtok_r(copy, "/", &save);
  if (!part) fail_path("path has no final component", path);
  for (;;) {
    char *next_part = strtok_r(NULL, "/", &save);
    struct open_how how = {
      .flags = (next_part || !readable ? O_PATH : O_RDONLY) | O_CLOEXEC | (next_part ? O_DIRECTORY : 0),
      .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
    };
    int next = (int)syscall(SYS_openat2, parent, part, &how, sizeof(how));
    if (next < 0) fail_path("cannot no-follow open attested file", path);
    struct stat st;
    if (fstat(next, &st) != 0 || st.st_uid != 0 || (st.st_mode & 0022) != 0 ||
        (next_part ? !S_ISDIR(st.st_mode) : (!S_ISREG(st.st_mode) || (executable && (st.st_mode & 0111) == 0)))) {
      fail_path(label, path);
    }
    close(parent);
    parent = next;
    if (!next_part) break;
    part = next_part;
  }
  free(copy);
  return parent;
}

static int open_attested_bwrap(const char *path) {
  return open_attested_file(path, true, false,
    "bwrap or one of its ancestors is not root-owned and non-writable");
}

static bool help_has_fd_contract(int bwrap_fd) {
  int pipefd[2];
  if (pipe2(pipefd, O_CLOEXEC) != 0) fail("cannot create bwrap probe pipe");
  pid_t pid = fork();
  if (pid < 0) fail("cannot fork bwrap probe");
  if (pid == 0) {
    if (dup2(pipefd[1], STDOUT_FILENO) < 0 || dup2(pipefd[1], STDERR_FILENO) < 0) _exit(127);
    close(pipefd[0]);
    close(pipefd[1]);
    char *const argv[] = { (char *)"bwrap", (char *)"--help", NULL };
    syscall(SYS_execveat, bwrap_fd, "", argv, environ, AT_EMPTY_PATH);
    _exit(127);
  }
  close(pipefd[1]);
  char output[65537], chunk[4096];
  size_t used = 0;
  bool overflow = false;
  for (;;) {
    ssize_t n = read(pipefd[0], chunk, sizeof(chunk));
    if (n == 0) break;
    if (n < 0) { if (errno == EINTR) continue; close(pipefd[0]); fail("cannot read bwrap probe output"); }
    size_t available = sizeof(output) - 1 - used;
    size_t retain = (size_t)n < available ? (size_t)n : available;
    if (retain > 0) { memcpy(output + used, chunk, retain); used += retain; }
    if (retain < (size_t)n) overflow = true;
  }
  close(pipefd[0]);
  output[used] = '\0';
  int status = 0;
  pid_t waited;
  do { waited = waitpid(pid, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited != pid) fail("cannot wait for bwrap probe");
  return !overflow && WIFEXITED(status) && WEXITSTATUS(status) == 0 &&
    help_has_option(output, "--bind-fd") && help_has_option(output, "--ro-bind-fd");
}

static void emit_path(int fd) {
  char *canonical = canonical_path(fd);
  Identity identity = identity_for_fd(fd);
  fputs("{\"path\":", stdout); json_string(canonical);
  fputs(",\"identity\":", stdout); json_string(identity.text); putchar('}');
  free(canonical);
}

static int prepare_main(int argc, char **argv) {
  const char *bwrap = NULL, *home = NULL, *cwd = NULL;
  Bind binds[MAX_BINDS];
  size_t bind_count = 0;
  const char *ensures[MAX_BINDS * 2];
  size_t ensure_count = 0;
  memset(binds, 0, sizeof(binds));
  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--bwrap") == 0) {
      if (bwrap || i + 1 >= argc) fail("invalid or duplicate --bwrap");
      bwrap = argv[++i];
    } else if (strcmp(argv[i], "--home") == 0) {
      if (home || i + 1 >= argc) fail("invalid or duplicate --home");
      home = argv[++i];
    } else if (strcmp(argv[i], "--cwd") == 0) {
      if (cwd || i + 1 >= argc) fail("invalid or duplicate --cwd");
      cwd = argv[++i];
    } else if (strcmp(argv[i], "--ensure") == 0) {
      if (i + 1 >= argc || ensure_count >= MAX_BINDS * 2) fail("invalid or excessive --ensure");
      ensures[ensure_count++] = argv[++i];
    } else if (strcmp(argv[i], "--rw") == 0 || strcmp(argv[i], "--ro") == 0) {
      if (i + 2 >= argc || bind_count >= MAX_BINDS) fail("invalid or excessive prepare bind");
      bool readonly = strcmp(argv[i], "--ro") == 0;
      binds[bind_count++] = (Bind){ .source = argv[++i], .target = argv[++i], .readonly = readonly, .source_fd = -1 };
    } else fail("invalid prepare arguments");
  }
  if (!bwrap || !home || !cwd) fail("prepare requires --bwrap, --home, and --cwd");
  int bwrap_fd = open_attested_bwrap(bwrap);
  if (!help_has_fd_contract(bwrap_fd)) fail("bwrap lacks the required fd bind contract");
  close(bwrap_fd);
  for (size_t i = 0; i < ensure_count; i++) {
    int fd = open_directory(ensures[i], true);
    if (fd < 0) fail_path("cannot securely create directory", ensures[i]);
    close(fd);
  }
  int home_fd = open_directory(home, false);
  int cwd_fd = open_directory(cwd, false);
  if (home_fd < 0) fail_path("cannot securely resolve HOME", home);
  if (cwd_fd < 0) fail_path("cannot securely resolve cwd", cwd);
  int source_fds[MAX_BINDS], target_fds[MAX_BINDS];
  for (size_t i = 0; i < bind_count; i++) {
    source_fds[i] = open_directory(binds[i].source, false);
    target_fds[i] = open_directory(binds[i].target, false);
    if (source_fds[i] < 0) fail_path("cannot securely resolve bind source", binds[i].source);
    if (target_fds[i] < 0) fail_path("cannot securely resolve bind target", binds[i].target);
  }
  fputs("{\"version\":1,\"cwd\":", stdout); emit_path(cwd_fd);
  fputs(",\"home\":", stdout); emit_path(home_fd);
  fputs(",\"binds\":[", stdout);
  for (size_t i = 0; i < bind_count; i++) {
    if (i) putchar(',');
    fputs("{\"mode\":", stdout); json_string(binds[i].readonly ? "ro" : "rw");
    fputs(",\"source\":", stdout); emit_path(source_fds[i]);
    fputs(",\"target\":", stdout); emit_path(target_fds[i]); putchar('}');
    close(source_fds[i]); close(target_fds[i]);
  }
  fputs("]}\n", stdout);
  close(home_fd); close(cwd_fd);
  return 0;
}

static void forward_signal(int signal_number) {
  pid_t group = (pid_t)child_group;
  if (group > 1) kill(-group, signal_number);
}

static char *fd_text(int fd) {
  char *value = malloc(24);
  if (!value) fail("out of memory");
  snprintf(value, 24, "%d", fd);
  return value;
}

static int write_pidfile(const char *path, pid_t pid, int *parent_fd_out, char **leaf_out) {
  require_path_shape(path);
  char *copy = strdup(path);
  if (!copy) fail("out of memory");
  char *slash = strrchr(copy, '/');
  if (!slash || !slash[1]) fail("pidfile requires a filename");
  char *leaf = strdup(slash + 1);
  if (!leaf) fail("out of memory");
  *slash = '\0';
  const char *parent_path = copy[0] ? copy : "/";
  int parent = open_directory(parent_path, false);
  if (parent < 0) fail_path("cannot resolve pidfile parent", parent_path);
  struct open_how how = {
    .flags = O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
    .mode = 0600,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
  };
  int fd = (int)syscall(SYS_openat2, parent, leaf, &how, sizeof(how));
  if (fd < 0) fail_path("cannot create exclusive pidfile", path);
  char value[32];
  int length = snprintf(value, sizeof(value), "%ld\n", (long)pid);
  if (write(fd, value, (size_t)length) != length || fsync(fd) != 0) fail("cannot publish pidfile");
  close(fd); free(copy);
  *parent_fd_out = parent; *leaf_out = leaf;
  return 0;
}

static bool ready_entry(int directory_fd, const char *name, mode_t type) {
  struct open_how how = {
    .flags = (type == S_IFREG ? O_RDONLY : O_PATH) | O_CLOEXEC | O_NOFOLLOW,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
  };
  int fd = (int)syscall(SYS_openat2, directory_fd, name, &how, sizeof(how));
  if (fd < 0) return false;
  struct stat st;
  bool valid = fstat(fd, &st) == 0 && (st.st_mode & S_IFMT) == type &&
    st.st_uid == geteuid() && (st.st_mode & 0077) == 0 &&
    (type != S_IFREG || st.st_nlink == 1);
  close(fd);
  return valid;
}

static int launch_main(int argc, char **argv) {
  const char *bwrap = NULL, *home = NULL, *home_id = NULL, *cwd = NULL, *cwd_id = NULL;
  const char *pidfile = NULL, *network = NULL;
  Bind binds[MAX_BINDS];
  size_t bind_count = 0;
  memset(binds, 0, sizeof(binds));
  int command_at = -1;
  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { command_at = i + 1; break; }
    if (strcmp(argv[i], "--bwrap") == 0) {
      if (bwrap || i + 1 >= argc) fail("invalid or duplicate --bwrap");
      bwrap = argv[++i];
    } else if (strcmp(argv[i], "--home") == 0) {
      if (home || i + 2 >= argc) fail("invalid or duplicate --home");
      home = argv[++i]; home_id = argv[++i];
    } else if (strcmp(argv[i], "--cwd") == 0) {
      if (cwd || i + 2 >= argc) fail("invalid or duplicate --cwd");
      cwd = argv[++i]; cwd_id = argv[++i];
    } else if (strcmp(argv[i], "--pidfile") == 0) {
      if (pidfile || i + 1 >= argc) fail("invalid or duplicate --pidfile");
      pidfile = argv[++i];
    } else if (strcmp(argv[i], "--network") == 0) {
      if (network || i + 1 >= argc) fail("invalid or duplicate --network");
      network = argv[++i];
    } else if (strcmp(argv[i], "--rw") == 0 || strcmp(argv[i], "--ro") == 0) {
      if (i + 4 >= argc || bind_count >= MAX_BINDS) fail("invalid or excessive launch bind");
      bool readonly = strcmp(argv[i], "--ro") == 0;
      binds[bind_count++] = (Bind){ .source = argv[++i], .expected_source = argv[++i],
        .target = argv[++i], .expected_target = argv[++i], .readonly = readonly, .source_fd = -1 };
    } else fail("invalid launch arguments");
  }
  if (!bwrap || !home || !home_id || !cwd || !cwd_id ||
      !pidfile || !network || command_at < 0 || command_at >= argc)
    fail("launch arguments are incomplete");
  if (strcmp(network, "inherit") != 0 && strcmp(network, "deny") != 0) fail("network must be inherit or deny");
  if (geteuid() == 0) fail("root execution is refused");

  pid_t initial_parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != initial_parent) fail("cannot bind launcher lifetime to WSL relay");
  int bwrap_fd = open_attested_bwrap(bwrap);
  if (!help_has_fd_contract(bwrap_fd)) fail("bwrap lacks the required fd bind contract");
  int home_fd = open_directory(home, false), cwd_fd = open_directory(cwd, false);
  if (home_fd < 0 || cwd_fd < 0) fail("cannot resolve HOME or cwd at launch");
  require_identity(home_fd, home_id, "HOME");
  require_identity(cwd_fd, cwd_id, "cwd");
  int inherited_cwd = open(".", O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (inherited_cwd < 0) fail("cannot inspect inherited cwd");
  require_identity(inherited_cwd, cwd_id, "outer WSL cwd");
  close(inherited_cwd);
  /* O_PATH fds cannot carry flock(2). Reopen the already-pinned directory itself for reading;
   * this does not traverse another pathname and preserves the identity established above. */
  int home_lock_fd = openat(home_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (home_lock_fd < 0 || flock(home_lock_fd, LOCK_EX | LOCK_NB) != 0)
    fail("provider HOME has an exclusive target-local lease");
  for (size_t i = 0; i < bind_count; i++) {
    binds[i].source_fd = open_directory(binds[i].source, false);
    int target_fd = open_directory(binds[i].target, false);
    if (binds[i].source_fd < 0 || target_fd < 0) fail("cannot resolve bind at launch");
    require_identity(binds[i].source_fd, binds[i].expected_source, "bind source");
    require_identity(target_fd, binds[i].expected_target, "bind target");
    close(target_fd);
  }

  int ready_fd = -1;
  for (size_t i = 0; i < bind_count; i++) {
    if (strcmp(binds[i].target, "/tmp/wollipog-agent-control") == 0) {
      if (!binds[i].readonly) fail("Agent Control ready directory must be read-only");
      if (ready_fd >= 0) fail("ready directory bind is ambiguous");
      ready_fd = binds[i].source_fd;
    }
  }
  if (ready_fd >= 0) {
    bool ready = false;
    for (int attempt = 0; attempt < 200; attempt++) {
      if (ready_entry(ready_fd, "control.sock", S_IFSOCK) &&
          ready_entry(ready_fd, "token", S_IFREG) && ready_entry(ready_fd, "mcp.json", S_IFREG)) {
        ready = true;
        break;
      }
      struct timespec delay = { .tv_sec = 0, .tv_nsec = 50 * 1000 * 1000 };
      while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
    }
    if (!ready) fail("target-local Agent Control relay did not become ready");
  }

  pid_t child = fork();
  if (child < 0) fail("cannot fork bwrap");
  if (child == 0) {
    if (setsid() < 0) _exit(125);
    /* F_DUPFD returns a distinct inherited descriptor with FD_CLOEXEC clear. Do not assume WSL
     * gives this process a small inherited descriptor table. */
    int bind_fds[MAX_BINDS];
    for (size_t i = 0; i < bind_count; i++) {
      bind_fds[i] = fcntl(binds[i].source_fd, F_DUPFD, 3);
      if (bind_fds[i] < 0) _exit(125);
    }
    int cwd_bind_fd = fcntl(cwd_fd, F_DUPFD, 3);
    if (cwd_bind_fd < 0) _exit(125);
    size_t capacity = 40 + bind_count * 5 + (size_t)(argc - command_at);
    char **args = calloc(capacity, sizeof(char *));
    if (!args) _exit(125);
    size_t n = 0;
    args[n++] = (char *)"bwrap";
    args[n++] = (char *)"--die-with-parent"; args[n++] = (char *)"--new-session";
    args[n++] = (char *)"--unshare-pid"; args[n++] = (char *)"--unshare-ipc"; args[n++] = (char *)"--unshare-uts";
    if (strcmp(network, "deny") == 0) args[n++] = (char *)"--unshare-net";
    args[n++] = (char *)"--ro-bind"; args[n++] = (char *)"/"; args[n++] = (char *)"/";
    args[n++] = (char *)"--dev"; args[n++] = (char *)"/dev";
    args[n++] = (char *)"--dir"; args[n++] = (char *)"/dev/shm";
    args[n++] = (char *)"--proc"; args[n++] = (char *)"/proc";
    args[n++] = (char *)"--tmpfs"; args[n++] = (char *)"/tmp";
    for (size_t i = 0; i < bind_count; i++) {
      /* Recreate destinations hidden by the fresh /tmp mount. For existing destinations this is
       * idempotent; source authority still comes only from the held descriptor below. */
      args[n++] = (char *)"--dir"; args[n++] = (char *)binds[i].target;
      args[n++] = (char *)(binds[i].readonly ? "--ro-bind-fd" : "--bind-fd");
      args[n++] = fd_text(bind_fds[i]); args[n++] = (char *)binds[i].target;
    }
    args[n++] = (char *)"--bind-fd"; args[n++] = fd_text(cwd_bind_fd); args[n++] = (char *)cwd;
    args[n++] = (char *)"--chdir"; args[n++] = (char *)cwd; args[n++] = (char *)"--";
    for (int i = command_at; i < argc; i++) args[n++] = argv[i];
    args[n] = NULL;
    syscall(SYS_execveat, bwrap_fd, "", args, environ, AT_EMPTY_PATH);
    _exit(127);
  }

  child_group = child;
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
  int pid_parent = -1; char *pid_leaf = NULL;
  write_pidfile(pidfile, child, &pid_parent, &pid_leaf);
  int status = 0;
  for (;;) {
    pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) break;
    if (waited < 0 && errno != EINTR) fail("cannot wait for bwrap");
    /* A WSL Linux process can outlive its Windows-side wsl.exe relay. Observe the standard-input
     * pipe without consuming provider bytes; EOF/HUP is the only portable relay-death signal. */
    struct pollfd relay = { .fd = STDIN_FILENO, .events = POLLHUP | POLLERR };
    int polled = poll(&relay, 1, 100);
    if (polled > 0 && (relay.revents & (POLLHUP | POLLERR | POLLNVAL)) != 0) {
      kill(-child, SIGTERM);
    }
  }
  unlinkat(pid_parent, pid_leaf, 0); close(pid_parent); free(pid_leaf);
  child_group = -1;
  for (size_t i = 0; i < bind_count; i++) close(binds[i].source_fd);
  close(cwd_fd); close(home_lock_fd); close(home_fd); close(bwrap_fd);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 125;
}

static void require_socket_leaf(const char *value) {
  if (!value || !value[0] || strlen(value) > 255 || strchr(value, '/') ||
      strcmp(value, ".") == 0 || strcmp(value, "..") == 0) {
    fail("relay socket must be one relative filename");
  }
}

/** Enter a prepared socket directory by descriptor and execute the target-local relay without
 * reopening either the directory or its installed program through a mutable pathname. */
static int relay_main(int argc, char **argv) {
  const char *directory = NULL, *directory_id = NULL;
  int command_at = -1;
  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { command_at = i + 1; break; }
    if (strcmp(argv[i], "--dir") == 0 && i + 2 < argc) {
      directory = argv[++i]; directory_id = argv[++i];
    } else fail("invalid relay arguments");
  }
  if (!directory || !directory_id || command_at < 0 || argc - command_at != 4 ||
      strcmp(argv[command_at + 2], "serve") != 0) {
    fail("relay requires --dir PATH ID -- NODE HELPER serve SOCKET");
  }
  if (geteuid() == 0) fail("root relay execution is refused");
  require_socket_leaf(argv[command_at + 3]);

  int directory_fd = open_directory(directory, false);
  if (directory_fd < 0) fail_path("cannot securely resolve relay directory", directory);
  require_identity(directory_fd, directory_id, "relay directory");
  if (fchdir(directory_fd) != 0) fail("cannot enter relay directory");

  /* Both artifacts must be installed beneath root-owned, non-writable ancestors. Keeping the
   * helper fd open through exec also prevents replacement after this attestation. */
  int node_fd = open_attested_file(argv[command_at], true, false,
    "relay Node or one of its ancestors is not root-owned and non-writable");
  int helper_fd = open_attested_file(argv[command_at + 1], false, true,
    "relay helper or one of its ancestors is not root-owned and non-writable");
  struct stat helper_st;
  if (fstat(helper_fd, &helper_st) != 0 || (helper_st.st_mode & 0777) != 0555) {
    fail("relay helper must have mode 0555");
  }
  const int inherited_helper_fd = fcntl(helper_fd, F_DUPFD, 3);
  if (inherited_helper_fd < 0) fail("cannot pin relay helper");
  char helper_path[64];
  if (snprintf(helper_path, sizeof(helper_path), "/proc/self/fd/%d", inherited_helper_fd) >=
      (int)sizeof(helper_path)) fail("relay helper fd path overflow");
  char *const relay_argv[] = {
    (char *)"node", helper_path, (char *)"serve", argv[command_at + 3], NULL,
  };
  syscall(SYS_execveat, node_fd, "", relay_argv, environ, AT_EMPTY_PATH);
  fail("cannot execute attested relay");
  return 125;
}

static int self_test_main(int argc) {
  if (argc != 2) fail("self-test takes no arguments");
  int root = open_directory("/", false);
  if (root < 0) fail("openat2 self-test failed");
  close(root);
  puts("wsl-bwrap-launcher-v1");
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) fail("expected prepare, launch, relay, or self-test");
  if (strcmp(argv[1], "prepare") == 0) return prepare_main(argc, argv);
  if (strcmp(argv[1], "launch") == 0) return launch_main(argc, argv);
  if (strcmp(argv[1], "relay") == 0) return relay_main(argc, argv);
  if (strcmp(argv[1], "self-test") == 0) return self_test_main(argc);
  fail("unknown mode");
  return 125;
}
