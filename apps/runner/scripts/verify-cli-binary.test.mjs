import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeTemporaryRoot, temporaryRootRemoval } from "./remove-temporary-root.mjs";

const smoke = fileURLToPath(new URL("./verify-cli-binary.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("./verify-cli-binary-fake-cli.mjs", import.meta.url));
const passed = "Packaged CLI dispatch smoke passed";
const eperm = () => Object.assign(new Error("EPERM, Permission denied"), { code: "EPERM" });

test("removeTemporaryRoot removes the directory and asks rmSync to retry transient failures", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-temporary-root-"));
  writeFileSync(join(root, "wollipog.exe"), "");
  assert.equal(removeTemporaryRoot(root), true);
  assert.equal(existsSync(root), false);

  const calls = [];
  assert.equal(removeTemporaryRoot("/smoke/root", { remove: (...call) => calls.push(call) }), true);
  assert.deepEqual(calls, [["/smoke/root", temporaryRootRemoval]]);
  assert.equal(temporaryRootRemoval.recursive, true);
  assert.equal(temporaryRootRemoval.force, true);
  assert.ok(temporaryRootRemoval.maxRetries >= 5);
  assert.ok(temporaryRootRemoval.retryDelay > 0);
});

test("removeTemporaryRoot warns instead of throwing when removal still fails", () => {
  const warnings = [];
  const removed = removeTemporaryRoot("/smoke/root", { remove: () => { throw eperm(); }, warn: (line) => warnings.push(line) });
  assert.equal(removed, false);
  assert.deepEqual(warnings, ["Warning: could not remove temporary directory /smoke/root: EPERM, Permission denied"]);
});

test("a cleanup failure in finally never replaces the assertion error already propagating", async () => {
  const warnings = [];
  await assert.rejects(async () => {
    try {
      assert.equal(1, 0, "dispatch assertion");
    } finally {
      removeTemporaryRoot("/smoke/root", { remove: () => { throw eperm(); }, warn: (line) => warnings.push(line) });
    }
  }, { name: "AssertionError", message: /^dispatch assertion/u });
  assert.equal(warnings.length, 1);
});

// The remaining tests run the real smoke script against a POSIX stand-in for the packaged CLI.
// Windows cannot execute the shell wrapper; its smoke runs in the Platform Isolation job instead.
// A read-only directory does not stop root from deleting its contents, so the cleanup-failure
// cases need an unprivileged user.
const posixOnly = process.platform === "win32" ? "the stand-in CLI is a POSIX shell wrapper" : false;
const unprivilegedOnly = posixOnly || (process.getuid?.() === 0 ? "root ignores read-only directories" : false);

function runSmoke(t, env) {
  const work = mkdtempSync(join(tmpdir(), "wollipog-cli-smoke-test-"));
  const smokeTemp = join(work, "tmp");
  mkdirSync(smokeTemp);
  const binary = join(work, "wollipog-runner-fake");
  writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCli)} "$0" "$@"\n`, { mode: 0o755 });
  t.after(() => {
    for (const entry of readdirSync(smokeTemp)) {
      const locked = join(smokeTemp, entry, "locked");
      if (existsSync(locked)) chmodSync(locked, 0o700);
    }
    rmSync(work, { recursive: true, force: true });
  });
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [smoke, binary], {
      env: { ...process.env, TMPDIR: smokeTemp, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr, leftovers: readdirSync(smokeTemp) }));
  });
}

test("a passing smoke prints its success line and removes its temporary directory", { skip: posixOnly }, async (t) => {
  const result = await runSmoke(t, {});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^${passed}$`, "mu"));
  assert.doesNotMatch(result.stderr, /Warning/u);
  assert.deepEqual(result.leftovers, []);
});

test("a passing smoke whose temporary directory cannot be removed warns and still exits 0", { skip: unprivilegedOnly }, async (t) => {
  const result = await runSmoke(t, { FAKE_CLI_LOCK_ROOT: "1" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^${passed}$`, "mu"));
  assert.match(result.stderr, /^Warning: could not remove temporary directory .*wollipog-cli-binary-/mu);
  assert.equal(result.leftovers.length, 1);
});

test("a failed dispatch assertion exits non-zero without the success line", { skip: posixOnly }, async (t) => {
  const result = await runSmoke(t, { FAKE_CLI_VERSION: "no protocol here" });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, new RegExp(passed, "u"));
  assert.match(result.stderr, /AssertionError/u);
  assert.deepEqual(result.leftovers, []);
});

test("a failed dispatch assertion still exits non-zero with its own error when cleanup also fails", { skip: unprivilegedOnly }, async (t) => {
  const result = await runSmoke(t, { FAKE_CLI_VERSION: "no protocol here", FAKE_CLI_LOCK_ROOT: "1" });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, new RegExp(passed, "u"));
  assert.match(result.stderr, /^Warning: could not remove temporary directory /mu);
  assert.match(result.stderr, /AssertionError/u);
  assert.match(result.stderr, /no protocol here/u);
  assert.equal(result.leftovers.length, 1);
});
