import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MANAGED_WORKTREE_REFUSAL } from "./managed-worktree-protection.js";
import { runnerReentryCommand } from "./runner-reentry.js";
import {
  MANAGED_WORKTREE_GUARD_ENV,
  managedWorktreeGuardProtectionsArgument,
  managedWorktreeGuardProtectionsPath,
  readManagedWorktreeGuardProtections,
  runManagedWorktreeGuardCli,
  runManagedWorktreeGuardDecision,
  verifyManagedWorktreeGuardLaunch,
  writeManagedWorktreeGuardProtections,
} from "./managed-worktree-guard.js";

const REPO = "/repo";
const WORKTREE = "/repo-worktrees/session-a";

function fixture(): { dir: string; protectionsFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-guard-"));
  const protectionsFile = join(dir, "s1.protections.json");
  writeManagedWorktreeGuardProtections(protectionsFile, [{ worktreePath: WORKTREE, repoPath: REPO }]);
  return { dir, protectionsFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function hookInput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "abc",
    cwd: WORKTREE,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    ...overrides,
  });
}

test("a destructive command against a protected worktree is denied with the managed refusal", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const outcome = runManagedWorktreeGuardDecision(
    hookInput({ tool_input: { command: `git worktree remove ${WORKTREE}` } }),
    f.protectionsFile,
  );
  assert.equal(outcome.exitCode, 0, "a deny decision is a successful hook run, not a failure");
  assert.equal(outcome.stderr, "");
  const decision = JSON.parse(outcome.stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  assert.deepEqual(decision.hookSpecificOutput, {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: MANAGED_WORKTREE_REFUSAL,
  });
});

test("rm -rf of a protected worktree is denied too", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const outcome = runManagedWorktreeGuardDecision(
    hookInput({ tool_input: { command: `rm -rf ${WORKTREE}` } }),
    f.protectionsFile,
  );
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.stdout, /"permissionDecision":"deny"/u);
});

test("a harmless command produces no decision at all, so the selected mode decides", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const outcome = runManagedWorktreeGuardDecision(hookInput(), f.protectionsFile);
  assert.deepEqual(outcome, { stdout: "", stderr: "", exitCode: 0 });
});

test("a non-Bash tool produces no decision", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const toolName of ["Edit", "Write", "Read", "Task", "WebFetch"]) {
    const outcome = runManagedWorktreeGuardDecision(
      hookInput({ tool_name: toolName, tool_input: { file_path: WORKTREE } }),
      f.protectionsFile,
    );
    assert.deepEqual(outcome, { stdout: "", stderr: "", exitCode: 0 }, `${toolName} has no guard opinion`);
  }
});

test("a Bash call made by a subagent is evaluated exactly like any other Bash call", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  // PreToolUse fires inside the subagent too; the payload shape is identical.
  const outcome = runManagedWorktreeGuardDecision(
    hookInput({ tool_input: { command: `git worktree remove ${WORKTREE}` }, tool_use_id: "toolu_sub" }),
    f.protectionsFile,
  );
  assert.match(outcome.stdout, /"permissionDecision":"deny"/u);
});

test("an empty protection set allows everything (the last managed worktree was discarded)", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeManagedWorktreeGuardProtections(f.protectionsFile, []);
  const outcome = runManagedWorktreeGuardDecision(
    hookInput({ tool_input: { command: `git worktree remove ${WORKTREE}` } }),
    f.protectionsFile,
  );
  assert.deepEqual(outcome, { stdout: "", stderr: "", exitCode: 0 });
});

test("a refreshed protections file is picked up by the very next invocation", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const second = "/repo-worktrees/session-b";
  const command = `git worktree remove ${second}`;
  assert.deepEqual(
    runManagedWorktreeGuardDecision(hookInput({ tool_input: { command } }), f.protectionsFile),
    { stdout: "", stderr: "", exitCode: 0 },
    "a worktree that is not protected yet is not the guard's business",
  );
  writeManagedWorktreeGuardProtections(f.protectionsFile, [
    { worktreePath: WORKTREE, repoPath: REPO },
    { worktreePath: second, repoPath: REPO },
  ]);
  assert.match(
    runManagedWorktreeGuardDecision(hookInput({ tool_input: { command } }), f.protectionsFile).stdout,
    /"permissionDecision":"deny"/u,
    "a worktree created mid-session is protected from the next invocation on",
  );
});

function blocks(outcome: { stdout: string; stderr: string; exitCode: number }, label: string): void {
  // Claude blocks the tool call on exit code 2 and shows stderr to the model (measured on 2.1.270).
  assert.equal(outcome.exitCode, 2, `${label} blocks the call`);
  assert.equal(outcome.stdout, "", `${label} prints no permission decision`);
  assert.ok(outcome.stderr.includes(MANAGED_WORKTREE_REFUSAL), `${label} explains itself`);
}

test("malformed hook input fails closed", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const [label, input] of [
    ["empty stdin", ""],
    ["truncated JSON", '{"tool_name":"Bash"'],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"Bash"'],
    ["a missing tool name", JSON.stringify({ cwd: WORKTREE, tool_input: { command: "ls" } })],
    ["a non-string tool name", JSON.stringify({ tool_name: 7, cwd: WORKTREE })],
    ["a Bash call with no command", JSON.stringify({ tool_name: "Bash", cwd: WORKTREE, tool_input: {} })],
    ["a Bash call with a non-string command", hookInput({ tool_input: { command: 12 } })],
    ["a Bash call with no cwd", JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })],
  ] as Array<[string, string]>) {
    blocks(runManagedWorktreeGuardDecision(input, f.protectionsFile), label);
  }
});

test("an unreadable or malformed protections file fails closed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "absent.protections.json");
  blocks(runManagedWorktreeGuardDecision(hookInput(), missing), "a missing protections file");
  blocks(runManagedWorktreeGuardDecision(hookInput(), null), "no protections file argument at all");

  const malformed = join(dir, "bad.protections.json");
  for (const contents of [
    "",
    "{",
    "[]",
    JSON.stringify({ version: 99, protections: [] }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, protections: [{ worktreePath: "/w" }] }),
    JSON.stringify({ version: 1, protections: [{ worktreePath: "", repoPath: "/r" }] }),
    JSON.stringify({ version: 1, protections: ["/w"] }),
  ]) {
    writeFileSync(malformed, contents, "utf8");
    blocks(runManagedWorktreeGuardDecision(hookInput(), malformed), `protections ${JSON.stringify(contents)}`);
  }
});

test("a protections file the guard cannot open fails closed rather than allowing the call", (t) => {
  if (process.getuid?.() === 0) return; // root ignores the mode bits
  const f = fixture();
  t.after(() => {
    chmodSync(f.protectionsFile, 0o600);
    f.cleanup();
  });
  chmodSync(f.protectionsFile, 0o000);
  blocks(runManagedWorktreeGuardDecision(hookInput(), f.protectionsFile), "an unreadable protections file");
});

test("the CLI reads stdin, writes the decision, and fails closed when stdin explodes", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const run = async (stdin: NodeJS.ReadableStream, argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    let code: number | undefined;
    await runManagedWorktreeGuardCli(argv, {}, {
      stdin,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      exit: (value) => { code = value; },
    });
    return { out: out.join(""), err: err.join(""), code };
  };

  const denied = await run(
    Readable.from([hookInput({ tool_input: { command: `git worktree remove ${WORKTREE}` } })]),
    ["node", "cli.js", "--managed-worktree-guard", "--protections", f.protectionsFile],
  );
  assert.equal(denied.code, 0);
  assert.match(denied.out, /"permissionDecision":"deny"/u);

  const allowed = await run(
    Readable.from([hookInput()]),
    ["node", "cli.js", "--managed-worktree-guard", "--protections", f.protectionsFile],
  );
  assert.deepEqual([allowed.code, allowed.out, allowed.err], [0, "", ""]);

  const exploding = new Readable({ read() { this.destroy(new Error("stdin went away")); } });
  const failed = await run(
    exploding,
    ["node", "cli.js", "--managed-worktree-guard", "--protections", f.protectionsFile],
  );
  assert.equal(failed.code, 2, "an unreadable stdin blocks the tool call");
  assert.ok(failed.err.includes(MANAGED_WORKTREE_REFUSAL));

  const noArgument = await run(Readable.from([hookInput()]), ["node", "cli.js", "--managed-worktree-guard"]);
  assert.equal(noArgument.code, 2, "a guard launched without a protections file blocks");
});

test("the protections file path is taken from the argument first and the settings env marker second", () => {
  assert.equal(
    managedWorktreeGuardProtectionsArgument(
      ["node", "cli.js", "--managed-worktree-guard", "--protections", "/a/s1.protections.json"],
      { [MANAGED_WORKTREE_GUARD_ENV]: "/b/other.protections.json" },
    ),
    "/a/s1.protections.json",
  );
  assert.equal(
    managedWorktreeGuardProtectionsArgument(["node", "cli.js"], { [MANAGED_WORKTREE_GUARD_ENV]: "/b/x.json" }),
    "/b/x.json",
  );
  assert.equal(managedWorktreeGuardProtectionsArgument(["node", "cli.js"], {}), null);
});

test("the protections path is derived from the settings file it belongs to", () => {
  assert.equal(
    managedWorktreeGuardProtectionsPath("/hooks/s1.settings.json", ".settings.json"),
    "/hooks/s1.protections.json",
  );
});

test("a written protections file round-trips exactly the runner-owned worktrees", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeManagedWorktreeGuardProtections(f.protectionsFile, [
    { worktreePath: WORKTREE, repoPath: REPO },
    { worktreePath: "/repo-worktrees/b", repoPath: REPO },
  ]);
  assert.deepEqual(readManagedWorktreeGuardProtections(f.protectionsFile), [
    { worktreePath: WORKTREE, repoPath: REPO },
    { worktreePath: "/repo-worktrees/b", repoPath: REPO },
  ]);
});

test("the REAL sidecar launch refuses from a foreign working directory", (t) => {
  // Regression for the fail-open hole found while validating #1313 against claude 2.1.270: a hook
  // launched with a BARE loader specifier (`--import tsx`) resolves it from CLAUDE's cwd, not the
  // runner's, fails with ERR_MODULE_NOT_FOUND, and exits 1 — and Claude blocks only on exit 2, so
  // every command would have been waved through while the driver stopped mediating.
  const f = fixture();
  t.after(f.cleanup);
  const launch = runnerReentryCommand(
    {
      isSea: false,
      execPath: process.execPath,
      execArgv: process.execArgv,
      scriptPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    },
    "--managed-worktree-guard",
  );
  assert.deepEqual(
    verifyManagedWorktreeGuardLaunch(launch, f.protectionsFile, [{ worktreePath: WORKTREE, repoPath: REPO }]),
    { ok: true },
  );
});

test("a sidecar that cannot start is reported as unverified, never as a working guard", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const launch = { command: process.execPath, args: ["--import", "definitely-not-installed-xyz", "/nope.ts"] };
  const verdict = verifyManagedWorktreeGuardLaunch(launch, f.protectionsFile, [
    { worktreePath: WORKTREE, repoPath: REPO },
  ]);
  assert.equal(verdict.ok, false);
});

test("a sidecar that exits 0 without refusing is rejected by the self-test", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const verdict = verifyManagedWorktreeGuardLaunch(
    { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
    f.protectionsFile,
    [{ worktreePath: WORKTREE, repoPath: REPO }],
    (() => ({ status: 0, stdout: "", stderr: "", error: undefined })) as never,
  );
  assert.deepEqual(verdict, { ok: false, reason: "probe did not produce the managed worktree refusal" });
});

test("the self-test needs a protected worktree to probe with", () => {
  assert.deepEqual(
    verifyManagedWorktreeGuardLaunch({ command: "node", args: [] }, "/nowhere.json", []),
    { ok: false, reason: "no protected worktree to probe with" },
  );
});
