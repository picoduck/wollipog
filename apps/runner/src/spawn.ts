/**
 * Cross-platform agent process spawning + termination.
 *
 * Windows gotchas handled here:
 *  - Agents are often launched via `.cmd` shims (npx, claude-code-acp, etc.),
 *    which require a shell to resolve, so we spawn with shell:true on Windows.
 *  - `child.kill()` only kills the immediate process; a `cmd.exe` wrapper would
 *    orphan the real agent. We use `taskkill /T /F` to kill the whole tree.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { posix, win32 } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { containerLabelArgs } from "./container-identity.js";
import { sensitiveEnvironmentName } from "./env-security.js";
import { encodeWindowsJobSpec, WINDOWS_JOB_ENCODED_COMMAND } from "./windows-job.js";
import { PosixProcessBoundary, terminatePosixProcessBoundaries } from "./posix-process-tree.js";

const isWindows = process.platform === "win32";
/** Runner policy switches are daemon input and must never become agent input. */
const RUNNER_ONLY_ENV = [
  "WOLLIPOG_CLAUDE_HOOKS",
  "MAM_CLAUDE_HOOKS",
  "WOLLIPOG_POLICY_HOOK_CP_URL",
  "MAM_POLICY_HOOK_CP_URL",
  "WOLLIPOG_POLICY_HOOK_SESSION_ID",
  "MAM_POLICY_HOOK_SESSION_ID",
  "WOLLIPOG_POLICY_HOOK_SETTINGS_FILE",
  "MAM_POLICY_HOOK_SETTINGS_FILE",
  "WOLLIPOG_POLICY_HOOK_CIRCUIT_FILE",
  "MAM_POLICY_HOOK_CIRCUIT_FILE",
  "WOLLIPOG_POLICY_HOOK_READY_FILE",
  "MAM_POLICY_HOOK_READY_FILE",
  "WOLLIPOG_POLICY_HOOK_ASK_CAPABLE",
  "MAM_POLICY_HOOK_ASK_CAPABLE",
  "WOLLIPOG_WINDOWS_JOB_SPEC",
  "MAM_WINDOWS_JOB_SPEC",
  "MANAGER_TOKEN_FILE",
];

function withoutRunnerOnlyEnv(env: Record<string, string> | undefined): Record<string, string> {
  const result = { ...(env ?? {}) };
  const runnerOnly = new Set(RUNNER_ONLY_ENV.map((key) => key.toLowerCase()));
  for (const key of Object.keys(result)) {
    if (runnerOnly.has(key.toLowerCase())) delete result[key];
  }
  return result;
}

/** Per-launch sequence for unique pidfile names (no Math.random/Date needed). */
let pgidSeq = 0;

/** Bookkeeping for reaping a WSL-bridged agent's in-distro process group. */
export interface WslReapInfo {
  distro: string;
  /** Linux path to the file the group leader wrote its PGID into. */
  pidfile: string;
}

export type AgentProcess = ChildProcessByStdio<Writable, Readable, Readable> & {
  /**
   * Set when launched via the WSL bridge. `child.pid` is only the Windows-side
   * `wsl.exe` relay; the real agent runs as a Linux process-group leader inside
   * the distro (outside the Win32 tree). killTree uses this to read the PGID and
   * signal the whole group. Absent for native spawns.
   */
  wslReap?: WslReapInfo;
  /** Internal proof that Node already emitted close; close is not replayed to later listeners. */
  closeObserved?: boolean;
  /** Kernel-identity ownership for descendants that escape the provider's POSIX process group. */
  posixBoundary?: PosixProcessBoundary;
};

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Native (default) or bridged into a WSL distro. */
  context?: AgentContext;
  /**
   * Env vars to drop from the INHERITED daemon environment before merging `env`.
   * An explicit `env` entry with the same name still wins — this only stops vars
   * that happen to be exported in the runner daemon's own environment from leaking
   * into the agent (e.g. a stray ANTHROPIC_API_KEY silently switching a claude
   * subscription session to API billing).
   */
  scrubInheritedEnv?: string[];
  /** Native Windows only: bypass cmd.exe when the caller already resolved a real executable. */
  windowsShell?: boolean;
  isolation?: SpawnIsolation;
  /** Marks the provider process whose checked in-image command replaces the host launch. Helpers
   * such as ACP terminals deliberately omit this even when their command text happens to match. */
  containerAgentLaunch?: boolean;
  /** Cloud equivalent: marks the provider launch whose checked remote command replaces host argv. */
  cloudAgentLaunch?: boolean;
  /** Stable owner for native POSIX descendants that may intentionally outlive one provider turn.
   * The boundary is retained after normal provider exit and terminated when that session disposes. */
  descendantOwner?: object;
}

export interface BwrapSpawnIsolation {
  backend: "bwrap";
  /** Resolved launcher in the same namespace as the target agent. */
  command: string;
  args: string[];
  network: "inherit" | "deny";
  /** Narrow durable state exceptions; source lives under runner data, target is the CLI's home path. */
  writableBinds?: Array<{ source: string; target: string }>;
}

export interface SeatbeltSpawnIsolation {
  backend: "seatbelt";
  command: string;
  args: string[];
  network: "inherit" | "deny";
  /** Complete parameter-free Seatbelt profile. Paths are escaped before reaching this field. */
  profile: string;
}

export interface WindowsJobSpawnIsolation {
  backend: "windows-job";
  command: string;
  args: string[];
  /** Job Objects manage a process tree; they do not restrict filesystem or network access. */
  network: "inherit";
}

export interface ContainerSpawnIsolation {
  backend: "container";
  /** Resolved native Docker/Podman client plus any resolver prefix arguments. */
  command: string;
  args: string[];
  image: string;
  network: "deny" | "bridge";
  templateId: string;
  runnerKey: string;
  containerName: string;
  hostAgentCommand: string;
  /** Explicit command inside the image; host discovery paths never cross this boundary. */
  agentCommand: string;
  agentArgs: string[];
  /** Host-only configured args replaced by agentArgs at the container boundary. */
  hostAgentArgs: string[];
}

export interface CloudSpawnIsolation {
  backend: "cloud";
  /** Resolved operator-installed proxy adapter. */
  command: string;
  args: string[];
  /** Sanitized native adapter environment plus explicit runner-local secret references. */
  env: Record<string, string>;
  targetId: string;
  handoffId: string;
  sessionId: string;
  hostAgentCommand: string;
  hostAgentArgs: string[];
  agentCommand: string;
  agentArgs: string[];
}

export type SpawnIsolation = BwrapSpawnIsolation | SeatbeltSpawnIsolation | WindowsJobSpawnIsolation | ContainerSpawnIsolation | CloudSpawnIsolation;

export function buildContainerArgs(
  opts: Pick<SpawnAgentOptions, "command" | "args" | "cwd" | "containerAgentLaunch">,
  isolation: ContainerSpawnIsolation,
): string[] {
  if (/[\0,\r\n]/.test(opts.cwd)) {
    throw new Error("container workspace path contains an unsupported mount character");
  }
  const agentLaunch = opts.containerAgentLaunch === true;
  if (agentLaunch && opts.command !== isolation.hostAgentCommand) {
    throw new Error("container agent command does not match the checked host launch");
  }
  const configuredArgsMatch = agentLaunch && isolation.hostAgentArgs.every((arg, index) => opts.args[index] === arg);
  if (agentLaunch && !configuredArgsMatch) {
    throw new Error("container agent arguments do not match the checked host launch prefix");
  }
  const command = agentLaunch
    ? isolation.agentCommand
    : (opts.command.includes("\\") ? win32.basename(opts.command) : posix.basename(opts.command)).replace(/\.(?:cmd|exe|ps1)$/i, "");
  const dynamicArgs = agentLaunch ? opts.args.slice(isolation.hostAgentArgs.length) : opts.args;
  return [
    ...isolation.args,
    "run", "--rm", "--interactive", "--init",
    "--name", isolation.containerName,
    ...containerLabelArgs(isolation.runnerKey, isolation.templateId),
    "--sig-proxy=true",
    "--network", isolation.network === "deny" ? "none" : "bridge",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--tmpfs", "/tmp:rw,nosuid,nodev",
    "--mount", `type=bind,src=${opts.cwd},dst=/workspace`,
    "--workdir", "/workspace",
    isolation.image,
    command,
    ...(agentLaunch ? isolation.agentArgs : []),
    ...dynamicArgs,
  ];
}

export function buildCloudArgs(
  opts: Pick<SpawnAgentOptions, "command" | "args" | "cloudAgentLaunch">,
  isolation: CloudSpawnIsolation,
): string[] {
  const agentLaunch = opts.cloudAgentLaunch === true;
  if (agentLaunch && opts.command !== isolation.hostAgentCommand) {
    throw new Error("cloud agent command does not match the checked host launch");
  }
  const configuredArgsMatch = agentLaunch && isolation.hostAgentArgs.every((arg, index) => opts.args[index] === arg);
  if (agentLaunch && !configuredArgsMatch) {
    throw new Error("cloud agent arguments do not match the checked host launch prefix");
  }
  const command = agentLaunch
    ? isolation.agentCommand
    : (opts.command.includes("\\") ? win32.basename(opts.command) : posix.basename(opts.command)).replace(/\.(?:cmd|exe|ps1)$/i, "");
  const dynamicArgs = agentLaunch ? opts.args.slice(isolation.hostAgentArgs.length) : opts.args;
  return [
    ...isolation.args,
    "connect",
    "--protocol", "1",
    "--target", isolation.targetId,
    "--handoff", isolation.handoffId,
    "--session", isolation.sessionId,
    "--",
    command,
    ...(agentLaunch ? isolation.agentArgs : []),
    ...dynamicArgs,
  ];
}

export function buildBwrapArgs(opts: Pick<SpawnAgentOptions, "command" | "args" | "cwd">, isolation: BwrapSpawnIsolation): string[] {
  return [
    ...isolation.args,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(isolation.network === "deny" ? ["--unshare-net"] : []),
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--dir", "/dev/shm",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    ...(isolation.writableBinds ?? []).flatMap((bind) => ["--bind", bind.source, bind.target]),
    "--bind", opts.cwd, opts.cwd,
    "--chdir", opts.cwd,
    "--",
    opts.command,
    ...opts.args,
  ];
}

/**
 * Argv for a WSL-bridged launch. Exported for tests.
 *
 * Env delivery: node's spawn `env` option only reaches the WINDOWS-side wsl.exe relay —
 * Linux children see the distro's environment, not Windows' (only WSLENV-listed vars
 * cross, and we set none). Agent-config env (and scrubInheritedEnv unsets) are therefore
 * delivered through the wsl.exe child environment + WSLENV. Only scrubbed variable NAMES ride
 * argv; secret values never appear in process listings. Without this, a WSL agent's configured tokens
 * silently never arrived.
 */
export function buildWslArgs(distro: string, cwd: string, pidfile: string, opts: SpawnAgentOptions): string[] {
  const configured = new Set(Object.keys(opts.env ?? {}).map((key) => key.toLowerCase()));
  const unsets = (opts.scrubInheritedEnv ?? [])
    .filter((key) => !configured.has(key.toLowerCase()))
    .flatMap((k) => ["-u", k]);
  const inner =
    unsets.length ? ["env", ...unsets, opts.command, ...opts.args] : [opts.command, ...opts.args];
  const wrapper =
    "if command -v setsid >/dev/null 2>&1; then " +
    "setsid sh -c 'echo $$ > \"$0\"; exec \"$@\"' \"$@\"; " +
    "else shift; exec \"$@\"; fi";
  // Positionals to the outer sh: $0=sh (dummy), $1=pidfile, $2..=env-prefix+command+args.
  return ["-d", distro, "--cd", cwd, "--exec", "sh", "-c", wrapper, "sh", pidfile, ...inner];
}

export function spawnAgent(opts: SpawnAgentOptions): AgentProcess {
  const remoteBoundary = opts.isolation?.backend === "container" || opts.isolation?.backend === "cloud";
  const scrubInheritedEnv = [...RUNNER_ONLY_ENV, ...(opts.scrubInheritedEnv ?? [])];
  let file = opts.command;
  let args = opts.args;
  let cwd: string | undefined = opts.cwd;
  let shell = isWindows && opts.windowsShell !== false;
  let wslReap: WslReapInfo | undefined;
  let isolationEnv: Record<string, string> = {};
  let explicitEnv = withoutRunnerOnlyEnv(opts.env);

  // A Windows Job is a lifetime boundary, not a filesystem/network sandbox. Apply it by default
  // to native provider-mode launches so a child cannot outlive either session disposal or a runner
  // owner crash. Explicit container/cloud/WSL boundaries retain their own lifecycle adapters.
  if (isWindows && opts.context?.kind !== "wsl" && !opts.isolation) {
    opts = {
      ...opts,
      isolation: {
        backend: "windows-job",
        command: win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", WINDOWS_JOB_ENCODED_COMMAND],
        network: "inherit",
      },
    };
  }

  if (opts.isolation) {
    if (opts.isolation.backend === "bwrap") {
      args = buildBwrapArgs({ command: file, args, cwd: opts.cwd }, opts.isolation);
      file = opts.isolation.command;
      shell = false;
    } else if (opts.isolation.backend === "seatbelt") {
      args = [...opts.isolation.args, "-p", opts.isolation.profile, file, ...args];
      file = opts.isolation.command;
      shell = false;
    } else if (opts.isolation.backend === "container") {
      const uniqueIsolation = {
        ...opts.isolation,
        containerName: `${opts.isolation.containerName}-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      };
      args = buildContainerArgs({ command: file, args, cwd: opts.cwd, containerAgentLaunch: opts.containerAgentLaunch }, uniqueIsolation);
      file = opts.isolation.command;
      shell = false;
      cwd = undefined;
      // Container targets explicitly claim `secrets: none`. Agent/terminal environment values
      // therefore must not reach either the container or the native runtime client process.
      explicitEnv = {};
    } else if (opts.isolation.backend === "cloud") {
      args = buildCloudArgs({ command: file, args, cloudAgentLaunch: opts.cloudAgentLaunch }, opts.isolation);
      file = opts.isolation.command;
      shell = false;
      cwd = undefined;
      // Provider env never crosses the cloud boundary. Only the runner-owned adapter's resolved,
      // explicit references reach the native proxy client.
      explicitEnv = opts.isolation.env;
    } else {
      let targetCommand = file;
      let targetArgs = args;
      let rawCommandLine: string | undefined;
      if (shell && !/\.(?:exe|com)$/i.test(file)) {
        if (file.includes('"')) throw new Error(`spawnAgent: executable path contains a quote: ${file}`);
        const commandToken = /[^\w.:\\/+@-]/.test(file) ? `"${file}"` : file;
        targetCommand = process.env.ComSpec || win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
        targetArgs = [];
        rawCommandLine = [commandToken, ...args.map(winQuoteArg)].join(" ");
      }
      isolationEnv = { WOLLIPOG_WINDOWS_JOB_SPEC: encodeWindowsJobSpec(targetCommand, targetArgs, opts.cwd, process.pid, rawCommandLine) };
      file = opts.isolation.command;
      args = opts.isolation.args;
      shell = false;
    }
  }
  // Isolation adapters may replace the explicit environment (for example, a cloud proxy).
  // Re-apply the daemon-only boundary after that projection too.
  explicitEnv = withoutRunnerOnlyEnv(explicitEnv);

  if (opts.context?.kind === "wsl") {
    // Bridge into a WSL distro. `--cd` needs an absolute Linux path; a relative/Windows
    // path silently lands the agent in $HOME and it edits the wrong tree, so fail loudly.
    if (!opts.cwd.startsWith("/")) {
      throw new Error(`WSL agent requires an absolute Linux cwd, got ${JSON.stringify(opts.cwd)}`);
    }
    const distro = opts.context.distro;
    // Use `--exec` (NOT `--`): `wsl.exe -- <cmd>` routes the command through the distro's
    // default LOGIN SHELL (e.g. zsh), which word-splits args, runs glob/redirect on them,
    // and rewrites $0 — destroying the positional-param wrapper below (and silently
    // word-splitting any prompt arg). `--exec` execs directly with clean argv, boundaries
    // intact.
    //
    // The real agent runs as a Linux process inside the distro's pico-process namespace,
    // invisible to the Win32 tree — so taskkill on wsl.exe can't reap it (see killTree).
    // Launch it as a process-GROUP LEADER and record its PGID so killTree can signal the
    // whole group. `setsid` (run as a child of the outer sh, so it is never already a
    // group leader and setsid(2) can't fail) makes the inner sh the new session/group
    // leader; `$$` there IS the PGID, and `exec` keeps that PID, so the agent inherits
    // leadership. The wrapper is injection-safe: the agent command, its args, and the
    // pidfile only ever flow through positional parameters ($0/"$@"), never into the
    // script text. If setsid is missing we fall back to a plain exec (no pidfile) so
    // launch still works — killTree then degrades to the relay-only kill, like a native
    // shim.
    const pidfile = `/tmp/wollipog-${process.pid}-${++pgidSeq}.pgid`;
    const innerCommand = file;
    file = "wsl.exe";
    args = buildWslArgs(distro, opts.cwd, pidfile, {
      ...opts,
      command: innerCommand,
      args,
      env: explicitEnv,
      scrubInheritedEnv,
    });
    cwd = undefined; // --cd sets the Linux working dir; a Windows cwd is meaningless here
    shell = false; // wsl.exe is a real executable, not a .cmd shim
    wslReap = { distro, pidfile };
  }

  // With shell:true on Windows, Node concatenates args without escaping, so any
  // arg with spaces (a prompt, a path) is word-split. Quote them for cmd.exe.
  // The COMMAND needs the same treatment: discovery can resolve an absolute path
  // under e.g. "C:\Program Files\..." (space) or "C:\Tools&Agents\..." (metachar) —
  // cmd.exe would split at the space / interpret the metachar. An embedded quote in
  // an executable path is not safely representable — fail loudly.
  if (shell) {
    args = args.map(winQuoteArg);
    if (file.includes('"')) {
      throw new Error(`spawnAgent: executable path contains a quote: ${file}`);
    }
    if (/[^\w.:\\/+@-]/.test(file)) file = `"${file}"`;
  }

  const inherited: Record<string, string | undefined> = { ...process.env };
  if (remoteBoundary) {
    for (const key of Object.keys(inherited)) {
      if (sensitiveEnvironmentName(key)) {
        delete inherited[key];
      }
    }
  }
  for (const key of scrubInheritedEnv) {
    delete inherited[key];
    if (isWindows) {
      // Windows env vars are case-insensitive: `OpenAI_Api_Key` would still reach the
      // child (and the CLI) if only the exact-case name were deleted.
      const lower = key.toLowerCase();
      for (const k of Object.keys(inherited)) {
        if (k.toLowerCase() === lower) delete inherited[k];
      }
    }
  }
  if (wslReap && Object.keys(explicitEnv).length > 0) {
    const existing = (inherited.WSLENV ?? "").split(":").filter(Boolean);
    const known = new Set(existing.map((entry) => entry.split("/")[0]?.toLowerCase()));
    const additions = Object.keys(explicitEnv).filter((name) => !known.has(name.toLowerCase()));
    inherited.WSLENV = [...existing, ...additions].join(":");
  }

  const child = spawn(file, args, {
    cwd,
    env: { ...inherited, ...explicitEnv, ...isolationEnv },
    // Resolve .cmd/.bat shims on Windows; harmless on POSIX for our commands.
    shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // POSIX: make the agent a process-group leader so killTree can signal the whole
    // group — claude/codex spawn bash/tool children that a single-pid SIGTERM would
    // orphan. Windows uses taskkill /T; the WSL bridge has its own setsid+PGID reap.
    detached: !isWindows,
  }) as AgentProcess;
  child.once("close", () => {
    child.closeObserved = true;
    if (child.posixBoundary) {
      if (opts.descendantOwner) void child.posixBoundary.releaseIfEmpty();
      else trackPendingKill(child.posixBoundary.terminate());
    }
  });
  if (!isWindows && !wslReap && !remoteBoundary && child.pid) {
    child.posixBoundary = new PosixProcessBoundary(child.pid, opts.descendantOwner);
  }
  if (wslReap) child.wslReap = wslReap;
  return child;
}

/** Quote an arg for cmd.exe (shell:true on Windows). Wraps in double quotes and
 * doubles embedded quotes when the arg contains spaces or cmd metacharacters.
 *
 * A newline cannot survive inside a `cmd /c "..."` token (it ends the command), and
 * `%VAR%` is expanded by cmd even inside quotes — neither is safely escapable here.
 * Multi-line / `%`-bearing content (a prompt) must therefore be delivered via stdin,
 * not argv; the native CLI drivers do exactly that. We throw on CR/LF so any future
 * multi-line arg fails loudly instead of being silently truncated. */
export function winQuoteArg(arg: string): string {
  if (/[\r\n]/.test(arg)) {
    throw new Error("winQuoteArg: argument contains CR/LF; deliver multi-line content via stdin, not argv");
  }
  if (arg === "") return '""';
  if (!/[ \t"&|<>^()!]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

/** Kills in flight. `process.exit()` cancels timers and exec callbacks, so a shutdown that
 * exits immediately after calling killTree would drop the SIGKILL escalation and the WSL
 * in-distro group reap on the floor — agents that ignore SIGTERM would survive the runner.
 * Shutdown awaits these (bounded) via waitForPendingKills before exiting. */
const pendingKills = new Set<Promise<void>>();
let incompleteKillObserved = false;

export function trackPendingKill(work: Promise<void | boolean>): void {
  const entry: Promise<void> = work.then((complete) => {
    if (complete === false) incompleteKillObserved = true;
  }, () => {
    incompleteKillObserved = true;
  }).then(() => {
    pendingKills.delete(entry);
  });
  pendingKills.add(entry);
}

/** Wait for all in-flight kills to finish delivering their signals, up to `deadlineMs`.
 * The deadline timer is deliberately REF'd: during shutdown the sockets are gone and the
 * kill-internal timers are unref'd, so without a live handle the event loop could drain
 * and exit the process before the escalations ever fire. Returns false when the deadline leaves
 * process trees pending, so shutdown can retain external ownership leases while exiting. */
export async function waitForPendingKills(deadlineMs: number): Promise<boolean> {
  const expiresAt = Date.now() + Math.max(0, deadlineMs);
  // A graceful stop can register its force-kill only after the five-second EOF window. Drain in
  // waves so work added by an earlier pending operation is still covered by the same deadline.
  while (pendingKills.size > 0) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...pendingKills]),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, remaining);
      }),
    ]);
    if (deadline) clearTimeout(deadline);
  }
  const complete = !incompleteKillObserved;
  // A drain consumes failures from the work it observed. A historical failure must not make every
  // later, unrelated session shutdown retain ownership forever.
  incompleteKillObserved = false;
  return complete;
}

/** Register cleanup for descendants retained after a provider's normal per-turn exit. */
export function terminateDescendantBoundaries(owner?: object): void {
  for (const work of terminatePosixProcessBoundaries(owner)) trackPendingKill(work);
}

/** Kill a process and all of its children, cross-platform. */
export function killTree(child: AgentProcess): void {
  if (child.posixBoundary) {
    trackPendingKill(child.posixBoundary.terminate());
    return;
  }
  if (child.closeObserved) return;
  if (!child.pid) {
    // Not spawned yet: wait so we tree-kill the REAL agent rather than the shell
    // wrapper (or no-op). Bail if the spawn fails outright.
    const onSpawn = () => killTree(child);
    child.once("spawn", onSpawn);
    child.once("error", () => child.removeListener("spawn", onSpawn));
    return;
  }
  if (child.wslReap) {
    // WSL bridge: child.pid is only the wsl.exe relay; the agent is a Linux process
    // group inside the distro, outside the Win32 tree. taskkill alone can't reap it.
    reapWslGroup(child.wslReap, child.pid);
    return;
  }
  if (isWindows) {
    // /T = tree, /F = force.
    trackPendingKill(
      new Promise<boolean>((resolve) => {
        let taskkillComplete = false;
        let closeObserved = child.closeObserved === true;
        const finish = () => {
          if (taskkillComplete && closeObserved) resolve(true);
        };
        child.once("close", () => {
          closeObserved = true;
          finish();
        });
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], (err) => {
          const code = (err as { code?: number } | null)?.code;
          // 128 = "process not found" / already exited — benign.
          if (err && code !== 128) {
            console.error(`[runner] taskkill failed for pid ${child.pid}: ${err.message}`);
            resolve(false);
            return;
          }
          taskkillComplete = true;
          if (code === 128) closeObserved = true;
          finish();
        });
      }),
    );
  } else {
    // The child was spawned detached (its own process group, PGID == its pid), so a
    // negative-pid kill signals the agent AND everything it spawned. Fall back to a
    // single-process kill if the group signal fails (group already reaped, or the
    // child predates the detached spawn).
    const pid = child.pid;
    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };
    signalGroup("SIGTERM");
    // Escalate if it lingers; resolve early when the process exits so shutdown
    // doesn't wait the full window for well-behaved agents.
    trackPendingKill(
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          signalGroup("SIGKILL");
        }, 2000);
        // Ownership may be released only after Node observes process exit, not merely when the
        // escalation signal is delivered. The outer shutdown deadline retains the lease if close
        // never arrives.
        t.unref?.();
        child.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    );
  }
}

/**
 * Reap a WSL-bridged agent. taskkill on the wsl.exe relay only drops the Windows-side
 * host; the real agent (and any children it spawned) run as a Linux process group
 * inside the distro. Read the leader's PGID from the pidfile the launch wrapper wrote,
 * signal the whole group (TERM, then KILL after ~2s), drop the relay, and clean up.
 */
function reapWslGroup(reap: WslReapInfo, relayPid: number): void {
  const { distro, pidfile } = reap;

  // Shutdown must be able to wait until the in-distro kill sequence has actually run —
  // TERM alone isn't enough: an agent that traps SIGTERM would survive if process.exit
  // cancelled the KILL escalation timer. Resolved below once the SIGKILL has been sent
  // (or the pidfile retries are exhausted); the safety cap covers a hung wsl.exe.
  let resolveReap!: () => void;
  trackPendingKill(
    new Promise<void>((resolve) => {
      resolveReap = resolve;
      setTimeout(resolve, 6000).unref?.();
    }),
  );

  // Drop the Windows-side relay regardless — frees the wsl.exe host and gives a
  // well-behaved agent stdio EOF even if the in-distro kill below can't run.
  execFile("taskkill", ["/pid", String(relayPid), "/T", "/F"], () => {
    /* relay may already be gone */
  });

  // The launch wrapper writes the PGID asynchronously; a cancel/dispose that fires in
  // the first instants of a turn can win the race and read an empty pidfile. Poll for
  // it briefly (the orphaned wrapper keeps running and writes it even after the relay
  // is killed) so we still reap the group. `--exec` runs the command directly (clean
  // argv, no login shell) — matters for the negative-PGID `kill` argument.
  let attempts = 0;
  const tryReap = (): void => {
    execFile("wsl.exe", ["-d", distro, "--exec", "cat", pidfile], (_err, stdout) => {
      const pgid = parseInt(String(stdout).trim(), 10);
      if (!Number.isInteger(pgid) || pgid <= 1) {
        // Not written yet — retry up to ~2s, then give up (setsid absent → plain-exec
        // fallback, or the agent died before writing; the relay taskkill is the fallback).
        if (++attempts < 10) setTimeout(tryReap, 200).unref?.();
        else resolveReap();
        return;
      }
      // Negative pid = the whole process group. The `--` is REQUIRED: without it,
      // util-linux `kill` parses the leading-dash PGID as an option and no-ops.
      execFile("wsl.exe", ["-d", distro, "--exec", "kill", "-TERM", "--", `-${pgid}`], () => {
        setTimeout(() => {
          execFile("wsl.exe", ["-d", distro, "--exec", "kill", "-KILL", "--", `-${pgid}`], () => {
            resolveReap(); // KILL delivered — a TERM-trapping agent is reaped; shutdown may proceed
            execFile("wsl.exe", ["-d", distro, "--exec", "rm", "-f", pidfile], () => {
              /* best-effort cleanup */
            });
          });
        }, 2000).unref?.();
      });
    });
  };
  tryReap();
}
