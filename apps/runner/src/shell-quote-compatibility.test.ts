import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, quote } from "shell-quote";
import {
  commandTargetsManagedWorktree,
  MANAGED_WORKTREE_REFUSAL,
  MANAGED_WORKTREE_UNRESOLVED_REFUSAL,
} from "./managed-worktree-protection.js";
import { isRoutineClaudeOrchestratorBash } from "./orchestrator-provider-permissions.js";

const protectedPath = "/runner/worktrees/session/requested/managed";
const protections = [{ worktreePath: protectedPath, repoPath: "/projects/repo" }];

test("patched shell parsing retains managed-worktree refusals for ANSI-C quoting and underscore variables", () => {
  for (const command of [
    `rm -rf $'${protectedPath}'`,
    String.raw`rm -rf $'/runner/worktrees/session/requested/man\x61ged'`,
    `_name=${protectedPath}; rm -rf $_name`,
  ]) {
    // 1.9.0 treated these as unresolved. 1.11.0 resolves the protected target directly.
    assert.equal(commandTargetsManagedWorktree(command, protectedPath, protections),
      MANAGED_WORKTREE_REFUSAL, command);
  }
});

test("nested parameter expansions and unknown underscore variables remain unresolved", () => {
  for (const command of ["rm -rf ${TARGET:-${FALLBACK}}", "rm -rf $_name"]) {
    assert.equal(commandTargetsManagedWorktree(command, protectedPath, protections),
      MANAGED_WORKTREE_UNRESOLVED_REFUSAL, command);
  }
  assert.equal(isRoutineClaudeOrchestratorBash("gh issue view ${n:-${fallback}}", [2233]), false);
  assert.equal(isRoutineClaudeOrchestratorBash("gh issue view $_name", [2233]), false);
});

test("ANSI-C quoted routine commands are classified by their decoded arguments", () => {
  for (const command of ["gh issue view $'2233'", String.raw`gh issue view $'22\x33\x33'`]) {
    // 1.9.0 rejected the empty environment reference it emitted for the leading dollar sign.
    assert.equal(isRoutineClaudeOrchestratorBash(command, [2233]), true, command);
  }
  assert.equal(isRoutineClaudeOrchestratorBash("gh issue close $'2233'", [2233]), false);
  assert.equal(isRoutineClaudeOrchestratorBash("gh issue edit $'2234' --add-assignee @me", [2233]), false);
  assert.equal(isRoutineClaudeOrchestratorBash(String.raw`gh issue $'cl\x6fse' $'2233'`, [2233]), false);
  assert.deepEqual(parse(String.raw`gh issue view $'2233\x3b rm -rf .'`),
    ["gh", "issue", "view", "2233; rm -rf ."]);
});

test("escaped backslashes retain POSIX filename meaning and quoted string arguments round trip", () => {
  const command = String.raw`rm -rf /runner/worktrees/session/requested/man\\aged`;
  assert.deepEqual(parse(command), ["rm", "-rf", String.raw`/runner/worktrees/session/requested/man\aged`]);
  assert.equal(commandTargetsManagedWorktree(command, protectedPath, protections), null);
  const arguments_ = [protectedPath, String.raw`back\slash`, "${TARGET:-${FALLBACK}}", "$_name", "$'quoted'", "a;b", "a b"];
  assert.deepEqual(parse(quote(arguments_)), arguments_);
});
