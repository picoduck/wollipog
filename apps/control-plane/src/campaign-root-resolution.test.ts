import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerMetadata, SessionView, WorkflowDecisionView } from "@wollipog/protocol";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";

/** #2451: the campaign projection, campaign events, and typed-gate ownership all resolve through
 * one ancestry walk. Each shape below pins where gates land today, so a change to the walk cannot
 * move a gate toward an agent unnoticed. */

const RUNNER_ID = "runner-1";
const NOOP_LOG = { info() {}, warn() {}, error() {} };

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws-1", name: "Demo", path: "/repos/demo" }],
    agents: [{
      id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" },
    }],
  };
}

function harness() {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  const make = (id: string, parentSessionId?: string, orchestrator = false) => {
    db.createSession({
      id, runnerId: RUNNER_ID, workspaceId: "ws-1", agentId: "claude", title: id, useWorktree: false,
      driver: "claude-code", now: Date.now(),
      config: orchestrator ? { permissionMode: "orchestrator" } : {},
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(orchestrator ? { role: "orchestrator" as const, orchestratorPolicy: policy } : {}),
    });
    db.updateSessionStatus(id, "running", Date.now());
  };
  const ask = (childSessionId: string, requestId: string) => svc.createWorkflowDecision(childSessionId, {
    requestId, resourceKey: `question:${requestId}`,
    resourceSnapshot: {
      category: "implementation_question", question: "Which option?",
      options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }],
    },
  });
  type Walks = {
    campaignEventController(start: SessionView | null): SessionView | null;
    orchestratorCampaignController(start: SessionView | null): SessionView | null;
  };
  /** Where campaign continuation and attention events are filed. */
  const campaignController = (sessionId: string): string | null =>
    (svc as unknown as Walks).campaignEventController(db.getSession(sessionId))?.id ?? null;
  /** Whose fixed child behavior and Parent Control authority apply; deliberately not changed. */
  const behaviorController = (sessionId: string): string | null =>
    (svc as unknown as Walks).orchestratorCampaignController(db.getSession(sessionId))?.id ?? null;
  return { db, svc, make, ask, campaignController, behaviorController };
}

function decisionOf(result: { ok: boolean; data?: unknown; error?: string }): WorkflowDecisionView {
  assert.ok(result.ok, result.error ?? "workflow decision refused");
  return result.data as WorkflowDecisionView;
}

test("a well-formed nested campaign keeps every gate, event, and projection at its root (#2451)", () => {
  const { db, make, ask, campaignController } = harness();
  try {
    make("root", undefined, true);
    make("nested", "root", true);
    make("worker", "nested");
    const decision = decisionOf(ask("worker", "well-formed"));
    assert.equal(decision.controllingSessionId, "root", "the gate owner is unchanged: the outermost Orchestrator");
    assert.equal(db.resolvedCampaignSessionId("nested"), "root");
    assert.equal(campaignController("nested"), "root", "campaign events land on the projection root");
    const pending = db.campaignProjection("root")!.pendingDecisions;
    assert.equal(pending.human + pending.orchestrator, 1, "get_campaign counts the decision where it was filed");
  } finally {
    db.close();
  }
});

test("ordinary sessions above the outermost Orchestrator are walked through (#2451)", () => {
  const { db, make, ask, campaignController } = harness();
  try {
    make("grandparent");
    make("parent", "grandparent");
    make("campaign", "parent", true);
    make("worker", "campaign");
    const decision = decisionOf(ask("worker", "ordinary-ancestors"));
    assert.equal(decision.controllingSessionId, "campaign", "the gate owner is unchanged: the only Orchestrator");
    assert.equal(db.resolvedCampaignSessionId("campaign"), "campaign",
      "two ordinary ancestors no longer make the campaign unprojectable");
    assert.equal(campaignController("campaign"), "campaign");
    const pending = db.campaignProjection("campaign")!.pendingDecisions;
    assert.equal(pending.human + pending.orchestrator, 1);
  } finally {
    db.close();
  }
});

test("an Orchestrator without a readable policy keeps its gates and has no campaign (#2451)", () => {
  const { db, make, ask, campaignController, behaviorController } = harness();
  try {
    make("legacy", undefined, true);
    db.raw().prepare("UPDATE sessions SET orchestrator_policy=NULL WHERE id='legacy'").run();
    make("nested", "legacy", true);
    make("worker", "nested");
    const decision = decisionOf(ask("worker", "legacy-root"));
    assert.equal(decision.controllingSessionId, "legacy",
      "the gate owner is unchanged: it never moves to the policy-bearing Orchestrator below");
    assert.equal(decision.authority, "human", "the policy-less owner stays human-only");
    assert.equal(db.resolvedCampaignSessionId("nested"), null, "nothing is projected under an unreadable root");
    assert.equal(db.campaignProjection("nested"), null);
    assert.equal(campaignController("nested"), null, "and no campaign event is filed for it");
    assert.equal(behaviorController("nested"), "nested",
      "the nested campaign's fixed child behavior still applies; refusing the projection loosens nothing");
  } finally {
    db.close();
  }
});

test("a cyclic ancestry is refused by every campaign path (#2451)", () => {
  const { db, make, ask, campaignController, behaviorController } = harness();
  try {
    make("a", undefined, true);
    make("b", "a", true);
    make("worker", "b");
    db.raw().prepare("UPDATE sessions SET parent_session_id='b' WHERE id='a'").run();
    const refused = ask("worker", "cycle");
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? "", /ancestry is malformed/);
    assert.equal(db.resolvedCampaignSessionId("b"), null);
    assert.equal(campaignController("b"), null);
    assert.notEqual(behaviorController("b"), null,
      "Parent Control authority and fixed behavior are not dropped for a cycle, so it gains no authority");
  } finally {
    db.close();
  }
});

test("an ancestry deeper than the walk bound is refused by every campaign path (#2451)", () => {
  const { db, make, ask, campaignController } = harness();
  try {
    for (let depth = 0; depth <= 65; depth += 1) make(`deep${depth}`, depth ? `deep${depth - 1}` : undefined, true);
    // deep65 is 65 hops below deep0, one past the bound. A worker's gates and its campaign events
    // both resolve from its parent, so they agree on which side of the bound it falls.
    make("worker", "deep65");
    const refused = ask("worker", "too-deep");
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? "", /ancestry is malformed/);
    assert.equal(campaignController("deep65"), null);
    assert.equal(db.resolvedCampaignSessionId("deep65"), null);
    make("shallow-worker", "deep64");
    assert.equal(decisionOf(ask("shallow-worker", "within-bound")).controllingSessionId, "deep0",
      "64 hops is within the bound for every path");
    assert.equal(campaignController("deep64"), "deep0");
    assert.equal(db.resolvedCampaignSessionId("deep64"), "deep0");
  } finally {
    db.close();
  }
});

test("a pending decision keeps its recorded controller and is revoked visibly once its ancestry is refused (#2451)", () => {
  const { db, svc, make, ask } = harness();
  try {
    make("root", undefined, true);
    make("nested", "root", true);
    make("worker", "nested");
    const decision = decisionOf(ask("worker", "before-corruption"));
    db.raw().prepare("UPDATE sessions SET parent_session_id='nested' WHERE id='root'").run();
    (svc as unknown as { restorePendingWorkflowDecisionCards(id: string): void })
      .restorePendingWorkflowDecisionCards("worker");
    const after = db.workflowDecisionByOccurrence(decision.occurrenceId)!;
    assert.equal(after.status, "revoked", "a decision whose ancestry is refused is revoked, not re-bound");
    assert.equal(after.controllingSessionId, "root", "the recorded controller is never rewritten");
    const notice = db.listEvents("worker").map((event) => event.payload)
      .find((payload) => payload.kind === "error");
    assert.ok(notice?.kind === "error" && notice.message.includes(decision.occurrenceId) &&
      /ancestry is malformed/.test(notice.message), "the transcript says why the card is gone");
  } finally {
    db.close();
  }
});
