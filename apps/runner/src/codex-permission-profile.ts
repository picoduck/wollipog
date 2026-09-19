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
 *     deny rides alongside it — BUT only when the user's own Codex configuration adjusts nothing.
 *     A user's `[sandbox_workspace_write]` settings (network access, extra writable roots) are
 *     honoured by the legacy launch and NOT by a profile extending the built-in, so each launch is
 *     compared against its own configured projection before it migrates (see
 *     `codexLegacySandboxMatchesProfile`).
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

import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
 * What the in-sandbox probe prints. Only `PROBE_DENIED` proves the deny; the other two are the
 * outcomes an exit code alone would be unable to distinguish from it.
 */
const PROBE_DENIED_SENTINEL = "WOLLIPOG_PROBE_DENIED";
const PROBE_READ_SENTINEL = "WOLLIPOG_PROBE_READ:";
const PROBE_ERROR_SENTINEL = "WOLLIPOG_PROBE_ERROR:";

/**
 * Argv that silently defeats a permission profile, measured rather than assumed.
 *
 * `-s`/`--sandbox` and `--dangerously-bypass-approvals-and-sandbox` each let the denied file be
 * read while the profile was the configured default. `--add-dir` over a strict ancestor and
 * `--approve-for-me` did NOT — a deny entry outranks a writable root — so neither is listed here.
 * Nor is a `-c sandbox_mode=…` override: in both the separated and the attached spelling, and in
 * `config.toml`, the deny still held, because `default_permissions` outranks the legacy key.
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
    // `-s value` and `--sandbox value`, plus the attached spellings codex-cli 0.155.1 also accepts:
    // `--sandbox=value`, `-svalue`, and `-s=value` (measured). A lowercase `-s` never begins
    // anything else in Codex's argument surface, so any token starting with it is treated as one.
    if (CODEX_SANDBOX_FLAGS.has(argument) || argument.startsWith("--sandbox=") ||
        (argument.startsWith("-s") && !argument.startsWith("--"))) {
      found.push(argument);
    }
  }
  return found;
}

/**
 * Flags in this argv that make the launch resolve its configuration somewhere the proof cannot
 * see. `-C`/`--cd` (in every spelling) moves the directory project-scoped configuration comes from,
 * while the proof reads it from the session's own directory; `--remote` runs the session on
 * another host and `--worktree` in a new worktree. The same flags make the Codex guard's hook
 * inventory unprobeable. Such a launch keeps its legacy policy rather than being compared with the
 * wrong configuration.
 */
export function codexPermissionProfileUnprovableArgs(args: readonly string[]): string[] {
  const { options } = splitAtOptionTerminator(args);
  const found: string[] = [];
  for (const argument of options) {
    if (argument === "-C" || argument === "--cd" || argument.startsWith("--cd=") ||
        (argument.startsWith("-C") && argument.length > 2) ||
        argument === "--remote" || argument.startsWith("--remote=") || argument === "--worktree") {
      found.push(argument);
    }
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

/** The outcome of one probe process. */
export interface CodexProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs one probe process to completion, never blocking the runner's event loop. */
export type CodexProbeRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<CodexProbeResult>;

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_OUTPUT_LIMIT = 256 * 1024;

/**
 * Spawn a probe as the leader of its own process group, so the whole tree can be killed. The
 * configured command may be a wrapper that starts the real `codex` as a child without `exec`;
 * killing only the wrapper would leak one app-server per proof.
 */
function spawnProbe(
  spawn: typeof spawnProcess,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: "pipe" | "ignore" },
): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd, env: options.env, stdio: [options.stdin, "pipe", "pipe"],
    detached: true, windowsHide: true,
  });
}

/** Kill a probe's whole process group; an already-gone group is not an error. */
function killProbeTree(child: ChildProcess | undefined): void {
  if (!child) return;
  if (typeof child.pid === "number") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is already gone */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
}

/**
 * Asynchronous, so a slow or hung `codex` never stalls the runner: every session, shell, and
 * control-plane message shares the one event loop a synchronous spawn would block.
 */
export const runCodexProbe: CodexProbeRunner = (command, args, options) => new Promise((resolve) => {
  let stdout = "";
  let stderr = "";
  let settled = false;
  let child: ChildProcess | undefined;
  const finish = (result: CodexProbeResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Whatever the outcome, nothing the probe started outlives it.
    killProbeTree(child);
    resolve(result);
  };
  const timer = setTimeout(() => {
    finish({ status: null, stdout, stderr, error: new Error(`timed out after ${options.timeoutMs}ms`) });
  }, options.timeoutMs);
  try {
    child = spawnProbe(spawnProcess, command, args, { cwd: options.cwd, env: options.env, stdin: "ignore" });
  } catch (error) {
    finish({ status: null, stdout: "", stderr: "", error: error as Error });
    return;
  }
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { if (stdout.length < PROBE_OUTPUT_LIMIT) stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { if (stderr.length < PROBE_OUTPUT_LIMIT) stderr += chunk; });
  child.on("error", (error) => finish({ status: null, stdout, stderr, error }));
  child.on("close", (status) => finish({ status, stdout, stderr }));
});

/**
 * Prove the deny before a provider starts, by running the real thing rather than reasoning about
 * it.
 *
 * `codex sandbox` runs an arbitrary command under a resolved profile, so the probe reads a
 * runner-written file inside the hook state directory from a shell inside that sandbox — an
 * indirection the command-text veto cannot see — and demands a positive report that the read was
 * refused. A build that predates permission profiles cannot run `codex sandbox -P` and never
 * produces that report, which is how a mixed-version host is caught without parsing a version.
 *
 * Every other outcome answers `ok: false`: the marker or the read report on either stream, no
 * denial report at any exit code, a spawn that fails, a timeout, or a probe file that could not
 * be written.
 */
export async function verifyCodexPermissionProfileDeny(
  launch: {
    command: string;
    base: CodexPermissionProfileBase;
    hookStateDir: string;
    cwd: string;
    /** The environment the PROVIDER will launch with. `CODEX_HOME` and `PATH` decide which binary
     * runs and which configuration it resolves, so proving the deny under a different environment
     * proves nothing about the launch. */
    env: NodeJS.ProcessEnv;
  },
  run: CodexProbeRunner = runCodexProbe,
): Promise<{ ok: true } | { ok: false; reason: string }> {
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
    // A POSITIVE signal is required, because an exit code cannot tell a real denial from a CLI that
    // never ran the probe at all. Measured on codex-cli 0.155.1: a genuine deny exits 1, an
    // undefined profile exits 1, and an unsupported flag — what a build predating permission
    // profiles produces — exits 2. Treating "nonzero" as proof would pass every one of those.
    //
    // The probe is `/bin/sh` and `cat`, not an inner Node: measured, a Node process inside
    // `codex sandbox` whose stdout is a pipe the runner created writes NOTHING that arrives (its
    // script runs — a file it writes appears — but `process.stdout.write` output is lost), while
    // `sh`'s `printf` arrives intact. The file path travels as `$1`, never spliced into the script.
    // The locale is pinned so the error text the classification reads is the C locale's.
    const script = `LC_ALL=C; export LC_ALL; out=$(cat -- "$1" 2>&1); rc=$?; ` +
      `if [ "$rc" -eq 0 ]; then printf '%s%s' '${PROBE_READ_SENTINEL}' "$out"; ` +
      `else case "$out" in *"Permission denied"*|*"Operation not permitted"*) ` +
      `printf '%s' '${PROBE_DENIED_SENTINEL}';; *) printf '%s%s' '${PROBE_ERROR_SENTINEL}' "$out";; esac; fi`;
    const result = await run(launch.command, [
      "sandbox",
      "-P", CODEX_GUARD_PERMISSION_PROFILE_ID,
      "-c", profileOverride,
      "-C", launch.cwd,
      "--",
      "/bin/sh", "-c", script, "wollipog-profile-probe", probeFile,
    ], { cwd: launch.cwd, env: launch.env, timeoutMs: PROBE_TIMEOUT_MS });
    if (result.error) return { ok: false, reason: `probe failed: ${result.error.message}` };
    const output = `${result.stdout}${result.stderr}`;
    if (output.includes(marker) || output.includes(PROBE_READ_SENTINEL)) {
      return { ok: false, reason: "the probe read the denied file" };
    }
    if (!output.includes(PROBE_DENIED_SENTINEL)) {
      return {
        ok: false,
        reason: `the probe reported no denial (exit ${String(result.status)}): ` +
          `${output.trim().slice(0, 160) || "no output"}`,
      };
    }
    return { ok: true };
  } finally {
    rmSync(probeFile, { force: true });
  }
}

/**
 * What sandbox the launch had BEFORE this change, which is what a migrated launch must reproduce.
 *
 * - `explicit`: the launch sent the legacy mode itself (`codex exec -s <mode>`, or the app-server's
 *   `sandboxPolicy`).
 * - `implicit`: the launch sent nothing and Codex resolved its own default (a native TUI, and a
 *   resumed `codex exec` turn, which never passed `-s`). That default is whatever the user's Codex
 *   configuration selects, so it is read rather than assumed, and it migrates only when it is the
 *   plain `:workspace` built-in.
 */
export type CodexLegacySandbox =
  | { kind: "explicit"; permissionMode: string | undefined | null }
  | { kind: "implicit" };

/** What `thread/start` reports for the launch's own configuration. */
export interface CodexSandboxProjection {
  activePermissionProfile: { id?: unknown; extends?: unknown } | null;
  sandbox: unknown;
}

/**
 * The legacy projection each built-in profile has when NOTHING in the user's configuration
 * adjusts it (measured with `thread/start`). A user's `[sandbox_workspace_write]` settings DO
 * adjust the legacy policy — `network_access` and `writable_roots` appear here, and were honoured
 * by a real turn under both `-s workspace-write` and the app-server's explicit `sandboxPolicy` —
 * but a profile extending the built-in does NOT carry them. So only a launch whose legacy
 * projection is exactly one of these can migrate without losing a grant the user configured.
 */
const CANONICAL_PROJECTION: Readonly<Record<CodexPermissionProfileBase, unknown>> = {
  ":workspace": {
    type: "workspaceWrite", writableRoots: [], networkAccess: false,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  },
  ":read-only": { type: "readOnly", networkAccess: false },
};

/**
 * Ask a throwaway `codex app-server`, started with the launch's own arguments, environment, and
 * working directory, which sandbox that launch resolves. The thread is ephemeral, so nothing is
 * written to the user's session history, and no turn is started, so nothing reaches a model.
 */
export function readCodexSandboxProjection(
  launch: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    /** The legacy mode to request, for an `explicit` launch; omitted for an `implicit` one. */
    sandboxMode?: "workspace-write" | "read-only";
  },
  spawn: typeof spawnProcess = spawnProcess,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ ok: true; projection: CodexSandboxProjection } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let stderr = "";
    const withStderr = (reason: string) => {
      const excerpt = stderr.trim().slice(0, 200);
      return excerpt ? `${reason}: ${excerpt}` : reason;
    };
    const finish = (verdict: { ok: true; projection: CodexSandboxProjection } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever the outcome, nothing the probe started outlives it.
      killProbeTree(child);
      resolve(verdict);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: withStderr(`sandbox projection timed out after ${timeoutMs}ms`) }),
      timeoutMs,
    );
    try {
      child = spawnProbe(spawn, launch.command, [...launch.args, "app-server"], {
        cwd: launch.cwd, env: launch.env, stdin: "pipe",
      });
    } catch (error) {
      finish({ ok: false, reason: `sandbox projection could not start: ${(error as Error).message}` });
      return;
    }
    // A command that exits before reading its input (an older CLI, a rejected argument, a config
    // error) turns every write into EPIPE. Unhandled, that is an 'error' event that terminates the
    // RUNNER. It is only recorded here, not settled on: the process is exiting, and its 'close'
    // arrives after stderr has been drained, so settling there reports WHY it exited. Settling on
    // the EPIPE itself raced that stderr and usually lost it. The timeout still bounds a process
    // that errors on input yet never exits.
    let inputError: Error | undefined;
    child.stdin?.on("error", (error) => { inputError = error; });
    // Drained under the same bound as stdout: a full stderr pipe would stall the reply behind it.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { if (stderr.length < PROBE_OUTPUT_LIMIT) stderr += chunk; });
    const send = (id: number, method: string, params: unknown) => {
      if (settled) return;
      child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > PROBE_OUTPUT_LIMIT) {
        finish({ ok: false, reason: "sandbox projection produced too much output" });
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: Record<string, unknown>; error?: { message?: unknown } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            finish({ ok: false, reason: `app-server initialize failed: ${String(message.error.message)}` });
            return;
          }
          send(2, "thread/start", {
            cwd: launch.cwd,
            ephemeral: true,
            ...(launch.sandboxMode ? { sandbox: launch.sandboxMode } : {}),
          });
        } else if (message.id === 2) {
          if (message.error || !message.result) {
            finish({ ok: false, reason: `thread/start failed: ${String(message.error?.message ?? "no result")}` });
            return;
          }
          const active = message.result.activePermissionProfile;
          finish({
            ok: true,
            projection: {
              activePermissionProfile: active && typeof active === "object"
                ? active as CodexSandboxProjection["activePermissionProfile"] : null,
              sandbox: message.result.sandbox,
            },
          });
        }
      }
    });
    child.on("error", (error) => finish({ ok: false, reason: `sandbox projection failed: ${error.message}` }));
    child.on("close", (code) => finish({
      ok: false,
      reason: withStderr(`app-server exited ${String(code)} before reporting a sandbox` +
        (inputError ? ` (its input failed: ${inputError.message})` : "")),
    }));
    send(1, "initialize", { clientInfo: { name: "wollipog-profile-probe", version: "0" } });
  });
}

/** Whether the launch's own legacy sandbox is exactly what the runner's profile reproduces. */
export function codexLegacySandboxMatchesProfile(
  legacy: CodexLegacySandbox,
  base: CodexPermissionProfileBase,
  projection: CodexSandboxProjection,
): { ok: true } | { ok: false; reason: string } {
  if (!isDeepStrictEqual(projection.sandbox, CANONICAL_PROJECTION[base])) {
    return {
      ok: false,
      reason: `the launch's configured sandbox ${JSON.stringify(projection.sandbox)} is not the plain ${base} ` +
        "built-in, so a profile would change more than the hook state directory",
    };
  }
  if (legacy.kind === "implicit") {
    // Codex's own default selected SOMETHING; migrate only when it is the plain built-in. A
    // user-selected profile (even one extending `:workspace`) may carry its own entries that the
    // projection does not show.
    const active = projection.activePermissionProfile;
    if (!active || active.id !== base || (active.extends !== undefined && active.extends !== null)) {
      return {
        ok: false,
        reason: `the launch's default permission profile is ${JSON.stringify(active)}, not the plain ${base} built-in`,
      };
    }
  }
  return { ok: true };
}

/**
 * The executable a launch would run, identified by its resolved file rather than by the command
 * text. A proof cached for `codex` must not survive that binary being replaced — by an older build
 * that silently ignores the profile keys, say.
 */
export function codexExecutableIdentity(command: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = command.includes("/")
    ? [command]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      const stat = statSync(real);
      if (!stat.isFile()) continue;
      return [real, stat.ino, stat.size, stat.mtimeMs].join(":");
    } catch { /* not this candidate */ }
  }
  return null;
}

/**
 * One proof per distinct launch per runner process, shared by concurrent launches while it runs.
 *
 * Everything the proof depends on is in the key: the executable's identity (not its name), the
 * arguments, the working directory (project-scoped configuration), the variables that locate the
 * configuration and the binary, the base, the legacy kind, and the directory. A success expires
 * after the same interval a failure is retried after, because the user's Codex configuration can
 * change under a running runner and nothing here watches it.
 */
export const CODEX_PROFILE_RETRY_COOLDOWN_MS = 5 * 60_000;
const provenProfileLaunches = new Map<string, {
  verdict: Promise<{ ok: true } | { ok: false; reason: string }>;
  at: number;
}>();

export interface CodexProfileProofDependencies {
  readProjection: typeof readCodexSandboxProjection;
  verifyDeny: typeof verifyCodexPermissionProfileDeny;
  executableIdentity: typeof codexExecutableIdentity;
  now: () => number;
}

const defaultProofDependencies: CodexProfileProofDependencies = {
  readProjection: (launch) => readCodexSandboxProjection(launch),
  verifyDeny: (launch) => verifyCodexPermissionProfileDeny(launch),
  executableIdentity: codexExecutableIdentity,
  now: () => Date.now(),
};

export function provenCodexPermissionProfile(
  launch: {
    command: string;
    args: readonly string[];
    legacy: CodexLegacySandbox;
    base: CodexPermissionProfileBase;
    hookStateDir: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
  dependencies: Partial<CodexProfileProofDependencies> = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deps = { ...defaultProofDependencies, ...dependencies };
  const identity = deps.executableIdentity(launch.command, launch.env);
  if (!identity) {
    return Promise.resolve({ ok: false, reason: `executable ${launch.command} could not be resolved` });
  }
  const key = JSON.stringify([
    identity, launch.args, launch.cwd, launch.env.CODEX_HOME ?? "", launch.env.HOME ?? "",
    launch.env.PATH ?? "", launch.legacy.kind, launch.base, launch.hookStateDir,
  ]);
  const now = deps.now();
  const cached = provenProfileLaunches.get(key);
  if (cached && now - cached.at < CODEX_PROFILE_RETRY_COOLDOWN_MS) return cached.verdict;
  const verdict = (async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const projection = await deps.readProjection({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      ...(launch.legacy.kind === "explicit"
        ? { sandboxMode: launch.base === ":read-only" ? "read-only" as const : "workspace-write" as const }
        : {}),
    });
    if (!projection.ok) return projection;
    const matches = codexLegacySandboxMatchesProfile(launch.legacy, launch.base, projection.projection);
    if (!matches.ok) return matches;
    return deps.verifyDeny({
      command: launch.command, base: launch.base, hookStateDir: launch.hookStateDir,
      cwd: launch.cwd, env: launch.env,
    });
  })().catch((error: unknown) => ({ ok: false as const, reason: `profile proof failed: ${String(error)}` }));
  provenProfileLaunches.set(key, { verdict, at: now });
  return verdict;
}

/** Testing seam: forget every remembered profile proof. */
export function resetCodexPermissionProfileVerification(): void {
  provenProfileLaunches.clear();
}

/**
 * The whole decision for one Codex launch: the argv it must use, and whether the deny is really in
 * force. `active: false` with a reason means the launch keeps its legacy sandbox policy unchanged —
 * never that it runs with a profile nobody proved.
 */
export type CodexPermissionProfileDecision =
  | { active: true; base: CodexPermissionProfileBase; args: string[] }
  | { active: false; reason: string };

export async function decideCodexPermissionProfile(
  launch: {
    command: string;
    args: readonly string[];
    legacy: CodexLegacySandbox;
    hookStateDir: string | undefined;
    cwd: string;
    /** The environment the provider will launch with; every probe must resolve the same way. */
    env: NodeJS.ProcessEnv;
    /**
     * Whether this launch runs the local `codex` binary directly. A WSL, container, or cloud launch
     * goes through an adapter to a different filesystem and a different CLI, so a proof run on the
     * runner host would say nothing about it — and the directory is not reachable there in the
     * first place. Those launches keep their legacy policy.
     */
    nativeHostLaunch: boolean;
    /** Testing seam; defaults to the runner's own platform. */
    platform?: NodeJS.Platform;
  },
  prove: typeof provenCodexPermissionProfile = provenCodexPermissionProfile,
): Promise<CodexPermissionProfileDecision> {
  if (!launch.hookStateDir) return { active: false, reason: "no runner hook state directory" };
  if (!launch.nativeHostLaunch) {
    return { active: false, reason: "not a native host launch, so the deny cannot be proven for it" };
  }
  // Only Linux was measured, and the proof needs a POSIX shell. `codex sandbox` on macOS is
  // Seatbelt and on Windows something else again; neither has been measured, so neither is assumed.
  const platform = launch.platform ?? process.platform;
  if (platform !== "linux") {
    return { active: false, reason: `the permission-profile deny is only measured on Linux, not ${platform}` };
  }
  // An implicit launch's legacy sandbox is Codex's own default, which migrates only as `:workspace`
  // (and only when the proof reads it as exactly that) — never as the session's structured mode.
  const base = launch.legacy.kind === "implicit"
    ? ":workspace"
    : codexPermissionProfileBase(launch.legacy.permissionMode);
  if (!base) {
    const mode = launch.legacy.kind === "explicit" ? launch.legacy.permissionMode : undefined;
    return { active: false, reason: `permission mode ${mode ?? "(default)"} has no equivalent profile` };
  }
  const defeated = codexPermissionProfileDefeatedBy(launch.args);
  if (defeated.length > 0) {
    return { active: false, reason: `launch arguments defeat a permission profile: ${defeated.join(", ")}` };
  }
  const unprovable = codexPermissionProfileUnprovableArgs(launch.args);
  if (unprovable.length > 0) {
    return {
      active: false,
      reason: `launch arguments resolve configuration where the proof cannot see it: ${unprovable.join(", ")}`,
    };
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
  const proof = await prove({
    command: launch.command, args: launch.args, legacy: launch.legacy, base,
    hookStateDir: launch.hookStateDir, cwd: launch.cwd, env: launch.env,
  });
  if (!proof.ok) return { active: false, reason: proof.reason };
  return { active: true, base, args };
}
