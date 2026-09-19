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
  MAX_FORWARDED_ENVIRONMENT_BYTES,
  MAX_FORWARDED_ENVIRONMENT_VALUE_BYTES,
  managedWorktreeGuardSocketAddress,
  managedWorktreeGuardVerdictRequest,
  parseManagedWorktreeGuardVerdict,
  requestManagedWorktreeGuardVerdict,
  runManagedWorktreeGuardCli,
  writeManagedWorktreeGuardProtections,
} from "./managed-worktree-guard.js";
import {
  GUARD_STATE_REFUSAL,
  MANAGED_WORKTREE_REFUSAL,
  type ManagedWorktreeProtection,
} from "./managed-worktree-protection.js";

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

/** Codex's edit payload: the patch document under the same `command` key a shell call uses. */
function patchPayload(lines: readonly string[], cwd = "/trees/one") {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    cwd,
    tool_input: { command: lines.join("\n") },
  });
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

test("the socket judges a Codex apply_patch exactly as the file transport does", { skip: !POSIX }, async () => {
  // #1437 put the patch-header judgment in the shared decision, so both transports #1447 left in
  // place carry it. A sandboxed Codex launch reaches the guard only through this socket.
  const { configDir, host } = fixture();
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_one"), [
    { worktreePath: "/trees/one", repoPath: "/repo" },
  ]);
  const socket = await host.ensure("s_one");
  const intoGuardState = await requestManagedWorktreeGuardVerdict(
    socket,
    patchPayload(["*** Begin Patch", `*** Add File: ${join(configDir, "planted.json")}`, "+{}", "*** End Patch"]),
  );
  assert.equal(intoGuardState.exitCode, 0);
  assert.ok(intoGuardState.stdout.includes(GUARD_STATE_REFUSAL));
  const intoWorktreeGit = await requestManagedWorktreeGuardVerdict(
    socket,
    patchPayload(["*** Begin Patch", "*** Delete File: /trees/one/.git", "*** End Patch"]),
  );
  assert.ok(intoWorktreeGit.stdout.includes(MANAGED_WORKTREE_REFUSAL));
  assert.deepEqual(
    await requestManagedWorktreeGuardVerdict(
      socket,
      patchPayload(["*** Begin Patch", "*** Add File: src/app.ts", "+x", "*** End Patch"]),
    ),
    { stdout: "", stderr: "", exitCode: 0 },
    "an ordinary project file is the session's own workspace",
  );
  const unparseable = await requestManagedWorktreeGuardVerdict(socket, patchPayload(["just write it for me"]));
  assert.equal(unparseable.exitCode, 2);
  assert.ok(unparseable.stderr.includes(MANAGED_WORKTREE_REFUSAL));
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

test("overlapping ensure and close for one session settle in order, leaving one listener or none", { skip: !POSIX }, async () => {
  const { configDir, host } = fixture();
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_race"), []);
  // An untracked listener is the failure this guards against, and the map cannot see one, so count
  // the process's live pipe handles instead.
  const pipes = () => process.getActiveResourcesInfo().filter((name) => name === "PipeWrap").length;
  const before = pipes();
  // Two launch preparations at once: both get the same, working socket, backed by one server.
  const [first, second] = await Promise.all([host.ensure("s_race"), host.ensure("s_race")]);
  assert.equal(first, second);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((host as any).servers.size, 1);
  assert.equal((await requestManagedWorktreeGuardVerdict(first, payload("git status"))).exitCode, 0);
  // A deletion racing a launch preparation: whichever was asked last wins, and nothing is left
  // listening behind a close that was asked for after the ensure.
  await Promise.all([host.ensure("s_race"), host.close("s_race")]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((host as any).servers.size, 0);
  assert.equal(statSync(managedWorktreeGuardSocketDirectory(configDir, "s_race"), { throwIfNoEntry: false }), undefined);
  const [, , again] = await Promise.all([host.close("s_race"), host.ensure("s_race"), host.ensure("s_race")]);
  assert.equal((await requestManagedWorktreeGuardVerdict(again, payload("git status"))).exitCode, 0);
  await host.closeAll();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((host as any).servers.size, 0);
  // Client connections finish closing a few ticks later; a leaked listener never does.
  for (let attempt = 0; attempt < 50 && pipes() > before; attempt++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(pipes(), before, "every listener this test started is closed");
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

/* ------------------------------------------------------------------------------------------
 * #1336 slice 3: the sidecar's environment, and the abstract socket that answers from memory.
 * --------------------------------------------------------------------------------------- */

const LINUX = process.platform === "linux";

test("a verdict is judged in the sidecar's environment, never the runner's", { skip: !POSIX }, async () => {
  // Regression for slice 1's socket mode: the runner judged with its OWN environment, so a variable
  // only the provider defines was unresolvable, and one both define could resolve somewhere else.
  const { configDir, host } = fixture();
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_env"), [
    { worktreePath: "/trees/env", repoPath: "/repo" },
  ]);
  const socket = await host.ensure("s_env");
  const name = "WOLLIPOG_TEST_ONLY_THE_PROVIDER_HAS_THIS";
  assert.equal(process.env[name], undefined);
  const command = `git worktree remove "$${name}"`;
  const resolved = await requestManagedWorktreeGuardVerdict(socket, payload(command), 5_000, { [name]: "/trees/env" });
  assert.ok(resolved.stdout.includes(MANAGED_WORKTREE_REFUSAL), "the provider's value places the operand in the worktree");
  const elsewhere = await requestManagedWorktreeGuardVerdict(socket, payload(command), 5_000, { [name]: "/trees/other" });
  assert.deepEqual(elsewhere, { stdout: "", stderr: "", exitCode: 0 }, "and a value elsewhere is judged there");
  // A variable both sides define is read from the sidecar's side.
  const home = await requestManagedWorktreeGuardVerdict(
    socket, payload('git worktree remove "$HOME/env"'), 5_000, { HOME: "/trees" },
  );
  assert.ok(home.stdout.includes(MANAGED_WORKTREE_REFUSAL));
});

test("a request that is not the sidecar's envelope is refused, not judged", { skip: !POSIX }, async () => {
  const { configDir, host } = fixture();
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_raw"), []);
  const socket = await host.ensure("s_raw");
  const { connect } = await import("node:net");
  const answer = await new Promise<string>((resolvePromise, reject) => {
    const client = connect(socket);
    let text = "";
    client.on("connect", () => client.end(payload("git status")));
    client.on("data", (chunk) => { text += chunk.toString("utf8"); });
    client.on("end", () => resolvePromise(text));
    client.on("error", reject);
  });
  const verdict = parseManagedWorktreeGuardVerdict(answer);
  assert.equal(verdict.exitCode, 2);
  assert.match(verdict.stderr, /unreadable verdict request/u);
});

test("an abstract socket answers from the runner's memory and writes nothing", { skip: !LINUX }, async () => {
  const { root, configDir } = fixture();
  const lists = new Map<string, ManagedWorktreeProtection[]>([
    ["s_one", [{ worktreePath: "/trees/one", repoPath: "/repo" }]],
    ["s_two", [{ worktreePath: "/trees/two", repoPath: "/repo" }]],
  ]);
  const host = new ManagedWorktreeGuardSockets(configDir, (sessionId) => {
    const list = lists.get(sessionId);
    if (!list) throw new Error("no list");
    return list;
  });
  hosts.push(host);
  const one = await host.ensure("s_one", "abstract");
  const two = await host.ensure("s_two", "abstract");
  assert.match(one, /^@wollipog-guard-[A-Za-z0-9_-]{32}$/u, "24 random bytes: 192 bits, above the 128 required");
  assert.notEqual(one, two);
  assert.equal(await host.ensure("s_one", "abstract"), one, "a running provider's hook keeps its address");
  assert.equal(statSync(configDir, { throwIfNoEntry: false }), undefined, "nothing was created on disk");

  const remove = payload(quote(["git", "worktree", "remove", "/trees/one"]));
  assert.ok((await requestManagedWorktreeGuardVerdict(one, remove)).stdout.includes(MANAGED_WORKTREE_REFUSAL));
  assert.deepEqual(await requestManagedWorktreeGuardVerdict(two, remove), { stdout: "", stderr: "", exitCode: 0 });
  // The guard-state veto still names this runner's hook state directory.
  const stateRead = await requestManagedWorktreeGuardVerdict(one, payload(quote(["cat", join(configDir, "x")])));
  assert.ok(stateRead.stdout.includes(GUARD_STATE_REFUSAL));
  // A list on DISK that would allow the call is not consulted.
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_one"), []);
  assert.ok((await requestManagedWorktreeGuardVerdict(one, remove)).stdout.includes(MANAGED_WORKTREE_REFUSAL));
  // A live refresh is simply the next read of memory.
  lists.set("s_one", []);
  assert.deepEqual(await requestManagedWorktreeGuardVerdict(one, remove), { stdout: "", stderr: "", exitCode: 0 });
  // No list at all is an invalidated guard: a refusal.
  lists.delete("s_one");
  const invalidated = await requestManagedWorktreeGuardVerdict(one, payload("git status"));
  assert.equal(invalidated.exitCode, 2);

  // The sidecar itself, given the address: a verdict while the runner listens, exit 2 once it stops.
  const allowed = await runCli(["--protections", join(root, "unused"), "--guard-socket", two], payload("git status"));
  assert.equal(allowed.code, 0);
  await host.close("s_two");
  const gone = await runCli(["--protections", join(root, "unused"), "--guard-socket", two], payload("git status"));
  assert.equal(gone.code, 2);
  assert.match(gone.stderr, /could not get a verdict from the runner/u);
  // The refusal reaches the model, and so the session's timeline: it does not repeat the name.
  assert.ok(!gone.stderr.includes(two.slice(1)), gone.stderr);
});

test("an abstract socket the runner listens on cannot be taken over by another listener", { skip: !LINUX }, async () => {
  // The measurement behind the design: a PATH socket can be unlinked and re-bound by any process of
  // the same OS user (see "a socket replaced at the same path" above, which only recovers at the
  // next ensure). An abstract name has no entry to unlink, and a second bind is refused outright.
  const { configDir } = fixture();
  const host = new ManagedWorktreeGuardSockets(configDir, () => [{ worktreePath: "/trees/held", repoPath: "/repo" }]);
  hosts.push(host);
  const address = await host.ensure("s_held", "abstract");
  const impostor = createServer((socket) => socket.on("end", () => socket.end('{"stdout":"","stderr":"","exitCode":0}')));
  const bound = await new Promise<NodeJS.ErrnoException | null>((resolvePromise) => {
    impostor.once("error", (error) => resolvePromise(error as NodeJS.ErrnoException));
    impostor.listen(`\0${address.slice(1)}`, () => resolvePromise(null));
  });
  try {
    assert.equal(bound?.code, "EADDRINUSE");
    const verdict = await requestManagedWorktreeGuardVerdict(address, payload(quote(["git", "worktree", "remove", "/trees/held"])));
    assert.ok(verdict.stdout.includes(MANAGED_WORKTREE_REFUSAL), "the runner still answers");
  } finally {
    impostor.close();
  }
});

test("an abstract socket is refused where the platform has none", async () => {
  const host = new ManagedWorktreeGuardSockets(join(tmpdir(), "wgs-none"), () => [], "darwin");
  await assert.rejects(host.ensure("s_mac", "abstract"), /only on Linux/u);
  assert.throws(() => managedWorktreeGuardSocketAddress("@name", "darwin"), /only on Linux/u);
  assert.equal(managedWorktreeGuardSocketAddress("/a/path", "darwin"), "/a/path");
  assert.equal(managedWorktreeGuardSocketAddress("@name", "linux"), "\0name");
});

test("a legal environment is never refused for its size, however badly it escapes (review CR-2.1)", { skip: !POSIX }, async () => {
  // Seven 100 KiB values of control characters fit Linux's execve limits but serialize to over
  // 4 MB of `\u0001`; the request cap is sized for that. A value longer than one Linux string can
  // be is left out, so only a command that references it is refused, never every command.
  const { configDir, host } = fixture();
  writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(configDir, "s_big"), [
    { worktreePath: "/trees/big", repoPath: "/repo" },
  ]);
  const socket = await host.ensure("s_big");
  const environment: Record<string, string> = { BIG_TARGET: "/trees/big" };
  for (let index = 0; index < 7; index++) environment[`NOISE_${index}`] = "\u0001".repeat(100 * 1024);
  const request = managedWorktreeGuardVerdictRequest(payload("git status"), environment);
  assert.ok(request.length > 4_000_000, `the escaped request is ${request.length} bytes`);
  const judged = await requestManagedWorktreeGuardVerdict(socket, payload('git worktree remove "$BIG_TARGET"'), 10_000, environment);
  assert.ok(judged.stdout.includes(MANAGED_WORKTREE_REFUSAL), "the request was judged, with the forwarded variable resolved");
  assert.deepEqual(await requestManagedWorktreeGuardVerdict(socket, payload("git status"), 10_000, environment), { stdout: "", stderr: "", exitCode: 0 });

  const tooLong = { ...environment, HUGE: "x".repeat(MAX_FORWARDED_ENVIRONMENT_VALUE_BYTES + 1) };
  assert.equal(Object.keys(JSON.parse(managedWorktreeGuardVerdictRequest("{}", tooLong)).environment).includes("HUGE"), false);
  const unresolved = await requestManagedWorktreeGuardVerdict(socket, payload('git worktree remove "$HUGE"'), 10_000, tooLong);
  assert.match(unresolved.stdout, /"permissionDecision":"deny".*cannot tell where/u, "a reference to the dropped variable is refused as unresolvable");
  assert.deepEqual(await requestManagedWorktreeGuardVerdict(socket, payload("git status"), 10_000, tooLong), { stdout: "", stderr: "", exitCode: 0 });

  // A host with a raised stack limit permits far more than 2 MiB of environment (review CR-3.1):
  // sixty legal values of 127 KiB of control characters would escape to about 47 MB. The sidecar
  // bounds what it forwards, largest values first, so the request always fits the runner's cap and
  // the small variable that matters still arrives.
  const raised: Record<string, string> = { BIG_TARGET: "/trees/big" };
  for (let index = 0; index < 60; index++) raised[`RAISED_${index}`] = "\u0001".repeat(127 * 1024);
  const bounded = managedWorktreeGuardVerdictRequest(payload("git status"), raised);
  assert.ok(bounded.length <= MAX_FORWARDED_ENVIRONMENT_BYTES + 4096, `the request is bounded: ${bounded.length} bytes`);
  const kept = JSON.parse(bounded).environment as Record<string, string>;
  assert.equal(kept.BIG_TARGET, "/trees/big");
  assert.ok(Object.keys(kept).length < 61 && Object.keys(kept).length > 1, "only the largest values were left out");
  const raisedVerdict = await requestManagedWorktreeGuardVerdict(socket, payload('git worktree remove "$BIG_TARGET"'), 10_000, raised);
  assert.ok(raisedVerdict.stdout.includes(MANAGED_WORKTREE_REFUSAL));
  assert.deepEqual(await requestManagedWorktreeGuardVerdict(socket, payload("git status"), 10_000, raised), { stdout: "", stderr: "", exitCode: 0 });
});
