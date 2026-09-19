/**
 * Managed-worktree guard: the Claude `PreToolUse` sidecar that enforces the runner-owned worktree
 * veto without taking the session's permission mode away from the user.
 *
 * Claude only consults the runner's stdio control channel in `default` (and, for what its own
 * classifier cannot decide, in `auto`). Before this guard existed the only way to guarantee the
 * veto saw every command was to force every non-`plan` mode to interactive `default` and emulate
 * the fixed-rule modes in the runner, which turned `auto` into "ask about everything" for any
 * session with a managed worktree (issue #1313).
 *
 * A `PreToolUse` command hook supplied through `--settings` is consulted for EVERY Bash call in
 * every mode, including `auto`, `acceptEdits`, and `bypassPermissions`, and its `deny` decision
 * cannot be overridden by Claude's classifier. Measured against claude 2.1.270:
 *   - `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 *      "permissionDecisionReason":"…"}}` on stdout blocks the call in `auto`, `acceptEdits`, and
 *     `bypassPermissions`, and the reason reaches the model.
 *   - exit code 2 with a message on stderr also blocks the call (measured in `auto` and
 *     `acceptEdits`), which is what makes fail-closed possible.
 *   - a `matcher` of `"Bash"` scopes the hook without losing any Bash call.
 *
 * This process runs before every Bash tool call, so it stays dependency-light: no network, no
 * control-plane round trip, no credentials. Anything it cannot evaluate confidently BLOCKS.
 *
 * Inside a runner-owned sandbox the hook state directory is hidden from the provider and from
 * everything it spawns, this sidecar included (#1336). There the hook command carries
 * `--guard-socket`, and the sidecar hands its payload to a per-session Unix socket the runner
 * serves from outside the sandbox (managed-worktree-guard-socket.ts) instead of reading the list.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import {
  APPLY_PATCH_TOOL,
  GUARD_STATE_FILE_TOOLS,
  MANAGED_WORKTREE_REFUSAL,
  applyPatchTargetsProtected,
  commandTargetsGuardState,
  commandTargetsManagedWorktree,
  toolTargetsGuardState,
  type ManagedWorktreeProtection,
  type ProviderEnvironment,
} from "./managed-worktree-protection.js";
import { quote } from "shell-quote";
import { protectedWrite } from "./protected-file.js";

/** Runner re-entry mode that runs this guard. */
export const MANAGED_WORKTREE_GUARD_MODE = "--managed-worktree-guard";
/**
 * Tools the guard hook must be invoked for: Bash, Codex's `apply_patch`, and every tool that names
 * a file path.
 *
 * Codex is named explicitly rather than relied on. Measured at codex-cli 0.155.1 (2026-09-19), an
 * `apply_patch` call is matched by `apply_patch` AND by `Edit`, so the alternation the runner wrote
 * before #1437 already reached the hook — but only through an undocumented alias, and a build that
 * dropped it would have silenced the guard on every edit without saying so. A matcher Codex does
 * not recognise simply never fires, and Claude has no tool by this name, so the addition costs
 * neither provider anything.
 */
export const MANAGED_WORKTREE_GUARD_MATCHER =
  ["Bash", APPLY_PATCH_TOOL, ...Object.keys(GUARD_STATE_FILE_TOOLS)].join("|");
export const MANAGED_WORKTREE_GUARD_PROTECTIONS_SUFFIX = ".protections.json";
const PROTECTIONS_VERSION = 1;
const MAX_HOOK_INPUT_BYTES = 1_000_000;

export function managedWorktreeGuardProtectionsPath(settingsFile: string, suffix: string): string {
  return settingsFile.endsWith(suffix)
    ? `${settingsFile.slice(0, -suffix.length)}${MANAGED_WORKTREE_GUARD_PROTECTIONS_SUFFIX}`
    : `${settingsFile}${MANAGED_WORKTREE_GUARD_PROTECTIONS_SUFFIX}`;
}

/**
 * Persist the LIVE protection set for a session. Written at every Claude spawn and again whenever
 * the session's attributed worktree inventory changes, so a worktree created mid-turn is covered
 * from the guard's next invocation.
 */
export function managedWorktreeGuardProtectionsDocument(
  protections: readonly ManagedWorktreeProtection[],
): string {
  return JSON.stringify({
    version: PROTECTIONS_VERSION,
    protections: protections.map(({ worktreePath, repoPath }) => ({ worktreePath, repoPath })),
  });
}

/** Digest of the exact document the runner wrote, used as the tamper tripwire's baseline. */
export function managedWorktreeGuardDigest(document: string): string {
  return createHash("sha256").update(document).digest("hex");
}

/**
 * Returns the digest of what was written, so the caller can remember its own baseline.
 *
 * An empty list is a legitimate state (issue #1303): the guard is installed from spawn so that a
 * worktree the session creates part-way through a turn is protected from the guard's next
 * invocation, and until then it has no worktree to protect. It still vetoes its own state.
 */
export function writeManagedWorktreeGuardProtections(
  file: string,
  protections: readonly ManagedWorktreeProtection[],
): string {
  const document = managedWorktreeGuardProtectionsDocument(protections);
  protectedWrite(file, document, "managed worktree guard file");
  return managedWorktreeGuardDigest(document);
}

/**
 * Tamper tripwire. The provider runs as the same OS user and can rewrite this file, so the runner
 * compares what is on disk against the digest of what it last wrote. A mismatch (or an unreadable
 * file where one is expected) means the guard's state is no longer the runner's.
 */
export function managedWorktreeGuardStateMatches(file: string, expectedDigest: string): boolean {
  try {
    return managedWorktreeGuardDigest(readFileSync(file, "utf8")) === expectedDigest;
  } catch {
    return false;
  }
}

/** Parse a protections document. Anything unexpected throws, which the guard turns into a block. */
export function parseManagedWorktreeGuardProtections(contents: string): ManagedWorktreeProtection[] {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("protections document is not an object");
  const document = parsed as { version?: unknown; protections?: unknown };
  if (document.version !== PROTECTIONS_VERSION) throw new Error("unsupported protections document version");
  if (!Array.isArray(document.protections)) throw new Error("protections document has no protection list");
  return document.protections.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("protection entry is not an object");
    const { worktreePath, repoPath } = entry as { worktreePath?: unknown; repoPath?: unknown };
    if (typeof worktreePath !== "string" || !worktreePath ||
        typeof repoPath !== "string" || !repoPath) {
      throw new Error("protection entry is missing a path");
    }
    return { worktreePath, repoPath };
  });
}

export function readManagedWorktreeGuardProtections(file: string): ManagedWorktreeProtection[] {
  return parseManagedWorktreeGuardProtections(readFileSync(file, "utf8"));
}

export type ManagedWorktreeGuardDecision =
  /** Deny the tool call with a reason the model reads. */
  | { kind: "deny"; reason: string }
  /** No opinion: the session's own permission mode decides. */
  | { kind: "allow" }
  /** Fail closed: the tool call is blocked because the guard could not evaluate it. */
  | { kind: "block"; reason: string };

/**
 * Decide a single `PreToolUse` payload. Every unreadable, malformed, or unexpected input blocks:
 * a guard that cannot evaluate a command must not let it through.
 */
export function managedWorktreeGuardDecision(
  hookInput: string,
  loadProtections: () => ManagedWorktreeProtection[],
  guardStateDirectory: string,
  // This process is spawned by the provider, so its own environment IS the one the provider's
  // shell starts from: the variable holding the protected worktree path resolves here (#1324).
  environment: ProviderEnvironment = process.env,
): ManagedWorktreeGuardDecision {
  let payload: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  try {
    if (hookInput.length > MAX_HOOK_INPUT_BYTES) throw new Error("hook payload is too large");
    const parsed = JSON.parse(hookInput) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("hook payload is not an object");
    }
    payload = parsed as typeof payload;
  } catch (error) {
    return { kind: "block", reason: `managed worktree guard could not read its input: ${(error as Error).message}` };
  }
  let protections: ManagedWorktreeProtection[];
  try {
    protections = loadProtections();
  } catch (error) {
    return {
      kind: "block",
      reason: `managed worktree guard could not load this session's protected worktrees: ${(error as Error).message}`,
    };
  }
  const toolName = payload.tool_name;
  if (typeof toolName !== "string" || !toolName) {
    return { kind: "block", reason: "managed worktree guard received a tool call with no tool name" };
  }
  // An empty list is the runner's own statement that this session owns no managed worktree yet;
  // an invalidated guard has NO list, which `loadProtections` has already turned into a block.
  const isBash = toolName === "Bash";
  const isFileTool = Object.hasOwn(GUARD_STATE_FILE_TOOLS, toolName);
  const isApplyPatch = toolName === APPLY_PATCH_TOOL;
  // Every other tool is outside the veto's vocabulary, so the guard holds no opinion.
  if (!isBash && !isFileTool && !isApplyPatch) return { kind: "allow" };
  const cwd = payload.cwd;
  if (typeof cwd !== "string" || !cwd) {
    return { kind: "block", reason: "managed worktree guard received a tool call with no working directory" };
  }
  try {
    if (isFileTool) {
      const verdict = toolTargetsGuardState(toolName, payload.tool_input, cwd, guardStateDirectory);
      if (verdict === "malformed") {
        return { kind: "block", reason: `managed worktree guard received a ${toolName} call with no usable path` };
      }
      return verdict ? { kind: "deny", reason: verdict } : { kind: "allow" };
    }
    const toolInput = payload.tool_input;
    const command = toolInput && typeof toolInput === "object"
      ? (toolInput as { command?: unknown }).command
      : undefined;
    if (isApplyPatch) {
      // Codex carries the patch document in the same `command` key a shell call carries its
      // command in (measured; see `applyPatchTargetsProtected`). Anything else is not a patch this
      // guard can read, and an unreadable edit is refused rather than passed.
      if (typeof command !== "string") {
        return { kind: "block", reason: `managed worktree guard received an ${APPLY_PATCH_TOOL} call with no patch text` };
      }
      const verdict = applyPatchTargetsProtected(command, cwd, guardStateDirectory, protections);
      if (verdict === "malformed") {
        return {
          kind: "block",
          reason: `managed worktree guard could not read the file headers of an ${APPLY_PATCH_TOOL} patch`,
        };
      }
      return verdict ? { kind: "deny", reason: verdict } : { kind: "allow" };
    }
    if (typeof command !== "string") {
      return { kind: "block", reason: "managed worktree guard received a Bash call with no command text" };
    }
    // The guard's own state comes first: a command that can rewrite the protection list would
    // otherwise disarm every later check.
    const stateRefusal = commandTargetsGuardState(command, cwd, guardStateDirectory);
    if (stateRefusal) return { kind: "deny", reason: stateRefusal };
    const refusal = commandTargetsManagedWorktree(command, cwd, protections, environment);
    return refusal ? { kind: "deny", reason: refusal } : { kind: "allow" };
  } catch (error) {
    return { kind: "block", reason: `managed worktree guard failed to classify the call: ${(error as Error).message}` };
  }
}

export function managedWorktreeGuardDenyPayload(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/**
 * The protections path comes ONLY from the hook command inside the 0600 settings file. It is
 * deliberately not published in the settings `env` block: that block is exported into every tool
 * process, which would hand the provider the exact path to the guard's own state.
 */
export function managedWorktreeGuardProtectionsArgument(argv: readonly string[]): string | null {
  const index = argv.indexOf("--protections");
  return (index >= 0 ? argv[index + 1] : undefined) ?? null;
}

export const MANAGED_WORKTREE_GUARD_SOCKET_FLAG = "--guard-socket";
/** A guard verdict is a local file read and a classification; anything slower is a stuck runner. */
export const MANAGED_WORKTREE_GUARD_SOCKET_TIMEOUT_MS = 30_000;
const MAX_VERDICT_BYTES = 256 * 1024;

/**
 * The runner's verdict socket for this session (#1336), present only when the launch runs inside a
 * runner-owned sandbox that hides the hook state directory. Its presence is a commitment: the
 * sidecar then asks the runner and never reads the protections file, which it cannot see.
 */
export function managedWorktreeGuardSocketArgument(argv: readonly string[]): string | null | undefined {
  const index = argv.indexOf(MANAGED_WORKTREE_GUARD_SOCKET_FLAG);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

export interface ManagedWorktreeGuardOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A verdict from the runner is exactly the outcome shape, and only the two exit codes Claude and
 * Codex give a meaning to. Anything else is not a verdict. */
export function parseManagedWorktreeGuardVerdict(text: string): ManagedWorktreeGuardOutcome {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("verdict is not an object");
  const { stdout, stderr, exitCode } = parsed as Record<string, unknown>;
  if (typeof stdout !== "string" || typeof stderr !== "string" || (exitCode !== 0 && exitCode !== 2)) {
    throw new Error("verdict has an unexpected shape");
  }
  return { stdout, stderr, exitCode };
}

/**
 * Ask the runner to judge one hook payload. The runner judges it against the protection list of
 * the session that owns this socket, with the same `runManagedWorktreeGuardDecision` a file-mode
 * sidecar runs. Every failure — no socket, a refused or reset connection, a timeout, an oversized
 * or malformed answer — rejects, and the caller turns that into exit 2.
 */
export function requestManagedWorktreeGuardVerdict(
  socketPath: string,
  hookInput: string,
  timeoutMs = MANAGED_WORKTREE_GUARD_SOCKET_TIMEOUT_MS,
): Promise<ManagedWorktreeGuardOutcome> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: Error | null, outcome?: ManagedWorktreeGuardOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(outcome!);
    };
    const socket = connect(socketPath);
    const timer = setTimeout(() => finish(new Error("the runner did not answer in time")), timeoutMs);
    socket.on("connect", () => socket.end(hookInput));
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_VERDICT_BYTES) finish(new Error("the runner's answer is too large"));
      else chunks.push(chunk);
    });
    socket.on("end", () => {
      try {
        finish(null, parseManagedWorktreeGuardVerdict(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        finish(new Error(`the runner's answer is not a verdict: ${(error as Error).message}`));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("the runner closed the connection without a verdict")));
  });
}

export function runManagedWorktreeGuardDecision(
  hookInput: string,
  protectionsFile: string | null,
  environment: ProviderEnvironment = process.env,
): ManagedWorktreeGuardOutcome {
  if (!protectionsFile) {
    return {
      stdout: "",
      stderr: `${MANAGED_WORKTREE_REFUSAL} (managed worktree guard was launched without a protections file)\n`,
      exitCode: 2,
    };
  }
  const decision = managedWorktreeGuardDecision(
    hookInput,
    () => readManagedWorktreeGuardProtections(protectionsFile),
    dirname(resolve(protectionsFile)),
    environment,
  );
  if (decision.kind === "deny") {
    return { stdout: `${managedWorktreeGuardDenyPayload(decision.reason)}\n`, stderr: "", exitCode: 0 };
  }
  if (decision.kind === "block") {
    return {
      stdout: "",
      // Claude blocks the tool call on exit code 2 and shows stderr to the model.
      stderr: `${MANAGED_WORKTREE_REFUSAL} (${decision.reason})\n`,
      exitCode: 2,
    };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

async function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    total += buffer.length;
    if (total > MAX_HOOK_INPUT_BYTES) throw new Error("hook payload is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Runner re-entry entry point (`--managed-worktree-guard`). */
export async function runManagedWorktreeGuardCli(
  argv: readonly string[] = process.argv,
  io: {
    stdin?: NodeJS.ReadableStream;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    exit?: (code: number) => void;
  } = {},
): Promise<void> {
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  const warn = io.stderr ?? ((text: string) => process.stderr.write(text));
  const exit = io.exit ?? ((code: number) => { process.exitCode = code; });
  let outcome: ManagedWorktreeGuardOutcome;
  try {
    const hookInput = await readAllStdin(io.stdin ?? process.stdin);
    const socketPath = managedWorktreeGuardSocketArgument(argv);
    if (socketPath === null) {
      outcome = {
        stdout: "",
        stderr: `${MANAGED_WORKTREE_REFUSAL} (managed worktree guard was launched with an empty verdict socket)\n`,
        exitCode: 2,
      };
    } else if (socketPath !== undefined) {
      // Sandboxed launch: the protections file is hidden from this process by design, so there is
      // nothing to fall back to. An unreachable runner is a refusal, never a pass.
      try {
        outcome = await requestManagedWorktreeGuardVerdict(socketPath, hookInput);
      } catch (error) {
        outcome = {
          stdout: "",
          stderr: `${MANAGED_WORKTREE_REFUSAL} (managed worktree guard could not get a verdict from the runner: ${(error as Error).message})\n`,
          exitCode: 2,
        };
      }
    } else {
      outcome = runManagedWorktreeGuardDecision(
        hookInput,
        managedWorktreeGuardProtectionsArgument(argv),
      );
    }
  } catch (error) {
    outcome = {
      stdout: "",
      stderr: `${MANAGED_WORKTREE_REFUSAL} (managed worktree guard failed: ${(error as Error).message})\n`,
      exitCode: 2,
    };
  }
  if (outcome.stdout) write(outcome.stdout);
  if (outcome.stderr) warn(outcome.stderr);
  exit(outcome.exitCode);
}

/**
 * Prove, before the launch commits to it, that this exact hook command actually refuses a
 * destructive command against a protected worktree.
 *
 * Claude only treats exit code 2 as blocking: a hook that fails to START (a bad interpreter, an
 * unresolvable loader, a missing script) exits 1 and the tool call proceeds. A guard that cannot
 * be proven to run is therefore worse than no guard, because the driver would stop mediating on
 * the strength of it. The probe runs the real sidecar from a directory that is NOT the runner's
 * own and demands the real refusal document.
 *
 * The probe owns its protections file and the worktree named in it. What is proven is a property
 * of the launch command, not of the session — and a session that owns no worktree yet still needs
 * a proven guard, because it may create its first one later in the very turn about to start
 * (issue #1303). Probing through the session's live file would mean publishing a fake protection
 * there, where a concurrent guard invocation could read it.
 */
export function verifyManagedWorktreeGuardLaunch(
  launch: { command: string; args: string[] },
  spawn: typeof spawnSync = spawnSync,
): { ok: true } | { ok: false; reason: string } {
  let probeDir: string;
  try {
    probeDir = mkdtempSync(join(tmpdir(), "wollipog-guard-probe-"));
  } catch (error) {
    return { ok: false, reason: `probe directory could not be created: ${(error as Error).message}` };
  }
  try {
    // The worktree lives OUTSIDE the state directory, as a real one always does: a path inside it
    // would be refused by the guard-state veto instead, which proves nothing about the worktree
    // veto. Its name carries a space and a quote so the probe always exercises the quoting below.
    const stateDir = join(probeDir, "state");
    const protectionsFile = join(stateDir, "probe.protections.json");
    const worktreePath = join(probeDir, "trees", "probe's worktree");
    writeManagedWorktreeGuardProtections(protectionsFile, [{ worktreePath, repoPath: join(probeDir, "repo") }]);
    const payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: probeDir,
      // Shell-quote the path: whitespace or a quote would otherwise split it into several operands,
      // the matcher would inspect the wrong one, the probe would see no refusal, and every launch
      // would silently fall back to mediation.
      tool_input: { command: quote(["git", "worktree", "remove", worktreePath]) },
    });
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawn(launch.command, [...launch.args, "--protections", protectionsFile], {
        input: payload,
        encoding: "utf8",
        // The sidecar's cwd is CLAUDE's, never the runner's; probe the same way.
        cwd: probeDir,
        timeout: 20_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, reason: `probe could not be started: ${(error as Error).message}` };
    }
    if (result.error) return { ok: false, reason: `probe failed: ${result.error.message}` };
    if (result.status !== 0) {
      return { ok: false, reason: `probe exited ${String(result.status)}: ${String(result.stderr ?? "").trim().slice(0, 200)}` };
    }
    const stdout = String(result.stdout ?? "");
    if (!stdout.includes('"permissionDecision":"deny"') || !stdout.includes(MANAGED_WORKTREE_REFUSAL)) {
      return { ok: false, reason: "probe did not produce the managed worktree refusal" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `probe could not be prepared: ${(error as Error).message}` };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/** Resolve-normalized comparison used by the settings self-description check. */
export function sameGuardPath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
