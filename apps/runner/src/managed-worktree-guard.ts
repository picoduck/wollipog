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
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MANAGED_WORKTREE_REFUSAL,
  commandTargetsManagedWorktree,
  type ManagedWorktreeProtection,
} from "./managed-worktree-protection.js";
import { protectedWrite } from "./protected-file.js";

/** Runner re-entry mode that runs this guard. */
export const MANAGED_WORKTREE_GUARD_MODE = "--managed-worktree-guard";
/** Non-secret marker that makes a guard settings file self-describing. */
export const MANAGED_WORKTREE_GUARD_ENV = "WOLLIPOG_MANAGED_WORKTREE_GUARD_FILE";
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
export function writeManagedWorktreeGuardProtections(
  file: string,
  protections: readonly ManagedWorktreeProtection[],
): void {
  protectedWrite(
    file,
    JSON.stringify({
      version: PROTECTIONS_VERSION,
      protections: protections.map(({ worktreePath, repoPath }) => ({ worktreePath, repoPath })),
    }),
    "managed worktree guard file",
  );
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
  // Only Bash can retire a worktree behind the runner's back; every other tool is outside the
  // veto's vocabulary, so the guard holds no opinion and the selected mode decides.
  if (toolName !== "Bash") return { kind: "allow" };
  if (protections.length === 0) return { kind: "allow" };
  const toolInput = payload.tool_input;
  const command = toolInput && typeof toolInput === "object"
    ? (toolInput as { command?: unknown }).command
    : undefined;
  if (typeof command !== "string") {
    return { kind: "block", reason: "managed worktree guard received a Bash call with no command text" };
  }
  const cwd = payload.cwd;
  if (typeof cwd !== "string" || !cwd) {
    return { kind: "block", reason: "managed worktree guard received a tool call with no working directory" };
  }
  try {
    const refusal = commandTargetsManagedWorktree(command, cwd, protections);
    return refusal ? { kind: "deny", reason: refusal } : { kind: "allow" };
  } catch (error) {
    return { kind: "block", reason: `managed worktree guard failed to classify the command: ${(error as Error).message}` };
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

/** `--protections <file>` is authoritative; the settings env marker is the fallback. */
export function managedWorktreeGuardProtectionsArgument(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const index = argv.indexOf("--protections");
  const fromArgs = index >= 0 ? argv[index + 1] : undefined;
  return fromArgs ?? env[MANAGED_WORKTREE_GUARD_ENV] ?? null;
}

export interface ManagedWorktreeGuardOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runManagedWorktreeGuardDecision(
  hookInput: string,
  protectionsFile: string | null,
): ManagedWorktreeGuardOutcome {
  if (!protectionsFile) {
    return {
      stdout: "",
      stderr: "managed worktree guard was launched without a protections file\n",
      exitCode: 2,
    };
  }
  const decision = managedWorktreeGuardDecision(
    hookInput,
    () => readManagedWorktreeGuardProtections(protectionsFile),
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
  env: NodeJS.ProcessEnv = process.env,
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
    outcome = runManagedWorktreeGuardDecision(
      hookInput,
      managedWorktreeGuardProtectionsArgument(argv, env),
    );
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

/** Resolve-normalized comparison used by the settings self-description check. */
export function sameGuardPath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
