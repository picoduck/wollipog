/*
 * Linux-only, bounded pipe owner for one Claude provider process.
 *
 * The namespace supervisor starts this worker with its own stdin connected to
 * the provider input and reads version-1 frames from stdout. The worker starts
 * the provider with private stdout/stderr pipes. After waitpid observes provider
 * exit it snapshots and drains the bytes then queued in those nonblocking pipes before
 * emitting EXIT. Descendants may keep the write ends open; their later output
 * is drained and discarded without delaying the provider's exit frame.
 *
 * Frame: 1-byte version (1), 1-byte kind (1=stdout, 2=stderr, 3=exit,
 * 4=worker ready),
 * 4-byte BE payload length, then payload. Data frames contain at most 16384 bytes. EXIT contains two
 * signed BE int32 values: exit code (-1 for signal), then signal (0 otherwise).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHUNK 16384U
#define LOOP_BUDGET (1024U * 1024U)
#define MAX_PIPE_CAPACITY (16U * 1024U * 1024U)
#define STDOUT_FRAME 1U
#define STDERR_FRAME 2U
#define EXIT_FRAME 3U
#define WORKER_READY_FRAME 4U

static int write_all(const unsigned char *data, size_t length) {
  while (length > 0) {
    ssize_t written = write(STDOUT_FILENO, data, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    data += (size_t)written;
    length -= (size_t)written;
  }
  return 0;
}

static int send_frame(unsigned char kind, const unsigned char *data, uint32_t length) {
  if (length > CHUNK && kind != EXIT_FRAME) return -1;
  unsigned char header[6] = {
    1U, kind, (unsigned char)(length >> 24), (unsigned char)(length >> 16),
    (unsigned char)(length >> 8), (unsigned char)length
  };
  if (write_all(header, sizeof(header)) < 0) return -1;
  return write_all(data, length);
}

static void put_i32(unsigned char *target, int32_t value) {
  uint32_t u = (uint32_t)value;
  target[0] = (unsigned char)(u >> 24);
  target[1] = (unsigned char)(u >> 16);
  target[2] = (unsigned char)(u >> 8);
  target[3] = (unsigned char)u;
}

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* Return -1 on read or transport error, 0 while open, 1 at EOF. */
static int drain(int fd, unsigned char kind, int report, size_t budget) {
  unsigned char data[CHUNK];
  while (budget > 0) {
    size_t requested = budget < sizeof(data) ? budget : sizeof(data);
    ssize_t count = read(fd, data, requested);
    if (count > 0) {
      if (report && send_frame(kind, data, (uint32_t)count) < 0) return -1;
      budget -= (size_t)count;
      continue;
    }
    if (count == 0) return 1;
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    return -1;
  }
  return 0;
}

static int queued_pipe_bytes(int fd, size_t *queued) {
  int bytes = 0;
  if (ioctl(fd, FIONREAD, &bytes) < 0 || bytes < 0 ||
      (unsigned int)bytes > MAX_PIPE_CAPACITY) return -1;
  *queued = (size_t)bytes;
  return 0;
}

static volatile sig_atomic_t worker_cancel_requested;

static void request_worker_cancel(int signal_number) {
  (void)signal_number;
  worker_cancel_requested = 1;
}

/* A worker is the subreaper for its exact provider generation. Kill every
 * adopted child, including setsid/double-fork descendants, before reporting
 * cancellation. Prior generations have different subreapers and are untouched. */
static int kill_worker_children(void) {
  char path[96], children[65536];
  int size = snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  if (size <= 0 || (size_t)size >= sizeof(path)) return -1;
  for (int attempt = 0; attempt < 200; attempt++) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t length = read(fd, children, sizeof(children) - 1);
    close(fd);
    if (length < 0 || (size_t)length >= sizeof(children) - 1) return -1;
    children[length] = '\0';
    char *cursor = children;
    int found = 0;
    while (*cursor) {
      while (*cursor == ' ') cursor++;
      if (!*cursor) break;
      char *end;
      long pid = strtol(cursor, &end, 10);
      if (end == cursor || pid <= 0 || pid > INT32_MAX) return -1;
      if (kill((pid_t)pid, SIGKILL) < 0 && errno != ESRCH) return -1;
      found = 1;
      cursor = end;
    }
    while (waitpid(-1, NULL, WNOHANG) > 0) { }
    if (!found) return 0;
    usleep(10000);
  }
  return -1;
}

static int worker_main(int argc, char **argv) {
  if (argc < 2 || !argv[1][0]) return 125;
  /* A provider with the same uid must not reopen this worker's control pipe
   * through /proc/<pid>/fd or ptrace it to forge provider frames. */
  if (prctl(PR_SET_DUMPABLE, 0) < 0) return 125;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) return 125;
  struct sigaction cancel_action = { 0 };
  cancel_action.sa_handler = request_worker_cancel;
  sigemptyset(&cancel_action.sa_mask);
  if (sigaction(SIGUSR1, &cancel_action, NULL) < 0) return 125;
  signal(SIGPIPE, SIG_IGN);
  /* START is not acknowledged until the cancel handler is installed. Without
   * this handshake an immediate CANCEL can deliver SIGUSR1's default action. */
  if (send_frame(WORKER_READY_FRAME, NULL, 0) < 0) return 125;
#ifdef TEST_CLOSE_WORKER_STDIN
  if (getenv("WOLLIPOG_TEST_CLOSE_WORKER_STDIN")) close(STDIN_FILENO);
#endif
  int out[2], err[2];
  if (pipe2(out, O_CLOEXEC) < 0) return 125;
  if (pipe2(err, O_CLOEXEC) < 0) { close(out[0]); close(out[1]); return 125; }
  pid_t worker_pid = getpid();
  pid_t provider = fork();
  if (provider < 0) return 125;
  if (provider == 0) {
    signal(SIGPIPE, SIG_DFL);
    /* A provider's `kill 0` must not reach its supervising worker. If the
     * worker dies unexpectedly, kill the direct provider as well. */
    if (setpgid(0, 0) < 0 || prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 ||
        getppid() != worker_pid) _exit(125);
    close(out[0]); close(err[0]);
    if (dup2(out[1], STDOUT_FILENO) < 0 || dup2(err[1], STDERR_FILENO) < 0) _exit(125);
    close(out[1]); close(err[1]);
    execvp(argv[1], &argv[1]);
    _exit(errno == ENOENT ? 127 : 126);
  }
  close(out[1]); close(err[1]);
  if (set_nonblocking(out[0]) < 0 || set_nonblocking(err[0]) < 0) {
    kill(provider, SIGKILL);
    waitpid(provider, NULL, 0);
    return 125;
  }

  int out_open = 1, err_open = 1, status = 0, provider_exited = 0;
  int exit_sent = 0;
  for (;;) {
    /* Once EXIT is on the wire, cancellation cannot change this generation's
     * result or kill background children retained after its normal exit. */
    if (worker_cancel_requested && !exit_sent) {
      if (!provider_exited) kill(provider, SIGKILL);
      if (kill_worker_children() < 0) goto failure;
      unsigned char result[8];
      put_i32(result, -1);
      put_i32(result + 4, SIGKILL);
      if (send_frame(EXIT_FRAME, result, sizeof(result)) < 0) goto failure;
      if (out_open) close(out[0]);
      if (err_open) close(err[0]);
      return 0;
    }
    /* Poll is bounded so a provider with no output is still reaped promptly. */
    struct pollfd fds[2] = {
      { out[0], out_open ? (POLLIN | POLLHUP) : 0, 0 },
      { err[0], err_open ? (POLLIN | POLLHUP) : 0, 0 }
    };
    int ready = poll(fds, 2, 20);
    if (ready < 0 && errno != EINTR) goto failure;
    /* The worker is a subreaper. Reap adopted descendants throughout a
     * persistent turn while preserving the direct provider's exit status. */
    for (;;) {
      int child_status;
      pid_t waited = waitpid(-1, &child_status, WNOHANG);
      if (waited > 0) {
        if (waited == provider) { status = child_status; provider_exited = 1; }
        continue;
      }
      if (waited == 0 || errno == ECHILD) break;
      if (errno != EINTR) goto failure;
    }
    size_t out_budget = LOOP_BUDGET, err_budget = LOOP_BUDGET;
    if (provider_exited && !exit_sent) {
      /* Snapshot both queues immediately after observing the provider exit.
       * Reading exactly those counts leaves later inherited-pipe writes for
       * the background drainer, even if a descendant keeps refilling them. */
      if (out_open && queued_pipe_bytes(out[0], &out_budget) < 0) goto failure;
      if (err_open && queued_pipe_bytes(err[0], &err_budget) < 0) goto failure;
    }
    /* waitpid is checked before the reads. These budgets bound the output
     * frames independently of whether descendants keep the pipes open. */
    if (out_open) {
      int result = drain(out[0], STDOUT_FRAME, !exit_sent, out_budget);
      if (result < 0) goto failure;
      if (result == 1) { out_open = 0; close(out[0]); }
    }
    if (err_open) {
      int result = drain(err[0], STDERR_FRAME, !exit_sent, err_budget);
      if (result < 0) goto failure;
      if (result == 1) { err_open = 0; close(err[0]); }
    }
    if (provider_exited && !exit_sent) {
      unsigned char result[8];
      put_i32(result, WIFEXITED(status) ? WEXITSTATUS(status) : -1);
      put_i32(result + 4, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
      if (send_frame(EXIT_FRAME, result, sizeof(result)) < 0) goto failure;
#ifdef TEST_DUPLICATE_EXIT_FRAME
      /* Fault injection proves the supervisor never sends a second EXIT even
       * if a worker violates its one-exit contract. Not built into releases. */
      if (getenv("WOLLIPOG_TEST_DUPLICATE_EXIT_FRAME") &&
          send_frame(EXIT_FRAME, result, sizeof(result)) < 0) goto failure;
#endif
      exit_sent = 1;
    }
    if (exit_sent && !out_open && !err_open) return 0;
  }

failure:
  if (!provider_exited) {
    kill(provider, SIGKILL);
    waitpid(provider, NULL, 0);
  }
  if (out_open) close(out[0]);
  if (err_open) close(err[0]);
  return 125;
}

/* The same fixed executable is Bubblewrap's long-lived initial application in
 * supervisor mode. The host control pipe is never inherited by a provider. */
#define CONTROL_HEADER 26U
#define CONTROL_BYTES (1024U * 1024U)
#define PROVIDER_INPUT_BYTES (64U * 1024U)
#ifndef MAX_RETIRED_WORKERS
#define MAX_RETIRED_WORKERS 64U
#endif
#define READY_MESSAGE 1U
#define START_MESSAGE 2U
#define INPUT_MESSAGE 3U
#define END_INPUT_MESSAGE 4U
#define CANCEL_MESSAGE 5U
#define TERMINATE_MESSAGE 6U
#define PROVIDER_STDOUT_MESSAGE 7U
#define PROVIDER_STDERR_MESSAGE 8U
#define PROVIDER_EXIT_MESSAGE 9U
#define ERROR_MESSAGE 10U
#define INPUT_ACK_MESSAGE 11U
#define START_ACK_MESSAGE 12U
#define INPUT_REJECT_MESSAGE 13U

static uint32_t get_u32(const unsigned char *data) {
  return ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) |
    ((uint32_t)data[2] << 8) | (uint32_t)data[3];
}

static void put_u32(unsigned char *data, uint32_t value) {
  data[0] = (unsigned char)(value >> 24);
  data[1] = (unsigned char)(value >> 16);
  data[2] = (unsigned char)(value >> 8);
  data[3] = (unsigned char)value;
}

struct supervisor {
  unsigned char token[16];
  unsigned char input[CONTROL_HEADER + CONTROL_BYTES];
  size_t input_size;
  unsigned char worker_frames[6 + CHUNK];
  size_t worker_size;
  unsigned char provider_input[PROVIDER_INPUT_BYTES];
  size_t provider_input_size;
  uint32_t generation;
  pid_t worker_pid;
  int worker_input;
  int worker_output;
  int end_input;
  int input_ack_pending;
  int input_failed;
  int active;
  pid_t retired[MAX_RETIRED_WORKERS];
  size_t retired_count;
};

static void reap_retired_workers(struct supervisor *state) {
  size_t keep = 0;
  for (size_t i = 0; i < state->retired_count; i++) {
    pid_t pid = state->retired[i];
    pid_t reaped = waitpid(pid, NULL, WNOHANG);
    if (reaped == 0) state->retired[keep++] = pid;
  }
  state->retired_count = keep;
  /* As a subreaper we also adopt background tasks when their workers finish.
   * Reap those tasks throughout the namespace lifetime. An active worker's
   * result travels in pipe frames, so its wait status is not needed here. */
  while (waitpid(-1, NULL, WNOHANG) > 0) { }
}

static int send_control(struct supervisor *state, unsigned char kind, uint32_t generation,
                        const unsigned char *payload, uint32_t length) {
  if (length > CONTROL_BYTES) return -1;
  unsigned char header[CONTROL_HEADER] = { 1U, kind };
  memcpy(header + 2, state->token, sizeof(state->token));
  put_u32(header + 18, generation);
  put_u32(header + 22, length);
  if (write_all(header, sizeof(header)) < 0) return -1;
  return write_all(payload, length);
}

static int control_error(struct supervisor *state, uint32_t generation, const char *reason) {
  return send_control(state, ERROR_MESSAGE, generation, (const unsigned char *)reason,
                      (uint32_t)strlen(reason));
}

static void close_active(struct supervisor *state) {
  if (state->worker_input >= 0) close(state->worker_input);
  if (state->worker_output >= 0) close(state->worker_output);
  state->worker_input = state->worker_output = -1;
  state->provider_input_size = state->worker_size = 0;
  state->input_ack_pending = 0;
  state->input_failed = 0;
  state->end_input = state->active = 0;
}

/* A worker may be killed by a same-UID provider or a signal to its group.
 * Its EOF is a failed provider generation, not a reason to exit PID 1 and
 * destroy older retained work. The direct provider has a parent-death signal;
 * its group is separate from the worker's group. */
static int fail_active_worker(struct supervisor *state) {
  pid_t worker = state->worker_pid;
  uint32_t generation = state->generation;
  unsigned char result[8];
  put_i32(result, 125);
  put_i32(result + 4, 0);
  close_active(state);
  if (kill(-worker, SIGKILL) < 0 && errno != ESRCH) return -1;
  if (waitpid(worker, NULL, 0) < 0 && errno != ECHILD) return -1;
  return send_control(state, PROVIDER_EXIT_MESSAGE, generation, result, sizeof(result));
}

static int start_worker(struct supervisor *state, const unsigned char *payload, size_t length) {
  reap_retired_workers(state);
  if (state->retired_count >= MAX_RETIRED_WORKERS) return -2;
  if (length < 2) return -1;
  unsigned int count = ((unsigned int)payload[0] << 8) | payload[1];
  if (count == 0 || count > 128) return -1;
  size_t offset = 2;
  char *args[130] = { 0 };
  char *worker_env[513] = { 0 };
  unsigned int env_count = 0;
  args[0] = (char *)"/proc/self/exe";
  for (unsigned int i = 0; i < count; i++) {
    if (offset + 4 > length) goto invalid;
    uint32_t bytes = get_u32(payload + offset);
    offset += 4;
    if (bytes == 0 || bytes > 128U * 1024U - 1U || offset + bytes > length ||
        memchr(payload + offset, '\0', bytes)) goto invalid;
    args[i + 1] = malloc((size_t)bytes + 1);
    if (!args[i + 1]) goto invalid;
    memcpy(args[i + 1], payload + offset, bytes);
    args[i + 1][bytes] = '\0';
    offset += bytes;
  }
  if (offset + 2 > length) goto invalid;
  unsigned int parsed_env_count = ((unsigned int)payload[offset] << 8) | payload[offset + 1];
  offset += 2;
  if (parsed_env_count > 512) goto invalid;
  env_count = parsed_env_count;
  for (unsigned int i = 0; i < env_count; i++) {
    if (offset + 4 > length) goto invalid;
    uint32_t bytes = get_u32(payload + offset);
    offset += 4;
    if (bytes == 0 || bytes > 32768 || offset + bytes > length ||
        memchr(payload + offset, '\0', bytes)) goto invalid;
    const unsigned char *equal = memchr(payload + offset, '=', bytes);
    if (!equal || equal == payload + offset) goto invalid;
    worker_env[i] = malloc((size_t)bytes + 1);
    if (!worker_env[i]) goto invalid;
    memcpy(worker_env[i], payload + offset, bytes);
    worker_env[i][bytes] = '\0';
    offset += bytes;
  }
  if (offset != length || args[1][0] != '/') goto invalid;
  int input_pipe[2], output_pipe[2];
  if (pipe2(input_pipe, O_CLOEXEC) < 0) goto invalid;
  if (pipe2(output_pipe, O_CLOEXEC) < 0) {
    close(input_pipe[0]); close(input_pipe[1]); goto invalid;
  }
  pid_t child = fork();
  if (child < 0) {
    close(input_pipe[0]); close(input_pipe[1]);
    close(output_pipe[0]); close(output_pipe[1]); goto invalid;
  }
  if (child == 0) {
    if (setpgid(0, 0) < 0) _exit(125);
    if (dup2(input_pipe[0], STDIN_FILENO) < 0 || dup2(output_pipe[1], STDOUT_FILENO) < 0) _exit(125);
    close(input_pipe[0]); close(input_pipe[1]);
    close(output_pipe[0]); close(output_pipe[1]);
    int null_fd = open("/dev/null", O_WRONLY);
    if (null_fd < 0 || dup2(null_fd, STDERR_FILENO) < 0) _exit(125);
    if (null_fd > STDERR_FILENO) close(null_fd);
    /* Every generation gets the host's current sanitized launch environment.
     * The supervisor retains its fixed mount profile and own control env. */
    execve(args[0], args, worker_env);
    _exit(125);
  }
  close(input_pipe[0]); close(output_pipe[1]);
  /* Establish the group in the parent before cancellation can observe the
   * worker. EACCES means the child has already exec'd, so verify its group. */
  if (setpgid(child, child) < 0 &&
      (errno != EACCES || getpgid(child) != child)) {
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
    close(input_pipe[1]); close(output_pipe[0]);
    goto invalid;
  }
  if (set_nonblocking(input_pipe[1]) < 0 || set_nonblocking(output_pipe[0]) < 0) {
    kill(-child, SIGKILL);
    waitpid(child, NULL, 0);
    close(input_pipe[1]); close(output_pipe[0]);
    goto invalid;
  }
  unsigned char ready[6];
  size_t ready_bytes = 0;
  for (int attempts = 0; ready_bytes < sizeof(ready) && attempts < 200; attempts++) {
    struct pollfd pending = { output_pipe[0], POLLIN | POLLHUP, 0 };
    int readable = poll(&pending, 1, 10);
    if (readable < 0 && errno == EINTR) continue;
    if (readable <= 0) continue;
    ssize_t amount = read(output_pipe[0], ready + ready_bytes, sizeof(ready) - ready_bytes);
    if (amount <= 0) break;
    ready_bytes += (size_t)amount;
  }
  if (ready_bytes != sizeof(ready) || ready[0] != 1U || ready[1] != WORKER_READY_FRAME ||
      get_u32(ready + 2) != 0) {
    kill(-child, SIGKILL);
    waitpid(child, NULL, 0);
    close(input_pipe[1]); close(output_pipe[0]);
    goto invalid;
  }
  state->worker_pid = child;
  state->worker_input = input_pipe[1];
  state->worker_output = output_pipe[0];
  state->active = 1;
  for (unsigned int i = 1; i <= count; i++) free(args[i]);
  for (unsigned int i = 0; i < env_count; i++) free(worker_env[i]);
  return 0;

invalid:
  for (unsigned int i = 1; i <= count; i++) free(args[i]);
  for (unsigned int i = 0; i < env_count; i++) free(worker_env[i]);
  return -1;
}

static int handle_control(struct supervisor *state, unsigned char kind, uint32_t generation,
                          const unsigned char *payload, uint32_t length) {
  if (kind == TERMINATE_MESSAGE && generation == 0 && length == 0) {
    /* The outer bwrap monitor can return the application's status before its
     * PID-namespace init has finished reaping. End and reap adopted descendants
     * ourselves before success permits the host to release provider references. */
    return kill_worker_children() == 0 ? 1 : -1;
  }
  if (kind == START_MESSAGE) {
    if (generation <= state->generation || state->active)
      return control_error(state, generation, "invalid or concurrent provider start") < 0 ? -1 : 0;
    int started = start_worker(state, payload, length);
    if (started == -2) {
      state->generation = generation;
      return control_error(state, generation, "retained provider drainer limit") < 0 ? -1 : 0;
    }
    if (started < 0) {
      state->generation = generation;
      return control_error(state, generation, "invalid provider start") < 0 ? -1 : 0;
    }
    state->generation = generation;
    return send_control(state, START_ACK_MESSAGE, generation, NULL, 0);
  }
  /* A provider may have exited before the host reads its EXIT frame. Late
   * input, EOF, and cancellation for that completed generation have no worker
   * to affect; do not turn them into an error that could dispose older work. */
  if ((kind == INPUT_MESSAGE || kind == END_INPUT_MESSAGE || kind == CANCEL_MESSAGE) &&
      generation > 0 && generation <= state->generation &&
      (!state->active || generation < state->generation)) return 0;
  if (!state->active || generation != state->generation)
    return control_error(state, generation, "stale provider generation") < 0 ? -1 : 0;
  if (state->input_failed && (kind == INPUT_MESSAGE || kind == END_INPUT_MESSAGE)) return 0;
  if (kind == INPUT_MESSAGE) {
    if (state->end_input || state->input_ack_pending ||
        length > PROVIDER_INPUT_BYTES - state->provider_input_size)
      return control_error(state, generation, "provider input limit") < 0 ? -1 : 0;
    memcpy(state->provider_input + state->provider_input_size, payload, length);
    state->provider_input_size += length;
    state->input_ack_pending = 1;
    return 0;
  }
  if (kind == END_INPUT_MESSAGE && length == 0) { state->end_input = 1; return 0; }
  if (kind == CANCEL_MESSAGE && length == 0) {
    /* The worker may have queued EXIT and already exited. In that case the
     * pending framed EXIT, or an EOF failure, remains authoritative. */
    if (kill(state->worker_pid, SIGUSR1) < 0 && errno != ESRCH) return -1;
    return 0;
  }
  return control_error(state, generation, "invalid provider control") < 0 ? -1 : 0;
}

static int consume_host_input(struct supervisor *state) {
  for (;;) {
    if (state->input_size >= sizeof(state->input)) return -1;
    ssize_t count = read(STDIN_FILENO, state->input + state->input_size,
                         sizeof(state->input) - state->input_size);
    if (count > 0) state->input_size += (size_t)count;
    else if (count == 0) return 1;
    else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return -1;
    while (state->input_size >= CONTROL_HEADER) {
      uint32_t length = get_u32(state->input + 22);
      if (length > CONTROL_BYTES || state->input[0] != 1U ||
          memcmp(state->input + 2, state->token, sizeof(state->token))) return -1;
      size_t total = CONTROL_HEADER + (size_t)length;
      if (state->input_size < total) break;
      int result = handle_control(state, state->input[1], get_u32(state->input + 18),
                                  state->input + CONTROL_HEADER, length);
      if (result != 0) return result;
      memmove(state->input, state->input + total, state->input_size - total);
      state->input_size -= total;
    }
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    if (count < 0 && errno == EINTR) continue;
  }
}

static int consume_worker_output(struct supervisor *state) {
  if (!state->active) return 0;
  for (;;) {
    if (state->worker_size >= sizeof(state->worker_frames)) return fail_active_worker(state);
    ssize_t count = read(state->worker_output, state->worker_frames + state->worker_size,
                         sizeof(state->worker_frames) - state->worker_size);
    if (count > 0) state->worker_size += (size_t)count;
    else if (count == 0) return fail_active_worker(state);
    else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)
      return fail_active_worker(state);
    while (state->worker_size >= 6) {
      uint32_t length = get_u32(state->worker_frames + 2);
      unsigned char kind = state->worker_frames[1];
      if (state->worker_frames[0] != 1U || length > CHUNK ||
          (kind != STDOUT_FRAME && kind != STDERR_FRAME && kind != EXIT_FRAME) ||
          (kind == EXIT_FRAME && length != 8)) return fail_active_worker(state);
      size_t total = 6 + (size_t)length;
      if (state->worker_size < total) break;
      unsigned char outer_kind = kind == STDOUT_FRAME ? PROVIDER_STDOUT_MESSAGE :
                                 kind == STDERR_FRAME ? PROVIDER_STDERR_MESSAGE : PROVIDER_EXIT_MESSAGE;
      if (send_control(state, outer_kind, state->generation, state->worker_frames + 6, length) < 0) return -1;
      memmove(state->worker_frames, state->worker_frames + total, state->worker_size - total);
      state->worker_size -= total;
      if (kind == EXIT_FRAME) {
        if (state->worker_size != 0) {
          /* EXIT was already forwarded. A worker that appended another frame
           * is invalid, but reporting a second EXIT would make the host
           * dispose older generations. Retire only this worker instead. */
          pid_t duplicate = state->worker_pid;
          close_active(state);
          if (kill(-duplicate, SIGKILL) < 0 && errno != ESRCH) return -1;
          if (waitpid(duplicate, NULL, 0) < 0 && errno != ECHILD) return -1;
          return 0;
        }
        pid_t finished = state->worker_pid;
        close_active(state);
        if (waitpid(finished, NULL, WNOHANG) == 0) {
          if (state->retired_count >= MAX_RETIRED_WORKERS) return -1;
          state->retired[state->retired_count++] = finished;
        }
        return 0;
      }
    }
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    if (count < 0 && errno == EINTR) continue;
  }
}

static int flush_provider_input(struct supervisor *state) {
  while (state->provider_input_size > 0) {
    ssize_t count = write(state->worker_input, state->provider_input, state->provider_input_size);
    if (count > 0) {
      memmove(state->provider_input, state->provider_input + count,
              state->provider_input_size - (size_t)count);
      state->provider_input_size -= (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    if (count < 0 && errno == EPIPE) {
      /* The worker closed its input pipe after poll selected it. Report the
       * failed write for this generation; exiting PID 1 would kill retained
       * work from every earlier generation. */
      close(state->worker_input);
      state->worker_input = -1;
      state->provider_input_size = 0;
      state->input_ack_pending = 0;
      state->input_failed = 1;
      return send_control(state, INPUT_REJECT_MESSAGE, state->generation, NULL, 0);
    }
    return -1;
  }
  if (state->input_ack_pending) {
    if (send_control(state, INPUT_ACK_MESSAGE, state->generation, NULL, 0) < 0) return -1;
    state->input_ack_pending = 0;
  }
  if (state->end_input && state->worker_input >= 0) {
    close(state->worker_input); state->worker_input = -1;
  }
  return 0;
}

static int hex_token(const char *hex, unsigned char token[16]) {
  if (strlen(hex) != 32) return -1;
  for (size_t i = 0; i < 16; i++) {
    int a = hex[i * 2], b = hex[i * 2 + 1];
    a = a >= '0' && a <= '9' ? a - '0' : a >= 'a' && a <= 'f' ? a - 'a' + 10 : -1;
    b = b >= '0' && b <= '9' ? b - '0' : b >= 'a' && b <= 'f' ? b - 'a' + 10 : -1;
    if (a < 0 || b < 0) return -1;
    token[i] = (unsigned char)((a << 4) | b);
  }
  return 0;
}

static int supervisor_main(const char *token_hex) {
  static struct supervisor state;
  state.worker_input = state.worker_output = -1;
  /* The namespace peer has our uid. Deny /proc/1/fd and ptrace access to
   * the host control descriptors before accepting any provider launch. */
  if (prctl(PR_SET_DUMPABLE, 0) < 0 || prctl(PR_SET_CHILD_SUBREAPER, 1) < 0 ||
      hex_token(token_hex, state.token) < 0 || set_nonblocking(STDIN_FILENO) < 0) return 125;
  signal(SIGPIPE, SIG_IGN);
  if (send_control(&state, READY_MESSAGE, 0, NULL, 0) < 0) return 125;
  for (;;) {
    struct pollfd fds[3] = {
      { STDIN_FILENO, POLLIN | POLLHUP, 0 },
      { state.active ? state.worker_output : -1, POLLIN | POLLHUP, 0 },
      { state.active && state.worker_input >= 0 && state.provider_input_size > 0 ? state.worker_input : -1, POLLOUT, 0 },
    };
    int ready = poll(fds, 3, 20);
    if (ready < 0 && errno != EINTR) return 125;
    if (fds[0].revents) {
      int result = consume_host_input(&state);
      if (result > 0) return 0;
      if (result < 0) return 125;
    }
    if (state.active && fds[1].revents && consume_worker_output(&state) < 0) return 125;
    if (state.active && state.worker_input >= 0 &&
        (fds[2].revents || state.provider_input_size > 0 || state.end_input) &&
        flush_provider_input(&state) < 0) return 125;
    reap_retired_workers(&state);
  }
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--supervisor") == 0) return supervisor_main(argv[2]);
  return worker_main(argc, argv);
}
