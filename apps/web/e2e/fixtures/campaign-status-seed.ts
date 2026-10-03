import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";
import { SessionsService } from "../../../control-plane/src/sessions.js";
import type { Hub } from "../../../control-plane/src/hub.js";

const RUNNER_ID = "campaign-status-e2e";
const WORKSPACE_ID = "campaign-status-workspace";
const MINUTE = 60_000;

/**
 * Seed a real control-plane database with a campaign ledger (#2417): delivered, running, blocked,
 * waiting, queued, planned and removed work, an accepted follow-up, and rejected and duplicate
 * recommendations, with attributed usage: provider-reported, unpriced, coordination, unattributed,
 * and an attempt that used nothing. The live spec serves it through the real Read API.
 */
export function seedCampaignStatus(databasePath: string, workspacePath: string) {
  const db = ControlPlaneDb.open(databasePath);
  const runner: RunnerMetadata = {
    runnerId: RUNNER_ID, hostname: "test-host", os: "linux", version: "e2e",
    workspaces: [{ id: WORKSPACE_ID, name: "Campaign Status E2E", path: workspacePath }],
    agents: [
      { id: "child-agent", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
        available: true, context: { kind: "native" } },
      { id: "orchestrator-agent", name: "Planner", command: "claude", args: [], env: {}, driver: "claude-code",
        available: true, context: { kind: "native" },
        capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
          permissionModes: ["default", "orchestrator"] } },
    ],
  };
  db.registerRunner(runner, Date.now(), PROTOCOL_VERSION);
  const hub = new Proxy({ isRunnerOnline: () => true, sendToRunner: () => true }, {
    get(target, key: string) {
      return key in target ? target[key as keyof typeof target] : () => undefined;
    },
  }) as unknown as Hub;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const ownerUserId = db.localIdentityContext().userId;
  const decisions = {
    implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
    follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator",
  } as const;
  const now = Date.now();
  try {
    const created = svc.createSession({
      runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "orchestrator-agent",
      title: "#2417 Campaign Orchestrator", config: { permissionMode: "orchestrator" }, prompt: "Orchestrate #2417.",
      orchestrator: { behavior: { completion: "retain" } },
    }, undefined, undefined, false, false, false, {
      defaultOwnerUserId: ownerUserId,
      orchestratorDefaults: {
        source: "user_default",
        defaults: {
          behavior: { childHarness: null, childModel: null, childEffort: null,
            maximumConcurrentChildren: 4, followUps: "execute_approved", completion: "retain" },
          delegation: { parentControl: "off", decisions: { ...decisions } },
          execution: { strictProjectIsolation: false, integrationIsolation: false },
        },
        capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" },
      },
      validateOrchestratorDefaults: () => null,
    });
    assert.ok(created.ok && created.data, created.error);
    const root = created.data.id;
    let sequence = 0;
    const child = (title: string, minutesAgo: number) => {
      const id = `campaign-child-${++sequence}`;
      db.createSession({
        id, parentSessionId: root, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent", title,
        useWorktree: false, driver: "claude-code", config: {}, now: now - minutesAgo * MINUTE,
      });
      return id;
    };
    const contract = child("#2417 Slice 3: Contract", 180);
    const panel = child("#2417 Slice 7: Campaign Status Panel", 95);
    const readApi = child("#2417 Slice 5: Read API", 70);
    const timeCost = child("#2417 Slice 6: Time and Cost", 50);
    const untracked = child("Exploratory Spike", 40);
    // A nested Orchestrator is a member of the root campaign, and an unrelated session is in none.
    const nested = "campaign-nested-orchestrator";
    db.createSession({
      id: nested, parentSessionId: root, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "orchestrator-agent",
      title: "Nested Release Orchestrator", useWorktree: false, driver: "claude-code", config: { permissionMode: "orchestrator" },
      role: "orchestrator", orchestratorPolicy: db.getSession(root)!.orchestratorPolicy!, now: now - 35 * MINUTE,
    });
    const unrelated = "unrelated-session";
    db.createSession({
      id: unrelated, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent", title: "Unrelated Session",
      useWorktree: false, driver: "claude-code", config: {}, now: now - 30 * MINUTE,
    });

    const repo = "picoduck/wollipog";
    const plan = svc.recordCampaignPlan(root, {
      items: [
        { key: "contract", title: "Campaign Work Ledger Contract", queuePosition: 1, dispatchState: "queued",
          issue: { repository: repo, number: 2417 } },
        { key: "panel", title: "Campaign Status Panel", queuePosition: 2, dispatchState: "queued", dependsOnKeys: ["contract"] },
        { key: "read-api", title: "Ledger Read API", queuePosition: 3, dispatchState: "queued", dependsOnKeys: ["contract"] },
        { key: "time-cost", title: "Time and Cost Attribution", queuePosition: 4, dispatchState: "queued" },
        { key: "forge", title: "Observed Forge Status", queuePosition: 5, dispatchState: "queued", dependsOnKeys: ["read-api"] },
        { key: "integration", title: "Integration Coverage", queuePosition: 6 },
        { key: "legacy-import", title: "Import Pre-Ledger History", queuePosition: 7 },
      ],
      planComplete: true,
    });
    assert.ok(plan.ok && plan.data, plan.error);
    const id = (key: string) => plan.data!.items.find((item) => item.key === key)!.workItemId;
    const assign = (key: string, session: string) =>
      assert.ok(svc.assignCampaignWorkItem(root, { workItemId: id(key), childSessionId: session }).ok);
    // Usage is attributed as it is recorded (slice 6): to the session's open attempt, otherwise to
    // coordination for the root or unattributed for a child. No costUsd and no rate is unpriced.
    const usage = (session: string, costUsd?: number) => db.appendEvent(session, {
      kind: "token_usage", inputTokens: 1_000, outputTokens: 200,
      ...(costUsd === undefined ? { model: "unpriced-model" } : { costUsd }),
    }, Date.now(), { accrueUsage: true });
    usage(root, 0.35);
    usage(untracked, 0.15);

    // Delivered: verified against the child's final report, then the child is archived.
    assign("contract", contract);
    usage(contract, 0.7);
    usage(contract, 0.5);
    db.updateSessionStatus(contract, "idle", now - 120 * MINUTE);
    const report = db.appendEvent(contract, { kind: "agent_message", text: "Contract merged.", final: true }, now - 121 * MINUTE).seq;
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: id("contract"),
      stage: { stage: "merged", pullRequests: [{ repository: repo, number: 2430 }] } }).ok);
    const verified = svc.verifyCampaignChild(root, { childSessionId: contract, reportEventSeq: report,
      followUpsAccounted: true, workItem: { id: id("contract"), outcome: "delivered" } });
    assert.ok(verified.ok, verified.error);
    db.setSessionArchived(contract, true, now - 110 * MINUTE);

    assign("panel", panel);
    usage(panel, 2.4);
    usage(panel);
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: id("panel"),
      stage: { stage: "implementing", note: "Binding to the merged contract." } }).ok);
    assign("read-api", readApi);
    usage(readApi, 0.8);
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: id("read-api"),
      blocker: { reason: "Waiting for a merge decision on the storage pull request.", responsibleActor: "human" },
      nextAction: "Rebase onto main once storage merges.",
      stage: { stage: "in_review", pullRequests: [{ repository: repo, number: 2436 }] } }).ok);
    // Slice 8: what the runner's GitHub CLI last read for that pull request, a minute ago.
    db.campaignForgeObservations.record(root, RUNNER_ID, [{
      ref: { repository: repo, number: 2436 },
      observation: {
        state: "open", draft: false, headSha: "dd08b41b6a0e2c4f1f0b7d4e5b9a3c2d1e0f9a8b", baseRef: "main",
        reviewDecision: "review_required",
        checks: { state: "pending", passing: 6, failing: 0, pending: 3 },
        requiredChecks: { state: "none", passing: 0, failing: 0, pending: 0 },
        mergeQueue: null, mergeCommitSha: null,
      },
    }], now - MINUTE);
    assign("time-cost", timeCost);
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: id("legacy-import"),
      commitment: { state: "scope_removed", reason: "Older campaigns show partial coverage instead." } }).ok);

    // Recommendations: one accepted into follow-up work, one rejected, one deduplicated.
    const recommend = (title: string) => svc.recordCampaignFollowUp(root, {
      originSessionId: panel, repository: repo, title, originWorkItemIds: [id("panel")],
    });
    const accepted = recommend("Bind Campaign Status to the Slice 5 Read API");
    const rejected = recommend("Animate the Work List");
    recommend("bind campaign status to the slice 5 read api");
    assert.ok(svc.adjudicateCampaignRecommendation(root, { recommendationId: accepted.data!.id, disposition: "accepted",
      reason: "The panel must run against the real endpoints.", resultingWorkItemKey: "followup:bind-read-api" }).ok);
    assert.ok(svc.adjudicateCampaignRecommendation(root, { recommendationId: rejected.data!.id, disposition: "rejected",
      reason: "Motion is out of scope." }).ok);

    return { rootId: root, panelId: panel, readApiId: readApi, timeCostId: timeCost, untrackedId: untracked,
      nestedId: nested, unrelatedId: unrelated,
      contractItemId: id("contract"), panelItemId: id("panel"), readApiItemId: id("read-api") };
  } finally {
    db.close();
  }
}

/**
 * Record plan items while the control plane is down, through the same service operation the
 * Orchestrator tool calls. Used to prove a reconnecting browser catches up on what it missed.
 */
export function recordPlanOffline(databasePath: string, rootId: string, items: Array<{ key: string; title: string; queuePosition: number }>) {
  const db = ControlPlaneDb.open(databasePath);
  try {
    const hub = new Proxy({ isRunnerOnline: () => false, sendToRunner: () => false }, {
      get(target, key: string) {
        return key in target ? target[key as keyof typeof target] : () => undefined;
      },
    }) as unknown as Hub;
    const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
    const recorded = svc.recordCampaignPlan(rootId, {
      items: items.map((item) => ({ ...item, dispatchState: "queued" as const })), planComplete: true,
    });
    assert.ok(recorded.ok, recorded.error);
  } finally {
    db.close();
  }
}

/** Startup marks sessions without a connected runner stopped. Put the live children back. */
export function restoreCampaignStatuses(databasePath: string, seeded: ReturnType<typeof seedCampaignStatus>) {
  const db = ControlPlaneDb.open(databasePath);
  try {
    const now = Date.now();
    db.updateSessionStatus(seeded.rootId, "running", now);
    db.updateSessionStatus(seeded.panelId, "running", now - MINUTE);
    db.updateSessionStatus(seeded.readApiId, "running", now - 8 * MINUTE);
    db.updateSessionStatus(seeded.timeCostId, "idle", now - 3 * MINUTE);
    db.updateSessionStatus(seeded.untrackedId, "idle", now - 30 * MINUTE);
    db.updateSessionStatus(seeded.nestedId, "running", now - 2 * MINUTE);
    db.updateSessionStatus(seeded.unrelatedId, "idle", now - 20 * MINUTE);
  } finally {
    db.close();
  }
}
