import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  GUARD_STATE_REFUSAL,
  MANAGED_WORKTREE_REFUSAL,
  commandTargetsGuardState,
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

test("an empty protection list fails closed, and the runner refuses to write one", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.throws(() => writeManagedWorktreeGuardProtections(f.protectionsFile, []), /empty/u);
  // Only tampering or a half-finished retirement can produce one, and neither may be trusted.
  writeFileSync(f.protectionsFile, JSON.stringify({ version: 1, protections: [] }), "utf8");
  blocks(
    runManagedWorktreeGuardDecision(hookInput({ tool_input: { command: "ls" } }), f.protectionsFile),
    "an empty protection list",
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

test("the hook matcher covers Bash and every path-bearing file tool", () => {
  assert.deepEqual(MANAGED_WORKTREE_GUARD_MATCHER.split("|").sort(),
    ["Bash", "Edit", "Glob", "Grep", "MultiEdit", "NotebookEdit", "Read", "Write"]);
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

test("the launch self-test quotes a protected path containing spaces and a quote", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The worktree must live OUTSIDE the guard's own state directory, as it always does in reality:
  // a path inside it would be refused by the guard-state veto instead, proving nothing here.
  const awkward = join(dir, "trees", "my work's trees", "issue 42");
  const protectionsFile = join(dir, "state", "s1.protections.json");
  writeManagedWorktreeGuardProtections(protectionsFile, [{ worktreePath: awkward, repoPath: REPO }]);
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
    verifyManagedWorktreeGuardLaunch(launch, protectionsFile, [{ worktreePath: awkward, repoPath: REPO }]),
    { ok: true },
    "an unquoted path would split into several operands and the probe would see no refusal",
  );
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
