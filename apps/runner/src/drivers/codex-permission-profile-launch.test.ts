/**
 * The #1336 slice 2 contract at the Codex App Server launch path: a migrated mode sends the
 * permission profile and NO legacy sandbox policy, an unmigrated one is byte-for-byte what it is
 * today, and the two never travel together (Codex silently ignores the profile when they do).
 *
 * No mode migrates on codex-cli 0.155.1, because a deny entry costs a launch every
 * APPROVED network escalation. The turn-params tests keep exercising the migrated shape with an
 * explicitly supplied base — that code stays live for a build whose escalation survives a deny.
 * (The `codex exec` launch-path cases left with that driver in #3259.)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCodexTurnParams } from "./codex-app-server.js";
import {
  codexPermissionProfileOverrides,
  type CodexPermissionProfileBase,
} from "../codex-permission-profile.js";

const HOOK_DIR = "/data/hooks/abc123";

/* ------------------------------------------------------------------------------------------
 * The app-server turn params, and the projection equality the migration rests on.
 * --------------------------------------------------------------------------------------- */

const MIGRATED: Array<[string, CodexPermissionProfileBase, string]> = [
  ["auto-review", ":workspace", "workspaceWrite"],
  ["on-request", ":workspace", "workspaceWrite"],
  ["untrusted", ":workspace", "workspaceWrite"],
  ["on-failure", ":workspace", "workspaceWrite"],
  ["workspace-write", ":workspace", "workspaceWrite"],
  ["read-only", ":read-only", "readOnly"],
];

test("a migrated mode's params are today's params MINUS the sandbox policy, and nothing else", () => {
  for (const [mode, base, sandboxType] of MIGRATED) {
    const legacy = buildCodexTurnParams({ permissionMode: mode }, "t1", "/repo", [], undefined, []);
    const profiled = buildCodexTurnParams({ permissionMode: mode }, "t1", "/repo", [], undefined, [], base);
    // The policy that is dropped is exactly the built-in's projection, measured from thread/start.
    assert.deepEqual(legacy.sandboxPolicy, { type: sandboxType }, mode);
    const { sandboxPolicy, ...withoutPolicy } = legacy;
    assert.deepEqual(profiled, withoutPolicy, `${mode}: only the sandbox policy changes`);
    assert.equal(profiled.sandboxPolicy, undefined, mode);
  }
});

test("a turn whose mode the running profile does not express keeps its legacy policy", () => {
  // The base is bound when the app-server starts; a mid-session switch to the other base, or to an
  // unmigrated mode, must NOT ride on a profile that expresses something different.
  const readOnlyTurn = buildCodexTurnParams({ permissionMode: "read-only" }, "t1", "/repo", [], undefined, [], ":workspace");
  assert.deepEqual(readOnlyTurn.sandboxPolicy, { type: "readOnly" });

  const workspaceTurn = buildCodexTurnParams({ permissionMode: "auto-review" }, "t1", "/repo", [], undefined, [], ":read-only");
  assert.deepEqual(workspaceTurn.sandboxPolicy, { type: "workspaceWrite" });

  const fullAccess = buildCodexTurnParams({ permissionMode: "danger-full-access" }, "t1", "/repo", [], undefined, [], ":workspace");
  assert.deepEqual(fullAccess.sandboxPolicy, { type: "dangerFullAccess" });
});

test("the Orchestrator preset keeps its own policy, profile or not", () => {
  const params = buildCodexTurnParams({ permissionMode: "orchestrator" }, "t1", "/repo", [], undefined, [], ":workspace");
  assert.deepEqual(params.sandboxPolicy, {
    type: "workspaceWrite", writableRoots: ["/repo"], networkAccess: true,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  });
});

test("a managed-worktree Git grant keeps the explicit policy instead of losing roots to a profile", (t) => {
  // The running profile expresses only the plain built-in workspace. A linked-worktree turn needs
  // a non-default writable root, so sending no policy would recreate #1569 even though Full Access
  // is correctly narrowed to on-request first.
  const root = mkdtempSync(join(tmpdir(), "wollipog-codex-profile-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoPath = join(root, "primary");
  const worktreePath = join(root, "worktree");
  const commonGitDir = join(repoPath, ".git");
  const worktreeGitDir = join(commonGitDir, "worktrees", "worktree");
  const gitRoots = [worktreeGitDir, ...["objects", "refs", "logs"].map((name) => join(commonGitDir, name))];
  for (const path of [worktreePath, ...gitRoots]) mkdirSync(path, { recursive: true });
  writeFileSync(join(worktreePath, ".git"), `gitdir: ${worktreeGitDir}\n`);
  const params = buildCodexTurnParams(
    { permissionMode: "danger-full-access" }, "t1", worktreePath, [], undefined,
    [{ worktreePath, repoPath }], ":workspace",
  );
  assert.deepEqual(params.sandboxPolicy, {
    type: "workspaceWrite", writableRoots: [worktreePath, ...gitRoots],
  });
  assert.equal(params.approvalPolicy, "on-request");
});

test("the profile override text is stable for both bases", () => {
  assert.equal(
    codexPermissionProfileOverrides(":read-only", HOOK_DIR)[0],
    `permissions.wollipog-runner-guard={extends=":read-only",filesystem={"${HOOK_DIR}"="deny"}}`,
  );
});
