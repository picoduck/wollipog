import assert from "node:assert/strict";
import type { CampaignForgePullRequestObservation } from "@wollipog/protocol";
import { hashToken } from "../../../control-plane/src/auth.js";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";
import type { Hub } from "../../../control-plane/src/hub.js";
import { SessionsService } from "../../../control-plane/src/sessions.js";
import type { seedCampaignStatus } from "./campaign-status-seed.js";

const RUNNER_ID = "campaign-status-e2e";
const WORKSPACE_ID = "campaign-status-workspace";
const MINUTE = 60_000;
const REPO = "picoduck/wollipog";

/** Pull requests of the timed walkthrough item, one per forge fact state. */
export const WALKTHROUGH_PULL_REQUESTS = { fresh: 2499, stale: 2498, failed: 2497, neverRead: 2496 } as const;

export const REVIEWER_TOKEN = "campaign-status-walkthrough-reviewer";

const observation = (overrides: Partial<CampaignForgePullRequestObservation> = {}): CampaignForgePullRequestObservation => ({
  state: "open", draft: false, headSha: "4be1c0ffee5d2a7b9c8e1f0a3d6b2c4e5f7a8b9c", baseRef: "main",
  reviewDecision: "approved",
  checks: { state: "passing", passing: 14, failing: 0, pending: 0 },
  requiredChecks: { state: "passing", passing: 1, failing: 0, pending: 0 },
  mergeQueue: { state: "awaiting_checks", position: 2 },
  mergeCommitSha: null,
  ...overrides,
});

/**
 * Add the integrated time, cost, and forge states to a database `seedCampaignStatus` prepared,
 * before the control plane starts:
 *
 * - In the main campaign, which began before recording did, a merge-queue wait begun since, whose
 *   attempt has recorded queue, active, and waiting intervals with a known model, and whose pull
 *   requests read fresh, stale, unavailable with a last value, and never read (so the disconnected
 *   runner is the reason).
 * - A second campaign shared with the whole organization, whose child and runner belong to the
 *   owner, plus a reviewer who may read the campaign but not that child or runner: its cost and
 *   forge facts read not_authorized.
 */
export function seedCampaignWalkthrough(databasePath: string, seeded: ReturnType<typeof seedCampaignStatus>) {
  const db = ControlPlaneDb.open(databasePath);
  const now = Date.now();
  try {
    const ledger = db.campaignWorkLedger;
    const root = seeded.rootId;
    // The campaign began an hour ago, five minutes before this installation started recording
    // intervals and attribution: its buckets carry that gap, while work begun since is measured.
    db.raw().prepare("UPDATE sessions SET created_at=? WHERE id=?").run(now - 60 * MINUTE, root);
    db.raw().prepare("UPDATE campaign_work_accounting_meta SET started_at=?").run(now - 55 * MINUTE);
    const planned = ledger.recordPlan(root, root, {
      items: [{ key: `${REPO}#2417-walkthrough`, title: "Merge-Queue Wait With Forge Facts", dispatchState: "queued",
        queuePosition: 0, issue: { repository: REPO, number: 2417 } }],
      planComplete: true,
    }, now - 50 * MINUTE);
    assert.ok(planned.ok, planned.ok ? "" : planned.error);
    const itemId = planned.data.items[0]!.workItemId;
    const worker = "campaign-walkthrough-worker";
    db.createSession({
      id: worker, parentSessionId: root, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent",
      title: "#2417 Walkthrough: Merge-Queue Wait", useWorktree: false, driver: "claude-code", config: {},
      now: now - 41 * MINUTE,
    });
    db.updateSessionStatus(worker, "running", now - 41 * MINUTE);
    const assigned = ledger.assign(root, root, itemId, worker, {
      title: "#2417 Walkthrough: Merge-Queue Wait", harness: "claude-code", agentName: "Claude", model: "opus", effort: "high",
    }, now - 40 * MINUTE);
    assert.ok(assigned.ok, assigned.ok ? "" : assigned.error);
    db.appendEvent(worker, { kind: "token_usage", inputTokens: 40_000, outputTokens: 6_000, costUsd: 1.1 }, now - 30 * MINUTE,
      { accrueUsage: true });
    db.updateSessionStatus(worker, "input_required", now - 25 * MINUTE);
    db.updateSessionStatus(worker, "running", now - 20 * MINUTE);
    db.appendEvent(worker, { kind: "token_usage", inputTokens: 12_000, outputTokens: 2_000, costUsd: 0.4 }, now - 12 * MINUTE,
      { accrueUsage: true });
    db.updateSessionStatus(worker, "idle", now - 8 * MINUTE);
    const pr = (number: number) => ({ repository: REPO, number });
    const updated = ledger.updateItem(root, root, {
      workItemId: itemId,
      stage: { stage: "merge_queued", note: "Enqueued after the cross-model review upvoted.",
        pullRequests: Object.values(WALKTHROUGH_PULL_REQUESTS).map(pr) },
      nextAction: "Verify delivery once the merge group passes.",
    }, now - 7 * MINUTE);
    assert.ok(updated.ok, updated.ok ? "" : updated.error);
    const forge = db.campaignForgeObservations;
    forge.record(root, RUNNER_ID, [{ ref: pr(WALKTHROUGH_PULL_REQUESTS.stale),
      observation: observation({ mergeQueue: null, reviewDecision: "review_required",
        requiredChecks: { state: "pending", passing: 0, failing: 0, pending: 1 } }) }], now - 40 * MINUTE);
    forge.record(root, RUNNER_ID, [{ ref: pr(WALKTHROUGH_PULL_REQUESTS.failed), observation: observation() }], now - 60 * MINUTE);
    forge.record(root, RUNNER_ID, [{ ref: pr(WALKTHROUGH_PULL_REQUESTS.failed), failure: "forge_unauthenticated" }], now - 5 * MINUTE);

    // A campaign every member of the organization can read, with the owner's own child and runner.
    const identity = db.localIdentityContext();
    const hub = new Proxy({ isRunnerOnline: () => true, sendToRunner: () => true }, {
      get(target, key: string) {
        return key in target ? target[key as keyof typeof target] : () => undefined;
      },
    }) as unknown as Hub;
    const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
    const decisions = {
      implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
      follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator",
    } as const;
    const created = svc.createSession({
      runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "orchestrator-agent",
      title: "Shared Review Campaign", config: { permissionMode: "orchestrator" }, prompt: "Orchestrate the shared review.",
      orchestrator: { behavior: { completion: "retain" } },
    }, undefined, undefined, false, false, false, {
      defaultOwnerUserId: identity.userId,
      orchestratorDefaults: {
        source: "user_default",
        defaults: {
          behavior: { childHarness: null, childModel: null, childEffort: null,
            maximumConcurrentChildren: 2, followUps: "recommend_only", completion: "retain" },
          delegation: { parentControl: "off", decisions: { ...decisions } },
          execution: { strictProjectIsolation: false, integrationIsolation: false },
        },
        capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" },
      },
      validateOrchestratorDefaults: () => null,
    });
    assert.ok(created.ok && created.data, created.error);
    const sharedRoot = created.data.id;
    const sharedChild = "shared-review-child";
    db.createSession({
      id: sharedChild, parentSessionId: sharedRoot, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent",
      title: "Owner's Private Review Child", useWorktree: false, driver: "claude-code", config: {}, now: now - 20 * MINUTE,
    });
    const shared = svc.recordCampaignPlan(sharedRoot, {
      items: [{ key: "shared-review", title: "Review the Shared Change", dispatchState: "queued" }], planComplete: true,
    });
    assert.ok(shared.ok && shared.data, shared.error);
    const sharedItem = shared.data.items[0]!.workItemId;
    assert.ok(svc.assignCampaignWorkItem(sharedRoot, { workItemId: sharedItem, childSessionId: sharedChild }).ok);
    db.appendEvent(sharedChild, { kind: "token_usage", inputTokens: 5_000, outputTokens: 800, costUsd: 0.6 }, now - 15 * MINUTE,
      { accrueUsage: true });
    assert.ok(svc.updateCampaignWorkItem(sharedRoot, { workItemId: sharedItem,
      stage: { stage: "in_review", pullRequests: [pr(2495)] } }).ok);
    forge.record(sharedRoot, RUNNER_ID, [{ ref: pr(2495), observation: observation({ mergeQueue: null }) }], now - MINUTE);
    db.updateSessionStatus(sharedRoot, "idle", now - 10 * MINUTE);
    db.updateSessionStatus(sharedChild, "idle", now - 10 * MINUTE);

    const own = (table: "session_ownership" | "runner_ownership", id: string, kind: "user" | "organization", ownerId: string) => {
      const column = table === "session_ownership" ? "session_id" : "runner_id";
      db.raw().prepare(
        `INSERT INTO ${table} (${column}, organization_id, owner_kind, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1)
         ON CONFLICT(${column}) DO UPDATE SET owner_kind=excluded.owner_kind, owner_id=excluded.owner_id`,
      ).run(id, identity.organizationId, kind, ownerId);
    };
    own("session_ownership", sharedRoot, "organization", identity.organizationId);
    own("session_ownership", sharedChild, "user", identity.userId);
    own("runner_ownership", RUNNER_ID, "user", identity.userId);
    db.createIdentityMember({ userId: "campaign-reviewer", displayName: "Campaign Reviewer",
      organizationId: identity.organizationId, role: "operator", now });
    db.createDevice({ id: "device-campaign-reviewer", name: "Reviewer Browser", tokenHash: hashToken(REVIEWER_TOKEN),
      userId: "campaign-reviewer", organizationId: identity.organizationId, now });
    return { walkthroughItemId: itemId, walkthroughWorkerId: worker, sharedRootId: sharedRoot, sharedItemId: sharedItem };
  } finally {
    db.close();
  }
}

/** Record the walkthrough's fresh observation just before the control plane serves it. */
export function recordFreshWalkthroughObservation(databasePath: string, rootId: string) {
  const db = ControlPlaneDb.open(databasePath);
  try {
    db.campaignForgeObservations.record(rootId, RUNNER_ID, [{
      ref: { repository: REPO, number: WALKTHROUGH_PULL_REQUESTS.fresh }, observation: observation(),
    }], Date.now() - 30_000);
  } finally {
    db.close();
  }
}
