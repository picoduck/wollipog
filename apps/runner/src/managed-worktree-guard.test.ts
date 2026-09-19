import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import fc from "fast-check";
import {
  GUARD_STATE_REFUSAL,
  MANAGED_WORKTREE_REFUSAL,
  MANAGED_WORKTREE_UNRESOLVED_REFUSAL,
  commandTargetsGuardState,
  guardStateClassifierWork,
  guardStateRelation,
  pathTargetsGuardState,
} from "./managed-worktree-protection.js";
import { runnerReentryCommand } from "./runner-reentry.js";
import {
  MANAGED_WORKTREE_GUARD_MATCHER,
  managedWorktreeGuardProtectionsArgument,
  managedWorktreeGuardProtectionsPath,
  managedWorktreeGuardStateMatches,
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

test("the guard resolves a worktree path held in its own environment (#1324)", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  // This process is spawned by the provider, so its environment is the one the provider's shell
  // starts from — which is where the runner put `WOLLIPOG_WORKTREE_PATH`. Passing it explicitly
  // here is what the real launch does implicitly through `process.env`.
  const environment = { WOLLIPOG_WORKTREE_PATH: WORKTREE, WOLLIPOG_PRIMARY_CHECKOUT: REPO };
  for (const command of ['rm -rf "$WOLLIPOG_WORKTREE_PATH"', "rm -rf ${WOLLIPOG_WORKTREE_PATH}",
    'git worktree remove "$WOLLIPOG_WORKTREE_PATH"']) {
    const outcome = runManagedWorktreeGuardDecision(
      hookInput({ tool_input: { command } }), f.protectionsFile, environment);
    assert.equal(outcome.exitCode, 0, command);
    assert.equal(JSON.parse(outcome.stdout).hookSpecificOutput.permissionDecisionReason,
      MANAGED_WORKTREE_REFUSAL, command);
  }
  // A destructive operand that resolves nowhere is denied with the message that says so...
  const unresolved = runManagedWorktreeGuardDecision(
    hookInput({ tool_input: { command: 'rm -rf "$SCRATCH_DIR"' } }), f.protectionsFile, environment);
  assert.equal(JSON.parse(unresolved.stdout).hookSpecificOutput.permissionDecisionReason,
    MANAGED_WORKTREE_UNRESOLVED_REFUSAL);
  // ...while work beneath the worktree, and reads naming the same unknown variable, still run.
  for (const command of ['rm -rf "$WOLLIPOG_WORKTREE_PATH/node_modules/.cache"', 'ls "$SCRATCH_DIR"',
    "pnpm test"]) {
    assert.deepEqual(
      runManagedWorktreeGuardDecision(hookInput({ tool_input: { command } }), f.protectionsFile, environment),
      { stdout: "", stderr: "", exitCode: 0 }, command);
  }
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

test("a tool outside the veto's vocabulary produces no decision", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const toolName of ["Task", "WebFetch", "TodoWrite"]) {
    const outcome = runManagedWorktreeGuardDecision(
      hookInput({ tool_name: toolName, tool_input: { file_path: WORKTREE } }),
      f.protectionsFile,
    );
    assert.deepEqual(outcome, { stdout: "", stderr: "", exitCode: 0 }, `${toolName} has no guard opinion`);
  }
});

test("an ordinary file-tool edit outside the guard's own state gets no opinion", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const [toolName, key] of [
    ["Edit", "file_path"], ["MultiEdit", "file_path"], ["Write", "file_path"],
    ["Read", "file_path"], ["NotebookEdit", "notebook_path"],
  ] as Array<[string, string]>) {
    const outcome = runManagedWorktreeGuardDecision(
      hookInput({ tool_name: toolName, tool_input: { [key]: `${WORKTREE}/src/app.ts` } }),
      f.protectionsFile,
    );
    assert.deepEqual(outcome, { stdout: "", stderr: "", exitCode: 0 }, `${toolName} elsewhere is allowed`);
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

test("an empty protection list is a session with no worktree yet: no opinion, but its own state stays vetoed", (t) => {
  // Issue #1303: the guard is installed from spawn so a worktree created later in the same turn is
  // protected from the next invocation. Until then it holds no worktree opinion at all.
  const f = fixture();
  t.after(f.cleanup);
  writeManagedWorktreeGuardProtections(f.protectionsFile, []);
  assert.deepEqual(readManagedWorktreeGuardProtections(f.protectionsFile), []);
  for (const command of ["ls", `git worktree remove ${WORKTREE}`, `rm -rf ${WORKTREE}`]) {
    assert.deepEqual(
      runManagedWorktreeGuardDecision(hookInput({ tool_input: { command } }), f.protectionsFile),
      { stdout: "", stderr: "", exitCode: 0 },
      `${command} is left to the selected mode while nothing is protected`,
    );
  }
  const stateWrite = runManagedWorktreeGuardDecision(
    hookInput({ tool_input: { command: `echo '{}' > ${f.protectionsFile}` } }),
    f.protectionsFile,
  );
  assert.match(stateWrite.stdout, /"permissionDecision":"deny"/u, "the empty list itself is still off limits");
  // The runner signals an invalidated guard by REMOVING the list, never by emptying it.
  rmSync(f.protectionsFile);
  blocks(runManagedWorktreeGuardDecision(hookInput(), f.protectionsFile), "a missing protection list");
});

test("a worktree added to an empty list is protected from the very next invocation", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeManagedWorktreeGuardProtections(f.protectionsFile, []);
  const destroy = hookInput({ tool_input: { command: `git worktree remove --force ${WORKTREE}` } });
  assert.equal(runManagedWorktreeGuardDecision(destroy, f.protectionsFile).stdout, "");
  writeManagedWorktreeGuardProtections(f.protectionsFile, [{ worktreePath: WORKTREE, repoPath: REPO }]);
  assert.match(runManagedWorktreeGuardDecision(destroy, f.protectionsFile).stdout, /"permissionDecision":"deny"/u);
  // Ordinary work inside the new worktree is untouched.
  assert.deepEqual(
    runManagedWorktreeGuardDecision(hookInput({ tool_input: { command: "git status && pnpm test" } }), f.protectionsFile),
    { stdout: "", stderr: "", exitCode: 0 },
  );
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
    await runManagedWorktreeGuardCli(argv, {
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

test("the protections path comes only from the hook command, never from the environment", () => {
  assert.equal(
    managedWorktreeGuardProtectionsArgument(
      ["node", "cli.js", "--managed-worktree-guard", "--protections", "/a/s1.protections.json"],
    ),
    "/a/s1.protections.json",
  );
  // No environment fallback: `env` is exported into every tool process, and an environment the
  // provider can influence must never be able to redirect the guard at a file of its choosing.
  assert.equal(managedWorktreeGuardProtectionsArgument(["node", "cli.js"]), null);
});

test("the hook matcher covers Bash, Codex's apply_patch, and every path-bearing file tool", () => {
  assert.deepEqual(MANAGED_WORKTREE_GUARD_MATCHER.split("|").sort(),
    ["Bash", "Edit", "Glob", "Grep", "MultiEdit", "NotebookEdit", "Read", "Write", "apply_patch"]);
  // #1437: Codex's edit tool is named outright rather than reached through the `Edit` alias it
  // also answers to. The runner installs this same string as its Codex hook matcher.
  assert.ok(MANAGED_WORKTREE_GUARD_MATCHER.split("|").includes("apply_patch"));
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
  const launch = runnerReentryCommand(
    {
      isSea: false,
      execPath: process.execPath,
      execArgv: process.execArgv,
      scriptPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    },
    "--managed-worktree-guard",
  );
  assert.deepEqual(verifyManagedWorktreeGuardLaunch(launch), { ok: true });
});

test("a sidecar that cannot start is reported as unverified, never as a working guard", () => {
  const launch = { command: process.execPath, args: ["--import", "definitely-not-installed-xyz", "/nope.ts"] };
  const verdict = verifyManagedWorktreeGuardLaunch(launch);
  assert.equal(verdict.ok, false);
});

test("a sidecar that exits 0 without refusing is rejected by the self-test", () => {
  const verdict = verifyManagedWorktreeGuardLaunch(
    { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
    (() => ({ status: 0, stdout: "", stderr: "", error: undefined })) as never,
  );
  assert.deepEqual(verdict, { ok: false, reason: "probe did not produce the managed worktree refusal" });
});

test("the self-test owns its protections, needs none from the session, and leaves nothing behind", () => {
  // Issue #1303: a session with no worktree yet still needs a PROVEN guard. The probe publishes a
  // protection only in its own private file — never in a session's live list.
  const seen: Array<{ args: string[]; cwd: string; input: string }> = [];
  const verdict = verifyManagedWorktreeGuardLaunch(
    { command: "node", args: ["guard.js"] },
    ((command: string, args: string[], options: { cwd: string; input: string }) => {
      seen.push({ args, cwd: options.cwd, input: options.input });
      return { status: 0, stdout: `{"permissionDecision":"deny","reason":"${MANAGED_WORKTREE_REFUSAL}"}`, stderr: "" };
    }) as never,
  );
  assert.deepEqual(verdict, { ok: true });
  assert.equal(seen.length, 1);
  const protectionsFile = seen[0]!.args[seen[0]!.args.indexOf("--protections") + 1]!;
  assert.ok(protectionsFile.startsWith(seen[0]!.cwd), "the probe's list lives in the probe's own directory");
  const payload = JSON.parse(seen[0]!.input) as { tool_input: { command: string } };
  assert.match(payload.tool_input.command, /^git worktree remove ["']/u, "the probe path is shell-quoted");
  assert.throws(() => readManagedWorktreeGuardProtections(protectionsFile), /ENOENT/u, "the probe cleans up");
});

/* ---------------------------------------------------------------------------------------------
 * The guard's own state is provider-writable (same OS user), so every tool call that references
 * the runner's hook state directory is refused — reads included. Tamper-EVIDENT best effort of the
 * same strength class as the command-text worktree matcher; real enforcement belongs to #1302.
 * ------------------------------------------------------------------------------------------ */

test("every way of rewriting the guard's own state through Bash is refused", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const dir = f.dir;
  const settings = join(dir, "s1.settings.json");
  const commands = [
    `echo '{"version":1,"protections":[]}' > ${f.protectionsFile}`,
    `rm -f ${f.protectionsFile}`,
    `rm -rf ${dir}`,
    `printf '' >> ${f.protectionsFile}`,
    `cat ${f.protectionsFile}`,
    `mv ${f.protectionsFile} /tmp/stolen.json`,
    `cp /tmp/fake.json ${join(dir, "s1.protections.json")}`,
    `sed -i 's/x/y/' ${settings}`,
    `truncate -s 0 ${join(dir, "s1.template.json")}`,
    `chmod 000 ${join(dir, "s1.guard.json")}`,
    `ln -sf /dev/null ${f.protectionsFile}`,
    // inline value forms and quoting styles
    `claude --settings=${settings}`,
    `cat "${f.protectionsFile}"`,
    `cat '${f.protectionsFile}'`,
    // an ancestor sweep takes the directory with it
    `rm -rf ${dirname(dir)}`,
  ];
  for (const command of commands) {
    const outcome = runManagedWorktreeGuardDecision(hookInput({ tool_input: { command } }), f.protectionsFile);
    assert.equal(outcome.exitCode, 0, command);
    assert.ok(outcome.stdout.includes(GUARD_STATE_REFUSAL), `refused: ${command}`);
  }
});

test("a cwd-relative reference to the guard's state is resolved and refused", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const outcome = runManagedWorktreeGuardDecision(
    hookInput({ cwd: f.dir, tool_input: { command: "rm s1.protections.json" } }),
    f.protectionsFile,
  );
  assert.ok(outcome.stdout.includes(GUARD_STATE_REFUSAL));
});

test("a file tool writing into the guard's state directory is refused", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const [toolName, key] of [
    ["Edit", "file_path"], ["MultiEdit", "file_path"], ["Write", "file_path"],
    ["Read", "file_path"], ["NotebookEdit", "notebook_path"],
  ] as Array<[string, string]>) {
    const outcome = runManagedWorktreeGuardDecision(
      hookInput({ tool_name: toolName, tool_input: { [key]: f.protectionsFile } }),
      f.protectionsFile,
    );
    assert.ok(outcome.stdout.includes(GUARD_STATE_REFUSAL), `${toolName} into the guard state is refused`);
  }
});

test("a matched file tool with no usable path fails closed", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  blocks(
    runManagedWorktreeGuardDecision(hookInput({ tool_name: "Write", tool_input: {} }), f.protectionsFile),
    "a Write with no file_path",
  );
  blocks(
    runManagedWorktreeGuardDecision(
      hookInput({ tool_name: "NotebookEdit", tool_input: { notebook_path: 7 } }),
      f.protectionsFile,
    ),
    "a NotebookEdit with a non-string path",
  );
});

test("the guard-state veto runs before the worktree veto and does not disturb ordinary commands", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const command of ["git status", "ls -a", "pnpm -r typecheck", "echo hi > out.txt"]) {
    assert.deepEqual(
      runManagedWorktreeGuardDecision(hookInput({ tool_input: { command } }), f.protectionsFile),
      { stdout: "", stderr: "", exitCode: 0 },
      command,
    );
  }
});

test("the tamper tripwire notices any edit to the document the runner wrote", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const digest = writeManagedWorktreeGuardProtections(f.protectionsFile, [
    { worktreePath: WORKTREE, repoPath: REPO },
  ]);
  assert.equal(managedWorktreeGuardStateMatches(f.protectionsFile, digest), true);
  writeFileSync(f.protectionsFile, JSON.stringify({ version: 1, protections: [] }), "utf8");
  assert.equal(managedWorktreeGuardStateMatches(f.protectionsFile, digest), false);
  rmSync(f.protectionsFile, { force: true });
  assert.equal(managedWorktreeGuardStateMatches(f.protectionsFile, digest), false,
    "a removed file is a mismatch, never a pass");
});

test("the REAL sidecar refuses a protected path containing spaces and a quote", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The worktree must live OUTSIDE the guard's own state directory, as it always does in reality:
  // a path inside it would be refused by the guard-state veto instead, proving nothing here.
  const awkward = join(dir, "trees", "my work's trees", "issue 42");
  const protectionsFile = join(dir, "state", "s1.protections.json");
  writeManagedWorktreeGuardProtections(protectionsFile, [{ worktreePath: awkward, repoPath: REPO }]);
  const outcome = runManagedWorktreeGuardDecision(
    hookInput({ cwd: dir, tool_input: { command: `git worktree remove '${awkward.replaceAll("'", "'\\''")}'` } }),
    protectionsFile,
  );
  assert.match(outcome.stdout, /"permissionDecision":"deny"/u, "a quoted awkward path is still recognised");
});

test("the search tools respect the guard-state boundary: path, default cwd, and glob prefix", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const refused: Array<[string, Record<string, unknown>, string?]> = [
    ["Grep", { pattern: "token", path: f.dir }],
    ["Grep", { pattern: "token", path: dirname(f.dir) }],
    ["Grep", { pattern: "token" }, f.dir],
    ["Glob", { pattern: "*.json", path: f.dir }],
    ["Glob", { pattern: `${f.dir}/*.json` }],
    ["Glob", { pattern: "*" }, f.dir],
  ];
  for (const [toolName, toolInput, cwd] of refused) {
    const outcome = runManagedWorktreeGuardDecision(
      hookInput({ tool_name: toolName, tool_input: toolInput, ...(cwd ? { cwd } : {}) }),
      f.protectionsFile,
    );
    assert.ok(outcome.stdout.includes(GUARD_STATE_REFUSAL), `${toolName} ${JSON.stringify(toolInput)} is refused`);
  }
  for (const [toolName, toolInput] of [
    ["Grep", { pattern: "token" }],
    ["Grep", { pattern: "token", path: "src" }],
    ["Glob", { pattern: "**/*.ts" }],
  ] as Array<[string, Record<string, unknown>]>) {
    const outcome = runManagedWorktreeGuardDecision(
      hookInput({ tool_name: toolName, tool_input: toolInput }), f.protectionsFile,
    );
    assert.deepEqual(outcome, { stdout: "", stderr: "", exitCode: 0 }, `${toolName} in the workspace is untouched`);
  }
  const malformed = runManagedWorktreeGuardDecision(
    hookInput({ tool_name: "Grep", tool_input: { pattern: "x", path: 7 } }), f.protectionsFile,
  );
  assert.equal(malformed.exitCode, 2, "a path that is not a string fails closed");
});

test("home-directory spellings of the guard state are refused", () => {
  const directory = join(homedir(), ".wollipog-test-data", "hooks");
  assert.equal(pathTargetsGuardState("~/.wollipog-test-data/hooks/s1.protections.json", WORKTREE, directory), true);
  assert.equal(pathTargetsGuardState("~", WORKTREE, directory), true, "an ancestor is refused as before");
  assert.equal(pathTargetsGuardState("~/projects/readme.md", WORKTREE, directory), false);
  for (const command of [
    "ls ~/.wollipog-test-data/hooks",
    "cat $HOME/.wollipog-test-data/hooks/s1.protections.json",
    'cat "${HOME}/.wollipog-test-data/hooks/s1.settings.json"',
  ]) {
    assert.equal(commandTargetsGuardState(command, WORKTREE, directory), GUARD_STATE_REFUSAL, command);
  }
  assert.equal(commandTargetsGuardState("ls ~/projects", WORKTREE, directory), null);
});

test("a symlink into the guard state is refused for what it points at", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const workspace = mkdtempSync(join(tmpdir(), "wollipog-guard-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, "src"));
  symlinkSync(f.dir, join(workspace, "innocent"));
  assert.equal(pathTargetsGuardState("innocent/s1.protections.json", workspace, f.dir), true);
  assert.equal(pathTargetsGuardState("innocent/not-yet-created.json", workspace, f.dir), true,
    "the nearest existing ancestor is what gets resolved");
  assert.equal(pathTargetsGuardState("src/index.ts", workspace, f.dir), false);
  const outcome = runManagedWorktreeGuardDecision(
    hookInput({ cwd: workspace, tool_name: "Read", tool_input: { file_path: join(workspace, "innocent", "s1.protections.json") } }),
    f.protectionsFile,
  );
  assert.ok(outcome.stdout.includes(GUARD_STATE_REFUSAL));
  const viaShell = runManagedWorktreeGuardDecision(
    hookInput({ cwd: workspace, tool_input: { command: "cat innocent/s1.protections.json" } }),
    f.protectionsFile,
  );
  assert.ok(viaShell.stdout.includes(GUARD_STATE_REFUSAL));
});

test("named-user and working-directory tilde forms are expanded before the comparison", () => {
  const directory = join(homedir(), ".wollipog-test-data", "hooks");
  const me = userInfo().username;
  assert.equal(
    commandTargetsGuardState(`printf x > ~${me}/.wollipog-test-data/hooks/s1.protections.json`, WORKTREE, directory),
    GUARD_STATE_REFUSAL,
  );
  assert.equal(pathTargetsGuardState(`~${me}/.wollipog-test-data/hooks`, WORKTREE, directory), true);
  assert.equal(pathTargetsGuardState(`~${me}/projects/readme.md`, WORKTREE, directory), false);
  // Another user's home is a sibling of ours; it is not the guard state.
  assert.equal(pathTargetsGuardState("~someone-else/.wollipog-test-data/hooks", WORKTREE, directory), false);
  // `~+` is the working directory, not a literal path component beneath it.
  assert.equal(pathTargetsGuardState("~+/hooks/s1.protections.json", dirname(directory), directory), true);
  assert.equal(pathTargetsGuardState("~+/src/index.ts", WORKTREE, directory), false);
});

test("a tilde form that may be a literal directory is judged under both readings", (t) => {
  // The shell expands `~name` only for a user that exists; otherwise it is a path component, and
  // `..` from inside it walks back out of the working directory.
  const base = mkdtempSync(join(tmpdir(), "wollipog-guard-tilde-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const directory = join(base, ".wollipog", "hooks");
  mkdirSync(project);
  mkdirSync(directory, { recursive: true });
  assert.equal(
    commandTargetsGuardState("cat ~missing/../../.wollipog/hooks/s1.protections.json", project, directory),
    GUARD_STATE_REFUSAL,
  );
  assert.equal(pathTargetsGuardState("~missing/../../.wollipog/hooks", project, directory), true);
  assert.equal(pathTargetsGuardState("~missing/notes.md", project, directory), false);
});

test("a Glob base of ~+ is resolved against the event's working directory, not the runner's", (t) => {
  const base = mkdtempSync(join(tmpdir(), "wollipog-guard-glob-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, "project");
  mkdirSync(project);
  const directory = join(base, ".wollipog", "hooks");
  mkdirSync(directory, { recursive: true });
  const protectionsFile = join(directory, "s1.protections.json");
  writeManagedWorktreeGuardProtections(protectionsFile, [{ worktreePath: WORKTREE, repoPath: REPO }]);
  const refused = runManagedWorktreeGuardDecision(
    hookInput({ cwd: project, tool_name: "Glob", tool_input: { path: "~+", pattern: "../.wollipog/hooks/**" } }),
    protectionsFile,
  );
  assert.ok(refused.stdout.includes(GUARD_STATE_REFUSAL));
  const allowed = runManagedWorktreeGuardDecision(
    hookInput({ cwd: project, tool_name: "Glob", tool_input: { path: "~+", pattern: "src/**" } }),
    protectionsFile,
  );
  assert.deepEqual(allowed, { stdout: "", stderr: "", exitCode: 0 });
});

test("a directory that merely contains the guard state can be inspected without recursion", (t) => {
  // The layout the bug was reported against: the hook directory sits under a data directory, which
  // sits under a home directory. Listing either of those reads nothing the guard owns (#1334).
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "project");
  const data = join(home, ".wollipog-data");
  const directory = join(data, "hooks");
  mkdirSync(project);
  mkdirSync(directory, { recursive: true });
  for (const command of [
    `ls ${home}`,
    `ls -la ${home}`,
    `ls -- ${home}`,
    `ls --color=auto ${data}`,
    `ls /`,
    `stat ${data}`,
    // A list of inspections is still an inspection; a stray separator commands nothing.
    `ls ${home} && stat ${home}`,
    `ls ${home}; stat ${data}`,
    `ls ${home};`,
    // A redirection belongs to the command it follows; its target is judged as a location only,
    // and a LEADING IO number belongs to the redirection rather than to the command.
    `ls ${home} > ${join(project, "listing.txt")}`,
    `ls ${home} 2>/dev/null`,
    `2>/dev/null ls ${home}`,
    // `du` walks the ancestor and learns the hook directory's shape and size, but opens no file.
    `du -sh ${home}`,
    `du ${home}`,
    `du ${data}`,
    `du -sh ~`,
    `du -chx --total -- ${home}`,
    `du -h --max-depth=1 ${home}`,
    `du --summarize --human-readable --apparent-size --si ${home}`,
    `du -sh ${home} 2>/dev/null`,
    `ls ${home} && du -sh ${home}`,
    // A walk that stops at or above the hook directory may name it but never reads it.
    `find ${home} -maxdepth 1`,
    `find ${home} -maxdepth 2`,
    `find ${home} -maxdepth 0`,
    `find ${data} -maxdepth 1`,
    `find ${home} ${data} -maxdepth 1`,
    `find ${home} ${project} -maxdepth 2`,
    `find ${home} -maxdepth 2 > ${join(project, "listing.txt")}`,
    `find ~ -maxdepth 2`,
    `ls ${home}; find ${home} -maxdepth 1; du -s ${home}`,
  ]) {
    assert.equal(commandTargetsGuardState(command, project, directory), null, command);
  }
});

test("recursive or unclassifiable work on an ancestor of the guard state stays refused", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "project");
  const data = join(home, ".wollipog-data");
  const directory = join(data, "hooks");
  mkdirSync(project);
  mkdirSync(directory, { recursive: true });
  for (const command of [
    // Removal and recursive search sweep the hook directory up with everything else.
    `rm -rf ${home}`,
    `rm -r -- ${data}`,
    `grep -r token ${home}`,
    `tar -czf /tmp/all.tgz ${home}`,
    `chmod -R 000 ${home}`,
    // A recursive listing is a walk, however it is spelled.
    `ls -R ${home}`,
    `ls -laR ${home}`,
    `ls --recursive ${home}`,
    // `find` is admitted only as `find START... -maxdepth N` with the bound stopping at or above the
    // hook directory, which sits two levels below the home directory and one below the data one.
    `find ${home}`,
    `find ${home} -maxdepth 3`,
    `find ${data} -maxdepth 2`,
    `find ${home} ${data} -maxdepth 2`,
    `find ${home} -name '*.json'`,
    `find ${home} -maxdepth 1 -delete`,
    `find ${home} -maxdepth 1 -print`,
    `find ${home} -type d -maxdepth 1`,
    `find ${home} -maxdepth 1 -maxdepth 9`,
    `find ${home} -maxdepth`,
    `find ${home} -maxdepth -1`,
    `find ${home} -maxdepth +1`,
    `find -L ${home} -maxdepth 1`,
    `find -H ${home} -maxdepth 1`,
    `find -maxdepth 1 ${home}`,
    `find ! ${home} -maxdepth 1`,
    // `du` is admitted only with value-free options spelled in full.
    `du --exclude=x ${home}`,
    `du -B1 ${home}`,
    `du -d 1 ${home}`,
    `du -L ${home}`,
    `du --summ ${home}`,
    `du --max-depth ${home}`,
    `du --time ${home}`,
    `du - ${home}`,
    // `-a` prints every file, which would enumerate the hook directory's protections files.
    `du -a ${home}`,
    `du -sah ${home}`,
    `du --all ${home}`,
    // An unexpanded variable could be a recursion flag or another operand.
    `ls $FLAGS ${home}`,
    // A wrapper is not the command it wraps, and is not classifiable here.
    `sudo ls ${home}`,
    `xargs ls ${home}`,
    // A destructive segment is refused even when a harmless one precedes it.
    `ls ${home} && rm -rf ${home}`,
    `ls ${home} | xargs rm -rf ${data}`,
  ]) {
    assert.equal(commandTargetsGuardState(command, project, directory), GUARD_STATE_REFUSAL, command);
  }
  // The directory itself and everything in it stay refused for every command, inspection included.
  for (const command of [`ls ${directory}`, `du -sh ${directory}`, `stat ${directory}`,
    `find ${directory} -maxdepth 0`, `cat ${join(directory, "s1.protections.json")}`]) {
    assert.equal(commandTargetsGuardState(command, project, directory), GUARD_STATE_REFUSAL, command);
  }
});

test("a command cannot launder itself into the ancestor carve-out", (t) => {
  // Every form here reaches the hook directory while containing something that looks like a
  // bounded inspection. Each was allowed by the first cut of the #1334 carve-out.
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "project");
  const data = join(home, ".wollipog-data");
  const directory = join(data, "hooks");
  mkdirSync(project);
  mkdirSync(directory, { recursive: true });
  for (const command of [
    // A leading redirection does not start a new command: the shell runs `rm`, not `ls`.
    `>ls rm -rf ${home}`,
    // GNU getopt_long takes any unambiguous abbreviation, so these all recurse.
    `ls --recurs ${home}`,
    `ls --recursi ${home}`,
    `ls --r ${home}`,
    // Brace expansion produces `--recursive` before the command ever runs.
    `ls --recurs{ive,} ${home}`,
    // An assignment prefix decides what the name resolves to.
    `PATH=${project} ls ${home}`,
    `LC_ALL=C ls ${home}`,
    // Only a bare name is the program it looks like.
    `${join(project, "ls")} ${home}`,
    `./ls ${home}`,
    // A pipe hands the listing to a command the classifier never vouched for.
    `ls ${home} | xargs rm -rf`,
    `find ${home} -maxdepth 1 | xargs rm -rf`,
    `du -sh ${home} | sh`,
    // A command substitution nests the inspection inside a removal.
    `rm -rf $(ls ${home})`,
    // A subshell and a process substitution are not modelled, so nothing in them is inspectable.
    `(rm -rf ${home})`,
    `cat <(rm -rf ${home})`,
    // An unescaped newline is whitespace to the tokenizer, so the second command would otherwise
    // join the first one's words; a backslash-newline would split `-R` into `-` and `R`.
    `ls ${home}\nrm -rf ${home}`,
    `ls -\\\nR ${home}`,
    // The shell carries state across a list: an earlier command decides what a later name runs.
    `hash -p /bin/rm ls; ls -rf ${home}`,
    `PATH=${project}; ls ${home}`,
    `ls ${home} && echo done`,
    `cd ${project} && ls ${home}`,
    // A file-valued option OPENS that file without ever naming it as an operand.
    `du --exclude-from=../.wollipog-data/hooks/s1.protections.json ${home}`,
    `du -X../.wollipog-data/hooks/s1.protections.json ${home}`,
    `ls ${home}; du --files0-from=../.wollipog-data/hooks/s1.protections.json`,
    // Accepted over-refusal: an option word carrying a path separator disqualifies the command,
    // although neither `ls` nor `stat` has an option that opens a file.
    `ls -l --time-style=+%Y/%m/%d ${home}`,
    `stat --format=%n/%s ${home}`,
    // Accepted over-refusal: a short-option cluster is scanned for `R` without modelling which
    // options take an attached value, so GNU's `ls -IREADME` reads as recursive. The alternative,
    // a hard-coded list of value-taking options, fails OPEN the day that list is wrong.
    `ls -IREADME ${home}`,
    // Accepted over-refusal: the tokenizer drops the adjacency that makes `2>` a redirection, so a
    // trailing IO number reads as a word after the bound and breaks the one admitted `find` shape.
    `find ${home} -maxdepth 1 2>/dev/null`,
  ]) {
    assert.equal(commandTargetsGuardState(command, project, directory), GUARD_STATE_REFUSAL, command);
  }
});

test("every bypass found while reviewing #1371 stays refused with du and find in the carve-out", (t) => {
  // The fourteen bypasses #1390 lists, in a session whose hook directory is
  // `<ancestor>/.wollipog-data/hooks`. Each one reaches the hook directory while looking like an
  // inspection; re-admitting `du` and a bounded `find` must not reopen any of them.
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "project");
  const data = join(home, ".wollipog-data");
  const directory = join(data, "hooks");
  mkdirSync(project);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "s1.protections.json"), "{}", "utf8");
  symlinkSync(join(directory, "s1.protections.json"), join(home, "state-link"));
  const intoHooks = "../.wollipog-data/hooks/s1.protections.json";
  const refusedFrom = (cwd: string, commands: readonly string[]): void => {
    for (const command of commands) {
      assert.equal(commandTargetsGuardState(command, cwd, directory), GUARD_STATE_REFUSAL, command);
    }
  };
  refusedFrom(project, [
    // A leading redirection whose target reads like an allowed command name.
    `>ls rm -rf ${home}`,
    `>du rm -rf ${home}`,
    `>find rm -rf ${home}`,
    // An abbreviated recursive option.
    `ls --recurs ${home}`,
    `ls --recursi ${home}`,
    `ls --r ${home}`,
    // A pipe into another command.
    `ls ${home} | xargs rm -rf`,
    `find ${home} -maxdepth 1 | xargs rm -rf`,
    `du -sh ${home} | sh`,
    // A command substitution, a subshell, or a process substitution.
    `rm -rf $(ls ${home})`,
    `rm -rf $(find ${home} -maxdepth 1)`,
    `(rm -rf ${home})`,
    `(du -sh ${home})`,
    `cat <(rm -rf ${home})`,
    // An assignment prefix, standalone or leading.
    `PATH=${project} ls ${home}`,
    `LC_ALL=C ls ${home}`,
    `PATH=${project}; ls ${home}`,
    `PATH=${project} du -sh ${home}`,
    `PATH=${project}; find ${home} -maxdepth 1`,
    // A command word that is not a bare name.
    `./ls ${home}`,
    `${join(project, "ls")} ${home}`,
    `./du -sh ${home}`,
    `${join(project, "find")} ${home} -maxdepth 1`,
    // Brace expansion producing a recursive option.
    `ls --recurs{ive,} ${home}`,
    `find ${home} -maxdepth {1,5}`,
    // A newline or carriage return joining two commands; a backslash-newline splitting an option.
    `ls ${home}\nrm -rf ${home}`,
    `ls ${home}\rrm -rf ${home}`,
    `du -sh ${home}\nrm -rf ${home}`,
    `ls -\\\nR ${home}`,
    `find ${home} -maxdepth 1 -\\\nempty`,
    // An earlier command rebinding a later name.
    `hash -p /bin/rm ls; ls -rf ${home}`,
    `alias ls=rm; ls -rf ${home}`,
    `hash -p /bin/rm du; du -rf ${home}`,
    `alias find=rm; find ${home} -maxdepth 1`,
    // `find -empty` at the depth bound opens the directory it names there.
    `find ${home} -maxdepth 1 -empty`,
    `find ${home} -maxdepth 2 -empty`,
    `find ${data} -maxdepth 1 -empty`,
    // A `du` option whose value names a file, with or without a path separator.
    `du --exclude-from=${intoHooks} ${home}`,
    `du -X${intoHooks} ${home}`,
    `ls ${home}; du --files0-from=${intoHooks}`,
  ]);
  // The same three with a bare value naming a symlink to the protections file, from its directory.
  refusedFrom(home, [
    `du --files0-from=state-link ${home}`,
    `ls ${home}; du --files0-from=state-link`,
    `du -Xstate-link ${home}`,
    `du --exclude-from=state-link ${home}`,
  ]);
  // An operand-less walk beside an ancestor-naming command, judged from the working directory: the
  // home directory is two components above the hook directory, so neither bound stops above it.
  refusedFrom(home, [
    `ls /; find -maxdepth 3`,
    `ls ${home}; find -maxdepth 999`,
  ]);
  // A spaced numeric argument is not an IO number: this walk is judged on its bound of three.
  refusedFrom(project, [`find ${home} -maxdepth 3 > ${join(project, "listing.txt")}`]);
  // Over-refusals the review found, which must stay fixed: a leading IO number belongs to its
  // redirection.
  assert.equal(commandTargetsGuardState(`2>/dev/null ls ${home}`, project, directory), null);
});

test("a file-valued option cannot reach the guard state through a symlink it names", (t) => {
  // Review round 6: a separator-free option value is a bare name, so no path check on the option's
  // spelling can see that it is a symlink to the protections file. `du` opens it, and echoes its
  // contents back in an error. The fix is not a better spelling check: no file-valued `du` option is
  // admitted at all, so the value is never judged.
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".wollipog-data", "hooks");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "s1.protections.json"), "{}", "utf8");
  symlinkSync(join(directory, "s1.protections.json"), join(home, "state-link"));
  for (const command of [
    `ls ${home}; du --files0-from=state-link`,
    `du --exclude-from=state-link ${home}`,
    `du -Xstate-link ${home}`,
  ]) {
    assert.equal(commandTargetsGuardState(command, home, directory), GUARD_STATE_REFUSAL, command);
  }
  // `ls`, `stat`, and a plain `du` of the same ancestor from the same place remain allowed.
  assert.equal(commandTargetsGuardState(`ls ${home}; stat ${home}; du -s ${home}`, home, directory), null);
});

test("a bounded find is measured from the directory it actually starts in", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, ".wollipog-data");
  const directory = join(data, "hooks");
  mkdirSync(join(directory, "sub"), { recursive: true });
  mkdirSync(join(home, "project"));
  // A start that is a symlink to the data directory walks from the data directory: the hook
  // directory is one level below it, not the two its spelling beside the home directory suggests.
  symlinkSync(data, join(home, "data-link"));
  assert.equal(commandTargetsGuardState(`find ${join(home, "data-link")}/ -maxdepth 1`, home, directory), null);
  assert.equal(commandTargetsGuardState(`find ${join(home, "data-link")}/ -maxdepth 2`, home, directory),
    GUARD_STATE_REFUSAL);
  // A relative start resolves against the working directory.
  assert.equal(commandTargetsGuardState("find . -maxdepth 2", home, directory), null);
  assert.equal(commandTargetsGuardState("find . -maxdepth 3", home, directory), GUARD_STATE_REFUSAL);
  assert.equal(commandTargetsGuardState("find . -maxdepth 1", data, directory), null);
  assert.equal(commandTargetsGuardState("find . -maxdepth 2", data, directory), GUARD_STATE_REFUSAL);
  assert.equal(commandTargetsGuardState(`find .. -maxdepth 2`, join(home, "project"), directory), null);
  assert.equal(commandTargetsGuardState(`find .. -maxdepth 3`, join(home, "project"), directory),
    GUARD_STATE_REFUSAL);
});

test("a backslash in a POSIX name is not a separator when measuring a walk", { skip: process.platform === "win32" }, (t) => {
  // Review of #1390: counting `\` as a separator put a hook directory under `foo\bar` one level
  // deeper than it is, so a walk one level too deep was allowed and listed the hook directory.
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, "foo\\bar", "hooks");
  mkdirSync(directory, { recursive: true });
  assert.deepEqual(guardStateRelation(home, home, directory), { kind: "ancestor", depth: 2 });
  assert.equal(commandTargetsGuardState(`find ${home} -maxdepth 2`, home, directory), null);
  assert.equal(commandTargetsGuardState(`find ${home} -maxdepth 3`, home, directory), GUARD_STATE_REFUSAL);
});

test("a spelling that climbs out of a symlink is judged by where the kernel lands", (t) => {
  // `resolve` folds `link/..` away before the symlink is ever seen, but the kernel follows the link
  // first and climbs out of its TARGET. Here that target is a subdirectory of the hook directory, so
  // the spelling reads as the data directory while every command on it acts on the hook directory.
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, ".wollipog-data");
  const directory = join(data, "hooks");
  mkdirSync(join(directory, "sub"), { recursive: true });
  symlinkSync(join(directory, "sub"), join(data, "link"));
  const climbing = `${join(data, "link")}/..`;
  assert.deepEqual(guardStateRelation(climbing, home, directory), { kind: "inside" });
  mkdirSync(join(home, "project"));
  assert.deepEqual(guardStateRelation("../.wollipog-data/link/..", join(home, "project"), directory),
    { kind: "inside" });
  for (const command of [`ls ${climbing}`, `stat ${climbing}`, `du ${climbing}`,
    `find ${climbing} -maxdepth 0`, `cat ${climbing}/s1.protections.json`]) {
    assert.equal(commandTargetsGuardState(command, home, directory), GUARD_STATE_REFUSAL, command);
  }
  // An ordinary `..` still reads as the ancestor it names, and past a missing component it resolves
  // nowhere, so the lexical reading stands alone.
  assert.deepEqual(guardStateRelation(`${join(home, "missing")}/..`, home, directory), { kind: "ancestor", depth: 2 });
  assert.equal(commandTargetsGuardState(`ls ${data}/../`, home, directory), null);
});

test("a command with no operand is judged against the directory it would run in", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-guard-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".wollipog-data", "hooks");
  mkdirSync(directory, { recursive: true });
  const elsewhere = mkdtempSync(join(tmpdir(), "wollipog-guard-away-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  // From INSIDE the guard state there is no inspection-only form of an operand-less command: the
  // bare `ls` lists the hook directory, and the bare `stat` reads its metadata.
  assert.equal(commandTargetsGuardState(`ls ${home}; ls`, directory, directory), GUARD_STATE_REFUSAL);
  assert.equal(commandTargetsGuardState(`ls ${home}; stat .`, directory, directory), GUARD_STATE_REFUSAL);
  // From anywhere else the same list is an inspection of an ancestor and nothing more.
  assert.equal(commandTargetsGuardState(`ls ${home}; ls`, elsewhere, directory), null);
  assert.equal(commandTargetsGuardState(`ls ${home}; ls`, home, directory), null);
});

test("the reported home-directory listings are allowed while the file tools stay closed", () => {
  const directory = join(homedir(), ".wollipog-test-data", "hooks");
  for (const command of ["ls ~", "ls -la ~/", "ls /", "stat ~", "du -sh ~", "find ~ -maxdepth 1"]) {
    assert.equal(commandTargetsGuardState(command, WORKTREE, directory), null, command);
  }
  for (const command of ["rm -rf ~", "grep -r secret ~", "find ~ -maxdepth 3", "find ~", "ls -R ~"]) {
    assert.equal(commandTargetsGuardState(command, WORKTREE, directory), GUARD_STATE_REFUSAL, command);
  }
  // The path-level predicate is unchanged: an ancestor is still "related", and the file tools,
  // which have no notion of a bounded walk, keep failing closed on it.
  assert.equal(pathTargetsGuardState("~", WORKTREE, directory), true);
  assert.deepEqual(guardStateRelation("~", WORKTREE, directory), { kind: "ancestor", depth: 2 });
  assert.deepEqual(guardStateRelation(join(directory, "s1.protections.json"), WORKTREE, directory),
    { kind: "inside" });
  assert.equal(guardStateRelation("~/projects/readme.md", WORKTREE, directory), null);
});

test("the guard hook allows an ancestor listing and still refuses an ancestor sweep", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const above = dirname(f.dir);
  for (const command of [`ls ${above}`, `stat ${above}`, `du -sh ${above}`, `find ${above} -maxdepth 1`]) {
    assert.deepEqual(
      runManagedWorktreeGuardDecision(hookInput({ tool_input: { command } }), f.protectionsFile),
      { stdout: "", stderr: "", exitCode: 0 },
      command,
    );
  }
  for (const command of [`rm -rf ${above}`, `ls -R ${above}`, `grep -r x ${above}`,
    `find ${above} -maxdepth 2`, `du -X${join(f.dir, "s1.protections.json")} ${above}`]) {
    const outcome = runManagedWorktreeGuardDecision(hookInput({ tool_input: { command } }), f.protectionsFile);
    assert.ok(outcome.stdout.includes(GUARD_STATE_REFUSAL), `refused: ${command}`);
  }
});

test("a long list of inspections is classified in linear time", () => {
  // The first cut of the all-segments rule re-scanned every segment for every ancestor operand,
  // which made a command list quadratic: 30,000 characters of `ls /;` took over three seconds
  // inside a hook that runs synchronously before every Bash call. The classifier's own work is
  // counted rather than timed, so machine load cannot move the result (#1428).
  const measure = (repetitions: number): { relations: number; segments: number } => {
    guardStateClassifierWork.relations = 0;
    guardStateClassifierWork.segments = 0;
    assert.equal(commandTargetsGuardState("ls /;".repeat(repetitions), WORKTREE, "/a/b"), null);
    return { ...guardStateClassifierWork };
  };
  const small = measure(500);
  const large = measure(6_000);
  // Every segment is judged and the ancestor resolved, so no count passes by skipping its work.
  assert.ok(small.segments >= 500, `500 inspections judged ${small.segments} segments`);
  assert.ok(small.relations >= 1, "the ancestor operand was never resolved");
  // Twelve times the input. Linear work is at most 12x; re-judging the list per segment is 144x.
  for (const count of ["segments", "relations"] as const) {
    assert.ok(large[count] <= 12 * small[count],
      `12x the input took ${(large[count] / small[count]).toFixed(1)}x the ${count}`);
  }
});

test("every strict ancestor is an ancestor, and every descendant is inside", () => {
  const segment = fc.constantFrom("a", "b", "state", "data", "hooks");
  const trunk = fc.array(segment, { minLength: 1, maxLength: 5 });
  const cwd = "/wollipog-fc-cwd";
  fc.assert(fc.property(trunk, fc.nat({ max: 5 }), fc.nat({ max: 5 }), (tail, cut, extra) => {
    const root = ["/wollipog-fc-root", ...tail].join("/");
    const depth = 1 + (cut % tail.length);
    const ancestor = ["/wollipog-fc-root", ...tail.slice(0, tail.length - depth)].join("/") || "/";
    assert.deepEqual(guardStateRelation(ancestor, cwd, root), { kind: "ancestor", depth },
      `${ancestor} contains ${root}`);
    assert.deepEqual(guardStateRelation(root, cwd, root), { kind: "inside" });
    const descendant = [root, ...Array.from({ length: extra }, (_, index) => `deep${index}`)].join("/");
    assert.deepEqual(guardStateRelation(descendant, cwd, root), { kind: "inside" }, descendant);
    // An unrelated sibling of the ancestor is neither.
    assert.equal(guardStateRelation(`${ancestor === "/" ? "" : ancestor}/unrelated-sibling`, cwd, root),
      null);
  }));
});

test("an inspection never reaches into the guard state, whatever the command", () => {
  const root = "/wollipog-fc-root/data/hooks";
  const cwd = "/wollipog-fc-cwd";
  // Each ancestor with the number of levels the hook directory sits below it.
  const ancestors = fc.constantFrom(["/wollipog-fc-root", 2], ["/wollipog-fc-root/data", 1], ["/", 3]) as
    fc.Arbitrary<[string, number]>;
  const inspection = fc.constantFrom("ls", "ls -la", "stat", "du", "du -sh", "du -bc --");
  const reaching = fc.constantFrom("rm -rf", "rm -r", "grep -r pattern", "ls -R", "cp -r", "mv",
    "find", "find -maxdepth 1", "find -L", "du -X state", "du --files0-from=state", "du --exclude-from state");
  fc.assert(fc.property(inspection, ancestors, (prefix, [target]) => {
    assert.equal(commandTargetsGuardState(`${prefix} ${target}`, cwd, root), null);
  }));
  fc.assert(fc.property(reaching, ancestors, (prefix, [target]) => {
    assert.equal(commandTargetsGuardState(`${prefix} ${target}`, cwd, root), GUARD_STATE_REFUSAL);
  }));
  // A bounded walk is allowed exactly when it stops at or above the hook directory.
  fc.assert(fc.property(ancestors, fc.nat({ max: 6 }), ([target, depth], bound) => {
    assert.equal(commandTargetsGuardState(`find ${target} -maxdepth ${bound}`, cwd, root),
      bound <= depth ? null : GUARD_STATE_REFUSAL);
  }));
  // A second command in the list is held to the same standard as the first, whichever order.
  fc.assert(fc.property(inspection, reaching, ancestors, (good, bad, [target]) => {
    assert.equal(commandTargetsGuardState(`${good} ${target}; ${bad} ${target}`, cwd, root),
      GUARD_STATE_REFUSAL);
    assert.equal(commandTargetsGuardState(`${bad} ${target}; ${good} ${target}`, cwd, root),
      GUARD_STATE_REFUSAL);
  }));
});
