/**
 * Deny the runner's hook state directory to Codex at the OS level, in `provider` mode (#1336).
 *
 * Slice 1 hid that directory from providers the RUNNER sandboxes (`executionIsolation.mode` of
 * `bwrap` or `seatbelt`). The default mode is `provider`, where the runner sandboxes nothing and
 * the command-text veto is the only control — so indirection through a script, an interpreter, a
 * variable, a walk from an ancestor, or an MCP filesystem tool still reaches the directory. Codex
 * has its own sandbox, and a named permission profile with one `deny` entry closes that in
 * `provider` mode without the runner needing to sandbox anything.
 *
 * Measured against codex-cli 0.155.1 on this machine (2026-09-19), in a throwaway `CODEX_HOME`
 * against a throwaway repository, every claim paired with a control run without the deny entry.
 * ADR 0012 carries the full matrix; the facts this module is BUILT on are:
 *
 *   - A profile is config, not a flag: `[permissions.<id>]` with `extends`, and
 *     `[permissions.<id>.filesystem]` mapping an absolute path to `"read"`, `"write"` or `"deny"`.
 *     One is selected with `default_permissions = "<id>"`. Both keys can be supplied entirely on
 *     argv as one `-c` each, so nothing is written into the user's `config.toml`.
 *   - A `deny` entry is enforced by the OS under `:workspace` and `:read-only`. From a strict
 *     ancestor, `cat`, `python3 -c open()`, `find -maxdepth 999`, `grep -r`, `rg`, `du -a`,
 *     `touch`, `mv` of the directory and `rm -rf` all failed, and `git clean -dfx` left it in
 *     place. No guard command recognition is involved in any of that.
 *   - The three legacy sandbox policies the runner sends ARE the three built-in profiles:
 *     `thread/start` projects `:read-only` to `{readOnly}` and `:workspace` to `{workspaceWrite}`
 *     with every field at its default, which is exactly what `buildCodexTurnParams` sends today.
 *     Adding a deny entry does not move that projection, so the mode is carried unchanged and the
 *     deny rides alongside it.
 *   - Hooks run OUTSIDE the Codex sandbox. In one run the model's own shell call, reaching the
 *     directory indirectly through a script, got `Permission denied`, while the `PreToolUse` hook
 *     process read the file. So the guard sidecar keeps ordinary file access to its protection
 *     list and needs no verdict socket the way a runner-sandboxed launch does.
 *
 * And the three ways this fails OPEN, which are the reason for `codexPermissionProfileArgsActive`
 * and for the launch proof rather than trust in the configuration being accepted:
 *
 *   1. The legacy sandbox silently WINS. Codex does not refuse to combine `sandbox_mode` /
 *      `sandboxPolicy` with a profile — it accepts both and ignores the profile, reporting
 *      nothing. `codex exec -s workspace-write` read the denied file at exit 0 while the profile
 *      was the configured default. So a migrated launch must stop sending the legacy policy.
 *   2. The LAST `-c` for a dotted path wins. A later override redefining the same profile without
 *      the deny entry silently removed it; an earlier one did not. The runner's overrides go last,
 *      and that they are last is read back from the argv rather than assumed.
 *   3. An unrecognised top-level `-c` key is accepted SILENTLY, so a codex-cli that predates
 *      permission profiles ignores both keys and runs with no deny at all. No version string is
 *      parsed for this; the launch proof below is what tells the two apart.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The runner's own profile id. A user profile of the same name would be REPLACED by the runner's
 * override rather than merged with it, so the id is deliberately one no hand-written configuration
 * is likely to hold.
 */
export const CODEX_GUARD_PERMISSION_PROFILE_ID = "wollipog-runner-guard";

/**
 * The built-in profiles a runner-owned profile may extend. `:danger-full-access` is NOT one of
 * them: extending it is a hard error ("cannot extend unsupported built-in profile"), and it has no
 * sandbox to enforce anything even if it could be.
 */
export type CodexPermissionProfileBase = ":workspace" | ":read-only";

const PERMISSIONS_PREFIX = `permissions.${CODEX_GUARD_PERMISSION_PROFILE_ID}=`;
const DEFAULT_PERMISSIONS_PREFIX = "default_permissions=";
/** Config overrides carry the same value in either spelling; both are scanned. */
const CODEX_CONFIG_FLAGS: ReadonlySet<string> = new Set(["-c", "--config"]);

/**
 * Argv that silently defeats a permission profile, measured rather than assumed.
 *
 * `-s`/`--sandbox` and `--dangerously-bypass-approvals-and-sandbox` each let the denied file be
 * read while the profile was the configured default. `--add-dir` over a strict ancestor and
 * `--approve-for-me` did NOT — a deny entry outranks a writable root — so neither is listed here.
 */
const CODEX_SANDBOX_FLAGS: ReadonlySet<string> = new Set(["-s", "--sandbox"]);
const CODEX_SANDBOX_BYPASS_FLAGS: ReadonlySet<string> = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
]);

/**
 * The permission modes whose legacy sandbox policy is EXACTLY a built-in profile, and which
 * therefore carry the deny with no other change (#1336 slice 2, "narrowest").
 *
 * Everything absent is unchanged and documented as unenforced, never silently downgraded:
 *   - `danger-full-access` has no sandbox, and its built-in cannot be extended.
 *   - `orchestrator` sends `workspaceWrite` with non-default `writableRoots`, `networkAccess`,
 *     and tmp exclusions. `writableRoots` has no projection to read back, so its equivalence
 *     cannot be asserted the way the others can.
 *   - An unknown mode keeps its legacy policy. The safe direction is "no deny", never "a
 *     different sandbox from the one the user chose".
 */
const CODEX_WORKSPACE_MODES: ReadonlySet<string> = new Set([
  "auto-review", "on-request", "untrusted", "on-failure", "workspace-write",
]);

/** The default when a session names no mode is `auto-review`, which is `:workspace`. */
export function codexPermissionProfileBase(
  permissionMode: string | undefined | null,
): CodexPermissionProfileBase | null {
  const mode = permissionMode || "auto-review";
  if (mode === "read-only") return ":read-only";
  return CODEX_WORKSPACE_MODES.has(mode) ? ":workspace" : null;
}

/** A TOML basic string. Control characters are refused rather than escaped, exactly as the Codex
 * guard override does: no path the runner builds holds one, and a value needing escapes is a value
 * worth failing closed on. */
function tomlString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Codex permission profile value contains a control character");
  }
  return JSON.stringify(value);
}

/**
 * The two `-c` values that express `base` plus one deny entry for the runner's hook state
 * directory, in the order they must appear.
 *
 * The deny value is the bare string form. The table form the app-server's `FileSystemSandboxEntry`
 * suggests — `"<dir>" = { access = "deny" }` — parses without error and does NOT deny, so the
 * shape is built here and never taken from a caller.
 */
export function codexPermissionProfileOverrides(
  base: CodexPermissionProfileBase,
  hookStateDir: string,
): [string, string] {
  return [
    `${PERMISSIONS_PREFIX}{extends=${tomlString(base)},` +
      `filesystem={${tomlString(hookStateDir)}="deny"}}`,
    `${DEFAULT_PERMISSIONS_PREFIX}${tomlString(CODEX_GUARD_PERMISSION_PROFILE_ID)}`,
  ];
}

function splitAtOptionTerminator(args: readonly string[]): { options: string[]; rest: string[] } {
  const terminator = args.indexOf("--");
  return terminator < 0
    ? { options: [...args], rest: [] }
    : { options: args.slice(0, terminator), rest: args.slice(terminator) };
}

function declaresRunnerProfile(argument: string): boolean {
  return argument.startsWith(PERMISSIONS_PREFIX) || argument.startsWith(DEFAULT_PERMISSIONS_PREFIX);
}

/**
 * Drop a profile override already in the argv, leaving every other user- or catalog-supplied `-c`
 * alone. A user's OWN `default_permissions` goes too: the runner is about to select its profile,
 * and the last override wins either way, so leaving an earlier selection behind would only be
 * confusing.
 */
export function withoutCodexPermissionProfileArgs(args: readonly string[]): string[] {
  const { options, rest } = splitAtOptionTerminator(args);
  const result: string[] = [];
  for (let index = 0; index < options.length; index++) {
    const value = options[index + 1];
    if (CODEX_CONFIG_FLAGS.has(options[index]!) && value !== undefined && declaresRunnerProfile(value)) {
      index += 1;
      continue;
    }
    result.push(options[index]!);
  }
  return [...result, ...rest];
}

/**
 * Flags in this argv that would silently defeat the profile. A launch carrying one is NOT quietly
 * stripped of it — that would change what the user asked for — it is reported, so the caller can
 * leave that launch on its legacy policy instead of claiming an enforcement it does not have.
 */
export function codexPermissionProfileDefeatedBy(args: readonly string[]): string[] {
  const { options } = splitAtOptionTerminator(args);
  const found: string[] = [];
  for (const argument of options) {
    if (CODEX_SANDBOX_BYPASS_FLAGS.has(argument)) found.push(argument);
    // `-s value`, `--sandbox value`, and the `--sandbox=value` spelling Codex also accepts.
    if (CODEX_SANDBOX_FLAGS.has(argument) || argument.startsWith("--sandbox=")) found.push(argument);
  }
  return found;
}

/** The argv this spawn must use: the runner's overrides LAST, so no earlier override of either
 * dotted path can replace them. */
export function codexPermissionProfileLaunchArgs(
  args: readonly string[],
  overrides: readonly [string, string],
): string[] {
  const { options, rest } = splitAtOptionTerminator(withoutCodexPermissionProfileArgs(args));
  return [...options, "-c", overrides[0], "-c", overrides[1], ...rest];
}

/**
 * Whether the profile really is in this argv, read from the argv rather than inferred: both
 * overrides present, each the LAST override of its own dotted path, and no flag that defeats it.
 */
export function codexPermissionProfileArgsActive(
  args: readonly string[],
  overrides: readonly [string, string],
): boolean {
  if (codexPermissionProfileDefeatedBy(args).length > 0) return false;
  const { options } = splitAtOptionTerminator(args);
  for (const [prefix, expected] of [
    [PERMISSIONS_PREFIX, overrides[0]],
    [DEFAULT_PERMISSIONS_PREFIX, overrides[1]],
  ] as const) {
    let last = -1;
    for (let index = 0; index < options.length; index++) {
      if (options[index]!.startsWith(prefix)) last = index;
    }
    if (last < 1 || options[last] !== expected || !CODEX_CONFIG_FLAGS.has(options[last - 1]!)) {
      return false;
    }
  }
  return true;
}

/**
 * Prove the deny before a provider starts, by running the real thing rather than reasoning about
 * it.
 *
 * `codex sandbox` runs an arbitrary command under a resolved profile, so the probe reads a
 * runner-written file inside the hook state directory through an INTERPRETER — exactly the
 * indirection the command-text veto cannot see — and demands that it fail. A build that predates
 * permission profiles has no `codex sandbox -P` to run and fails here, which is how a
 * mixed-version host is caught without parsing a version string.
 *
 * Every failure path answers `ok: false`: a zero exit, the marker on either stream, a spawn that
 * throws, a timeout, or a probe file that could not be written.
 */
export function verifyCodexPermissionProfileLaunch(
  launch: { command: string; base: CodexPermissionProfileBase; hookStateDir: string; cwd: string },
  spawn: typeof spawnSync = spawnSync,
): { ok: true } | { ok: false; reason: string } {
  // The file's NAME and its CONTENT are different random values on purpose. A refusal reports the
  // path it was refused, so a marker shared with the filename would come back on stderr from the
  // very denial this is trying to prove, and read as a successful read.
  const probeFile = join(launch.hookStateDir, `.profile-probe-${randomBytes(16).toString("hex")}`);
  const marker = randomBytes(16).toString("hex");
  try {
    mkdirSync(launch.hookStateDir, { recursive: true, mode: 0o700 });
    writeFileSync(probeFile, marker, { mode: 0o600 });
  } catch (error) {
    return { ok: false, reason: `probe file could not be written: ${(error as Error).message}` };
  }
  try {
    const [profileOverride] = codexPermissionProfileOverrides(launch.base, launch.hookStateDir);
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawn(launch.command, [
        "sandbox",
        "-P", CODEX_GUARD_PERMISSION_PROFILE_ID,
        "-c", profileOverride,
        "-C", launch.cwd,
        "--",
        process.execPath, "-e",
        `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(probeFile)},"utf8"))`,
      ], { encoding: "utf8", cwd: launch.cwd, timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true });
    } catch (error) {
      return { ok: false, reason: `probe could not be started: ${(error as Error).message}` };
    }
    if (result.error) return { ok: false, reason: `probe failed: ${result.error.message}` };
    const output = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
    if (output.includes(marker)) return { ok: false, reason: "the probe read the denied file" };
    if (result.status === 0) return { ok: false, reason: "the probe read succeeded" };
    return { ok: true };
  } finally {
    rmSync(probeFile, { force: true });
  }
}

/**
 * One proof per distinct (command, base, directory) per runner process. The probe costs a process
 * start, and the launch is identical for every session using that combination.
 *
 * A success is final. A failure can be transient, so it is retried after a cooldown rather than
 * putting a failing process start in front of every Codex spawn.
 */
export const CODEX_PROFILE_RETRY_COOLDOWN_MS = 5 * 60_000;
const verifiedProfileLaunches = new Map<string, {
  verdict: { ok: true } | { ok: false; reason: string };
  at: number;
}>();

export function verifiedCodexPermissionProfile(
  launch: { command: string; base: CodexPermissionProfileBase; hookStateDir: string; cwd: string },
  verify: typeof verifyCodexPermissionProfileLaunch = verifyCodexPermissionProfileLaunch,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const key = [launch.command, launch.base, launch.hookStateDir].join("\u0000");
  const cached = verifiedProfileLaunches.get(key);
  if (cached && (cached.verdict.ok || now - cached.at < CODEX_PROFILE_RETRY_COOLDOWN_MS)) {
    return cached.verdict;
  }
  const verdict = verify(launch);
  verifiedProfileLaunches.set(key, { verdict, at: now });
  return verdict;
}

/** Testing seam: forget every remembered profile proof. */
export function resetCodexPermissionProfileVerification(): void {
  verifiedProfileLaunches.clear();
}

/**
 * The whole decision for one Codex launch: the argv it must use, and whether the deny is really in
 * force. `active: false` with a reason means the launch keeps its legacy sandbox policy unchanged —
 * never that it runs with a profile nobody proved.
 */
export type CodexPermissionProfileDecision =
  | { active: true; base: CodexPermissionProfileBase; args: string[] }
  | { active: false; reason: string };

export function decideCodexPermissionProfile(
  launch: {
    command: string;
    args: readonly string[];
    permissionMode: string | undefined | null;
    hookStateDir: string | undefined;
    cwd: string;
  },
  verify: typeof verifiedCodexPermissionProfile = verifiedCodexPermissionProfile,
): CodexPermissionProfileDecision {
  if (!launch.hookStateDir) return { active: false, reason: "no runner hook state directory" };
  const base = codexPermissionProfileBase(launch.permissionMode);
  if (!base) {
    return { active: false, reason: `permission mode ${launch.permissionMode ?? "(default)"} has no equivalent profile` };
  }
  const defeated = codexPermissionProfileDefeatedBy(launch.args);
  if (defeated.length > 0) {
    return { active: false, reason: `launch arguments defeat a permission profile: ${defeated.join(", ")}` };
  }
  let overrides: [string, string];
  try {
    overrides = codexPermissionProfileOverrides(base, launch.hookStateDir);
  } catch (error) {
    return { active: false, reason: (error as Error).message };
  }
  const args = codexPermissionProfileLaunchArgs(launch.args, overrides);
  if (!codexPermissionProfileArgsActive(args, overrides)) {
    return { active: false, reason: "the profile override is not the last one in the launch arguments" };
  }
  const proof = verify({ command: launch.command, base, hookStateDir: launch.hookStateDir, cwd: launch.cwd });
  if (!proof.ok) return { active: false, reason: proof.reason };
  return { active: true, base, args };
}
