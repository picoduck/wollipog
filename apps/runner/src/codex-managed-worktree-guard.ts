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
import { resolve } from "node:path";
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
/**
 * `--remote` attaches the TUI to another app-server, whose hooks are its own, and `--worktree` runs
 * the session in a new Codex-made worktree; a local probe describes neither.
 */
const CODEX_UNPROBEABLE_FLAGS: ReadonlySet<string> = new Set(["--remote", "--worktree"]);
/** `-C`/`--cd` moves the directory Codex resolves project-scoped hooks from. */
const CODEX_CWD_FLAGS: ReadonlySet<string> = new Set(["-C", "--cd"]);
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

/** A runner-owned hook TRUST override, as distinct from the isolation override, which writes the
 * same `hooks.state=` prefix with `enabled=false` and must survive re-preparation. */
function declaresRunnerHookTrust(argument: string): boolean {
  return argument.startsWith(CODEX_HOOK_STATE_OVERRIDE_PREFIX) && argument.includes("trusted_hash");
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
  const { options, rest } = splitAtOptionTerminator(args);
  const result: string[] = [];
  for (let index = 0; index < options.length; index++) {
    const value = options[index + 1];
    if (CODEX_CONFIG_FLAGS.has(options[index]!) && value !== undefined &&
        ((value.startsWith(CODEX_GUARD_OVERRIDE_PREFIX) && value.includes(MANAGED_WORKTREE_GUARD_MODE)) ||
          declaresRunnerHookTrust(value))) {
      index += 1;
      continue;
    }
    result.push(options[index]!);
  }
  return [...result, ...rest];
}

/**
 * Everything after a `--` is positional (a prompt), never an option: the guard's flags must go
 * before it, and nothing after it is read as a flag.
 */
function splitAtOptionTerminator(args: readonly string[]): { options: string[]; rest: string[] } {
  const terminator = args.indexOf("--");
  return terminator < 0
    ? { options: [...args], rest: [] }
    : { options: args.slice(0, terminator), rest: args.slice(terminator) };
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
  trustOverride?: string,
): string[] {
  const { options, rest } = splitAtOptionTerminator(withoutCodexGuardArgs(args));
  const result = [...options, "-c", override];
  // Both trust mechanisms travel, because they cover different entry points: the bypass flag is
  // what a TUI and `codex exec` honour, and the hash override is the only one `codex app-server`
  // honours. Neither is taken on faith — the inventory read-back is what decides `guardActive`.
  if (trustOverride) result.push("-c", trustOverride);
  if (!result.includes(CODEX_HOOK_TRUST_BYPASS_FLAG)) result.push(CODEX_HOOK_TRUST_BYPASS_FLAG);
  return [...result, ...rest];
}

/**
 * Whether THIS argv carries a proven runner guard, without knowing the override texts.
 *
 * `codexGuardArgsActive` compares against the exact strings provisioning built, which only
 * provisioning holds. A driver re-spawns on its own — every resume and transport restart — from
 * args it was handed, so it needs the same question answered from the argv alone, exactly as
 * `prepareClaudeHookArgs` re-derives Claude's `guardActive` at each spawn.
 *
 * Both halves are required. A `hooks.PreToolUse` override alone is the pre-#1499 contract, which is
 * unfalsifiable on an entry point where the trust bypass does nothing: Codex would report the hook
 * enabled and untrusted, and skip it silently. The trust override is what makes the claim real.
 */
export function codexGuardActiveInArgs(args: readonly string[]): boolean {
  const { options } = splitAtOptionTerminator(args);
  let guard = false;
  let trust = false;
  for (let index = 1; index < options.length; index++) {
    if (!CODEX_CONFIG_FLAGS.has(options[index - 1]!)) continue;
    const value = options[index]!;
    // The LAST override of each dotted path is the one Codex honours, so a later foreign override
    // of either path disarms the guard rather than merely shadowing part of it.
    if (declaresPreToolUseHooks(value)) guard = value.includes(MANAGED_WORKTREE_GUARD_MODE);
    if (value.startsWith(CODEX_HOOK_STATE_OVERRIDE_PREFIX)) {
      if (declaresRunnerHookTrust(value)) trust = true;
      else if (!value.includes("enabled=false")) trust = false;
    }
  }
  return guard && trust;
}

/**
 * Whether the guard really is in this argv, read from the argv itself rather than inferred.
 *
 * It has to be the LAST `hooks.PreToolUse` override present — a later one, in any spelling,
 * replaces it — and the trust bypass has to be there, without which Codex skips the hook silently.
 */
export function codexGuardArgsActive(
  args: readonly string[],
  override: string,
  trustOverride?: string,
): boolean {
  const { options } = splitAtOptionTerminator(args);
  let last = -1;
  for (let index = 0; index < options.length; index++) {
    if (declaresPreToolUseHooks(options[index]!)) last = index;
  }
  if (last < 1) return false;
  if (trustOverride) {
    // The trust override must be the LAST `hooks.state` override naming a trusted hash, for the
    // same reason the guard override must be last: a later one replaces it.
    let lastTrust = -1;
    for (let index = 0; index < options.length; index++) {
      if (declaresRunnerHookTrust(options[index]!)) lastTrust = index;
    }
    if (lastTrust < 1 || options[lastTrust] !== trustOverride ||
        !CODEX_CONFIG_FLAGS.has(options[lastTrust - 1]!)) {
      return false;
    }
  }
  return options[last] === override && CODEX_CONFIG_FLAGS.has(options[last - 1]!) &&
    options.includes(CODEX_HOOK_TRUST_BYPASS_FLAG);
}

export interface CodexHookEntry {
  key: string;
  enabled: boolean;
  trustStatus: string;
  command?: string;
  source?: string;
  /**
   * Codex's own digest of this hook's definition. A trust override names it, and it moves whenever
   * the hook's command string or matcher moves, so it cannot be computed here — only read back.
   */
  currentHash?: string;
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

/**
 * The Orchestrator preset's form of the rule (#1473). The preset's isolation promises that NO user
 * hook runs, trusted or not, so for such a launch every enabled hook that is not the runner's is
 * disqualifying — including ones the person has trusted, which the ordinary verdict admits.
 */
export function codexHookIsolationVerdict(
  entries: readonly CodexHookEntry[],
  guardCommand: string,
): CodexHookInventoryVerdict {
  const base = codexHookInventoryVerdict(entries, guardCommand);
  if (!base.ok) return base;
  const foreign = entries.filter((entry) => entry.command !== guardCommand && entry.enabled);
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `${foreign.length} hook(s) the runner does not own would still be enabled beside the ` +
        `guard in an Orchestrator launch: ${foreign.map((entry) => entry.key).join(", ")}`,
    };
  }
  return { ok: true };
}

const CODEX_HOOK_STATE_OVERRIDE_PREFIX = "hooks.state=";

/**
 * A `-c` override that disables each named hook for this invocation only, leaving the user's
 * configuration untouched (#1473). Measured on codex-cli 0.155.1: the INLINE TABLE spelling
 * `hooks.state={"<key>"={enabled=false}}` turns the hook off in `hooks/list`, while the dotted
 * spelling `hooks.state."<key>".enabled=false` is accepted and changes nothing, because the key
 * itself contains dots. Whether it took effect is read back from the inventory, never assumed.
 */
/**
 * The `-c hooks.state=…` override that TRUSTS the runner's own hook for one invocation.
 *
 * `--dangerously-bypass-hook-trust` is what a Codex TUI or `codex exec` uses for this, and measured
 * on codex-cli 0.155.1 it has NO EFFECT on `codex app-server`: the same argv that fired the hook
 * and blocked under `codex exec` did nothing at all under `app-server` — no hook process, no bypass
 * warning, no error, and `hooks/list` still reporting the hook `enabled` and `untrusted`. That is
 * the documented silent skip, and it is why a structured launch trusts by hash instead.
 *
 * The hash is Codex's own digest of the hook's definition, so it moves with the hook's command
 * string and matcher and cannot be computed here. It is read from the launch's own inventory and
 * then proven again on a second read — a stale or mistyped hash fails exactly the way an untrusted
 * hook fails, which is silently.
 */
export function codexGuardTrustOverride(entries: readonly CodexHookEntry[], guardCommand: string): string | null {
  const trustable = entries.filter((entry) =>
    entry.command === guardCommand && typeof entry.currentHash === "string" && entry.currentHash);
  if (trustable.length === 0) return null;
  const pairs = trustable.map((entry) =>
    `${tomlString(entry.key)}={trusted_hash=${tomlString(entry.currentHash!)}}`);
  return `${CODEX_HOOK_STATE_OVERRIDE_PREFIX}{${pairs.join(",")}}`;
}

/**
 * Whether the runner's own hook is enabled AND trusted in this inventory.
 *
 * `codexHookInventoryVerdict` deliberately checks only that the runner's hook is present and
 * enabled, and checks trust for FOREIGN hooks. That was sufficient while the bypass flag carried
 * the runner's own hook. Where the bypass does nothing, "enabled" is not enough: an enabled,
 * untrusted hook is skipped without a word, so a launch that stopped here would report a guard it
 * does not have.
 */
export function codexHookTrustVerdict(
  entries: readonly CodexHookEntry[],
  guardCommand: string,
): CodexHookInventoryVerdict {
  const ours = entries.filter((entry) => entry.command === guardCommand);
  if (ours.length === 0) {
    return { ok: false, reason: "Codex did not install the runner's PreToolUse hook" };
  }
  const untrusted = ours.filter((entry) => !CODEX_TRUSTED_STATUSES.has(entry.trustStatus));
  if (untrusted.length > 0) {
    return {
      ok: false,
      reason: "Codex still reports the runner's PreToolUse hook as " +
        `${untrusted[0]!.trustStatus}, so it would be skipped silently`,
    };
  }
  return ours.every((entry) => entry.enabled)
    ? { ok: true }
    : { ok: false, reason: "Codex reports the runner's PreToolUse hook as disabled" };
}

export function codexHookStateDisableOverride(keys: readonly string[]): string {
  return `${CODEX_HOOK_STATE_OVERRIDE_PREFIX}{${keys.map((key) => `${tomlString(key)}={enabled=false}`).join(",")}}`;
}

/** Codex's `--disable hooks`, in every spelling the preset or a person could have written. */
function disablesCodexHooksFeature(argument: string, next: string | undefined): number {
  if (argument === "--disable" && next === "hooks") return 2;
  if (argument === "--disable=hooks") return 1;
  return 0;
}

/**
 * Drop the preset's `--disable hooks` so the guard hook can load (#1473). Only the launch that
 * proves, through the inventory, that the runner's hook is the sole enabled one may use the
 * result; every other launch keeps the flag exactly as the preset wrote it.
 */
export function withoutCodexHooksFeatureDisable(args: readonly string[]): string[] {
  const { options, rest } = splitAtOptionTerminator(args);
  const result: string[] = [];
  for (let index = 0; index < options.length; index++) {
    const consumed = disablesCodexHooksFeature(options[index]!, options[index + 1]);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    result.push(options[index]!);
  }
  return [...result, ...rest];
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
 *
 * Every spelling Codex accepts is handled, not only the spaced one: `--disable=hooks` turns every
 * hook off and `-cVALUE` adds one, and a probe that missed either would approve a launch it never
 * saw (measured on codex-cli 0.155.1). The probe also runs where the TUI will resolve
 * project-scoped hooks, which a `-C`/`--cd` in the launch moves. A launch carrying a flag that
 * could change the inventory without being replayable (a profile) has no faithful probe and is
 * rejected here.
 */
export function codexHookInventoryProbe(
  launch: { command: string; args: readonly string[]; env?: Record<string, string> },
  cwd: string,
  override: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  /**
   * The trust override to enumerate WITH (#1499). It travels as its own parameter rather than
   * inside `launch.args`, because the replay above strips runner-owned overrides — including this
   * one — so an override smuggled through the argv would be removed before the probe ever ran, and
   * the inventory would answer `untrusted` about a launch that is in fact trusted.
   */
  trustOverride?: string,
): CodexHookInventoryProbe {
  const replayed: string[] = [];
  let probeCwd = cwd;
  const { options: args } = splitAtOptionTerminator(withoutCodexGuardArgs(launch.args));
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (CODEX_UNPROBEABLE_FLAGS.has(argument) || /^--(?:remote|worktree)=/u.test(argument)) {
      throw new Error(
        `${argument.split("=")[0]} runs the session somewhere the local inventory probe cannot see`,
      );
    }
    if (CODEX_PROFILE_FLAGS.has(argument) || /^--profile=/u.test(argument) || /^-p./u.test(argument)) {
      throw new Error("a Codex profile may declare hooks that the inventory probe cannot enumerate");
    }
    if (CODEX_CONFIG_FLAGS.has(argument) || CODEX_FEATURE_FLAGS.has(argument)) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} carries no value`);
      replayed.push(argument, value);
      index += 1;
      continue;
    }
    // Attached spellings are replayed verbatim; Codex parses them identically in both places.
    if (/^--(?:config|enable|disable)=/u.test(argument) || /^-c./u.test(argument)) {
      replayed.push(argument);
      continue;
    }
    if (CODEX_CWD_FLAGS.has(argument)) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} carries no value`);
      probeCwd = resolve(cwd, value);
      index += 1;
      continue;
    }
    const attachedCwd = /^--cd=(.*)$/su.exec(argument)?.[1] ?? /^-C=?(.+)$/su.exec(argument)?.[1];
    if (attachedCwd !== undefined) probeCwd = resolve(cwd, attachedCwd);
  }
  return {
    command: launch.command,
    args: [
      "app-server", ...replayed, "-c", override,
      ...(trustOverride ? ["-c", trustOverride] : []),
    ],
    cwd: probeCwd,
    env: { ...hostEnv, ...launch.env },
  };
}

interface HooksListEntry {
  errors?: { path?: unknown; message?: unknown }[];
  hooks?: {
    key?: unknown; enabled?: unknown; trustStatus?: unknown; command?: unknown; source?: unknown;
    currentHash?: unknown;
  }[];
}

function parseHookEntries(payload: unknown): CodexHookEntry[] {
  const data = (payload as { result?: { data?: unknown } })?.result?.data;
  if (!Array.isArray(data)) throw new Error("hooks/list returned no inventory");
  const entries: CodexHookEntry[] = [];
  for (const group of data as HooksListEntry[]) {
    // A discovery error means part of the inventory is unknown, and an unknown hook is not
    // evidence that the runner's is the only one the trust bypass would run.
    if (Array.isArray(group.errors) && group.errors.length > 0) {
      const paths = group.errors.map((error) => String(error?.path ?? "unknown")).slice(0, 3).join(", ");
      throw new Error(`hooks/list reported hook discovery errors (${paths})`);
    }
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
        ...(typeof hook.currentHash === "string" ? { currentHash: hook.currentHash } : {}),
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
      // A probe that exits before reading its input makes these writes fail with EPIPE; the
      // exit handler above already settles that case, and an unhandled stream error would not.
      child.stdin?.on("error", () => {});
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
