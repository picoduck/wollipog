import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function combineFailures(primary, cleanup) {
  return primary ? new AggregateError([
    ...(primary instanceof AggregateError ? primary.errors : [primary]), cleanup,
  ], "successor load validation and cleanup failed") : cleanup;
}

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function killOwnedTree(current) {
  if (current.exitCode !== null || current.signalCode !== null || !current.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => execFile("taskkill", ["/PID", String(current.pid), "/T", "/F"], { timeout: 5_000 }, (error) => {
      if (!error || error.code === 128) resolve(); else reject(new Error("owned validation tree termination failed", { cause: error }));
    }));
  } else {
    try { process.kill(-current.pid, "SIGKILL"); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      current.kill("SIGKILL");
    }
  }
}

// Own storage before the runner starts. Never scan global /tmp or signal PIDs
// read from disk: detached contenders can outlive it, and PIDs can be reused.
export async function runFocusedValidation({
  cwd, args, env = process.env, outerMs = 45_000, cleanupMs = 5_000,
  onOutput = () => {}, terminate = killOwnedTree, removeRoot = rmSync,
}) {
  const fixtureParent = mkdtempSync(join(tmpdir(), "wollipog-successor-load-fixtures-"));
  let failure;
  let current;
  let closed;
  let closeObserved = false;
  let output = "";
  try {
    current = spawn(process.execPath, args, {
      cwd, env: { ...env, WOLLIPOG_SUCCESSOR_FIXTURE_PARENT: fixtureParent },
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"],
    });
    let spawnFailure;
    closed = new Promise((resolve) => {
      current.once("error", (error) => { spawnFailure = error; });
      current.once("close", (code, signal) => {
        closeObserved = true;
        resolve({ code, signal });
      });
    });
    current.stdout.on("data", (chunk) => { output += chunk; onOutput(chunk); });
    const status = await bounded(closed, outerMs, "focused validation exceeded its outer deadline");
    if (spawnFailure) throw spawnFailure;
    if (status.code !== 0) throw new Error(`focused validation exit=${status.code} signal=${status.signal}`);
    const lines = output.split(/\r?\n/);
    assert.ok(lines.some((line) => /^ok \d+ - the exclusive successor elects one winner across real runner processes$/.test(line)), "the exact focused test must run");
    for (const expected of ["# tests 1", "# pass 1", "# fail 0", "# cancelled 0", "# skipped 0"]) {
      assert.ok(lines.includes(expected), `unexpected focused result: ${expected}`);
    }
  } catch (error) { failure = error; }
  if (current && !closeObserved) {
    try { await terminate(current); }
    catch (error) { failure = combineFailures(failure, error); }
    try { await bounded(closed, cleanupMs, "owned validation tree did not close"); }
    catch (error) { failure = combineFailures(failure, error); }
  }
  try {
    // Empty means no fixture started, or its cleanup observed all contenders
    // close and removed its root. Runner closure alone proves neither on POSIX.
    const retained = readdirSync(fixtureParent);
    if (closeObserved && retained.length === 0) removeRoot(fixtureParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    else failure = combineFailures(failure, new Error(
      `fixture state retained at ${fixtureParent}; detached contenders may still be running; cleanup is unproved; inspect fixture contenders.json as advisory ownership evidence, not authority to signal a PID`,
    ));
  } catch (error) {
    failure = combineFailures(failure, new Error(`temporary fixture cleanup failed; state retained at ${fixtureParent}`, { cause: error }));
  }
  if (failure) throw failure;
}
