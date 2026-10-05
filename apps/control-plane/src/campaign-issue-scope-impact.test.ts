import test from "node:test";
import assert from "node:assert/strict";
import type { SessionView } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { scopeSnapshot } from "./campaign-issue-scope.js";

test("scope removal impact distinguishes equal issue numbers across repositories", () => {
  const root = { id: "root", orchestratorPolicy: { issueNumbers: [124] } } as SessionView;
  const db = {
    campaignWorkLedger: { page: () => ({ ok: true, data: { items: [
      { issue: { repository: "TEAM/REPO", number: 124 }, currentAttempt: { sessionId: "member" } },
      { issue: { repository: "other/repo", number: 124 }, currentAttempt: { sessionId: "foreign-member" } },
    ], nextCursor: null } }) },
    unconsumedWorkflowDecisionsForController: () => [],
    campaignDescendantIds: () => [],
  } as unknown as ControlPlaneDb;
  const snapshot = scopeSnapshot(db, root, "team/repo", { requestId: "remove", expectedRevision: 1,
    additions: [], removals: [{ repository: "team/repo", number: 124 }], explanation: "Remove member" });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.affectedAssignments, [{ sessionId: "member", issue: 124 }]);
});
