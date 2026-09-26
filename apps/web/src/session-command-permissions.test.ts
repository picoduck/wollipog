import assert from "node:assert/strict";
import test from "node:test";
import { queueHoldRecoveryAction, sessionHolds, type SessionCommandPermissions, type SessionQueueHoldView } from "@wollipog/protocol";
import { holdRecoveryActionFor } from "./session-command-permissions.js";

const VIEWER = "Your Viewer role is read-only.";
const queueHold: SessionQueueHoldView = {
  kind: "worktree_rebind",
  holdId: "worktree-rebind:1",
  since: 1,
  target: "/repo/.agent-worktrees/fix",
  queuedPrompts: 1,
  unfinishedBackgroundJobs: 1,
  canStopJobs: true,
};
const [serverHold] = sessionHolds({ queueHold });

function permissions(stopJobs: boolean, restart: boolean): SessionCommandPermissions {
  return {
    stop: { allowed: true },
    restart: restart ? { allowed: true } : { allowed: false, reason: VIEWER },
    stopBackgroundJob: stopJobs ? { allowed: true } : { allowed: false, reason: VIEWER },
  };
}

test("queue-hold advice is rewritten for the person reading it (#1857)", () => {
  const viewer = holdRecoveryActionFor(serverHold!, { queueHold, commandPermissions: permissions(false, false) });
  assert.doesNotMatch(viewer, /Stop Job|stop_background_job|restart/iu, "a Viewer is not told to stop a job or restart");
  assert.match(viewer, /^Wait for the unfinished background job to end/u);
  assert.equal(viewer, queueHoldRecoveryAction(queueHold, { canStopJobs: false, canRestart: false }));

  const admin = holdRecoveryActionFor(serverHold!, { queueHold, commandPermissions: permissions(false, true) });
  assert.doesNotMatch(admin, /Stop Job|stop_background_job/u, "a non-owning admin cannot stop one job");

  assert.equal(holdRecoveryActionFor(serverHold!, { queueHold, commandPermissions: permissions(true, true) }),
    serverHold!.recoveryAction, "a person allowed both reads the server's advice");
});

test("the server's advice is shown as written when the client cannot tailor it (#1857)", () => {
  const cases = [
    ["no session view", undefined],
    ["a control plane that sends no permissions", { queueHold }],
    ["a session view without its queue hold", { commandPermissions: permissions(false, false) }],
    ["a later hold incident", { queueHold: { ...queueHold, holdId: "worktree-rebind:2" }, commandPermissions: permissions(false, false) }],
  ] as const;
  for (const [label, session] of cases) {
    assert.equal(holdRecoveryActionFor(serverHold!, session), serverHold!.recoveryAction, label);
  }
  const worktreeHold = { ...serverHold!, kind: "worktree_recovery" as const, recoveryAction: "Restore the branch." };
  assert.equal(holdRecoveryActionFor(worktreeHold, { queueHold, commandPermissions: permissions(false, false) }),
    "Restore the branch.", "a worktree hold's advice is not a queue hold's");
});
