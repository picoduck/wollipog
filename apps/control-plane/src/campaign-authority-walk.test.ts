import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingApproval, RunnerMetadata, SessionConfig, SessionView } from "@wollipog/protocol";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";

/** #2468: fixed child behavior, child creation, Parent Control, and UI-evidence delivery refuse
 * malformed ancestry with a stated reason instead of applying whichever campaign the old loop saw
 * last. Well-formed campaigns are pinned to behave exactly as before. */

const RUNNER_ID = "runner-1";
const NOOP_LOG = { info() {}, warn() {}, error() {} };
const MALFORMED = /ancestry is malformed/;

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

type Internals = {
  campaignChildBehaviorError(session: SessionView, config: SessionConfig | undefined): string | null;
  orchestratorOwnsGenericRequest(session: SessionView, request: PendingApproval): boolean;
};

function harness() {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  // Creation needs an online runner; deliveries are not under test, so they report success.
  const hub = Object.assign(new Hub(db), { isRunnerOnline: () => true, sendToRunner: () => true });
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
  /** Creates a child through the service, approving a spawn card if the parent asks for one. */
  const spawn = (parentSessionId: string) => {
    const request = { runnerId: RUNNER_ID, workspaceId: "ws-1", agentId: "claude", prompt: "Work" };
    let result = svc.createSession(request, undefined, undefined, false, false, false, { parentSessionId });
    if (result.status === 428) {
      const approval = db.getSession(parentSessionId)!.pendingApproval!;
      assert.ok(svc.approve(parentSessionId, approval.requestId, "allow").ok);
      result = svc.createSession(request, undefined, undefined, false, false, false, { parentSessionId });
    }
    return result;
  };
  const internals = svc as unknown as Internals;
  const behaviorError = (sessionId: string) =>
    internals.campaignChildBehaviorError(db.getSession(sessionId)!, { model: "another-model" });
  const question: PendingApproval = {
    requestId: "question-1", title: "Which?", options: [], kind: "question",
    questions: [{ id: "q", header: "Choice", question: "Which?", options: [{ label: "A" }] }],
  };
  const ownsGeneric = (sessionId: string) => internals.orchestratorOwnsGenericRequest(db.getSession(sessionId)!, question);
  const always = () => true;
  return { db, svc, make, spawn, behaviorError, ownsGeneric, always };
}

/** Each malformed shape yields an Orchestrator `actor` (with a running child `worker`) whose
 * ancestry the shared campaign walk refuses. */
const MALFORMED_SHAPES: Array<{ name: string; build(h: ReturnType<typeof harness>): void }> = [
  {
    name: "a cycle",
    build: ({ db, make }) => {
      make("outer", undefined, true);
      make("actor", "outer", true);
      make("worker", "actor");
      db.raw().prepare("UPDATE sessions SET parent_session_id='actor' WHERE id='outer'").run();
    },
  },
  {
    name: "a missing parent",
    build: ({ db, make }) => {
      make("outer", undefined, true);
      make("actor", "outer", true);
      make("worker", "actor");
      // Foreign keys keep this from happening through the service (a deleted parent sets NULL);
      // only malformed data can leave a dangling id.
      db.raw().exec("PRAGMA foreign_keys = OFF");
      db.raw().prepare("UPDATE sessions SET parent_session_id='deleted-elsewhere' WHERE id='actor'").run();
      db.raw().exec("PRAGMA foreign_keys = ON");
    },
  },
  {
    name: "a chain longer than 64 sessions",
    build: ({ make }) => {
      for (let depth = 0; depth < 64; depth += 1) make(`deep${depth}`, depth ? `deep${depth - 1}` : undefined, true);
      // actor -> deep63 -> ... -> deep0 holds 65 sessions.
      make("actor", "deep63", true);
      make("worker", "actor");
    },
  },
];

for (const shape of MALFORMED_SHAPES) {
  test(`every authority-dependent operation refuses ${shape.name} with a stated reason (#2468)`, () => {
    const h = harness();
    const { db, svc, spawn, behaviorError, ownsGeneric, always } = h;
    try {
      shape.build(h);
      assert.equal(db.campaignAncestryRoot("actor"), "refused", "the shared walk refuses this ancestry");

      const child = spawn("actor");
      assert.equal(child.status, 409, "child creation and policy inheritance refuse");
      assert.match(child.error ?? "", MALFORMED);

      assert.match(behaviorError("worker") ?? "", MALFORMED, "a child's model or effort change refuses");
      assert.equal(ownsGeneric("worker"), false, "a generic request stays with the human");

      const requests = svc.descendantRequests("actor", always);
      assert.equal(requests.status, 409, "Parent Control descendant reads refuse");
      assert.match(requests.error ?? "", MALFORMED);
      const resolution = svc.resolveDescendantRequest("actor", "worker", "occurrence", {
        kind: "question", answers: {},
      } as unknown as Parameters<SessionsService["resolveDescendantRequest"]>[3], always);
      assert.equal(resolution.status, 409, "Parent Control resolutions refuse");
      assert.match(resolution.error ?? "", MALFORMED);
      const evidence = svc.reviewDescendantUiEvidence("actor", "worker", "occurrence", "evidence", always);
      assert.equal(evidence.status, 409, "UI-evidence delivery refuses");
      assert.match(evidence.error ?? "", MALFORMED);
    } finally {
      db.close();
    }
  });
}

test("a well-formed nested campaign keeps its authority exactly as before (#2468)", () => {
  const { db, svc, make, spawn, behaviorError, ownsGeneric, always } = harness();
  try {
    make("root", undefined, true);
    make("nested", "root", true);
    make("worker", "nested");
    db.updateSessionOrchestratorBehavior("root", { childModel: "fixed-model" }, Date.now());
    db.updateSessionParentControl("root", "questions", Date.now());

    assert.ok(spawn("nested").ok, "children are still created beneath a nested Orchestrator");
    assert.equal(behaviorError("worker"), "child model is fixed by campaign policy at fixed-model",
      "the root campaign's fixed behavior still applies to a nested campaign's children");
    assert.equal(ownsGeneric("worker"), true, "the root's Parent Control still owns eligible requests");
    assert.ok(svc.descendantRequests("root", always).ok, "the root still reads its descendants");
    const nestedRead = svc.descendantRequests("nested", always);
    assert.equal(nestedRead.status, 403, "a nested Orchestrator is still told the root owns Parent Control");
    assert.doesNotMatch(nestedRead.error ?? "", MALFORMED);
  } finally {
    db.close();
  }
});

test("ordinary sessions above the outermost Orchestrator keep its authority exactly as before (#2468)", () => {
  const { db, svc, make, spawn, behaviorError, always } = harness();
  try {
    make("grandparent");
    make("parent", "grandparent");
    make("campaign", "parent", true);
    make("worker", "campaign");
    db.updateSessionParentControl("campaign", "questions", Date.now());
    assert.ok(spawn("campaign").ok);
    assert.equal(behaviorError("worker"), null, "no fixed model is set, so nothing is refused");
    const read = svc.descendantRequests("campaign", always);
    assert.ok(read.ok, `the outermost Orchestrator still reads its descendants: ${read.error}`);
  } finally {
    db.close();
  }
});

test("descendant requests ignore quiet retained event history and skip campaign projections (#4856)", (t) => {
  const { db, svc, make, always } = harness();
  try {
    make("campaign", undefined, true);
    make("quiet", "campaign");
    make("asking", "quiet");
    make("decision", "campaign", true);
    db.updateSessionParentControl("campaign", "questions", Date.now());
    const questions = [{ id: "q", header: "Choice", question: "Continue?", options: [{ label: "Yes" }] }];
    db.appendEvent("asking", { kind: "question_request", requestId: "question", questions }, 5);
    db.setPendingApproval("asking", { requestId: "question", occurrenceId: "generic", title: "Question",
      kind: "question", options: [], questions });
    const decision = svc.createWorkflowDecision("decision", {
      requestId: "implementation", resourceKey: "implementation",
      resourceSnapshot: { category: "implementation_question", question: "Choose an implementation",
        options: [{ optionId: "a", label: "Implementation A" }, { optionId: "b", label: "Implementation B" }] },
    });
    assert.ok(decision.ok && decision.data, decision.error ?? "workflow decision was not created");
    // Pending durable decisions can exist without the mirrored session approval.
    db.setPendingApproval("decision", null);
    const read = () => svc.descendantRequests("campaign", always, "human", true);
    const expected = read();
    assert.ok(expected.ok && expected.data, expected.error ?? "descendant requests were not returned");
    assert.deepEqual(expected.data.requests.map(({ occurrenceId, sessionId }) => ({ occurrenceId, sessionId })), [
      { occurrenceId: decision.data.occurrenceId, sessionId: "decision" },
      { occurrenceId: "generic", sessionId: "asking" },
    ]);
    assert.equal(expected.data.requests[1]?.createdAt, 5);

    const sqlite = db.raw();
    sqlite.exec(`WITH RECURSIVE history(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM history WHERE seq < 512)
      INSERT INTO session_events (session_id, seq, ts, kind, payload)
      SELECT 'quiet', seq, seq, 'agent_message',
        json_object('kind', 'agent_message', 'text', hex(zeroblob(512)), 'final', false) FROM history`);
    const eventVisits = new Map<string, number>();
    sqlite.function("observe_event_kind", (sessionId, kind) => {
      const id = String(sessionId);
      eventVisits.set(id, (eventVisits.get(id) ?? 0) + 1);
      return kind;
    });
    // Count SQLite's row visits without timing thresholds or relying on the query plan's wording.
    sqlite.exec(`CREATE TEMP VIEW session_events AS
      SELECT id, session_id, seq, runner_seq, ts, observe_event_kind(session_id, kind) AS kind, payload
      FROM main.session_events`);
    const projection = t.mock.method(db, "campaignProjection");
    assert.deepEqual(read(), expected);
    assert.ok(eventVisits.has("asking"), "the probe sees event reads for a pending question");
    assert.equal(eventVisits.get("quiet") ?? 0, 0, "pending-less descendants skip event history");
    assert.equal(projection.mock.callCount(), 0, "the nested Orchestrator's decision needs no campaign projection");
  } finally {
    db.close();
  }
});

test("64 sessions is within the bound for every authority operation (#2468)", () => {
  const { db, svc, make, spawn, behaviorError, always } = harness();
  try {
    for (let depth = 0; depth < 63; depth += 1) make(`deep${depth}`, depth ? `deep${depth - 1}` : undefined, true);
    make("actor", "deep62", true); // actor -> deep62 -> ... -> deep0 holds 64 sessions.
    make("worker", "actor");
    assert.notEqual(db.campaignAncestryRoot("actor"), "refused");
    assert.ok(spawn("actor").ok);
    assert.equal(behaviorError("worker"), null);
    assert.equal(svc.descendantRequests("actor", always).status, 403,
      "deep0 is the root campaign, exactly as the old loop found it");
  } finally {
    db.close();
  }
});
