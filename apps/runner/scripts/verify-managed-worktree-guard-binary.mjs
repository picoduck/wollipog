/** Exercise the injected SEA, never a source-build substitute. Run with node --import tsx. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { quote } from "shell-quote";
import {
  verifyManagedWorktreeGuardLaunch,
  writeManagedWorktreeGuardProtections,
} from "../src/managed-worktree-guard.ts";
import { MANAGED_WORKTREE_REFUSAL } from "../src/managed-worktree-protection.ts";
import { runnerReentryCommand } from "../src/runner-reentry.ts";

assert.equal(process.argv.length, 3, "pass exactly one packaged runner path");
const binary = realpathSync(resolve(process.argv[2]));
const launch = runnerReentryCommand({ isSea: true, execPath: binary, execArgv: [] }, "--managed-worktree-guard");
assert.deepEqual(verifyManagedWorktreeGuardLaunch(launch), { ok: true }, "packaged provisioning self-test");
console.log("packaged provisioning self-test passed");

const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-packaged-guard-")));
try {
  const cwd = join(root, "foreign cwd");
  const worktreePath = join(root, "trees", "probe's worktree");
  const protections = join(root, "state", "protections.json");
  mkdirSync(cwd);
  writeManagedWorktreeGuardProtections(protections, [{ worktreePath, repoPath: join(root, "repo") }]);
  const run = (input) => {
    const result = spawnSync(launch.command, [...launch.args, "--protections", protections], {
      input, encoding: "utf8", cwd, timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, "guard must exit normally");
    return result;
  };
  const payload = (command) => JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", cwd,
    tool_input: { command },
  });
  const denied = run(payload(quote(["git", "worktree", "remove", worktreePath])));
  assert.equal(denied.status, 0, denied.stderr);
  const document = JSON.parse(denied.stdout); // Empty output and crash diagnostics must fail.
  assert.equal(document.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(document.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(document.hookSpecificOutput.permissionDecisionReason.includes(MANAGED_WORKTREE_REFUSAL));
  console.log("packaged destructive command returned a deny document");

  const malformed = run("{not json");
  assert.equal(malformed.status, 2, malformed.stderr);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /managed worktree guard could not read its input/);
  console.log("packaged malformed input blocked with exit 2");

  const allowed = run(payload("git status --short"));
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "", "ordinary commands must not be blanket-denied");
  console.log("packaged ordinary command allowed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
