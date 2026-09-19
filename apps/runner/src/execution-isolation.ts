import type { AgentContext } from "@wollipog/protocol";
import type { AgentDriverKind } from "@wollipog/protocol";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, opendir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { RunnerExecutionIsolation } from "./config.js";
import { assertExecutionIsolationContextSupported, WSL_BWRAP_UNAVAILABLE_ERROR } from "./execution-isolation-policy.js";
import { runContextCommand } from "./context-command.js";
import { resolveNative, type ResolvedBinary } from "./discovery/resolve.js";
import type { SpawnIsolation } from "./spawn.js";
import { materializeWindowsJobLauncher } from "./windows-job.js";
import { wslAgentControlLaunch } from "./agent-control.js";
import {
  cleanupWslBwrapSessionState,
  prepareWslBwrapIsolation,
  provisionWslBwrapSessionState,
  WSL_BWRAP_LAUNCHER_PATH,
  type WslBwrapPreparation,
  type WslBwrapPrepareRequest,
} from "./wsl-bwrap-launcher.js";
import { WSL_AGENT_CONTROL_PRIVATE_DIR } from "./wsl-agent-control.js";

interface IsolationDeps {
  platform: NodeJS.Platform;
  uid: () => number | undefined;
  resolveNative: (name: string) => Promise<ResolvedBinary | null>;
  resolveWsl: (context: Extract<AgentContext, { kind: "wsl" }>) => Promise<{ command: string; uid: number; home: string } | null>;
  resolveWslHome: (context: Extract<AgentContext, { kind: "wsl" }>) => Promise<string | null>;
  nativeHome: () => string;
  nativeTmp: () => string;
  realpathNative: (path: string) => Promise<string>;
  mkdirNative: (paths: string[]) => Promise<void>;
  mkdirWsl: (context: Extract<AgentContext, { kind: "wsl" }>, paths: string[]) => Promise<void>;
  copyNative: (source: ProviderStateLocation, target: ProviderStateLocation) => Promise<void>;
  copyWsl: (context: Extract<AgentContext, { kind: "wsl" }>, source: ProviderStateLocation, target: ProviderStateLocation) => Promise<void>;
  removeNative: (location: ProviderStateLocation) => Promise<void>;
  removeWsl: (context: Extract<AgentContext, { kind: "wsl" }>, location: ProviderStateLocation) => Promise<void>;
  cleanupWslSessionState: (distro: string, ownerHash: string, sessionKey: string) => Promise<void>;
  provisionWslSessionState: (distro: string, ownerHash: string, sessionKey: string, uid: number) =>
    Promise<{ root: string; provider: string; relay: string }>;
  prepareWslIsolation: (context: AgentContext, request: WslBwrapPrepareRequest) => Promise<WslBwrapPreparation>;
  existsNative: (path: string) => Promise<boolean>;
  existsWsl: (context: Extract<AgentContext, { kind: "wsl" }>, path: string) => Promise<boolean>;
  isRunnerOwnedEntryNative: (path: string) => Promise<boolean>;
  /** A real file, directory, or socket at exactly this path — never a symlink, which a bind or a
   * Seatbelt allow would follow somewhere the runner did not choose. */
  isExposableEntryNative: (path: string) => Promise<boolean>;
  forkSizeNative: (location: ProviderStateLocation, driver: AgentDriverKind, providerSessionId: string) => Promise<number | null>;
  forkSizeWsl: (context: Extract<AgentContext, { kind: "wsl" }>, location: ProviderStateLocation, driver: AgentDriverKind, providerSessionId: string) => Promise<number | null>;
  wait: (ms: number) => Promise<void>;
  materializeWindowsJobLauncher: () => string;
}

const defaultDeps: IsolationDeps = {
  platform: process.platform,
  uid: () => process.getuid?.(),
  resolveNative,
  resolveWsl: async (context) => {
    try {
      const result = await runContextCommand(context, "sh", ["-c", "command -v bwrap; id -u; printf '%s\n' \"$HOME\""], {
        cwd: "/",
        timeoutMs: 5_000,
      });
      return parseWslIsolationProbe(result.stdout);
    } catch {
      return null;
    }
  },
  resolveWslHome: async (context) => {
    try {
      const result = await runContextCommand(context, "sh", ["-c", "printf '%s' \"$HOME\""], {
        cwd: "/", timeoutMs: 5_000,
      });
      return absoluteHome(result.stdout.trim(), "probed HOME inside WSL");
    } catch {
      return null;
    }
  },
  nativeHome: homedir,
  nativeTmp: tmpdir,
  realpathNative: realpath,
  mkdirNative: async (paths) => { for (const path of paths) await mkdir(path, { recursive: true }); },
  mkdirWsl: async (context, paths) => {
    await runContextCommand(context, "mkdir", ["-p", "--", ...paths], { cwd: "/", timeoutMs: 5_000 });
  },
  copyNative: async (source, target) => {
    await rm(target.root, { recursive: true, force: true });
    await mkdir(target.root, { recursive: true });
    await cp(source.leaf, target.leaf, { recursive: true, force: false, errorOnExist: true });
  },
  copyWsl: async (context, source, target) => {
    await runContextCommand(context, "rm", ["-rf", "--", target.root], { cwd: "/", timeoutMs: 5_000 });
    await runContextCommand(context, "mkdir", ["-p", "--", target.root], { cwd: "/", timeoutMs: 5_000 });
    await runContextCommand(context, "cp", ["-a", "--", source.leaf, target.leaf], { cwd: "/", timeoutMs: 300_000 });
  },
  removeNative: async (location) => { await rm(location.root, { recursive: true, force: true }); },
  removeWsl: async (context, location) => {
    await runContextCommand(context, "rm", ["-rf", "--", location.root], { cwd: "/", timeoutMs: 5_000 });
  },
  cleanupWslSessionState: cleanupWslBwrapSessionState,
  provisionWslSessionState: provisionWslBwrapSessionState,
  prepareWslIsolation: prepareWslBwrapIsolation,
  existsNative: async (path) => stat(path).then((value) => value.isDirectory(), () => false),
  existsWsl: async (context, path) => runContextCommand(
    context, "test", ["-d", path], { cwd: "/", timeoutMs: 5_000 },
  ).then(() => true, () => false),
  isRunnerOwnedEntryNative: async (path) => stat(path).then((value) => value.isFile(), () => false),
  isExposableEntryNative: async (path) => lstat(path).then(
    (value) => value.isFile() || value.isDirectory() || value.isSocket(),
    () => false,
  ),
  forkSizeNative: async (location, driver, providerSessionId) => {
    return findProviderForkSizeNative(location.leaf, driver, providerSessionId, 0);
  },
  forkSizeWsl: async (context, location, driver, providerSessionId) => {
    const patterns = driver === "claude-code"
      ? ["-name", `${providerSessionId}.jsonl`]
      : driver === "pi"
        ? ["(", "-name", `${providerSessionId}.jsonl`, "-o", "-name", `*_${providerSessionId}.jsonl`, ")"]
        : ["-name", `*-${providerSessionId}.jsonl`];
    return runContextCommand(
      context,
      "find",
      [location.leaf, "-maxdepth", "8", "-type", "f", ...patterns, "-printf", "%s\\n", "-quit"],
      { cwd: "/", timeoutMs: 5_000 },
    ).then((result) => {
      const size = Number(result.stdout.trim());
      return Number.isSafeInteger(size) && size >= 0 ? size : null;
    }, () => null);
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  materializeWindowsJobLauncher,
};

export interface IsolationStateOptions {
  driver: AgentDriverKind;
  dataDir: string;
  env: Record<string, string>;
  sessionId: string;
  cwd: string;
  /** Session-private roots that may be populated after launch (for example an agent-requested
   * worktree). They are materialized before sandbox construction and never shared across sessions. */
  additionalWritableRoots?: string[];
  /** Keep the provider's writable filesystem to its private cwd and transcript state. */
  orchestratorScratchOnly?: boolean;
  /** Runner-owned administrative entries that sit inside an otherwise writable session root and
   * must stay read-only to the provider. Sandbox modes that can express a per-path rule apply it;
   * the modes that cannot are documented as unenforcing rather than silently assumed safe. */
  readOnlyPaths?: string[];
  /** The runner's hook state directory, hidden from the provider and everything it spawns, and
   * the few entries inside it the provider must still read (#1336). Native bwrap and Seatbelt
   * express it; every other mode is documented as not enforcing it. */
  guardStateMask?: GuardStateMaskOptions;
  /** Stable attested runner/control-plane owner for state outside dataDir (currently WSL). */
  ownerHash?: string;
  /** Canonical shared provider leaf used by Seatbelt when a home component is symlinked. */
  providerStatePath?: string;
}

interface ProviderStateLocation { root: string; leaf: string; }

/** See `GuardStateMask` in managed-worktree-guard-socket.ts, which the runner fills in. */
interface GuardStateMaskOptions {
  directory: string;
  readable: string[];
  socket?: string;
  managerTransport?: { readable: string[]; writable: string[] };
}

export function parseWslIsolationProbe(stdout: string): { command: string; uid: number; home: string } | null {
  const lines = stdout.trim().split(/\r?\n/).map((line) => line.trim());
  const command = lines[0];
  const uid = Number(lines[1]);
  let home: string;
  try { home = absoluteHome(lines[2] ?? "", "probed HOME inside WSL"); }
  catch { return null; }
  return command?.startsWith("/") && Number.isInteger(uid) ? { command, uid, home } : null;
}

function statePath(driver: AgentDriverKind): { provider: string; relative: string } | null {
  if (driver === "claude-code") return { provider: "claude", relative: ".claude/projects" };
  if (driver === "codex" || driver === "codex-app-server") return { provider: "codex", relative: ".codex/sessions" };
  if (driver === "pi") return { provider: "pi", relative: ".pi/agent/sessions" };
  return null;
}

/** Session ids cross a trust boundary from the control plane. Hashing keeps them out of host and
 * WSL path syntax while preserving one stable partition for reconnect/resume. */
export function providerStateKey(sessionId: string): string {
  if (!sessionId) throw new Error("isolated provider state requires a non-empty session id");
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function providerStateLocation(base: string, driver: AgentDriverKind, sessionId: string): ProviderStateLocation | null {
  const mapping = statePath(driver);
  if (!mapping) return null;
  const root = posix.join(base, "provider-state", mapping.provider, providerStateKey(sessionId));
  return { root, leaf: posix.join(root, mapping.relative.split("/").at(-1)!) };
}

function wslRunnerStateBase(home: string, ownerHash?: string): string {
  const base = `${absoluteHome(home, "probed HOME inside WSL")}/.agent-manager`;
  if (!ownerHash) return base;
  if (!/^[a-f0-9]{64}$/u.test(ownerHash)) throw new Error("WSL runner state requires a valid attested owner hash");
  return posix.join(base, "runner-instances", ownerHash);
}

function legacyProviderStateLocation(base: string, driver: AgentDriverKind): ProviderStateLocation | null {
  const mapping = statePath(driver);
  if (!mapping) return null;
  const root = posix.join(base, "provider-state", mapping.provider);
  return { root, leaf: posix.join(root, mapping.relative.split("/").at(-1)!) };
}

function providerForkFileMatches(driver: AgentDriverKind, providerSessionId: string, filename: string): boolean {
  if (driver === "claude-code") return filename === `${providerSessionId}.jsonl`;
  if (driver === "pi") {
    return filename === `${providerSessionId}.jsonl` || filename.endsWith(`_${providerSessionId}.jsonl`);
  }
  return (driver === "codex" || driver === "codex-app-server") && filename.endsWith(`-${providerSessionId}.jsonl`);
}

async function findProviderForkSizeNative(
  root: string,
  driver: AgentDriverKind,
  providerSessionId: string,
  depth: number,
): Promise<number | null> {
  const directory = await opendir(root).catch(() => null);
  if (!directory) return null;
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isFile() && providerForkFileMatches(driver, providerSessionId, entry.name)) {
      return stat(path).then((value) => value.size, () => null);
    }
    if (entry.isDirectory() && depth < 8) {
      const nested = await findProviderForkSizeNative(path, driver, providerSessionId, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function safeProviderSessionId(providerSessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(providerSessionId)) {
    throw new Error("provider fork returned an unsafe session id");
  }
}

function absoluteHome(value: string, label: string): string {
  if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
    throw new Error(`bubblewrap isolation requires an absolute traversal-free POSIX ${label}`);
  }
  return posix.normalize(value);
}

function seatbeltLiteral(value: string): string {
  if (!value.startsWith("/") || /[\0\r\n]/.test(value)) {
    throw new Error(`Seatbelt isolation requires an absolute control-free POSIX path, got ${JSON.stringify(value)}`);
  }
  return `"${posix.normalize(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Exactly the roots a Seatbelt session may write to. Anything that must REPORT what the sandbox
 * permits reads this rather than re-deriving it: a second copy of the list drifts, and a caller
 * told a path is blocked when the profile in fact grants it waits for a relaunch it never needed. */
export function seatbeltWritableRoots(
  state: IsolationStateOptions,
  home: string,
  nativeTmp = tmpdir(),
): string[] {
  const mapping = statePath(state.driver);
  const paths = new Set(state.orchestratorScratchOnly
    ? [state.cwd]
    : [state.cwd, state.dataDir, nativeTmp, ...(state.additionalWritableRoots ?? [])]);
  if (mapping) paths.add(state.providerStatePath ?? posix.join(
    absoluteHome(state.env.HOME ?? home, "HOME on macOS"), ...mapping.relative.split("/"),
  ));
  return [...paths];
}

/** A parameter-free Seatbelt profile. It intentionally grants read access for installed CLI,
 * credential, toolchain, and system compatibility while restricting writes to the declared
 * session roots and the provider's real transcript leaf. Unlike bwrap, Seatbelt cannot mount a
 * per-session transcript leaf over the provider's home path. */
export function buildSeatbeltProfile(
  state: IsolationStateOptions,
  home: string,
  network: "inherit" | "deny",
  nativeTmp = tmpdir(),
): string {
  return renderSeatbeltProfile(
    seatbeltWritableRoots(state, home, nativeTmp),
    network,
    state.readOnlyPaths ?? [],
    state.guardStateMask
      ? {
        directories: [state.guardStateMask.directory],
        readableFiles: state.guardStateMask.readable,
        readableDirectories: [],
        sockets: state.guardStateMask.socket ? [state.guardStateMask.socket] : [],
        transportReadable: state.guardStateMask.managerTransport?.readable ?? [],
        transportWritable: state.guardStateMask.managerTransport?.writable ?? [],
      }
      : undefined,
  );
}

/** The mask as Seatbelt sees it, with every spelling of each path, so a path Seatbelt
 * canonicalizes differently from the runner (`/var` and `/private/var`) is still covered. */
interface SeatbeltGuardStateMask {
  directories: string[];
  readableFiles: string[];
  readableDirectories: string[];
  sockets: string[];
  /** Manager policy hook state: read-only files, and files it rewrites (with their atomic-write
   * temporary siblings). */
  transportReadable: string[];
  transportWritable: string[];
}

function renderSeatbeltProfile(
  writableRoots: string[],
  network: "inherit" | "deny",
  readOnlyPaths: readonly string[] = [],
  guardStateMask?: SeatbeltGuardStateMask,
): string {
  const writeRules = writableRoots
    .map((path) => `    (subpath ${seatbeltLiteral(path)})`).join("\n");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
    "(allow sysctl-read)",
    ...(network === "inherit" ? ["(allow mach*)"] : []),
    "(allow ipc-posix*)",
    "(allow signal)",
    "(allow file-write*",
    '    (literal "/dev/null")',
    '    (literal "/dev/tty")',
    writeRules,
    ")",
    // Seatbelt resolves a profile in order and the last matching rule wins, so the runner-owned
    // entries carve their exception out of the writable roots above rather than fighting them.
    // Each entry is denied as both a literal and a subpath: `literal` is the exact-pathname match
    // that a regular link file needs, and `subpath` additionally covers anything beneath it. This
    // repository's only enforcing macOS host is CI, so the redundant form is deliberate — a filter
    // that silently matched nothing would leave the rule looking applied and doing nothing.
    ...(readOnlyPaths.length
      ? [
        "(deny file-write*",
        ...readOnlyPaths.flatMap((path) => [
          `    (literal ${seatbeltLiteral(path)})`,
          `    (subpath ${seatbeltLiteral(path)})`,
        ]),
        ")",
      ]
      : []),
    // The runner's hook state directory (#1336): unreadable and unwritable, although the data
    // directory that contains it is a writable root above. The later allows re-expose, read-only,
    // exactly the entries the provider needs: its own settings documents and its own verdict
    // socket. Last matching rule wins, so the order here is the rule.
    ...(guardStateMask?.directories.length
      ? [
        "(deny file-read* file-write*",
        ...guardStateMask.directories.map((path) => `    (subpath ${seatbeltLiteral(path)})`),
        ")",
        // Only the directory's own metadata, so a lookup through it to an exposed entry resolves.
        "(allow file-read-metadata",
        ...guardStateMask.directories.map((path) => `    (literal ${seatbeltLiteral(path)})`),
        ")",
        ...(guardStateMask.readableFiles.length || guardStateMask.readableDirectories.length
          ? [
            "(allow file-read*",
            ...guardStateMask.readableFiles.map((path) => `    (literal ${seatbeltLiteral(path)})`),
            ...guardStateMask.readableDirectories.map((path) => `    (subpath ${seatbeltLiteral(path)})`),
            ")",
          ]
          : []),
        ...(guardStateMask.transportReadable.length || guardStateMask.transportWritable.length
          ? [
            "(allow file-read*",
            ...[...guardStateMask.transportReadable, ...guardStateMask.transportWritable]
              .map((path) => `    (literal ${seatbeltLiteral(path)})`),
            ")",
          ]
          : []),
        ...(guardStateMask.transportWritable.length
          ? [
            "(allow file-write*",
            ...guardStateMask.transportWritable.flatMap((path) => [
              `    (literal ${seatbeltLiteral(path)})`,
              `    (regex ${seatbeltAtomicWriteSiblings(path)})`,
            ]),
            ")",
          ]
          : []),
      ]
      : []),
    ...(network === "inherit" ? ["(allow network*)"] : []),
    // With the network denied the verdict socket still has to be reachable; nothing else is.
    ...(network === "deny" && guardStateMask?.sockets.length
      ? [
        "(allow network-outbound",
        ...guardStateMask.sockets.map((path) => `    (remote unix-socket (path-literal ${seatbeltLiteral(path)}))`),
        ")",
      ]
      : []),
    "",
  ].join("\n");
}

/**
 * The temporary siblings `protectedWrite` creates next to `path` before renaming over it:
 * `.<name>.<pid>.<uuid>.tmp` in the same directory. A path the regex literal cannot carry safely is
 * refused, which fails the launch rather than granting a broader write.
 */
function seatbeltAtomicWriteSiblings(path: string): string {
  if (!path.startsWith("/") || /["\\\0\r\n]/u.test(path)) {
    throw new Error(`Seatbelt isolation cannot express a write rule for ${JSON.stringify(path)}`);
  }
  const escape = (value: string) => value.replace(/[.^$*+?()[\]{}|]/gu, (character) => `\\${character}`);
  return `#"^${escape(posix.dirname(path))}/\\.${escape(posix.basename(path))}\\.[0-9]+\\.[0-9a-f-]+\\.tmp$"`;
}

/** Whether `path` lies strictly inside `directory` (both POSIX; bwrap and Seatbelt are POSIX-only). */
function strictlyInside(directory: string, path: string): boolean {
  const rel = posix.relative(directory, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel);
}

/**
 * Resolve the hook-state mask against the real filesystem. The directory is created when missing,
 * because a directory that appears after the sandbox is built would not be hidden by it. Exposed
 * entries must exist, sit strictly inside the directory, and not be symlinks; anything else is
 * dropped, which only ever hides more.
 */
async function resolveGuardStateMask(
  mask: IsolationStateOptions["guardStateMask"],
  runtime: IsolationDeps,
): Promise<GuardStateMaskOptions | undefined> {
  if (!mask) return undefined;
  const directory = posix.normalize(mask.directory);
  if (!posix.isAbsolute(directory)) throw new Error("the guard state mask needs an absolute directory");
  await runtime.mkdirNative([directory]);
  const readable: string[] = [];
  for (const entry of mask.readable) {
    const path = posix.normalize(entry);
    if (!strictlyInside(directory, path) || readable.includes(path)) continue;
    if (await runtime.isExposableEntryNative(path)) readable.push(path);
  }
  const socket = mask.socket && readable.some((entry) => strictlyInside(entry, mask.socket!))
    ? posix.normalize(mask.socket)
    : undefined;
  // The manager transport's files may not exist yet (the circuit is written on its first failure),
  // so they are kept by position, not by presence; only a path inside the directory is kept.
  const inside = (paths: readonly string[]) => paths.map((path) => posix.normalize(path))
    .filter((path) => strictlyInside(directory, path));
  const managerTransport = mask.managerTransport
    ? { readable: inside(mask.managerTransport.readable), writable: inside(mask.managerTransport.writable) }
    : undefined;
  return {
    directory,
    readable,
    ...(socket ? { socket } : {}),
    ...(managerTransport ? { managerTransport } : {}),
  };
}

async function seatbeltGuardStateMask(
  mask: GuardStateMaskOptions,
  runtime: IsolationDeps,
): Promise<SeatbeltGuardStateMask> {
  const spellings = async (path: string) => {
    const canonical = await runtime.realpathNative(path).catch(() => path);
    return canonical === path ? [path] : [path, canonical];
  };
  const result: SeatbeltGuardStateMask = {
    directories: await spellings(mask.directory),
    readableFiles: [],
    readableDirectories: [],
    sockets: [],
    transportReadable: [],
    transportWritable: [],
  };
  // A file that does not exist yet has no canonical form of its own; its directory's does.
  const fileSpellings = async (path: string) => (await spellings(posix.dirname(path)))
    .map((parent) => posix.join(parent, posix.basename(path)));
  for (const path of mask.managerTransport?.readable ?? []) result.transportReadable.push(...await fileSpellings(path));
  for (const path of mask.managerTransport?.writable ?? []) result.transportWritable.push(...await fileSpellings(path));
  for (const entry of mask.readable) {
    const names = await spellings(entry);
    if (await runtime.existsNative(entry)) result.readableDirectories.push(...names);
    else result.readableFiles.push(...names);
  }
  // A socket's canonical path is its directory's canonical path plus its name, and the directory
  // is what exists to be resolved.
  if (mask.socket) {
    for (const parent of await spellings(posix.dirname(mask.socket))) {
      result.sockets.push(posix.join(parent, posix.basename(mask.socket)));
    }
  }
  return result;
}

/** Deny rules are monotone: an extra entry only ever removes access. Keeping the pathname next to
 * its realpath means an entry whose canonical form cannot be resolved is still denied by name,
 * and a realpath that leaves the granted subpath is denied on both spellings. */
async function seatbeltReadOnlyPaths(
  paths: readonly string[] | undefined,
  isRunnerOwnedEntry: IsolationDeps["isRunnerOwnedEntryNative"],
  realpathNative: IsolationDeps["realpathNative"],
): Promise<string[]> {
  const denied = new Set<string>();
  for (const path of paths ?? []) {
    if (!await isRunnerOwnedEntry(path)) continue;
    denied.add(path);
    try { denied.add(await realpathNative(path)); } catch { /* denied by pathname alone */ }
  }
  return [...denied];
}

/** A bind mount needs a source that exists, and only a worktree's link FILE is runner-owned: a
 * `.git` directory is a real repository whose administrative writes must keep working. Anything
 * else is dropped rather than bound, because a missing or wrong source fails the whole launch. */
async function bwrapReadOnlyBinds(
  paths: readonly string[] | undefined,
  isRunnerOwnedEntry: IsolationDeps["isRunnerOwnedEntryNative"],
): Promise<string[]> {
  const binds = new Set<string>();
  for (const path of paths ?? []) if (await isRunnerOwnedEntry(path)) binds.add(path);
  return [...binds];
}

async function canonicalizeSeatbeltAdditionalWritableRoots(
  roots: readonly string[] | undefined,
  realpathNative: IsolationDeps["realpathNative"],
): Promise<string[] | undefined> {
  if (!roots) return undefined;
  const canonical: string[] = [];
  for (const [index, root] of roots.entries()) {
    try {
      canonical.push(await realpathNative(root));
    } catch {
      throw new Error(
        `Seatbelt isolation could not resolve additional writable root ${index + 1}; ` +
        "ensure it exists and is accessible before launch",
      );
    }
  }
  return canonical;
}

/** Resolve the configured runner-owned boundary in the target process namespace. Failure is
 * terminal for the session: a strict policy must never silently fall back to provider mode. */
export async function resolveExecutionIsolation(
  policy: RunnerExecutionIsolation,
  context: AgentContext,
  deps: Partial<IsolationDeps> = {},
  state?: IsolationStateOptions,
): Promise<SpawnIsolation | undefined> {
  const runtime = { ...defaultDeps, ...deps };
  if (policy.mode === "provider") return undefined;
  if (policy.mode === "bwrap" && context.kind === "wsl" && state) {
    const bridge = wslAgentControlLaunch(state.sessionId);
    if (!bridge || bridge.safeLauncherProtocolVersion !== 1 || !state.ownerHash) {
      throw new Error(WSL_BWRAP_UNAVAILABLE_ERROR);
    }
    const resolved = await runtime.resolveWsl(context);
    if (!resolved || resolved.uid === 0 || resolved.command !== bridge.bwrapRuntime) {
      throw new Error("target-local WSL launcher prerequisites changed after discovery");
    }
    const mapping = statePath(state.driver);
    const targetHome = absoluteHome(state.env.HOME ?? resolved.home, "HOME inside WSL");
    const binds: Array<{ mode: "ro" | "rw"; source: string; target: string }> = [];
    const ensure: string[] = [];
    const sessionState = await runtime.provisionWslSessionState(
      context.distro, state.ownerHash, providerStateKey(state.sessionId), resolved.uid,
    );
    if (mapping) {
      const target = posix.join(targetHome, ...mapping.relative.split("/"));
      ensure.push(target);
      binds.push({ mode: "rw", source: sessionState.provider, target });
    }
    for (const root of state.additionalWritableRoots ?? []) {
      ensure.push(root);
      binds.push({ mode: "rw", source: root, target: root });
    }
    if (!bridge.socketPath) throw new Error("target-local Agent Control socket was not provisioned");
    const socketDirectory = sessionState.relay;
    bridge.socketPath = posix.join(socketDirectory, posix.basename(bridge.socketPath));
    ensure.push(WSL_AGENT_CONTROL_PRIVATE_DIR);
    binds.push({ mode: "ro", source: socketDirectory, target: WSL_AGENT_CONTROL_PRIVATE_DIR });
    const preparation = await runtime.prepareWslIsolation(context, {
      bwrap: bridge.bwrapRuntime,
      home: targetHome,
      cwd: state.cwd,
      ensure,
      binds,
    });
    const preparedSocket = preparation.binds.find((bind) => bind.mode === "ro" &&
      bind.source.path === socketDirectory && bind.target.path === WSL_AGENT_CONTROL_PRIVATE_DIR)?.source;
    if (!preparedSocket) throw new Error("target-local Agent Control socket directory was not attested");
    bridge.socketDirectory = preparedSocket;
    return {
      backend: "wsl-bwrap",
      distro: context.distro,
      command: WSL_BWRAP_LAUNCHER_PATH,
      args: [
        "launch", "--bwrap", bridge.bwrapRuntime,
        "--home", preparation.home.path, preparation.home.identity,
        "--cwd", preparation.cwd.path, preparation.cwd.identity,
        "--network", policy.network,
        ...preparation.binds.flatMap((bind) => [
          `--${bind.mode}`, bind.source.path, bind.source.identity, bind.target.path, bind.target.identity,
        ]),
      ],
      cwd: preparation.cwd.path,
      network: policy.network,
      wslAgentControl: bridge,
    };
  }
  assertExecutionIsolationContextSupported(policy, context);
  if (context.kind === "wsl") {
    throw new Error(`${policy.mode} isolation is native-host only; WSL Direct execution is unavailable`);
  }
  if (policy.mode === "seatbelt") {
    if (runtime.platform !== "darwin") throw new Error(`Seatbelt isolation requires native macOS; native ${runtime.platform} sessions fail closed`);
    if (!state) throw new Error("Seatbelt isolation requires session state and a worktree path");
    const binary = await runtime.resolveNative("sandbox-exec");
    if (!binary) throw new Error("Seatbelt isolation requires /usr/bin/sandbox-exec but it was not found");
    const home = await runtime.realpathNative(state.env.HOME ?? runtime.nativeHome());
    const mapping = statePath(state.driver);
    const providerStatePath = mapping ? posix.join(home, ...mapping.relative.split("/")) : undefined;
    if (providerStatePath) await runtime.mkdirNative([providerStatePath]);
    const additionalWritableRoots = state.orchestratorScratchOnly
      ? undefined
      : await canonicalizeSeatbeltAdditionalWritableRoots(state.additionalWritableRoots, runtime.realpathNative);
    const canonicalState = {
      ...state,
      dataDir: await runtime.realpathNative(state.dataDir),
      cwd: await runtime.realpathNative(state.cwd),
      env: { ...state.env, ...(state.env.HOME ? { HOME: home } : {}) },
      additionalWritableRoots,
      ...(providerStatePath ? { providerStatePath: await runtime.realpathNative(providerStatePath) } : {}),
    };
    const writableRoots = seatbeltWritableRoots(
      canonicalState,
      home,
      await runtime.realpathNative(runtime.nativeTmp()),
    );
    const readOnlyPaths = await seatbeltReadOnlyPaths(
      state.readOnlyPaths,
      runtime.isRunnerOwnedEntryNative,
      runtime.realpathNative,
    );
    const guardStateMask = await resolveGuardStateMask(state.guardStateMask, runtime);
    return {
      backend: "seatbelt",
      command: binary.launch.command,
      args: binary.launch.args,
      network: policy.network,
      profile: renderSeatbeltProfile(
        writableRoots,
        policy.network,
        readOnlyPaths,
        guardStateMask ? await seatbeltGuardStateMask(guardStateMask, runtime) : undefined,
      ),
      writableRoots,
      ...(readOnlyPaths.length ? { readOnlyPaths } : {}),
      ...(guardStateMask ? { guardStateMask } : {}),
    };
  }
  if (policy.mode === "windows-job") {
    if (runtime.platform !== "win32") throw new Error(`Windows Job isolation requires native Windows; native ${runtime.platform} sessions fail closed`);
    const binary = await runtime.resolveNative("powershell");
    if (!binary) throw new Error("Windows Job isolation requires Windows PowerShell but powershell.exe was not found");
    return {
      backend: "windows-job",
      command: binary.launch.command,
      args: [
        ...binary.launch.args,
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", runtime.materializeWindowsJobLauncher(),
      ],
      network: "inherit",
    };
  }
  if (runtime.platform !== "linux") {
    throw new Error(`bubblewrap isolation requires native Linux; native ${runtime.platform} sessions fail closed`);
  }
  if (runtime.uid() === 0) throw new Error("bubblewrap isolation refuses a root runner");
  const binary = await runtime.resolveNative("bwrap");
  if (!binary) throw new Error("bubblewrap is required by runner policy but bwrap was not found on PATH");
  const mapping = state && statePath(state.driver);
  const writableBinds = mapping ? (() => {
    const targetHome = absoluteHome(state?.env.HOME ?? runtime.nativeHome(), "HOME on Linux");
    const location = providerStateLocation(state.dataDir, state.driver, state.sessionId)!;
    return [{
      source: location.leaf,
      target: posix.join(targetHome, ...mapping.relative.split("/")),
    }];
  })() : [];
  for (const root of state?.additionalWritableRoots ?? []) writableBinds.push({ source: root, target: root });
  if (writableBinds.length) await runtime.mkdirNative(writableBinds.flatMap((bind) => [bind.source, bind.target]));
  // Resolved after the writable binds are materialized: the entries live inside those roots, and
  // the launcher renders them last so the narrower read-only rule wins over the containing mount.
  const readOnlyBinds = await bwrapReadOnlyBinds(state?.readOnlyPaths, runtime.isRunnerOwnedEntryNative);
  // bwrap renders the directory read-only as a whole, so the manager transport's writes cannot be
  // granted there; its entries are not carried (docs/agent-control.md, "Known limits").
  const resolvedMask = await resolveGuardStateMask(state?.guardStateMask, runtime);
  const guardStateMask = resolvedMask
    ? { directory: resolvedMask.directory, readable: resolvedMask.readable, ...(resolvedMask.socket ? { socket: resolvedMask.socket } : {}) }
    : undefined;
  return {
    backend: "bwrap",
    command: binary.launch.command,
    args: binary.launch.args,
    network: policy.network,
    ...(writableBinds.length ? { writableBinds } : {}),
    ...(readOnlyBinds.length ? { readOnlyBinds } : {}),
    ...(guardStateMask ? { guardStateMask } : {}),
  };
}

/** Copy a completed source transcript store after the provider creates and persists its fork. The
 * target remains unpublished until this copy completes; failures are loud and caller-cleaned. */
export async function cloneExecutionIsolationState(
  policy: RunnerExecutionIsolation,
  context: AgentContext,
  driver: AgentDriverKind,
  dataDir: string,
  sourceSessionId: string,
  targetSessionId: string,
  deps: Partial<IsolationDeps> = {},
  ownerHash?: string,
): Promise<void> {
  if (policy.mode !== "bwrap" || !statePath(driver)) return;
  const runtime = { ...defaultDeps, ...deps };
  if (context.kind === "wsl") {
    const resolved = await runtime.resolveWsl(context);
    if (!resolved) throw new Error(`cannot transfer isolated provider state inside WSL distro ${context.distro}`);
    const base = wslRunnerStateBase(resolved.home, ownerHash);
    await runtime.copyWsl(
      context,
      providerStateLocation(base, driver, sourceSessionId)!,
      providerStateLocation(base, driver, targetSessionId)!,
    );
    return;
  }
  await runtime.copyNative(
    providerStateLocation(dataDir, driver, sourceSessionId)!,
    providerStateLocation(dataDir, driver, targetSessionId)!,
  );
}

/** Provider fork RPCs may resolve before their transcript file reaches disk. Poll the exact
 * session partition and refuse to publish/copy a child whose provider artifact is not visible. */
export async function verifyExecutionIsolationForkState(
  policy: RunnerExecutionIsolation,
  context: AgentContext,
  driver: AgentDriverKind,
  dataDir: string,
  sourceSessionId: string,
  providerSessionId: string,
  deps: Partial<IsolationDeps> = {},
  ownerHash?: string,
): Promise<void> {
  if (policy.mode !== "bwrap" || !statePath(driver)) return;
  safeProviderSessionId(providerSessionId);
  const runtime = { ...defaultDeps, ...deps };
  let previousSize: number | null = null;
  let stableReads = 0;
  if (context.kind === "wsl") {
    const resolved = await runtime.resolveWsl(context);
    if (!resolved) throw new Error(`cannot verify isolated provider fork inside WSL distro ${context.distro}`);
    const base = wslRunnerStateBase(resolved.home, ownerHash);
    const location = providerStateLocation(base, driver, sourceSessionId)!;
    for (let attempt = 0; attempt < 20 && stableReads < 2; attempt++) {
      const size = await runtime.forkSizeWsl(context, location, driver, providerSessionId);
      stableReads = size !== null && size > 0 && size === previousSize ? stableReads + 1 : 0;
      previousSize = size;
      if (stableReads < 2 && attempt < 19) await runtime.wait(250);
    }
  } else {
    const location = providerStateLocation(dataDir, driver, sourceSessionId)!;
    for (let attempt = 0; attempt < 20 && stableReads < 2; attempt++) {
      const size = await runtime.forkSizeNative(location, driver, providerSessionId);
      stableReads = size !== null && size > 0 && size === previousSize ? stableReads + 1 : 0;
      previousSize = size;
      if (stableReads < 2 && attempt < 19) await runtime.wait(250);
    }
  }
  if (stableReads < 2) {
    throw new Error(`provider fork ${providerSessionId} did not reach a stable non-empty isolated transcript artifact`);
  }
}

/** Upgrade the legacy provider-wide transcript root into a session partition. The legacy root is
 * deliberately retained until the later reconciliation slice has migrated every old session. */
export async function migrateExecutionIsolationState(
  policy: RunnerExecutionIsolation,
  context: AgentContext,
  driver: AgentDriverKind,
  dataDir: string,
  sessionId: string,
  deps: Partial<IsolationDeps> = {},
  ownerHash?: string,
): Promise<void> {
  if (policy.mode !== "bwrap" || !statePath(driver)) return;
  const runtime = { ...defaultDeps, ...deps };
  if (context.kind === "wsl") {
    const resolved = await runtime.resolveWsl(context);
    if (!resolved) throw new Error(`cannot migrate isolated provider state inside WSL distro ${context.distro}`);
    const sharedBase = wslRunnerStateBase(resolved.home);
    const ownedBase = wslRunnerStateBase(resolved.home, ownerHash);
    const legacy = legacyProviderStateLocation(sharedBase, driver)!;
    const partition = providerStateLocation(sharedBase, driver, sessionId)!;
    const ownedPartition = providerStateLocation(ownedBase, driver, sessionId)!;
    if (ownerHash && (await runtime.existsWsl(context, legacy.leaf) || await runtime.existsWsl(context, partition.leaf))) {
      throw new Error(
        `legacy WSL provider state at ${legacy.leaf} or ${partition.leaf} has no control-plane ownership proof; ` +
        `stop all pre-attestation runners, archive those retained bytes, and manually migrate the intended session to ${ownedPartition.leaf} before resuming`,
      );
    }
    if (!await runtime.existsWsl(context, legacy.leaf)) return;
    await runtime.copyWsl(context, legacy, ownedPartition);
    return;
  }
  const legacy = legacyProviderStateLocation(dataDir, driver)!;
  if (!await runtime.existsNative(legacy.leaf)) return;
  await runtime.copyNative(legacy, providerStateLocation(dataDir, driver, sessionId)!);
}

/** Operator-authorized offline adoption for unattributable WSL bwrap state. Exactly one legacy
 * source shape may exist; the source is copied into the attested root and never removed. */
export async function adoptLegacyWslExecutionIsolationState(
  context: Extract<AgentContext, { kind: "wsl" }>,
  driver: AgentDriverKind,
  sessionId: string,
  ownerHash: string,
  deps: Partial<IsolationDeps> = {},
): Promise<"absent" | "adopted"> {
  if (!statePath(driver)) return "absent";
  if (!/^[a-f0-9]{64}$/u.test(ownerHash)) throw new Error("WSL provider adoption requires an attested owner hash");
  const runtime = { ...defaultDeps, ...deps };
  const resolved = await runtime.resolveWsl(context);
  if (!resolved) throw new Error(`cannot inventory legacy provider state inside WSL distro ${context.distro}`);
  const sharedBase = wslRunnerStateBase(resolved.home);
  const providerWide = legacyProviderStateLocation(sharedBase, driver)!;
  const partition = providerStateLocation(sharedBase, driver, sessionId)!;
  const hasProviderWide = await runtime.existsWsl(context, providerWide.leaf);
  const hasPartition = await runtime.existsWsl(context, partition.leaf);
  if (hasProviderWide && hasPartition) {
    throw new Error("legacy WSL provider state has both provider-wide and partitioned sources; quarantine or resolve it explicitly");
  }
  const source = hasPartition ? partition : hasProviderWide ? providerWide : null;
  if (!source) return "absent";
  const target = providerStateLocation(wslRunnerStateBase(resolved.home, ownerHash), driver, sessionId)!;
  if (await runtime.existsWsl(context, target.leaf)) {
    throw new Error("owned WSL provider-state target already exists; refusing to merge or overwrite it");
  }
  await runtime.copyWsl(context, source, target);
  return "adopted";
}

/** Best-effort callers may use this during failed-fork/session cleanup. It removes only the hashed
 * session partition and never follows a control-plane id as a path. */
export async function removeExecutionIsolationState(
  policy: RunnerExecutionIsolation,
  context: AgentContext,
  driver: AgentDriverKind,
  dataDir: string,
  sessionId: string,
  deps: Partial<IsolationDeps> = {},
  ownerHash?: string,
): Promise<void> {
  if (policy.mode !== "bwrap" || !statePath(driver)) return;
  const runtime = { ...defaultDeps, ...deps };
  if (context.kind === "wsl") {
    if (!ownerHash) throw new Error("cannot clean Direct WSL provider state without an attested runner owner");
    await runtime.cleanupWslSessionState(context.distro, ownerHash, providerStateKey(sessionId));
    return;
  }
  await runtime.removeNative(providerStateLocation(dataDir, driver, sessionId)!);
}
