import type { AgentContext } from "@wollipog/protocol";
import type { AgentDriverKind } from "@wollipog/protocol";
import { createHash } from "node:crypto";
import { cp, mkdir, opendir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { RunnerExecutionIsolation } from "./config.js";
import { runContextCommand } from "./context-command.js";
import { resolveNative, type ResolvedBinary } from "./discovery/resolve.js";
import type { SpawnIsolation } from "./spawn.js";
import { WINDOWS_JOB_ENCODED_COMMAND } from "./windows-job.js";

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
  existsNative: (path: string) => Promise<boolean>;
  existsWsl: (context: Extract<AgentContext, { kind: "wsl" }>, path: string) => Promise<boolean>;
  forkSizeNative: (location: ProviderStateLocation, driver: AgentDriverKind, providerSessionId: string) => Promise<number | null>;
  forkSizeWsl: (context: Extract<AgentContext, { kind: "wsl" }>, location: ProviderStateLocation, driver: AgentDriverKind, providerSessionId: string) => Promise<number | null>;
  wait: (ms: number) => Promise<void>;
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
  existsNative: async (path) => stat(path).then((value) => value.isDirectory(), () => false),
  existsWsl: async (context, path) => runContextCommand(
    context, "test", ["-d", path], { cwd: "/", timeoutMs: 5_000 },
  ).then(() => true, () => false),
  forkSizeNative: async (location, driver, providerSessionId) => {
    return findProviderForkSizeNative(location.leaf, driver, providerSessionId, 0);
  },
  forkSizeWsl: async (context, location, driver, providerSessionId) => {
    const pattern = driver === "claude-code" ? `${providerSessionId}.jsonl` : `*-${providerSessionId}.jsonl`;
    return runContextCommand(
      context,
      "find",
      [location.leaf, "-maxdepth", "8", "-type", "f", "-name", pattern, "-printf", "%s\\n", "-quit"],
      { cwd: "/", timeoutMs: 5_000 },
    ).then((result) => {
      const size = Number(result.stdout.trim());
      return Number.isSafeInteger(size) && size >= 0 ? size : null;
    }, () => null);
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface IsolationStateOptions {
  driver: AgentDriverKind;
  dataDir: string;
  env: Record<string, string>;
  sessionId: string;
  cwd: string;
  /** Canonical shared provider leaf used by Seatbelt when a home component is symlinked. */
  providerStatePath?: string;
}

interface ProviderStateLocation { root: string; leaf: string; }

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

function legacyProviderStateLocation(base: string, driver: AgentDriverKind): ProviderStateLocation | null {
  const mapping = statePath(driver);
  if (!mapping) return null;
  const root = posix.join(base, "provider-state", mapping.provider);
  return { root, leaf: posix.join(root, mapping.relative.split("/").at(-1)!) };
}

function providerForkFileMatches(driver: AgentDriverKind, providerSessionId: string, filename: string): boolean {
  if (driver === "claude-code") return filename === `${providerSessionId}.jsonl`;
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

/** A parameter-free Seatbelt profile. It intentionally grants read access for installed CLI,
 * credential, toolchain, and system compatibility while restricting writes to the worktree,
 * runner data, temporary directory, and the provider's real transcript leaf. Unlike bwrap,
 * Seatbelt cannot mount a per-session transcript leaf over the provider's home path. */
export function buildSeatbeltProfile(
  state: IsolationStateOptions,
  home: string,
  network: "inherit" | "deny",
  nativeTmp = tmpdir(),
): string {
  const mapping = statePath(state.driver);
  const paths = new Set([state.cwd, state.dataDir, nativeTmp]);
  if (mapping) paths.add(state.providerStatePath ?? posix.join(
    absoluteHome(state.env.HOME ?? home, "HOME on macOS"), ...mapping.relative.split("/"),
  ));
  const writeRules = [...paths].map((path) => `    (subpath ${seatbeltLiteral(path)})`).join("\n");
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
    ...(network === "inherit" ? ["(allow network*)"] : []),
    "",
  ].join("\n");
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
  if (context.kind === "wsl") {
    if (policy.mode !== "bwrap") {
      throw new Error(`${policy.mode} isolation is native-host only; WSL sessions require bwrap`);
    }
    const resolved = await runtime.resolveWsl(context);
    if (!resolved) throw new Error(`bubblewrap is required inside WSL distro ${context.distro} by runner policy`);
    if (resolved.uid === 0) throw new Error(`bubblewrap isolation refuses root execution inside WSL distro ${context.distro}`);
    const mapping = state && statePath(state.driver);
    const writableBinds = mapping ? (() => {
      const targetHome = absoluteHome(state?.env.HOME ?? resolved.home, "HOME inside WSL");
      const location = providerStateLocation(`${resolved.home}/.agent-manager`, state.driver, state.sessionId)!;
      return [{
        source: location.leaf,
        target: `${targetHome}/${mapping.relative}`,
      }];
    })() : [];
    if (writableBinds.length) await runtime.mkdirWsl(context, writableBinds.flatMap((bind) => [bind.source, bind.target]));
    return {
      backend: "bwrap", command: resolved.command, args: [], network: policy.network,
      ...(writableBinds.length ? { writableBinds } : {}),
    };
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
    const canonicalState = {
      ...state,
      dataDir: await runtime.realpathNative(state.dataDir),
      cwd: await runtime.realpathNative(state.cwd),
      env: { ...state.env, ...(state.env.HOME ? { HOME: home } : {}) },
      ...(providerStatePath ? { providerStatePath: await runtime.realpathNative(providerStatePath) } : {}),
    };
    return {
      backend: "seatbelt",
      command: binary.launch.command,
      args: binary.launch.args,
      network: policy.network,
      profile: buildSeatbeltProfile(
        canonicalState,
        home,
        policy.network,
        await runtime.realpathNative(runtime.nativeTmp()),
      ),
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
        "-EncodedCommand", WINDOWS_JOB_ENCODED_COMMAND,
      ],
      network: "inherit",
    };
  }
  if (runtime.platform !== "linux") {
    throw new Error(`bubblewrap isolation requires Linux or WSL; native ${runtime.platform} sessions fail closed`);
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
  if (writableBinds.length) await runtime.mkdirNative(writableBinds.flatMap((bind) => [bind.source, bind.target]));
  return {
    backend: "bwrap",
    command: binary.launch.command,
    args: binary.launch.args,
    network: policy.network,
    ...(writableBinds.length ? { writableBinds } : {}),
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
): Promise<void> {
  if (policy.mode !== "bwrap" || !statePath(driver)) return;
  const runtime = { ...defaultDeps, ...deps };
  if (context.kind === "wsl") {
    const resolved = await runtime.resolveWsl(context);
    if (!resolved) throw new Error(`cannot transfer isolated provider state inside WSL distro ${context.distro}`);
    const base = `${absoluteHome(resolved.home, "probed HOME inside WSL")}/.agent-manager`;
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
): Promise<void> {
  if (policy.mode !== "bwrap" || !statePath(driver)) return;
  safeProviderSessionId(providerSessionId);
  const runtime = { ...defaultDeps, ...deps };
  let previousSize: number | null = null;
  let stableReads = 0;
  if (context.kind === "wsl") {
    const resolved = await runtime.resolveWsl(context);
    if (!resolved) throw new Error(`cannot verify isolated provider fork inside WSL distro ${context.distro}`);
    const base = `${absoluteHome(resolved.home, "probed HOME inside WSL")}/.agent-manager`;
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
): Promise<void> {
  if (policy.mode !== "bwrap" || !statePath(driver)) return;
  const runtime = { ...defaultDeps, ...deps };
  if (context.kind === "wsl") {
    const resolved = await runtime.resolveWsl(context);
    if (!resolved) throw new Error(`cannot migrate isolated provider state inside WSL distro ${context.distro}`);
    const base = `${absoluteHome(resolved.home, "probed HOME inside WSL")}/.agent-manager`;
    const legacy = legacyProviderStateLocation(base, driver)!;
    if (!await runtime.existsWsl(context, legacy.leaf)) return;
    await runtime.copyWsl(context, legacy, providerStateLocation(base, driver, sessionId)!);
    return;
  }
  const legacy = legacyProviderStateLocation(dataDir, driver)!;
  if (!await runtime.existsNative(legacy.leaf)) return;
  await runtime.copyNative(legacy, providerStateLocation(dataDir, driver, sessionId)!);
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
): Promise<void> {
  if (policy.mode !== "bwrap" || !statePath(driver)) return;
  const runtime = { ...defaultDeps, ...deps };
  if (context.kind === "wsl") {
    const home = await runtime.resolveWslHome(context);
    if (!home) throw new Error(`cannot clean isolated provider state inside WSL distro ${context.distro}`);
    const base = `${home}/.agent-manager`;
    await runtime.removeWsl(context, providerStateLocation(base, driver, sessionId)!);
    return;
  }
  await runtime.removeNative(providerStateLocation(dataDir, driver, sessionId)!);
}
