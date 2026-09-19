/**
 * Codex's form of the managed-worktree guard (#1377).
 *
 * Codex's worktree protection has always lived in the structured driver: `buildCodexTurnParams`
 * narrows `danger-full-access` while a runner-owned worktree is live, and the driver decides each
 * approval through `commandTargetsManagedWorktree`. A TUI runs no driver, so neither exists there
 * and a Codex TUI launch carried no protection at all.
 *
 * Codex does have a provider-side interception point that survives an argv-only launch, and it is
 * the same shape Claude's is. Measured against codex-cli 0.155.1 on this machine (2026-09-18), in
 * a throwaway `CODEX_HOME` against a throwaway repository and worktree:
 *
 *   - `hooks` is a STABLE feature, on with no configuration (`codex features list`), and
 *     `PreToolUse` is one of its events.
 *   - The `PreToolUse` stdin payload is Claude-shaped: `tool_name` (`Bash` for a shell call,
 *     `apply_patch` for an edit), `tool_input.command`, `cwd`, `permission_mode`. A deny is the
 *     same `hookSpecificOutput` document `managedWorktreeGuardDenyPayload` already writes, and
 *     exit 2 with a reason on stderr also blocks. So the runner's existing `--managed-worktree-guard`
 *     sidecar needs no Codex-specific decision logic.
 *   - A hook can be installed from argv alone: `-c hooks.PreToolUse=[...]`, which `hooks/list`
 *     reports with source `sessionFlags`. `-c` is a top-level flag the interactive TUI accepts,
 *     and hooks from different sources MERGE, so the runner's hook is added to the user's own
 *     rather than replacing them.
 *   - Trust gates it, and an untrusted hook is skipped SILENTLY: with the override in place and no
 *     trust bypass, `git worktree remove <worktree>` ran and the worktree was removed without the
 *     hook process ever starting. `--dangerously-bypass-hook-trust` (also top-level) is what makes
 *     a session-flags hook run; no way to persist trust for one was found, and `hooks.managed_dir`
 *     is a managed/MDM key that `-c` does not honour.
 *   - End to end with the real sidecar: `git status --short` ran, and the issue's
 *     `git worktree remove <worktree>` was refused with `Command blocked by PreToolUse hook:`
 *     followed by `MANAGED_WORKTREE_REFUSAL`, leaving the worktree in place.
 *   - The Claude fail-open hole is present here too: a sidecar that cannot START is reported as a
 *     failed hook and the tool call PROCEEDS. `verifyManagedWorktreeGuardLaunch` and
 *     `cwdIndependentExecArgv` already cover that and are provider-independent.
 *
 * The trust bypass is per-invocation rather than per-hook, so this module does not simply set it:
 * it first enumerates the launch's effective hook inventory and refuses to use the bypass when any
 * hook other than the runner's own would be un-gated by it. That enumeration doubles as the Codex
 * half of the launch self-test, because a runner hook that does not appear in the inventory —
 * a `--disable hooks`, a future config-schema change, a quoting mistake — is a guard that would
 * never have run.
 */

import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { quote } from "shell-quote";
import {
  MANAGED_WORKTREE_GUARD_MATCHER,
  MANAGED_WORKTREE_GUARD_MODE,
} from "./managed-worktree-guard.js";

/** Codex drivers whose TUI launch is the interactive `codex` CLI. */
export const CODEX_GUARD_DRIVERS: ReadonlySet<string> = new Set(["codex", "codex-app-server"]);

/**
 * Codex runs an ENABLED hook only when it is trusted, and a session-flags hook can never be. This
 * flag lifts that requirement for one invocation — for every enabled hook, not just the runner's —
 * which is why `codexHookInventoryVerdict` refuses when the inventory holds a foreign untrusted one.
 */
export const CODEX_HOOK_TRUST_BYPASS_FLAG = "--dangerously-bypass-hook-trust";

const CODEX_GUARD_OVERRIDE_PREFIX = "hooks.PreToolUse=";
/** Config overrides carry the same value in either spelling; both are scanned. */
const CODEX_CONFIG_FLAGS: ReadonlySet<string> = new Set(["-c", "--config"]);
const CODEX_FEATURE_FLAGS: ReadonlySet<string> = new Set(["--enable", "--disable"]);
/**
 * A profile layers `$CODEX_HOME/<name>.config.toml`, which may declare hooks, and `app-server`
 * accepts no `--profile`. The inventory below could therefore not see what the TUI would load, so
 * a profiled launch is treated as un-enumerable rather than enumerated incorrectly.
 */
const CODEX_PROFILE_FLAGS: ReadonlySet<string> = new Set(["-p", "--profile"]);
/** Trust states under which Codex runs an enabled hook without the invocation-wide bypass. */
const CODEX_TRUSTED_STATUSES: ReadonlySet<string> = new Set(["trusted", "managed"]);
const CODEX_HOOK_INVENTORY_TIMEOUT_MS = 20_000;

/** A TOML basic string. Control characters are refused rather than escaped: no path the runner
 * builds contains one, and a value that needs escaping is a value worth failing closed on. */
function tomlString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Codex hook value contains a control character");
  }
  return JSON.stringify(value);
}

/**
 * The sidecar's argv as the ONE shell command string a Codex hook handler takes (it runs it
 * through `-lc`), rather than Claude's command-plus-argv pair. It is also the identity the
 * inventory below matches the runner's own hook by.
 */
export function codexGuardCommandString(launch: { command: string; args: readonly string[] }): string {
  return quote([launch.command, ...launch.args]);
}

/**
 * The `-c` override that installs the runner's sidecar as a Codex `PreToolUse` hook.
 *
 * The `--protections` argument travels inside that command string exactly as it travels in
 * Claude's settings document; it is never exported into the environment, where every tool process
 * would see it.
 */
export function codexGuardConfigOverride(launch: { command: string; args: readonly string[] }): string {
  return `${CODEX_GUARD_OVERRIDE_PREFIX}[{matcher=${tomlString(MANAGED_WORKTREE_GUARD_MATCHER)},` +
    `hooks=[{type="command",command=${tomlString(codexGuardCommandString(launch))}}]}]`;
}

/** Does this argument carry a `hooks.PreToolUse` override, in any spelling Codex accepts? */
function declaresPreToolUseHooks(argument: string): boolean {
  return argument.includes(CODEX_GUARD_OVERRIDE_PREFIX);
}

/**
 * Drop a runner-owned guard override already present in the argv, leaving every user- or
 * catalog-supplied `-c` alone. Recognised by the re-entry mode inside it, the same way a
 * runner-owned Claude settings file is recognised by declaring the guard.
 */
export function withoutCodexGuardArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index + 1];
    if (CODEX_CONFIG_FLAGS.has(args[index]!) && value !== undefined &&
        value.startsWith(CODEX_GUARD_OVERRIDE_PREFIX) && value.includes(MANAGED_WORKTREE_GUARD_MODE)) {
      index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
}

/**
 * The argv this spawn must use. The override goes LAST, so no earlier override of the same dotted
 * path can replace it; whether it took effect is not assumed but read from the hook inventory.
 * The trust bypass is added only when absent, so a launch that already carried the user's own
 * copy keeps exactly one.
 */
export function codexGuardLaunchArgs(
  args: readonly string[],
  override: string,
): string[] {
  const result = [...withoutCodexGuardArgs(args), "-c", override];
  if (!result.includes(CODEX_HOOK_TRUST_BYPASS_FLAG)) result.push(CODEX_HOOK_TRUST_BYPASS_FLAG);
  return result;
}

/**
 * Whether the guard really is in this argv, read from the argv itself rather than inferred.
 *
 * It has to be the LAST `hooks.PreToolUse` override present — a later one, in any spelling,
 * replaces it — and the trust bypass has to be there, without which Codex skips the hook silently.
 */
export function codexGuardArgsActive(args: readonly string[], override: string): boolean {
  let last = -1;
  for (let index = 0; index < args.length; index++) {
    if (declaresPreToolUseHooks(args[index]!)) last = index;
  }
  if (last < 1) return false;
  return args[last] === override && CODEX_CONFIG_FLAGS.has(args[last - 1]!) &&
    args.includes(CODEX_HOOK_TRUST_BYPASS_FLAG);
}

export interface CodexHookEntry {
  key: string;
  enabled: boolean;
  trustStatus: string;
  command?: string;
  source?: string;
}

export type CodexHookInventoryVerdict =
  | { ok: true }
  | { ok: false; reason: string; foreignUntrusted?: string[] };

/** How many offending hooks a refusal names before summarising the rest. */
const CODEX_NAMED_HOOK_LIMIT = 5;

/**
 * Judge an enumerated hook inventory for one guarded launch.
 *
 * Two independent facts have to hold. The runner's own hook must be present and enabled, which is
 * what proves the `-c` override actually installed it in THIS Codex build. And no OTHER enabled
 * hook may be untrusted, because the bypass the runner is about to pass would run that one too.
 */
export function codexHookInventoryVerdict(
  entries: readonly CodexHookEntry[],
  guardCommand: string,
): CodexHookInventoryVerdict {
  const ours = entries.filter((entry) => entry.command === guardCommand);
  if (ours.length === 0) {
    return { ok: false, reason: "Codex did not install the runner's PreToolUse hook" };
  }
  if (!ours.every((entry) => entry.enabled)) {
    return { ok: false, reason: "Codex reports the runner's PreToolUse hook as disabled" };
  }
  const foreign = entries.filter((entry) =>
    entry.command !== guardCommand && entry.enabled && !CODEX_TRUSTED_STATUSES.has(entry.trustStatus));
  if (foreign.length > 0) {
    const named = foreign.slice(0, CODEX_NAMED_HOOK_LIMIT).map((entry) => entry.key).join(", ");
    const more = foreign.length > CODEX_NAMED_HOOK_LIMIT
      ? ` and ${foreign.length - CODEX_NAMED_HOOK_LIMIT} more`
      : "";
    return {
      ok: false,
      foreignUntrusted: foreign.map((entry) => entry.key),
      reason: `the Codex hook trust bypass the guard needs would also run ${foreign.length} enabled ` +
        `but untrusted hook(s) the runner does not own: ${named}${more}. Trust them in Codex ` +
        "(/hooks) or disable them, then open the TUI again",
    };
  }
  return { ok: true };
}

export interface CodexHookInventoryProbe {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the enumeration probe. `codex app-server` is the only Codex entry point that can report
 * the effective hook inventory (`hooks/list`), and it accepts only the config-shaped flags, so the
 * launch's own `-c`/`--config`/`--enable`/`--disable` arguments are replayed and nothing else is.
 * A launch carrying a flag that could change the inventory without being replayable (a profile)
 * has no faithful probe and is rejected here.
 */
export function codexHookInventoryProbe(
  launch: { command: string; args: readonly string[]; env?: Record<string, string> },
  cwd: string,
  override: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
): CodexHookInventoryProbe {
  const replayed: string[] = [];
  const args = withoutCodexGuardArgs(launch.args);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (CODEX_PROFILE_FLAGS.has(argument) || /^--profile=/u.test(argument)) {
      throw new Error("a Codex profile may declare hooks that the inventory probe cannot enumerate");
    }
    if (CODEX_CONFIG_FLAGS.has(argument) || CODEX_FEATURE_FLAGS.has(argument)) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} carries no value`);
      replayed.push(argument, value);
      index += 1;
    }
  }
  return {
    command: launch.command,
    args: ["app-server", ...replayed, "-c", override],
    cwd,
    env: { ...hostEnv, ...launch.env },
  };
}

interface HooksListEntry {
  hooks?: { key?: unknown; enabled?: unknown; trustStatus?: unknown; command?: unknown; source?: unknown }[];
}

function parseHookEntries(payload: unknown): CodexHookEntry[] {
  const data = (payload as { result?: { data?: unknown } })?.result?.data;
  if (!Array.isArray(data)) throw new Error("hooks/list returned no inventory");
  const entries: CodexHookEntry[] = [];
  for (const group of data as HooksListEntry[]) {
    for (const hook of group.hooks ?? []) {
      // An entry the runner cannot classify is not evidence that the inventory is clean.
      if (typeof hook.key !== "string" || typeof hook.enabled !== "boolean" ||
          typeof hook.trustStatus !== "string") {
        throw new Error("hooks/list returned an entry the runner cannot classify");
      }
      entries.push({
        key: hook.key,
        enabled: hook.enabled,
        trustStatus: hook.trustStatus,
        ...(typeof hook.command === "string" ? { command: hook.command } : {}),
        ...(typeof hook.source === "string" ? { source: hook.source } : {}),
      });
    }
  }
  return entries;
}

/**
 * Run the probe and return the effective inventory. Every failure throws, because the caller turns
 * an un-enumerable inventory into "no guard" and, for a session that owns a worktree, a refusal.
 */
export async function readCodexHookInventory(
  probe: CodexHookInventoryProbe,
  spawn: typeof spawnProcess = spawnProcess,
  timeoutMs = CODEX_HOOK_INVENTORY_TIMEOUT_MS,
): Promise<CodexHookEntry[]> {
  let child: ChildProcess;
  try {
    child = spawn(probe.command, probe.args, {
      cwd: probe.cwd,
      env: probe.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`the Codex hook inventory probe could not be started: ${(error as Error).message}`);
  }
  try {
    return await new Promise<CodexHookEntry[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the Codex hook inventory probe timed out")),
        timeoutMs,
      );
      timer.unref?.();
      let buffered = "";
      const finish = (settle: () => void) => { clearTimeout(timer); settle(); };
      child.on("error", (error) => finish(() => reject(
        new Error(`the Codex hook inventory probe failed: ${error.message}`))));
      child.on("exit", () => finish(() => reject(
        new Error("the Codex hook inventory probe exited before answering"))));
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if ((message as { id?: unknown }).id !== 2) continue;
          try {
            finish(() => resolve(parseHookEntries(message)));
          } catch (error) {
            finish(() => reject(error as Error));
          }
          return;
        }
      });
      const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          clientInfo: { name: "wollipog-runner", title: "Wollipog", version: "0" },
          capabilities: { experimentalApi: true },
        },
      });
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      send({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [probe.cwd] } });
    });
  } finally {
    child.kill();
  }
}
