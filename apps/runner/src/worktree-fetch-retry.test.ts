import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { fetchRemoteDefaultBase } from "./worktree.js";

const advertised = "ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n";
const gitError = Object.assign(new Error("Permission denied (publickey).\nfatal: Could not read from remote repository."), { code: 128, cmd: "git" });
type Call = { file: string; args: string[]; options: ExecFileOptions; at: number };
type Result = { stdout?: string; error?: ExecFileException; delay?: number };

function fixture(t: TestContext, respond: (call: Call, index: number) => Result) {
  const calls: Call[] = [];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const execFile = ((file: string, args: string[], options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    const call = { file, args: [...args], options, at: Date.now() };
    calls.push(call);
    const result = respond(call, calls.length - 1);
    const complete = () => callback(result.error ?? null, result.stdout ?? "", result.error?.message ?? "");
    if (result.delay) setTimeout(complete, result.delay);
    else queueMicrotask(complete);
    return { stdin: null } as ChildProcess;
  }) as typeof childProcess.execFile;
  t.mock.method(childProcess, "execFile", execFile);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    t.mock.timers.reset();
  });
  return calls;
}

// Drain promise continuations before advancing the next backoff or command deadline.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("default-base fetch retries once with backoff, keeping remote, refspec, context, and progress", async (t) => {
  const calls = fixture(t, (_call, index) => index === 1 ? { error: gitError } : { stdout: advertised });
  const phases: string[] = [];
  const pending = fetchRemoteDefaultBase("/repo", {
    context: { kind: "wsl", distro: "Test" }, onProgress: (phase) => phases.push(phase),
  }, "upstream");
  await settle();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(499);
  await settle();
  assert.equal(calls.length, 2, "no retry before the backoff expires");
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ref: "upstream/develop", branch: "develop" });
  assert.deepEqual(phases, ["resolving_remote", "fetching_remote", "fetching_remote"]);
  assert.deepEqual(calls.map((call) => call.at), [0, 0, 500]);
  assert.deepEqual(calls[1]?.args, ["-d", "Test", "--cd", "/repo", "--exec", "git", "fetch", "--no-tags", "upstream",
    "+refs/heads/develop:refs/remotes/upstream/develop"]);
  assert.deepEqual(calls[2]?.args, calls[1]?.args);
  assert.ok(calls.every((call) => call.file === "wsl.exe"));
  assert.deepEqual(calls.map((call) => call.options.timeout), [120_000, 120_000, 119_500]);
});

test("default-branch lookup retries before fetching and uses the later advertised branch", async (t) => {
  const calls = fixture(t, (_call, index) => index === 0 ? { error: gitError } : { stdout: advertised });
  const phases: string[] = [];
  const pending = fetchRemoteDefaultBase("/repo", { onProgress: (phase) => phases.push(phase) });
  await settle();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(500);
  assert.deepEqual(await pending, { ref: "origin/develop", branch: "develop" });
  assert.deepEqual(calls.map((call) => call.args[0]), ["ls-remote", "ls-remote", "fetch"]);
  assert.deepEqual(calls[0]?.args, ["ls-remote", "--symref", "origin", "HEAD"]);
  assert.deepEqual(calls[1]?.args, calls[0]?.args);
  assert.deepEqual(phases, ["resolving_remote", "resolving_remote", "fetching_remote"]);
  assert.ok(calls.every((call) => call.file === "git" && call.options.cwd === "/repo"));
});

test("persistent fetch failure stops after three attempts and preserves the final Git cause and recovery hint", async (t) => {
  const calls = fixture(t, (_call, index) => index === 0 ? { stdout: advertised } : { error: gitError });
  const pending = fetchRemoteDefaultBase("/repo");
  const rejected = assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /fetching the remote default branch after 3 attempts/);
    assert.ok(error.message.includes(gitError.message));
    assert.match(error.message, /Retry, or pass an explicit base ref/);
    assert.equal(error.cause, gitError);
    return true;
  });
  await settle();
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(999);
  await settle();
  assert.equal(calls.length, 3);
  t.mock.timers.tick(1);
  await rejected;
  t.mock.timers.tick(120_000);
  await settle();
  assert.deepEqual(calls.map((call) => call.at), [0, 0, 500, 1500]);
  assert.deepEqual(calls.map((call) => call.args[0]), ["ls-remote", "fetch", "fetch", "fetch"]);
});

test("persistent lookup failure names lookup and never fetches", async (t) => {
  const calls = fixture(t, () => ({ error: gitError }));
  const rejected = assert.rejects(fetchRemoteDefaultBase("/repo"), (error: Error) => {
    assert.match(error.message, /resolving the remote default branch after 3 attempts/);
    assert.ok(error.message.includes(gitError.message));
    assert.match(error.message, /explicit base ref/);
    assert.equal(error.cause, gitError);
    return true;
  });
  await settle();
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(1000);
  await rejected;
  assert.deepEqual(calls.map((call) => call.args[0]), ["ls-remote", "ls-remote", "ls-remote"]);
});

test("missing default-branch advertisement is bounded and actionable without fetching", async (t) => {
  const calls = fixture(t, () => ({ stdout: "abc123\tHEAD\n" }));
  const rejected = assert.rejects(fetchRemoteDefaultBase("/repo"), /resolving the remote default branch.*explicit base ref.*did not advertise/);
  await settle();
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.args[0] === "ls-remote"));
});

test("a slow successful fetch retains the existing 120-second allowance", async (t) => {
  const calls = fixture(t, (call) => call.args[0] === "ls-remote" ? { stdout: advertised } : {
    delay: Math.min(45_000, call.options.timeout ?? 0),
    ...(Number(call.options.timeout) < 45_000
      ? { error: Object.assign(new Error("Git command timed out"), { cmd: "git", killed: true, signal: "SIGKILL" as const }) }
      : { stdout: "" }),
  });
  const pending = fetchRemoteDefaultBase("/repo");
  await settle();
  assert.equal(calls[1]?.options.timeout, 120_000);
  t.mock.timers.tick(45_000);
  assert.deepEqual(await pending, { ref: "origin/develop", branch: "develop" });
  assert.equal(calls.length, 2);
});

test("a failure near the deadline preserves its cause without starting a backoff outside the budget", async (t) => {
  const calls = fixture(t, () => ({ error: gitError, delay: 119_800 }));
  const rejected = assert.rejects(fetchRemoteDefaultBase("/repo"), (error: Error) => {
    assert.equal(error.cause, gitError);
    assert.match(error.message, /resolving the remote default branch after 1 attempt/);
    return true;
  });
  t.mock.timers.tick(119_800);
  await rejected;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls.length, 1);
});

test("slow lookup and fetch failures share deadlines including backoff within the total 240-second budget", async (t) => {
  const calls = fixture(t, (call, index) => ({
    ...(index === 2 ? { stdout: advertised } : { error: Object.assign(new Error("Git command timed out"), { cmd: "git" }) }),
    delay: index === 0 ? 60_000 : index === 1 ? 50_000 : call.options.timeout,
  }));
  const rejected = assert.rejects(fetchRemoteDefaultBase("/repo"), /fetching the remote default branch.*Git command timed out/);
  for (const duration of [60_000, 500, 50_000, 1000, 8500, 120_000]) {
    t.mock.timers.tick(duration);
    await settle();
  }
  await rejected;
  assert.equal(Date.now(), 240_000);
  assert.equal(calls.length, 4, "an exhausted command deadline gets no further retries");
  assert.deepEqual(calls.map((call) => call.options.timeout), [120_000, 59_500, 8500, 120_000]);
});
