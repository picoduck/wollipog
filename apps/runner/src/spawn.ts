/**
 * Cross-platform agent process spawning + termination.
 *
 * Windows gotchas handled here:
 *  - Agents are often launched via `.cmd` shims (npx, claude-code-acp, etc.),
 *    which require a shell to resolve, so we spawn with shell:true on Windows.
 *  - `child.kill()` only kills the immediate process; a `cmd.exe` wrapper would
 *    orphan the real agent. We use `taskkill /T /F` to kill the whole tree.
 */

import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { posix, win32 } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { containerLabelArgs } from "./container-identity.js";
import { dockerTargetClientConfig } from "./docker-client-config.js";
import { RUNNER_CREDENTIAL_ENVIRONMENT, sensitiveEnvironmentName } from "./env-security.js";
import { WSL_BWRAP_UNAVAILABLE_ERROR } from "./execution-isolation-policy.js";
import { encodeWindowsJobSpec, materializeWindowsJobLauncher } from "./windows-job.js";
import {
  DESCENDANT_MARKER_ENV,
  PosixProcessBoundary,
  releaseEmptyPosixProcessBoundaries,
  terminatePosixProcessBoundaries,
  WORKTREE_DESCENDANT_MARKER_ENV,
} from "./posix-process-tree.js";
import { currentProviderHomeRunnerMarker, PROVIDER_HOME_RUNNER_MARKER_ENV } from "./provider-home-lease-evidence.js";
import { spawnWithLinuxCgroup, type LinuxCgroupBoundary } from "./linux-cgroup.js";
import { quoteWindowsCmdToken } from "./windows-cmd.js";
import {
  attachWslAgentControlBroker,
  WSL_AGENT_CONTROL_PRIVATE_DIR,
  WSL_AGENT_CONTROL_PRIVATE_SOCKET,
  type WslAgentControlLaunch,
} from "./wsl-agent-control.js";
import { buildWslBwrapRelayArgs } from "./wsl-bwrap-launcher.js";
import {
  cancelClaudeNamespaceProvider,
  claudeNamespaceFor,
  spawnClaudeNamespaceProvider,
  terminateClaudeNamespaces,
  type ClaudeNamespaceLifetime,
} from "./claude-namespace-session.js";

const isWindows = process.platform === "win32";
/** Runner credentials and policy switches are daemon input and must never become agent input. */
const RUNNER_ONLY_ENV = [
  ...RUNNER_CREDENTIAL_ENVIRONMENT,
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
  DESCENDANT_MARKER_ENV,
  WORKTREE_DESCENDANT_MARKER_ENV,
  "MANAGER_TOKEN_FILE",
];

function inheritedEnvironmentScrub(names: readonly string[] = []): string[] {
  return [...new Set([...RUNNER_ONLY_ENV, ...names])];
}

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
  /** Exact completion for this launch's bounded in-distro process-group reap. */
  wslReapCompletion?: Promise<boolean>;
  /** Internal proof that Node already emitted close; close is not replayed to later listeners. */
  closeObserved?: boolean;
  /** Kernel-identity ownership for descendants that escape the provider's POSIX process group. */
  posixBoundary?: PosixProcessBoundary;
  /** Dedicated standard pipes and process for the target-local WSL Agent Control relay. */
  wslAgentControl?: {
    input: Writable;
    output: Readable;
    relay: ChildProcessWithoutNullStreams;
    dispose: () => void;
  };
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
  /** Explicit environment names a reviewed container helper may receive. Values stay in the
   * native client environment and Docker/Podman receives only `--env NAME`, never `NAME=value`. */
  containerEnvironmentKeys?: string[];
  /** Cloud equivalent: marks the provider launch whose checked remote command replaces host argv. */
  cloudAgentLaunch?: boolean;
  /** Explicit environment names a reviewed cloud helper may ask the proxy to forward. */
  cloudEnvironmentKeys?: string[];
  /** Stable owner for native POSIX descendants that may intentionally outlive one provider turn.
   * The boundary is retained after normal provider exit and terminated when that session disposes. */
  descendantOwner?: object;
  /** Native protected Claude only: retain one PID namespace across provider exits. */
  claudeNamespaceProvider?: boolean;
  /** Stable Claude session key for host-visible task output ownership and crash reconciliation. */
  claudeNamespaceSessionId?: string;
  /** Runner-private durable marker shared by processes owned by one managed worktree. */
  descendantMarker?: string;
  /** False for user-owned interactive shells whose daemonized children are not provider-owned. */
  trackDescendants?: boolean;
}

export interface BwrapSpawnIsolation {
  backend: "bwrap";
  /** Resolved launcher in the same namespace as the target agent. */
  command: string;
  args: string[];
  network: "inherit" | "deny";
  /** Forced managed-worktree bwrap still writes the shared provider transcript/credential home. */
  preservesProviderHome?: true;
  /** Narrow durable state exceptions; source lives under runner data, target is the CLI's home path. */
  writableBinds?: Array<{ source: string; target: string }>;
  /** Exact operator-approved project runtime roots also admitted by the provider's inner sandbox. */
  projectSharedWritableRoots?: string[];
  /** A managed worktree whose parent must remain read-only while the child stays writable.
   * `ownedWorktrees` are the session's other worktrees this boundary binds writable (#3316), each
   * with its own admin directory, so a provider's inner sandbox can grant exactly the same set. */
  protectedWorktree?: {
    parent: string;
    path: string;
    gitWritableRoots: string[];
    ownedWorktrees?: Array<{ path: string; gitAdmin: string }>;
  };
  /** Runner-owned administrative entries bound read-only over themselves. Rendered after every
   * writable bind, including the cwd, so the narrower rule is the one that lands. */
  readOnlyBinds?: string[];
  /** Exact host package directories protected by this launch's readonly root/overlays. */
  codexPackageReadOnlyPaths?: readonly string[];
  /** The runner's hook state directory, replaced by an empty read-only tmpfs so neither the
   * provider nor anything it spawns can read, list, or change it (#1336). `readable` entries are
   * bound back read-only; `socket` is the verdict socket inside one of them. Rendered LAST, so no
   * earlier bind can re-expose what it hides. */
  guardStateMask?: { directory: string; readable: string[]; socket?: string };
  /** Ephemeral authenticated bridge state; never persisted or advertised. WSL only. */
  wslAgentControl?: WslAgentControlLaunch;
  /** Runner-owned fallback for staging the fixed Claude pipe worker when TMPDIR is noexec. */
  claudePipeHelperDataDir?: string;
  /** Internal, attested bind points for a session-owned Claude namespace. */
  claudeNamespace?: { helperPath: string; taskDirectory: string };
}

/** Exact target-local launcher authorization. This is deliberately not `bwrap`: generic WSL
 * bwrap remains rejected before any target mutation. */
export interface WslBwrapSpawnIsolation {
  backend: "wsl-bwrap";
  distro: string;
  command: string;
  args: string[];
  cwd: string;
  network: "inherit" | "deny";
  wslAgentControl: WslAgentControlLaunch;
}

export interface SeatbeltSpawnIsolation {
  backend: "seatbelt";
  command: string;
  args: string[];
  network: "inherit" | "deny";
  /** Complete parameter-free Seatbelt profile. Paths are escaped before reaching this field. */
  profile: string;
  /** Canonical roots rendered into profile, retained so live-process notices report that exact boundary. */
  writableRoots: string[];
  /** Runner-owned entries the profile denies writes to even though a writable root contains them. */
  readOnlyPaths?: string[];
  /** Exact package directories denied writes (including ancestor relocation). */
  codexPackageReadOnlyPaths?: readonly string[];
  /** The hook state directory the profile denies, with the entries it re-exposes (#1336). */
  guardStateMask?: { directory: string; readable: string[]; socket?: string };
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
  runtime: "docker" | "podman";
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
  /** Local Docker socket or named pipe established by setup checks, independent of operator config. */
  dockerHost?: string;
  /** Recheck the effective client and engine with the launch's exact native environment. */
  verifyRuntimeIdentity: (env: NodeJS.ProcessEnv) => void;
  /** Recheck mutable Podman defaults immediately before every client spawn, including later terminals. */
  verifyDefaults?: () => void;
  /** Trust-gated repository setup names forwarded without putting values in argv. */
  sessionEnvironmentKeys?: string[];
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
  /** Adapter v2 revalidates this identity before connecting the selected executable. */
  harnessInstallationId?: string;
  /** Trust-gated repository setup names the proxy must forward to the remote command. */
  sessionEnvironmentKeys?: string[];
}

export type SpawnIsolation = BwrapSpawnIsolation | WslBwrapSpawnIsolation | SeatbeltSpawnIsolation | WindowsJobSpawnIsolation | ContainerSpawnIsolation | CloudSpawnIsolation;

export function buildContainerArgs(
  opts: Pick<SpawnAgentOptions, "command" | "args" | "cwd" | "containerAgentLaunch" | "containerEnvironmentKeys">,
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
    ...(isolation.runtime === "podman" ? ["--http-proxy=false"] : []),
    "--network", isolation.network === "deny" ? "none" : "bridge",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--tmpfs", "/tmp:rw,nosuid,nodev",
    "--mount", `type=bind,src=${opts.cwd},dst=/workspace`,
    "--workdir", "/workspace",
    ...(opts.containerEnvironmentKeys ?? isolation.sessionEnvironmentKeys ?? []).flatMap((key) => ["--env", key]),
    isolation.image,
    command,
    ...(agentLaunch ? isolation.agentArgs : []),
    ...dynamicArgs,
  ];
}

export function buildCloudArgs(
  opts: Pick<SpawnAgentOptions, "command" | "args" | "cloudAgentLaunch" | "cloudEnvironmentKeys">,
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
    ...(agentLaunch && isolation.harnessInstallationId ? ["--installation", isolation.harnessInstallationId] : []),
    ...(opts.cloudEnvironmentKeys ?? isolation.sessionEnvironmentKeys ?? []).flatMap((key) => ["--env", key]),
    "--",
    command,
    ...(agentLaunch ? isolation.agentArgs : []),
    ...dynamicArgs,
  ];
}

export function buildBwrapArgs(opts: Pick<SpawnAgentOptions, "command" | "args" | "cwd">, isolation: BwrapSpawnIsolation): string[] {
  const bridge = isolation.wslAgentControl;
  const socketDir = bridge?.socketPath ? posix.dirname(bridge.socketPath) : undefined;
  const protectedParent = isolation.protectedWorktree?.parent;
  const protectedChild = isolation.protectedWorktree?.path;
  const within = (parent: string, path: string) => {
    const relative = posix.relative(parent, path);
    return relative !== "" && relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
  };
  if (protectedChild && opts.cwd !== protectedChild && !within(protectedChild, opts.cwd)) {
    throw new Error("protected worktree launch cannot bind a different working directory writable");
  }
  const parentBinds = protectedParent && protectedChild
    ? (isolation.writableBinds ?? []).filter((bind) => within(protectedParent, bind.target) &&
        bind.target !== protectedChild && !within(protectedChild, bind.target))
    : [];
  const childBinds = protectedChild
    ? (isolation.writableBinds ?? []).filter((bind) => within(protectedChild, bind.target))
    : [];
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
    ...(socketDir ? ["--dir", WSL_AGENT_CONTROL_PRIVATE_DIR,
      "--ro-bind", socketDir, WSL_AGENT_CONTROL_PRIVATE_DIR] : []),
    ...(isolation.writableBinds ?? []).flatMap((bind) => ["--bind", bind.source, bind.target]),
    // The protected child bind below already makes its descendants writable. Binding a terminal's
    // cwd separately could follow a symlink out of that child and widen its writable boundary.
    ...(!protectedChild ? ["--bind", opts.cwd, opts.cwd] : []),
    ...(isolation.protectedWorktree
      ? [
        "--ro-bind", isolation.protectedWorktree.parent, isolation.protectedWorktree.parent,
        ...parentBinds.flatMap((bind) => ["--bind", bind.source, bind.target]),
        "--bind", isolation.protectedWorktree.path, isolation.protectedWorktree.path,
        ...childBinds.flatMap((bind) => ["--bind", bind.source, bind.target]),
        ...isolation.protectedWorktree.gitWritableRoots.flatMap((path) => ["--bind", path, path]),
      ]
      : []),
    ...(isolation.readOnlyBinds ?? []).flatMap((path) => ["--ro-bind", path, path]),
    ...(isolation.claudeNamespace ? [
      "--dir", "/tmp/claude",
      "--bind", isolation.claudeNamespace.taskDirectory, "/tmp/claude",
      "--ro-bind", isolation.claudeNamespace.helperPath, "/tmp/wollipog-claude-provider-pipe",
    ] : []),
    ...(isolation.guardStateMask
      ? [
        "--tmpfs", isolation.guardStateMask.directory,
        ...isolation.guardStateMask.readable.flatMap((path) => ["--ro-bind", path, path]),
        // The tmpfs is writable until remounted; a file the provider wrote there would vanish with
        // the sandbox, but a read-only mask leaves nothing to reason about.
        "--remount-ro", isolation.guardStateMask.directory,
      ]
      : []),
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
  const configured = new Set(Object.keys(withoutRunnerOnlyEnv(opts.env)).map((key) => key.toLowerCase()));
  const unsets = inheritedEnvironmentScrub(opts.scrubInheritedEnv)
    .filter((key) => !configured.has(key.toLowerCase()))
    .flatMap((k) => ["-u", k]);
  const inner =
    unsets.length ? ["env", ...unsets, opts.command, ...opts.args] : [opts.command, ...opts.args];
  const bridge = opts.isolation?.backend === "bwrap" || opts.isolation?.backend === "wsl-bwrap"
    ? opts.isolation.wslAgentControl : undefined;
  const socket = bridge?.socketPath;
  const wrapper = bridge && socket
    ? "pidfile=$1; socket=$2; shift 2; " +
      "socket_dir=${socket%/*}; provider=; watcher=; cleanup(){ test -n \"$watcher\" && kill \"$watcher\" 2>/dev/null || true; test -n \"$provider\" && kill \"$provider\" 2>/dev/null || true; }; trap cleanup EXIT HUP INT TERM; " +
      "ready=0; i=0; while test $i -lt 200; do if test -S \"$socket\" && test -f \"$socket_dir/token\" && test -f \"$socket_dir/mcp.json\"; then ready=1; break; fi; i=$((i+1)); sleep .05; done; test $ready -eq 1 || exit 125; " +
      // POSIX shells replace stdin with /dev/null for an asynchronous command when job control is
      // disabled. Duplicate the already-translated WSL stdin inside this Linux shell, restore it
      // explicitly for the provider, and close the duplicate on both sides of the launch.
      "exec 3<&0; if command -v setsid >/dev/null 2>&1; then setsid sh -c 'echo $$ > \"$0\"; exec \"$@\"' \"$pidfile\" \"$@\" <&3 3<&- & provider=$!; else \"$@\" <&3 3<&- & provider=$!; fi; exec 3<&-; " +
      "(while kill -0 \"$provider\" 2>/dev/null && test -S \"$socket\"; do sleep .1; done; test -S \"$socket\" || kill \"$provider\" 2>/dev/null || true) & watcher=$!; " +
      "wait \"$provider\"; status=$?; provider=; kill \"$watcher\" 2>/dev/null || true; wait \"$watcher\" 2>/dev/null || true; watcher=; exit $status"
    : "if command -v setsid >/dev/null 2>&1; then " +
      "setsid sh -c 'echo $$ > \"$0\"; exec \"$@\"' \"$@\"; " +
      "else shift; exec \"$@\"; fi";
  // Positionals to the outer sh: $0=sh (dummy), $1=pidfile, then optional socket and command argv.
  return ["-d", distro, "--cd", cwd, "--exec", "sh", "-c", wrapper, "sh", pidfile,
    ...(bridge && socket ? [socket] : []), ...inner];
}

/** Launch the fixed target-local relay as a separate runner-owned WSL process. Standard
 * stdin/stdout are the only Windows handles WSL promises to translate; the provider gets neither
 * those handles nor this argv and can reach only the relay's closed AF_UNIX socket surface. */
export function buildWslAgentControlRelayArgs(bridge: WslAgentControlLaunch): string[] {
  if (!bridge.socketPath) throw new Error("target-local Agent Control relay requires a socket path");
  if (!bridge.socketDirectory) throw new Error("target-local Agent Control relay directory is not attested");
  return buildWslBwrapRelayArgs({
    distro: bridge.distro,
    directory: bridge.socketDirectory,
    node: bridge.nodeRuntime,
    helper: bridge.helperPath,
    socket: posix.basename(bridge.socketPath),
  });
}

export function wslProviderPidfile(relayDirectory: string): string {
  return posix.join(relayDirectory, `provider-${randomUUID().replace(/-/g, "")}.pgid`);
}

export function spawnAgent(opts: SpawnAgentOptions): AgentProcess {
  if (opts.context?.kind === "wsl" && opts.isolation?.backend === "bwrap") {
    throw new Error(WSL_BWRAP_UNAVAILABLE_ERROR);
  }
  if (opts.context?.kind === "wsl" && opts.isolation?.backend === "container") {
    // Container targets are registered against the native runner's engine. A persisted WSL
    // context can bypass new-session validation; probing native Docker and launching in WSL
    // would validate a different engine.
    throw new Error("container execution targets require a native agent context");
  }
  const remoteBoundary = opts.isolation?.backend === "container" || opts.isolation?.backend === "cloud";
  const scrubInheritedEnv = inheritedEnvironmentScrub(opts.scrubInheritedEnv);
  let file = opts.command;
  let args = opts.args;
  let cwd: string | undefined = opts.cwd;
  let shell = isWindows && opts.windowsShell !== false;
  let wslReap: WslReapInfo | undefined;
  let isolationEnv: Record<string, string> = {};
  let explicitEnv = withoutRunnerOnlyEnv(opts.env);
  let bridge = (opts.isolation?.backend === "bwrap" || opts.isolation?.backend === "wsl-bwrap")
    ? opts.isolation.wslAgentControl : undefined;
  if (bridge) {
    if (opts.context?.kind !== "wsl" || opts.context.distro !== bridge.distro) {
      throw new Error("target-local Agent Control bridge does not match the WSL launch context");
    }
    const socket = bridge.socketPath ?? `/tmp/wlp-${process.pid}-${++pgidSeq}-${randomUUID().replace(/-/g, "").slice(0, 12)}/control.sock`;
    bridge = { ...bridge, socketPath: socket };
    opts = { ...opts, isolation: { ...opts.isolation, wslAgentControl: bridge } as SpawnIsolation };
    explicitEnv = {
      ...explicitEnv,
      WOLLIPOG_AGENT_CONTROL_SOCKET: WSL_AGENT_CONTROL_PRIVATE_SOCKET,
    };
  }

  // A Windows Job is a lifetime boundary, not a filesystem/network sandbox. Apply it by default
  // to native provider-mode launches so a child cannot outlive either session disposal or a runner
  // owner crash. Explicit container/cloud/WSL boundaries retain their own lifecycle adapters.
  if (isWindows && opts.context?.kind !== "wsl" && !opts.isolation) {
    const powershell = win32.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
    );
    if (!existsSync(powershell)) {
      throw new Error("Windows Job isolation requires Windows PowerShell but powershell.exe was not found");
    }
    opts = {
      ...opts,
      isolation: {
        backend: "windows-job",
        command: powershell,
        args: [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", materializeWindowsJobLauncher(),
        ],
        network: "inherit",
      },
    };
  }

  if (opts.isolation) {
    if (opts.isolation.backend === "bwrap") {
      args = buildBwrapArgs({ command: file, args, cwd: opts.cwd }, opts.isolation);
      file = opts.isolation.command;
      shell = false;
    } else if (opts.isolation.backend === "wsl-bwrap") {
      if (opts.context?.kind !== "wsl" || opts.context.distro !== opts.isolation.distro ||
          opts.cwd !== opts.isolation.cwd) {
        throw new Error("target-local WSL launcher does not match the authorized context and cwd");
      }
      const configured = new Set(Object.keys(explicitEnv).map((key) => key.toLowerCase()));
      const unsets = scrubInheritedEnv.filter((key) => !configured.has(key.toLowerCase()))
        .flatMap((key) => ["-u", key]);
      const target = unsets.length ? ["/usr/bin/env", ...unsets, file, ...args] : [file, ...args];
      const isolation = opts.isolation;
      const relayDirectory = isolation.wslAgentControl.socketDirectory?.path;
      if (!relayDirectory) throw new Error("target-local WSL launcher is missing its pinned session directory");
      const pidfile = wslProviderPidfile(relayDirectory);
      file = "wsl.exe";
      args = ["-d", isolation.distro, "--cd", isolation.cwd, "--exec", isolation.command,
        ...isolation.args, "--pidfile", pidfile, "--", ...target];
      cwd = undefined;
      shell = false;
      wslReap = { distro: isolation.distro, pidfile };
    } else if (opts.isolation.backend === "seatbelt") {
      args = [...opts.isolation.args, "-p", opts.isolation.profile, file, ...args];
      file = opts.isolation.command;
      shell = false;
    } else if (opts.isolation.backend === "container") {
      const uniqueIsolation = {
        ...opts.isolation,
        containerName: `${opts.isolation.containerName}-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      };
      args = buildContainerArgs({
        command: file,
        args,
        cwd: opts.cwd,
        containerAgentLaunch: opts.containerAgentLaunch,
        containerEnvironmentKeys: opts.containerEnvironmentKeys,
      }, uniqueIsolation);
      file = opts.isolation.command;
      shell = false;
      cwd = undefined;
      // Container targets explicitly claim `secrets: none`. Agent/terminal environment values
      // therefore must not reach either the container or the native runtime client process. The
      // setup runner is the sole reviewed exception and allowlists names explicitly; values stay
      // out of argv and are forwarded by the container runtime from its own environment.
      const allowedEnvironment = new Set(opts.containerEnvironmentKeys ?? opts.isolation.sessionEnvironmentKeys ?? []);
      if (opts.isolation.runtime === "docker" && [...allowedEnvironment].some((name) => /^DOCKER_/iu.test(name))) {
        throw new Error("Docker client control environment cannot be forwarded to a container target");
      }
      explicitEnv = Object.fromEntries(Object.entries(explicitEnv).filter(([key]) => allowedEnvironment.has(key)));
      if (opts.isolation.runtime === "docker") {
        // Docker config.json proxy defaults are applied by the CLI, even when no --env flag is
        // present. Keep its config private and pin the local endpoint verified at readiness.
        scrubInheritedEnv.push(...Object.keys(process.env).filter((name) => /^DOCKER_/iu.test(name)));
        isolationEnv = {
          DOCKER_CONFIG: dockerTargetClientConfig(),
          ...(opts.isolation.dockerHost ? { DOCKER_HOST: opts.isolation.dockerHost } : {}),
        };
      }
    } else if (opts.isolation.backend === "cloud") {
      const allowedEnvironment = new Set(opts.cloudEnvironmentKeys ?? opts.isolation.sessionEnvironmentKeys ?? []);
      const forwardedEnvironment = Object.fromEntries(Object.entries(explicitEnv).filter(([key]) => allowedEnvironment.has(key)));
      args = buildCloudArgs({
        command: file,
        args,
        cloudAgentLaunch: opts.cloudAgentLaunch,
        cloudEnvironmentKeys: opts.cloudEnvironmentKeys,
      }, opts.isolation);
      file = opts.isolation.command;
      shell = false;
      cwd = undefined;
      // Provider env never crosses the cloud boundary. Only runner-owned adapter references and
      // trust-gated repository setup names reach the proxy; the proxy receives forwarding names
      // in argv and values only in its native environment.
      explicitEnv = { ...forwardedEnvironment, ...opts.isolation.env };
    } else {
      let targetCommand = file;
      let targetArgs = args;
      let rawCommandLine: string | undefined;
      if (shell && !/\.(?:exe|com)$/i.test(file)) {
        if (file.includes('"')) throw new Error(`spawnAgent: executable path contains a quote: ${file}`);
        const commandToken = winQuoteArg(file);
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

  if (opts.context?.kind === "wsl" && opts.isolation?.backend !== "wsl-bwrap") {
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

  const ownsNativePosixDescendants = !isWindows && !wslReap && !remoteBoundary && opts.trackDescendants !== false;
  const descendantMarker = ownsNativePosixDescendants ? randomUUID() : undefined;
  const worktreeDescendantMarker = ownsNativePosixDescendants ? opts.descendantMarker : undefined;
  let bridgeRelay: ChildProcessWithoutNullStreams | undefined;
  let disposeBridge: (() => void) | undefined;
  let bridgeStderr = "";
  if (bridge) {
    bridgeRelay = spawn("wsl.exe", buildWslAgentControlRelayArgs(bridge), {
      env: inherited,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    bridgeRelay.stderr.setEncoding("utf8");
    bridgeRelay.stderr.on("data", (chunk: string) => {
      if (bridgeStderr.length < 8_192) bridgeStderr += chunk;
    });
    bridgeRelay.once("error", (error) => {
      if (bridgeStderr.length < 8_192) bridgeStderr += `${(error as Error).message}\n`;
    });
    disposeBridge = attachWslAgentControlBroker(bridgeRelay.stdout, bridgeRelay.stdin, bridge);
  }

  // #3241: a provider-HOME lease's lifecycle evidence is this runner's marker; an explicit
  // environment must not drop or replace it.
  const leaseRunnerMarker = currentProviderHomeRunnerMarker();
  const launchEnv: NodeJS.ProcessEnv = {
    ...inherited,
    ...explicitEnv,
    ...isolationEnv,
    ...(leaseRunnerMarker ? { [PROVIDER_HOME_RUNNER_MARKER_ENV]: leaseRunnerMarker } : {}),
    ...(descendantMarker ? { [DESCENDANT_MARKER_ENV]: descendantMarker } : {}),
    ...(worktreeDescendantMarker
      ? { [WORKTREE_DESCENDANT_MARKER_ENV]: worktreeDescendantMarker }
      : {}),
  };
  if (opts.claudeNamespaceProvider && opts.isolation?.backend === "bwrap" &&
      opts.context?.kind !== "wsl" && opts.descendantOwner) {
    return spawnClaudeNamespaceProvider(
      { ...opts, isolation: opts.isolation, descendantOwner: opts.descendantOwner },
      launchEnv, buildBwrapArgs,
    );
  }
  let child: AgentProcess;
  let containment: LinuxCgroupBoundary | undefined;
  try {
    if (opts.isolation?.backend === "container") {
      opts.isolation.verifyDefaults?.();
      opts.isolation.verifyRuntimeIdentity(launchEnv);
    }
    const spawnOptions = {
      cwd,
      env: launchEnv,
      // Resolve .cmd/.bat shims on Windows; harmless on POSIX for our commands.
      shell,
      windowsHide: true,
      // POSIX: make the agent a process-group leader so killTree can signal the whole
      // group — claude/codex spawn bash/tool children that a single-pid SIGTERM would
      // orphan. Windows uses taskkill /T; the WSL bridge has its own setsid+PGID reap.
      detached: !isWindows,
    };
    if (ownsNativePosixDescendants) {
      const launch = spawnWithLinuxCgroup(file, args, spawnOptions);
      child = launch.child as AgentProcess;
      containment = launch.containment;
    } else {
      // Ordinary user shells do not acquire provider-HOME ownership. Preserve their historical
      // launch/lifetime even if provider containment is unavailable. Agent TUIs and shells
      // whose cleanup owns descendants use the tracked branch above.
      child = spawn(file, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }) as AgentProcess;
    }
  } catch (error) {
    disposeBridge?.();
    throw error;
  }
  if (bridge && bridgeRelay && disposeBridge) {
    const relay = bridgeRelay;
    const dispose = disposeBridge;
    child.wslAgentControl = { input: relay.stdin, output: relay.stdout, relay, dispose };
    relay.once("close", () => {
      dispose();
      if (!child.closeObserved && child.exitCode === null) {
        if (bridgeStderr.trim()) process.stderr.write(`target-local Agent Control relay failed: ${bridgeStderr.trim()}\n`);
        killTree(child);
      }
    });
    child.once("close", dispose);
  }
  child.once("close", () => {
    child.closeObserved = true;
    if (child.posixBoundary) {
      if (opts.descendantOwner) void child.posixBoundary.releaseIfEmpty();
      else trackPendingKill(child.posixBoundary.terminate());
    }
  });
  if (!isWindows && !wslReap && !remoteBoundary && opts.trackDescendants !== false && child.pid) {
    child.posixBoundary = new PosixProcessBoundary(child.pid, opts.descendantOwner, descendantMarker, undefined, undefined, containment);
    child.once("exit", () => child.posixBoundary?.markRootExited());
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
  try {
    return quoteWindowsCmdToken(arg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`winQuoteArg: ${message}; deliver unsupported content via stdin instead`);
  }
}

/** Kills in flight. `process.exit()` cancels timers and exec callbacks, so a shutdown that
 * exits immediately after calling killTree would drop the SIGKILL escalation and the WSL
 * in-distro group reap on the floor — agents that ignore SIGTERM would survive the runner.
 * Shutdown awaits these (bounded) via waitForPendingKills before exiting. */
/** Maximum TERM + KILL verification time after descendant enumeration succeeds. */
export const DESCENDANT_BOUNDARY_TERMINATION_BUDGET_MS = 4_500;

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
  // later, unrelated session shutdown retain ownership forever. Runner shutdown has one drain
  // caller; this module-global consumption is not a concurrent waiter protocol.
  incompleteKillObserved = false;
  return complete;
}

/** Register cleanup for descendants retained after a provider's normal per-turn exit. */
export function terminateDescendantBoundaries(owner?: object): void {
  for (const work of terminateClaudeNamespaces(owner)) trackPendingKill(work);
  for (const work of terminatePosixProcessBoundaries(owner)) trackPendingKill(work);
}

/** Register the global retained-boundary sweep after work already in flight has settled. Provider
 * drivers use that work for graceful EOF shutdown, so an immediate global sweep would preempt their
 * grace period with TERM. waitForPendingKills() drains in waves and therefore observes both this
 * barrier and the boundary terminations it registers. */
export function terminateDescendantBoundariesAfterPendingKills(): void {
  const current = [...pendingKills];
  if (current.length === 0) {
    terminateDescendantBoundaries();
    return;
  }
  trackPendingKill(Promise.allSettled(current).then(() => {
    terminateDescendantBoundaries();
  }));
}

/** True when `child`'s process tree is gone by the same standard runner shutdown uses before it
 * releases every provider-HOME lease: the POSIX boundary terminated every process it tracks
 * (a joined Linux cgroup when available, otherwise parent links and the environment marker) and
 * found no survivor. It is idempotent,
 * so a boundary already terminated on close returns that result.
 *
 * Without Linux cgroup containment, a helper that detaches with a scrubbed environment before its
 * parent link is observed, or whose environment cannot be read, can be invisible to tracking.
 *
 * Without a boundary (Windows, WSL, remote or untracked spawns) only the root's exit is
 * observable, which is not a tree proof, so the answer is false. */
export function provenProcessTreeExit(child: AgentProcess): Promise<boolean> {
  return child.posixBoundary ? child.posixBoundary.terminate().catch(() => false) : Promise.resolve(false);
}

/** Every process one provider instance starts, so the instance can prove its complete process
 * tree gone when it ends (same standard and known limit as provenProcessTreeExit).
 *
 * Children spawned with `owner` as their descendantOwner are covered by that owner's POSIX
 * boundaries, which stay registered until proven gone. A child without a POSIX boundary (Windows,
 * WSL, remote, or a spawn that never got a pid) can never be proven, so recording one makes every
 * proof false. A Claude virtual provider has no boundary of its own: the bwrap namespace it runs in
 * is the unit of proof instead (see ClaudeNamespaceLifetime). Proving seals the ledger: the
 * instance must not start anything afterwards. */
export class ProviderProcessLedger {
  /** Pass as `descendantOwner` on every spawn the instance makes. */
  readonly owner: object = {};
  private sealed = false;
  /** Sticky: once anything the instance started cannot be proven gone, no proof ever passes. */
  private unprovable = false;
  private readonly separate = new Set<AgentProcess>();
  private readonly closedSeparate = new WeakSet<AgentProcess>();
  private readonly namespaces = new Set<ClaudeNamespaceLifetime>();
  private readonly proofs = new Map<boolean, Promise<boolean>>();
  private readonly observations = new Set<Promise<boolean>>();
  private readonly namespaceFor: (child: AgentProcess) => ClaudeNamespaceLifetime | undefined;

  constructor(options: { namespaceFor?: (child: AgentProcess) => ClaudeNamespaceLifetime | undefined } = {}) {
    this.namespaceFor = options.namespaceFor ?? claudeNamespaceFor;
  }

  /** Throws once the instance has ended; call before every spawn. */
  assertOpen(): void {
    if (this.sealed) throw new Error("provider instance already ended; refusing to start another process");
  }

  /** Record a spawned process. A child whose boundary is not registered under `owner` (spawned
   * without it, or by a spawn function that ignored it) is proven individually instead, so the
   * owner proof can never pass vacuously for it.
   *
   * The namespace of a Claude virtual provider is captured here, because the owner's namespace
   * lookup forgets it once it closes. */
  record(child: AgentProcess): AgentProcess {
    const namespace = this.namespaceFor(child);
    if (namespace) this.namespaces.add(namespace);
    else if (!child.posixBoundary) this.unprovable = true;
    else if (child.posixBoundary.owner !== this.owner) this.recordSeparate(child);
    return child;
  }

  /** A separate child without an owner (a per-turn probe, say) has its boundary terminated when it
   * closes anyway, so its proof is settled then rather than letting such children accumulate for
   * the instance's whole lifetime. Only a true result may forget the child: the boundary memoizes
   * it, and a later proof would see the same answer. A false result is kept as a sticky failure,
   * because PosixProcessBoundary retries a failed termination and a retry must not turn an earlier
   * unproven tree into a proven one. A child whose boundary belongs to another owner keeps its
   * survivors until that owner ends them, so it stays recorded and is proven at the end. */
  private recordSeparate(child: AgentProcess): void {
    this.separate.add(child);
    const ownerless = child.posixBoundary?.owner === undefined;
    const settle = () => {
      this.closedSeparate.add(child);
      if (!ownerless) return;
      void provenProcessTreeExit(child).then((proven) => {
        if (proven) this.separate.delete(child);
        else this.unprovable = true;
      });
    };
    if (child.closeObserved) settle();
    else if (typeof child.once === "function") child.once("close", settle);
  }

  /** A separate child's proof terminates its boundary. The non-killing proof must not do that to a
   * child that is still running, so a live one is simply unproven. */
  private proveSeparate(child: AgentProcess, terminate: boolean): Promise<boolean> {
    if (!terminate && !child.closeObserved && !this.closedSeparate.has(child)) return Promise.resolve(false);
    return provenProcessTreeExit(child);
  }

  /** Uninstrumented work remains conservatively unprovable. Codex probes use observe instead. */
  async untracked<T>(work: () => Promise<T>): Promise<T> {
    this.unprovable = true;
    return await work();
  }

  /** Register asynchronous preparation before it can start any probe. Disposal must await the
   * entire operation, including probes that start after an earlier await or share a cached proof.
   * Completed operations are compacted to a sticky failure or forgotten after true proof. */
  async observe<T>(work: (observer: { onProcess(proof: Promise<boolean>): void }) => Promise<T>): Promise<T> {
    this.assertOpen();
    const processes: Promise<boolean>[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const proof = finished.then(async () => (await Promise.all(processes)).every(Boolean)).catch(() => false);
    this.observations.add(proof);
    void proof.then((proven) => {
      if (!proven) this.unprovable = true;
      this.observations.delete(proof);
    });
    try {
      return await work({ onProcess: (process) => { processes.push(process.catch(() => false)); } });
    } finally { finish(); }
  }

  /** `terminate: true` after disposal (kills survivors, as disposal already started to); `false`
   * after the instance exited on its own (never kills; live work makes the answer false).
   * Memoized per mode and never rejects. */
  prove(options: { terminate: boolean }): Promise<boolean> {
    this.sealed = true;
    const existing = this.proofs.get(options.terminate);
    if (existing) return existing;
    const proof = (async () => {
      if (this.unprovable) return false;
      const owned = options.terminate
        ? terminatePosixProcessBoundaries(this.owner)
        : releaseEmptyPosixProcessBoundaries(this.owner);
      const namespaces = [...this.namespaces].map((namespace) => namespaceEnded(namespace, options.terminate));
      const results = await Promise.all([
        ...owned, ...[...this.separate].map((child) => this.proveSeparate(child, options.terminate)), ...namespaces,
        ...this.observations,
      ].map((work) => work.catch(() => false)));
      return results.every(Boolean) && !this.unprovable;
    })().catch(() => false);
    this.proofs.set(options.terminate, proof);
    return proof;
  }
}

/** A Claude namespace is proven gone only when its in-namespace supervisor stopped every process
 * after TERMINATE and the outer bwrap then closed without the SIGKILL fallback. The killing proof
 * starts (or joins) that disposal; the non-killing one only inspects what already happened, so a
 * live namespace (retained background tasks, for example) is unproven. */
async function namespaceEnded(namespace: ClaudeNamespaceLifetime, terminate: boolean): Promise<boolean> {
  if (!terminate && !namespace.endedGracefully) return false;
  // Graceful implies disposal already ran, so this only reads its memoized result.
  const disposed = await namespace.dispose();
  return disposed && namespace.ended && namespace.endedGracefully;
}

/** Kill a process and all of its children, returning exact completion for callers that own one
 * cleanup boundary. Global shutdown still registers the same promise through killTree(). */
export function killTreeAndWait(child: AgentProcess): Promise<boolean> {
  const virtualKill = cancelClaudeNamespaceProvider(child);
  if (virtualKill) return virtualKill;
  if (child.posixBoundary) {
    return child.posixBoundary.terminate();
  }
  if (child.closeObserved) return Promise.resolve(true);
  if (!child.pid) {
    // Not spawned yet: wait so we tree-kill the REAL agent rather than the shell
    // wrapper (or no-op). Bail if the spawn fails outright.
    return new Promise<boolean>((resolve) => {
      const onSpawn = () => {
        child.removeListener("error", onError);
        void killTreeAndWait(child).then(resolve, () => resolve(false));
      };
      const onError = () => {
        child.removeListener("spawn", onSpawn);
        resolve(true);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }
  if (child.wslReap) {
    // WSL bridge: child.pid is only the wsl.exe relay; the agent is a Linux process
    // group inside the distro, outside the Win32 tree. taskkill alone can't reap it.
    child.wslReapCompletion = reapWslGroup(child.wslReap, child.pid);
    return child.wslReapCompletion;
  }
  if (isWindows) {
    // /T = tree, /F = force.
    return new Promise<boolean>((resolve) => {
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
      });
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
    return new Promise<boolean>((resolve) => {
        const t = setTimeout(() => {
          signalGroup("SIGKILL");
        }, 2000);
        // Ownership may be released only after Node observes process exit, not merely when the
        // escalation signal is delivered. The outer shutdown deadline retains the lease if close
        // never arrives.
        t.unref?.();
        child.once("close", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
  }
}

/** Kill a process tree in the global runner shutdown lane. */
export function killTree(child: AgentProcess): void {
  trackPendingKill(killTreeAndWait(child));
}

/**
 * Reap a WSL-bridged agent. taskkill on the wsl.exe relay only drops the Windows-side
 * host; the real agent (and any children it spawned) run as a Linux process group
 * inside the distro. Read the leader's PGID from the pidfile the launch wrapper wrote,
 * signal the whole group (TERM, then KILL after ~2s), drop the relay, and clean up.
 */
function reapWslGroup(reap: WslReapInfo, relayPid: number): Promise<boolean> {
  const { distro, pidfile } = reap;

  // Shutdown must be able to wait until the in-distro kill sequence has actually run —
  // TERM alone isn't enough: an agent that traps SIGTERM would survive if process.exit
  // cancelled the KILL escalation timer. Resolved below once the SIGKILL has been sent
  // (or the pidfile retries are exhausted); the safety cap covers a hung wsl.exe.
  let resolveReap!: (complete: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    resolveReap = resolve;
    setTimeout(() => resolve(false), 6000).unref?.();
  });
  trackPendingKill(completion);

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
        else resolveReap(false);
        return;
      }
      // Negative pid = the whole process group. The `--` is REQUIRED: without it,
      // util-linux `kill` parses the leading-dash PGID as an option and no-ops.
      execFile("wsl.exe", ["-d", distro, "--exec", "kill", "-TERM", "--", `-${pgid}`], () => {
        setTimeout(() => {
          execFile("wsl.exe", ["-d", distro, "--exec", "kill", "-KILL", "--", `-${pgid}`], () => {
            resolveReap(true); // KILL delivered — a TERM-trapping agent is reaped; shutdown may proceed
            execFile("wsl.exe", ["-d", distro, "--exec", "rm", "-f", pidfile], () => {
              /* best-effort cleanup */
            });
          });
        }, 2000).unref?.();
      });
    });
  };
  tryReap();
  return completion;
}
