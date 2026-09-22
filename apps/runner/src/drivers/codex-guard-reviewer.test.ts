/**
 * Who reviews an escalation in a structured Codex session that owns a managed worktree (#1499).
 *
 * Before this, `auto-review` silently became manual review in exactly those sessions: the reviewer
 * was forced to `user` so the driver's approval-time `commandTargetsManagedWorktree` veto would
 * run, because that veto is only reachable while the request comes to this client. A proven
 * `PreToolUse` guard hook enforces the same veto a step earlier and independently of the reviewer,
 * so where one is proven Guardian owns the review again.
 *
 * Measured on codex-cli 0.155.1 with a real `codex app-server`, a scripted model provider, and a
 * hook standing in for the guard sidecar (ADR 0012). One real turn per case:
 *
 *   protected command, no escalation                     -> denied before execution
 *   protected command, escalated, client would accept    -> denied, approval never even raised
 *   protected command, escalated, reviewer auto_review   -> denied
 *   benign command, escalated                            -> allowed through, then ran
 *
 * The hook fires before the approval exists, so a protected command never becomes a prompt at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCodexTurnParams } from "./codex-app-server.js";
import {
  codexGuardActiveInArgs,
  codexGuardLaunchArgs,
  withoutCodexGuardArgs,
} from "../codex-managed-worktree-guard.js";

const GUARD_OVERRIDE =
  'hooks.PreToolUse=[{matcher="Bash|apply_patch",hooks=[{type="command",' +
  'command="/usr/bin/node /runner/cli.js --managed-worktree-guard --protections /state/s1.json"}]}]';
const TRUST_OVERRIDE =
  'hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:abc"}}';
const BYPASS = "--dangerously-bypass-hook-trust";
const GUARDED = ["-c", GUARD_OVERRIDE, "-c", TRUST_OVERRIDE, BYPASS];

function reviewerFor(protectManagedWorktrees: boolean, guardActive: boolean): unknown {
  return buildCodexTurnParams(
    { permissionMode: "auto-review" }, "t1", "/repo", [], undefined,
    protectManagedWorktrees ? [{ worktreePath: "/repo", repoPath: "/primary" }] : [], null, guardActive,
  ).approvalsReviewer;
}

/* ---------------------------------------------------------------------------------------------
 * The reviewer gate.
 * ------------------------------------------------------------------------------------------ */

test("a proven guard gives an auto-review turn back to Guardian, worktree or not", () => {
  assert.equal(reviewerFor(true, true), "auto_review", "with a managed worktree and a proven guard");
  assert.equal(reviewerFor(false, true), "auto_review", "with no managed worktree at all");
});

test("without a proven guard, a managed worktree still routes every escalation to the human", () => {
  // The driver's approval-time veto is then the ONLY managed-worktree protection a structured
  // Codex session has, and it is reachable only while the request comes to this client.
  assert.equal(reviewerFor(true, false), "user");
  // With nothing to protect, the guard is irrelevant and Guardian reviews as it always did.
  assert.equal(reviewerFor(false, false), "auto_review");
});

test("the guard changes only who reviews, never the sandbox or the approval policy", () => {
  const guarded = buildCodexTurnParams(
    { permissionMode: "auto-review" }, "t1", "/repo", [], undefined,
    [{ worktreePath: "/repo", repoPath: "/primary" }], null, true);
  const unguarded = buildCodexTurnParams(
    { permissionMode: "auto-review" }, "t1", "/repo", [], undefined,
    [{ worktreePath: "/repo", repoPath: "/primary" }], null, false);
  assert.deepEqual(guarded.sandboxPolicy, unguarded.sandboxPolicy);
  assert.equal(guarded.approvalPolicy, unguarded.approvalPolicy);
  const { approvalsReviewer: _a, ...guardedRest } = guarded;
  const { approvalsReviewer: _b, ...unguardedRest } = unguarded;
  assert.deepEqual(guardedRest, unguardedRest);
});

test("a mode that never routes to Guardian is untouched by the guard", () => {
  // `approvalsReviewer` is only ever set for auto-review; on-request asks the client by design,
  // and the Orchestrator preset pins its own reviewer.
  for (const mode of ["on-request", "read-only", "danger-full-access"]) {
    const params = buildCodexTurnParams(
      { permissionMode: mode }, "t1", "/repo", [], undefined,
      [{ worktreePath: "/repo", repoPath: "/primary" }], null, true);
    assert.equal(params.approvalsReviewer, undefined, mode);
  }
  const orchestrator = buildCodexTurnParams(
    { permissionMode: "orchestrator" }, "t1", "/repo", [], undefined,
    [{ worktreePath: "/repo", repoPath: "/primary" }], null, true);
  assert.equal(orchestrator.approvalsReviewer, "auto_review");
});

test("the gate defaults to the pre-#1499 routing when no caller supplies it", () => {
  // Every existing caller that has not been taught about the guard must keep today's behaviour.
  assert.equal(
    buildCodexTurnParams(
      { permissionMode: "auto-review" }, "t1", "/repo", [], undefined,
      [{ worktreePath: "/repo", repoPath: "/primary" }],
    ).approvalsReviewer,
    "user",
  );
});

/* ---------------------------------------------------------------------------------------------
 * Re-deriving the guard from the argv a spawn will actually use.
 * ------------------------------------------------------------------------------------------ */

test("both halves are required, because the hook override alone is unfalsifiable", () => {
  assert.equal(codexGuardActiveInArgs(GUARDED), true);
  // The pre-#1499 shape: a hook override with no trust override. On an entry point where the
  // bypass flag does nothing, Codex reports this hook enabled and untrusted, and skips it.
  assert.equal(codexGuardActiveInArgs(["-c", GUARD_OVERRIDE, BYPASS]), false);
  assert.equal(codexGuardActiveInArgs(["-c", TRUST_OVERRIDE, BYPASS]), false);
  assert.equal(codexGuardActiveInArgs([]), false);
});

test("stripping the trust bypass after provisioning disarms the derived guard", () => {
  // `stripOrchestratorLaunchArgs` drops the bypass flag for a non-Claude driver. The flag is inert
  // on `app-server` and load-bearing on a TUI and `codex exec`, but either way its removal means
  // the argv is no longer the one provisioning proved, so both derivations must agree it is not
  // guarded rather than one of them vouching for it.
  assert.equal(codexGuardActiveInArgs(["-c", GUARD_OVERRIDE, "-c", TRUST_OVERRIDE]), false);
});

test("a later foreign override of either dotted path disarms the guard", () => {
  const foreignHook = 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="/u/x.sh"}]}]';
  assert.equal(codexGuardActiveInArgs([...GUARDED, "-c", foreignHook]), false);
  // A later `hooks.state` that is not a trust override replaces the runner's trust for that path.
  assert.equal(
    codexGuardActiveInArgs([...GUARDED, "-c", 'hooks.state={"k"={enabled=true}}']),
    false,
  );
  // An EARLIER foreign override is replaced by the runner's, which goes last.
  assert.equal(codexGuardActiveInArgs(["-c", foreignHook, ...GUARDED]), true);
});

test("the isolation override is not mistaken for a trust override, and does not disarm one", () => {
  // #1473's override writes the same `hooks.state` prefix with `enabled=false`; it disables
  // foreign hooks and says nothing about trust, so it must neither grant nor revoke it.
  const disable = 'hooks.state={"/home/u/.codex/config.toml:pre_tool_use:0:0"={enabled=false}}';
  assert.equal(codexGuardActiveInArgs(["-c", GUARD_OVERRIDE, "-c", disable, BYPASS]), false);
  assert.equal(codexGuardActiveInArgs([...GUARDED, "-c", disable]), true);
});

test("a value that is not a config override's value is never read as one", () => {
  // The overrides only count when they follow `-c`/`--config`; a prompt that happens to contain
  // the same text is an argument, not configuration.
  assert.equal(codexGuardActiveInArgs([GUARD_OVERRIDE, TRUST_OVERRIDE, BYPASS]), false);
  assert.equal(codexGuardActiveInArgs(["--", "-c", GUARD_OVERRIDE, "-c", TRUST_OVERRIDE, BYPASS]), false);
});

test("--disable hooks disarms the guard, whatever the overrides still say", () => {
  // Review finding CR-1.1. The flag switches the whole feature off, so Codex runs NO hook while the
  // argv still carries every string this predicate looks for. Provisioning drops it for an isolated
  // launch and proves that argv; anything re-adding it afterwards has taken the guard away.
  for (const disable of [["--disable", "hooks"], ["--disable=hooks"]]) {
    assert.equal(codexGuardActiveInArgs([...GUARDED, ...disable]), false, disable.join(" "));
    assert.equal(codexGuardActiveInArgs([...disable, ...GUARDED]), false, disable.join(" "));
  }
  // Disabling some other feature says nothing about hooks.
  assert.equal(codexGuardActiveInArgs([...GUARDED, "--disable", "web_search"]), true);
});

test("no hook-trust configuration is stripped before the runner knows its own key", () => {
  // Review findings CR-1.2 and round 2. `withoutCodexGuardArgs` runs before the inventory is read,
  // so it cannot tell a person's trust override from the runner's — a person can install their own
  // session-flags hook through `-c` too, and Codex keys that under `/<session-flags>/` as well. It
  // therefore strips neither. It still strips the runner's own PreToolUse override.
  const userConfigTrust = 'hooks.state={"/home/u/.codex/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:u"}}';
  const userFlagsTrust = 'hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:1"={trusted_hash="sha256:v"}}';
  for (const value of [userConfigTrust, userFlagsTrust, TRUST_OVERRIDE]) {
    assert.deepEqual(withoutCodexGuardArgs(["-c", value]), ["-c", value], value);
  }
  const disable = 'hooks.state={"/home/u/.codex/config.toml:pre_tool_use:0:0"={enabled=false}}';
  assert.deepEqual(withoutCodexGuardArgs(["-c", disable]), ["-c", disable]);
});

test("appending the runner's trust replaces only overrides naming the same hook", () => {
  // The runner's own must not stack across re-preparation, and a person's trust for a DIFFERENT
  // hook — including another session-flags hook, which is the round-2 case — must survive. Codex
  // replaces the whole `hooks.state` table with the last override, so a same-key one is superseded
  // anyway; dropping it just keeps the argv from growing.
  const userFlagsTrust = 'hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:1"={trusted_hash="sha256:v"}}';
  const twice = codexGuardLaunchArgs(["-c", TRUST_OVERRIDE, "-c", userFlagsTrust], GUARD_OVERRIDE, TRUST_OVERRIDE);
  assert.equal(twice.filter((arg) => arg === TRUST_OVERRIDE).length, 1, "the runner's own is not stacked");
  assert.ok(twice.includes(userFlagsTrust), "a person's trust for another hook survives");
  assert.equal(codexGuardActiveInArgs(twice), true);
});
