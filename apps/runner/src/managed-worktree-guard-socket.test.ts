import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { quote } from "shell-quote";
import { claudeHookSessionProtectionsPath } from "./hook-settings.js";
import {
  MAX_GUARD_SOCKET_PATH_BYTES,
  ManagedWorktreeGuardSockets,
  managedWorktreeGuardSocketDirectory,
  managedWorktreeGuardSocketPath,
  verifyManagedWorktreeGuardInSandbox,
} from "./managed-worktree-guard-socket.js";
import {
  parseManagedWorktreeGuardVerdict,
  requestManagedWorktreeGuardVerdict,
  runManagedWorktreeGuardCli,
  writeManagedWorktreeGuardProtections,
} from "./managed-worktree-guard.js";
import { GUARD_STATE_REFUSAL, MANAGED_WORKTREE_REFUSAL } from "./managed-worktree-protection.js";

const POSIX = process.platform !== "win32";
const roots: string[] = [];
const hosts: ManagedWorktreeGuardSockets[] = [];
after(async () => {
  for (const host of hosts) await host.closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  // Short on purpose: a Unix socket path has to fit in `sun_path`.
  const root = mkdtempSync(join(tmpdir(), "wgs-"));
  roots.push(root);
  const configDir = join(root, "hooks");
  const host = new ManagedWorktreeGuardSockets(configDir);
  hosts.push(host);
  return { root, configDir, host };
}

function payload(command: string, cwd = "/work") {
  return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });
}

async function runCli(argv: string[], input: string) {
  let stdout = "";
  let stderr = "";
  let code = -1;
  const { Readable } = await import("node:stream");
  await runManagedWorktreeGuardCli(["node", "cli", "--managed-worktree-guard", ...argv], {
    stdin: Readable.from([input]),
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    exit: (value) => { code = value; },
  });
  return { stdout, stderr, code };
}

test("the socket judges against the list of the session that owns it", { skip: !POSIX }, async () => {
  const { configDir, host } = fixture();
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_one"), [
    { worktreePath: "/trees/one", repoPath: "/repo" },
  ]);
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_two"), [
    { worktreePath: "/trees/two", repoPath: "/repo" },
  ]);
  const one = await host.ensure("s_one");
  const two = await host.ensure("s_two");
  assert.notEqual(one, two);

  const removeOne = await requestManagedWorktreeGuardVerdict(one, payload(quote(["git", "worktree", "remove", "/trees/one"])));
  assert.equal(removeOne.exitCode, 0);
  assert.ok(removeOne.stdout.includes(MANAGED_WORKTREE_REFUSAL));
  // The same question on the other session's socket is judged against THAT session's list.
  const removeOneOnTwo = await requestManagedWorktreeGuardVerdict(two, payload(quote(["git", "worktree", "remove", "/trees/one"])));
  assert.deepEqual(removeOneOnTwo, { stdout: "", stderr: "", exitCode: 0 });
  // The guard-state veto runs there too, against this runner's hook state directory.
  const stateRead = await requestManagedWorktreeGuardVerdict(one, payload(quote(["cat", join(configDir, "x")])));
  assert.ok(stateRead.stdout.includes(GUARD_STATE_REFUSAL));
  assert.deepEqual(await requestManagedWorktreeGuardVerdict(one, payload("git status")), { stdout: "", stderr: "", exitCode: 0 });
});

test("an invalidated guard (its list removed) is a refusal over the socket too", { skip: !POSIX }, async () => {
  const { configDir, host } = fixture();
  const socket = await host.ensure("s_gone");
  const verdict = await requestManagedWorktreeGuardVerdict(socket, payload("git status"));
  assert.equal(verdict.exitCode, 2);
  assert.match(verdict.stderr, /could not load this session's protected worktrees/u);
  assert.equal(statSync(claudeHookSessionProtectionsPath(configDir, "s_gone"), { throwIfNoEntry: false }), undefined);
});

test("the sidecar refuses whenever it cannot get a verdict, and never reads the file in socket mode", { skip: !POSIX }, async () => {
  const { root, configDir } = fixture();
  const protectionsFile = claudeHookSessionProtectionsPath(configDir, "s_file");
  // A readable list that WOULD allow the call: the sidecar must not fall back to it.
  writeManagedWorktreeGuardProtections(protectionsFile, []);
  const missing = await runCli(["--protections", protectionsFile, "--guard-socket", join(root, "no-such.sock")], payload("git status"));
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /could not get a verdict from the runner/u);

  const empty = await runCli(["--protections", protectionsFile, "--guard-socket"], payload("git status"));
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /empty verdict socket/u);

  // Something answering on the socket that is not the runner's verdict is not a verdict.
  const liar = join(root, "liar.sock");
  const server = createServer((socket) => socket.on("data", () => socket.end("{\"exitCode\":0}")));
  await new Promise<void>((resolvePromise) => server.listen(liar, resolvePromise));
  try {
    const lied = await runCli(["--protections", protectionsFile, "--guard-socket", liar], payload("git status"));
    assert.equal(lied.code, 2);
    assert.match(lied.stderr, /not a verdict/u);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }

  // File mode is unchanged: no socket argument, the list decides.
  const fileMode = await runCli(["--protections", protectionsFile], payload("git status"));
  assert.equal(fileMode.code, 0);
});

test("a silent runner times out into a refusal", { skip: !POSIX }, async () => {
  const { root } = fixture();
  const silent = join(root, "silent.sock");
  const server = createServer(() => { /* never answers */ });
  await new Promise<void>((resolvePromise) => server.listen(silent, resolvePromise));
  try {
    await assert.rejects(requestManagedWorktreeGuardVerdict(silent, payload("git status"), 200), /did not answer in time/u);
  } finally {
    server.close();
  }
});

test("only a verdict-shaped answer with a meaningful exit code is a verdict", () => {
  assert.deepEqual(parseManagedWorktreeGuardVerdict('{"stdout":"","stderr":"","exitCode":0}'), { stdout: "", stderr: "", exitCode: 0 });
  for (const text of ['{"stdout":"","stderr":"","exitCode":1}', '{"stdout":1,"stderr":"","exitCode":0}', "[]", "nope"]) {
    assert.throws(() => parseManagedWorktreeGuardVerdict(text), undefined, text);
  }
});

test("the socket lives in an owner-only directory that replaces anything planted there", { skip: !POSIX }, async () => {
  const { root, configDir, host } = fixture();
  const directory = managedWorktreeGuardSocketDirectory(configDir, "s_planted");
  mkdirSync(configDir, { recursive: true });
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, directory);
  const socket = await host.ensure("s_planted");
  assert.equal(socket, managedWorktreeGuardSocketPath(configDir, "s_planted"));
  const entry = lstatSync(directory);
  assert.equal(entry.isSymbolicLink(), false);
  assert.equal(entry.mode & 0o777, 0o700);
  assert.equal(lstatSync(socket).mode & 0o777, 0o600);
  // Idempotent while it is still listening, and gone once closed.
  assert.equal(await host.ensure("s_planted"), socket);
  await host.close("s_planted");
  assert.equal(statSync(directory, { throwIfNoEntry: false }), undefined);
});

test("a socket replaced at the same path is not reused as the runner's", { skip: !POSIX }, async () => {
  const { configDir, host } = fixture();
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_swap"), [
    { worktreePath: "/trees/swap", repoPath: "/repo" },
  ]);
  const path = await host.ensure("s_swap");
  // Something else unlinks the runner's socket and binds its own at the same path, answering
  // "allow" to everything.
  rmSync(path);
  const impostor = createServer((socket) => socket.on("end", () => socket.end('{"stdout":"","stderr":"","exitCode":0}')));
  await new Promise<void>((resolvePromise) => impostor.listen(path, resolvePromise));
  try {
    assert.equal(await host.ensure("s_swap"), path);
    const verdict = await requestManagedWorktreeGuardVerdict(path, payload(quote(["git", "worktree", "remove", "/trees/swap"])));
    assert.ok(verdict.stdout.includes(MANAGED_WORKTREE_REFUSAL), "the runner listens afresh and judges the call itself");
  } finally {
    impostor.close();
  }
});

test("a socket path that cannot be bound is refused before anything is created", async () => {
  const host = new ManagedWorktreeGuardSockets(join(tmpdir(), "x".repeat(MAX_GUARD_SOCKET_PATH_BYTES)));
  await assert.rejects(host.ensure("s_long"), /longer than/u);
});

test("the in-sandbox probe has nothing to prove without a runner-owned sandbox, and says so", async () => {
  const verdict = await verifyManagedWorktreeGuardInSandbox(
    { launch: { command: process.execPath, args: [] }, protectionsFile: "/p", socketPath: "/s" },
    undefined,
    tmpdir(),
  );
  assert.equal(verdict.ok, false);
});
