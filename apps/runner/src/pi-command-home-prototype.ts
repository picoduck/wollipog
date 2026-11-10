/** Experimental #3922 seam. Not wired to provider launches and never advertises protection.
 * Its caller must still prove the actual outer/inner topology and complete Pi execution coverage. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { buildBwrapArgs, killTree, provenProcessTreeExit, spawnAgent,
  type BwrapSpawnIsolation } from "./spawn.js";

export const PI_COMMAND_HOME_PROTOTYPE_VERSION = "0.85.0";
/** Exact installed code audited 2026-11-10. No mutable-main or version-only compatibility claim. */
export const PI_COMMAND_HOME_SOURCE_PINS = Object.freeze({
  "dist/bundle/cli.js": "4c152df1ef4b743898ec780e49cf7a197e4032a4b0696f645730aa8c18703b96",
  "dist/core/tools/bash.js": "5f5bc414757f2b4888c9300646d14518979cda638c68ba1836acca8835dd280a",
  "dist/core/tools/bash.d.ts": "7e7032a3ea31f4e63e55adb81b5d76dee9900ea4a0ff286b858cebe7d2d70d29",
  "dist/modes/rpc/rpc-mode.js": "e7e4724aa55c5aac73cf36793653b26736200e5c59d58373990fc31028f86477",
  "dist/core/agent-session.js": "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f",
  "dist/core/resource-loader.js": "8e8a1bc1c5bc9e955f6a2314dd1db02071be56d48b1fea7b8b2cacb4fc9a0628",
  "dist/core/extensions/types.d.ts": "5baa29ca2f541f71f81a400dec25903abfbd03980bd4d9b691d10353e52d169a",
});
const REFUSAL = "Pi command-home prototype could not prove its immutable execution boundary.";
const within = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
};
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

/** Conservative eligibility only. Never add flags, drop user tools/extensions or infer versions. */
export function piCommandHomePrototypeEligible(version: string | undefined, args: readonly string[], platform = process.platform): boolean {
  return platform === "linux" && version === PI_COMMAND_HOME_PROTOTYPE_VERSION &&
    args.length === 1 && args[0] === "--no-extensions";
}

export interface PiCommandHomePrototypePolicy {
  outer: BwrapSpawnIsolation;
  providerHome: string;
  /** Entire imported runtime/dependency trees and generated hook. Must remain immutable outside
   * every writable source and target, not merely have their launch spelling quoted. */
  immutablePaths: readonly string[];
  shell: string;
  envCommand: string;
  installationRoot: string;
  version: string;
  /** The selected argv BEFORE any runner extension injection. */
  configuredArgs: readonly string[];
}

/** Reads installed code/schema only, never executes Pi or reads a provider state directory. */
export function verifyPiCommandHomePrototypeInstallation(root: string): boolean {
  try {
    canonical(root);
    const metadata = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
    if (metadata.name !== "@earendil-works/pi-coding-agent" || metadata.version !== PI_COMMAND_HOME_PROTOTYPE_VERSION) return false;
    return Object.entries(PI_COMMAND_HOME_SOURCE_PINS).every(([name, sha]) =>
      createHash("sha256").update(readFileSync(canonical(`${root}/${name}`))).digest("hex") === sha);
  } catch { return false; }
}

function canonical(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || realpathSync(path) !== path) throw new Error(REFUSAL);
  return path;
}

/** Read metadata only, never credential contents. Refuse pre-existing aliases into writable roots.
 * The experimental caller supplies synthetic homes; production admission is not implemented. */
function noProviderAliases(root: string, budget = { left: 10_000 }): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (--budget.left < 0 || entry.isSymbolicLink()) throw new Error(REFUSAL);
    if (entry.isDirectory()) noProviderAliases(`${root}/${entry.name}`, budget);
  }
}

export function createPiCommandHomePrototype(policy: PiCommandHomePrototypePolicy, deps: Partial<{
  spawn: typeof spawnAgent; kill: typeof killTree; prove: typeof provenProcessTreeExit;
  auditInstallation: typeof verifyPiCommandHomePrototypeInstallation;
}> = {}) {
  const shell = policy.shell;
  const envCommand = policy.envCommand;
  let inner: BwrapSpawnIsolation;
  let cwdRoot: string;
  try {
    const outer = policy.outer;
    if (!piCommandHomePrototypeEligible(policy.version, policy.configuredArgs) ||
        !(deps.auditInstallation ?? verifyPiCommandHomePrototypeInstallation)(policy.installationRoot)) throw new Error(REFUSAL);
    if (process.platform !== "linux" || !outer.protectedWorktree || outer.args.length !== 0 ||
        outer.wslAgentControl || outer.claudeNamespace) throw new Error(REFUSAL);
    canonical(outer.command); canonical(policy.shell); canonical(policy.envCommand);
    const home = canonical(policy.providerHome);
    if (!lstatSync(home).isDirectory()) throw new Error(REFUSAL);
    noProviderAliases(home);
    cwdRoot = canonical(outer.protectedWorktree.path);
    const binds = (outer.writableBinds ?? []).flatMap(bind => {
      canonical(bind.source); canonical(bind.target);
      if (bind.source === home && bind.target === home) return [];
      if (overlaps(home, bind.source) || overlaps(home, bind.target)) throw new Error(REFUSAL);
      // Aliased mutable storage defeats a canonical-path proof. This prototype accepts only
      // identity binds already present in the immutable provider launch policy.
      if (bind.source !== bind.target) throw new Error(REFUSAL);
      return [{ ...bind }];
    });
    const writable = [cwdRoot, ...outer.protectedWorktree.gitWritableRoots,
      ...(outer.protectedWorktree.ownedWorktrees ?? []).flatMap(worktree => [worktree.path, worktree.gitAdmin]),
      ...binds.map(bind => bind.target)];
    for (const path of writable) {
      canonical(path);
      if (overlaps(home, path)) throw new Error(REFUSAL);
    }
    const immutable = [outer.command, policy.shell, policy.envCommand, policy.installationRoot, ...policy.immutablePaths];
    if (policy.immutablePaths.length === 0) throw new Error(REFUSAL);
    for (const path of immutable) {
      canonical(path);
      if (path === "/tmp" || path.startsWith("/tmp/") || path === "/dev" || path.startsWith("/dev/") ||
          path === "/proc" || path.startsWith("/proc/") || writable.some(root => overlaps(root, path))) throw new Error(REFUSAL);
    }
    inner = structuredClone({ ...outer, writableBinds: binds,
      // Last after every writable grant. Nothing makes HOME writable or enlarges Git/tmp grants.
      readOnlyBinds: [...(outer.readOnlyBinds ?? []), home, ...immutable] });
    delete inner.preservesProviderHome;
  } catch {
    throw new Error(REFUSAL);
  }
  const spawn = deps.spawn ?? spawnAgent;
  const kill = deps.kill ?? killTree;
  const prove = deps.prove ?? provenProcessTreeExit;
  return Object.freeze({
    async exec(command: string, cwd: string, options: {
      onData(data: Buffer): void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv;
    }): Promise<{ exitCode: number | null }> {
      if (options.signal?.aborted) throw new Error("Pi command-home prototype command cancelled.");
      try {
        canonical(cwd);
        if (!within(cwdRoot, cwd) || typeof command !== "string" || command.includes("\0") ||
            (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 ||
              options.timeout > 2_147_483))) throw new Error(REFUSAL);
      } catch { throw new Error(REFUSAL); }
      const environment: string[] = [];
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes("\0")) throw new Error(REFUSAL);
        environment.push(`${key}=${value}`);
      }
      // bwrap itself never receives model/tool environment or loader injection. The env payload
      // is applied by trusted env only after the child namespace exists, not by a shell prefix.
      const args = buildBwrapArgs({ command: envCommand,
        args: ["-i", ...environment, shell, "-c", command], cwd }, inner);
      const child = spawn({ command: inner.command, args, cwd,
        env: { PATH: "/usr/bin:/bin", LANG: "C" }, scrubInheritedEnv: Object.keys(process.env),
        context: { kind: "native" }, windowsShell: false });
      child.stdin.end();
      child.stdout.on("data", options.onData); child.stderr.on("data", options.onData);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;
      const cancel = () => { cancelled = true; void kill(child); };
      if (options.signal) {
        options.signal.addEventListener("abort", cancel, { once: true });
        if (options.signal.aborted) cancel();
      }
      if (options.timeout !== undefined) timer = setTimeout(cancel, options.timeout * 1000);
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", () => reject(new Error("Pi command-home prototype sandbox failed.")));
          child.once("close", code => resolve(code));
        });
        if (!await prove(child)) throw new Error("Pi command-home prototype could not prove command-tree exit.");
        if (cancelled) throw new Error("Pi command-home prototype command cancelled.");
        return { exitCode };
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      }
    },
  });
}

type PrototypeOperations = ReturnType<typeof createPiCommandHomePrototype>;
interface PrototypeTool {
  name: string;
  execute(...args: unknown[]): Promise<unknown>;
  [key: string]: unknown;
}
interface PrototypePiApi {
  registerTool(tool: PrototypeTool): void;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string; sourceInfo: { source: string; path: string } }>;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

/** Synthetic-integration seam for the pinned Pi APIs. There is deliberately no runner launch
 * wiring or protected capability. SDK and extension imports must be immutable before activation. */
export function installPiCommandHomePrototype(
  pi: PrototypePiApi,
  sdk: { createBashTool(cwd: string, options: { operations: PrototypeOperations }): PrototypeTool },
  operations: PrototypeOperations,
  cwd: string,
  extensionPath: string,
): void {
  let ready = false;
  const trustedInventory = () => {
    try {
      const all = pi.getAllTools();
      const active = pi.getActiveTools();
      const builtins = new Set(["read", "edit", "write", "grep", "find", "ls", "powershell"]);
      return new Set(all.map(tool => tool.name)).size === all.length &&
        active.includes("bash") && active.every(name => ["read", "bash", "edit", "write"].includes(name)) &&
        all.some(tool => tool.name === "bash" && tool.sourceInfo.path === extensionPath) &&
        all.every(tool => tool.name === "bash"
          ? tool.sourceInfo.path === extensionPath
          : builtins.has(tool.name) && tool.sourceInfo.source === "builtin");
    } catch { return false; }
  };
  const tool = sdk.createBashTool(cwd, { operations });
  if (tool.name !== "bash" || typeof tool.execute !== "function") throw new Error(REFUSAL);
  pi.registerTool({ ...tool, async execute(...args: unknown[]) {
    if (!ready || !trustedInventory()) throw new Error(REFUSAL);
    return tool.execute(...args);
  } });
  pi.on("session_start", () => { ready = trustedInventory(); });
  pi.on("session_shutdown", () => { ready = false; });
  pi.on("tool_call", () => ready && trustedInventory() ? undefined : { block: true, reason: REFUSAL });
  const refused = Object.freeze({ async exec(): Promise<{ exitCode: number | null }> { throw new Error(REFUSAL); } });
  // RPC bash and interactive user_bash pass this operations object into executeBash in pinned
  // 0.85.0. Always return an operations object: undefined would invoke Pi's local fallback.
  pi.on("user_bash", () => ({ operations: ready && trustedInventory() ? operations : refused }));
}
