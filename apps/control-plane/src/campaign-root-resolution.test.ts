import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerMetadata, SessionView, WorkflowDecisionView } from "@wollipog/protocol";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION } from "@wollipog/protocol";
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
    orchestratorCampaignController(start: SessionView | null): SessionView | null | "refused";
  };
  /** Where campaign continuation and attention events are filed. */
  const campaignController = (sessionId: string): string | null =>
    (svc as unknown as Walks).campaignEventController(db.getSession(sessionId))?.id ?? null;
  /** Whose fixed child behavior and Parent Control authority apply (refused on malformed ancestry, #2468). */
  const behaviorController = (sessionId: string): string | null => {
    const controller = (svc as unknown as Walks).orchestratorCampaignController(db.getSession(sessionId));
    return controller === "refused" ? "refused" : controller?.id ?? null;
  };
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
    assert.equal(behaviorController("b"), "refused",
      "Parent Control authority and fixed behavior refuse a cycle rather than dropping or guessing (#2468)");
  } finally {
    db.close();
  }
});

test("an ancestry deeper than the walk bound is refused by every campaign path (#2451)", () => {
  const { db, make, ask, campaignController } = harness();
  try {
    for (let depth = 0; depth <= 64; depth += 1) make(`deep${depth}`, depth ? `deep${depth - 1}` : undefined, true);
    // The two outermost Orchestrators own implementation questions differently, so a walk that
    // reached one level further than the old gate walk would hand a human-owned gate to an agent.
    db.updateSessionParentControlPolicy("deep0", { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, implementation_question: "orchestrator" }, Date.now());
    db.updateSessionParentControlPolicy("deep1", { ...HUMAN_ONLY_PARENT_CONTROL_POLICY }, Date.now());
    // From deep64 the chain holds 65 sessions, one more than the old gate walk examined: there it
    // picked deep1 (human-owned). Now the gate is refused rather than resolved to deep0 (agent-owned).
    make("worker", "deep64");
    const refused = ask("worker", "too-deep");
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? "", /ancestry is malformed/);
    assert.equal(campaignController("deep64"), null, "events agree with the gate on the bound");
    assert.equal(db.resolvedCampaignSessionId("deep64"), null);
    // From deep63 the chain holds 64 sessions, all of which the old gate walk examined too.
    make("shallow-worker", "deep63");
    const withinBound = decisionOf(ask("shallow-worker", "within-bound"));
    assert.equal(withinBound.controllingSessionId, "deep0", "the owner the old gate walk chose at this depth");
    assert.equal(withinBound.authority, "orchestrator");
    assert.equal(campaignController("deep63"), "deep0");
    assert.equal(db.resolvedCampaignSessionId("deep63"), "deep0");
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
