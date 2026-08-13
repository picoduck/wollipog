import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
  ControlPlaneToRunner,
  RunnerMetadata,
  SessionCommandInvocationResultMessage,
  SessionCommandInvocationUpdateMessage,
} from "@wollipog/protocol";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb, type StageSessionCommandInvocationInput } from "./db.js";
import type { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";

const RUNNER_ID = "runner-command-tests";
const SESSION_ID = "session-command-tests";
const OTHER_SESSION_ID = "other-session-command-tests";
const WORKSPACE_ID = "workspace-command-tests";
const AGENT_ID = "claude-command-tests";

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID,
    hostname: "command-test-host",
    os: "linux",
    version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Command Tests", path: "/repos/commands" }],
    agents: [{
      id: AGENT_ID,
      name: "Claude",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
      context: { kind: "native" },
    }],
  };
}

function harness(): ControlPlaneDb {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), 1, PROTOCOL_VERSION);
  for (const id of [SESSION_ID, OTHER_SESSION_ID]) {
    db.createSession({
      id,
      runnerId: RUNNER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      title: "Untitled session",
      useWorktree: false,
      driver: "claude-code",
      config: {},
      now: 2,
    });
  }
  return db;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function invocation(
  suffix: string,
  overrides: Partial<StageSessionCommandInvocationInput> = {},
): StageSessionCommandInvocationInput {
  const payload = {
    sessionId: SESSION_ID,
    submissionId: `submission-${suffix}`,
    providerCommandId: "provider-command-1",
    catalogRevision: "catalog-revision-1",
    expectedExecutionMode: "passthrough",
    argumentText: `arguments ${suffix}`,
  };
  return {
    invocationId: `invocation-${suffix}`,
    requestId: `request-${suffix}`,
    sessionId: payload.sessionId,
    runnerId: RUNNER_ID,
    submissionId: payload.submissionId,
    providerCommandId: payload.providerCommandId,
    catalogRevision: payload.catalogRevision,
    commandName: "review",
    argumentText: payload.argumentText,
    executionMode: "passthrough",
    payloadDigest: digest(payload),
    expiresAt: 100_000,
    now: 10,
    ...overrides,
  };
}

function resultReceipt(
  input: StageSessionCommandInvocationInput,
  state: SessionCommandInvocationResultMessage["state"],
  revision: number,
): SessionCommandInvocationResultMessage {
  return {
    type: "session_command_invocation_result",
    requestId: input.requestId,
    invocationId: input.invocationId,
    submissionId: input.submissionId,
    sessionId: input.sessionId,
    state,
    revision,
    duplicate: false,
  };
}

function updateReceipt(
  input: StageSessionCommandInvocationInput,
  state: SessionCommandInvocationUpdateMessage["state"],
  revision: number,
  userEventSeq?: number,
): SessionCommandInvocationUpdateMessage {
  return {
    type: "session_command_invocation_update",
    invocationId: input.invocationId,
    submissionId: input.submissionId,
    sessionId: input.sessionId,
    state,
    revision,
    ...(userEventSeq === undefined ? {} : { userEventSeq }),
  };
}

test("session command staging is idempotent, conflict-safe, projected, and cascades", () => {
  const db = harness();
  try {
    const input = invocation("stage");
    assert.equal(db.stageSessionCommandInvocation(input).kind, "inserted");
    assert.equal(
      db.stageSessionCommandInvocation({ ...input, invocationId: "ignored", requestId: "ignored" }).kind,
      "duplicate",
      "same session/submission and digest reuses the durable invocation",
    );
    assert.equal(
      db.stageSessionCommandInvocation({
        ...input,
        invocationId: "conflicting-invocation",
        requestId: "conflicting-request",
        payloadDigest: digest("different payload"),
      }).kind,
      "conflict",
    );

    assert.deepEqual(db.sessionCommandInvocationMessage(input.invocationId), {
      type: "invoke_session_command",
      requestId: input.requestId,
      invocationId: input.invocationId,
      submissionId: input.submissionId,
      payloadDigest: input.payloadDigest,
      expiresAt: input.expiresAt,
      sessionId: input.sessionId,
      providerCommandId: input.providerCommandId,
      catalogRevision: input.catalogRevision,
      expectedExecutionMode: input.executionMode,
      argumentText: input.argumentText,
    });
    assert.deepEqual(db.getSession(SESSION_ID)?.commandInvocations?.map((item) => item.invocationId), [
      input.invocationId,
    ]);

    db.deleteSession(SESSION_ID);
    assert.equal(db.getSessionCommandInvocation(input.invocationId), null);
    assert.equal(
      (db.raw().prepare("SELECT COUNT(*) AS count FROM session_command_invocation_attempts").get() as { count: number }).count,
      0,
      "session deletion cascades through invocations and delivery attempts",
    );
  } finally {
    db.close();
  }
});

test("session command admission capacity is atomic and preserves exact duplicates", () => {
  const db = harness();
  try {
    const first = invocation("capacity-first");
    const second = invocation("capacity-second");
    const third = invocation("capacity-third");
    assert.equal(db.stageSessionCommandInvocation(first, 2).kind, "inserted");
    assert.equal(db.stageSessionCommandInvocation(second, 2).kind, "inserted");
    assert.equal(db.stageSessionCommandInvocation(first, 2).kind, "duplicate");
    assert.equal(db.stageSessionCommandInvocation(third, 2).kind, "full");
    assert.equal(db.getSessionCommandInvocation(third.invocationId), null);
  } finally {
    db.close();
  }
});

test("receipts require exact ownership and advance monotonically to an immutable terminal state", () => {
  const db = harness();
  try {
    const input = invocation("lifecycle");
    db.stageSessionCommandInvocation(input);
    assert.equal(db.markSessionCommandInvocationSent(input.requestId, 20)?.state, "sent");

    assert.equal(db.recordSessionCommandInvocationReceipt(
      "wrong-runner",
      resultReceipt(input, "accepted", 1),
      21,
    ), null);
    assert.equal(db.recordSessionCommandInvocationReceipt(RUNNER_ID, {
      ...resultReceipt(input, "accepted", 1),
      requestId: "wrong-request",
    }, 21), null);
    assert.equal(db.recordSessionCommandInvocationReceipt(RUNNER_ID, {
      ...resultReceipt(input, "accepted", 1),
      sessionId: OTHER_SESSION_ID,
    }, 21), null);
    assert.equal(db.recordSessionCommandInvocationReceipt(RUNNER_ID, {
      ...resultReceipt(input, "accepted", 1),
      invocationId: "wrong-invocation",
    }, 21), null);
    assert.equal(db.getSessionCommandInvocation(input.invocationId)?.state, "sent");

    assert.equal(
      db.recordSessionCommandInvocationReceipt(RUNNER_ID, resultReceipt(input, "accepted", 1), 30)?.invocation.state,
      "accepted",
    );
    assert.equal(
      db.recordSessionCommandInvocationReceipt(RUNNER_ID, updateReceipt(input, "queued", 2), 31)?.invocation.state,
      "queued",
    );
    assert.equal(
      db.recordSessionCommandInvocationReceipt(RUNNER_ID, updateReceipt(input, "started", 3, 17), 32)?.invocation.state,
      "started",
    );
    assert.equal(db.getSessionCommandInvocation(input.invocationId)?.userEventSeq, 17);

    assert.equal(
      db.recordSessionCommandInvocationReceipt(RUNNER_ID, updateReceipt(input, "queued", 2), 33)?.invocation.state,
      "started",
      "stale receipts cannot regress the lifecycle",
    );
    assert.equal(
      db.recordSessionCommandInvocationReceipt(RUNNER_ID, updateReceipt(input, "completed", 4), 34)?.invocation.state,
      "completed",
    );
    assert.equal(
      db.recordSessionCommandInvocationReceipt(RUNNER_ID, {
        ...updateReceipt(input, "rejected", 5),
        error: "late contradiction",
        code: "INVALID_COMMAND",
      }, 35)?.invocation.state,
      "completed",
      "terminal receipts are immutable",
    );
    assert.equal(db.getSessionCommandInvocation(input.invocationId)?.error, undefined);
  } finally {
    db.close();
  }
});

test("a first-revision receipt-store rejection settles the staged invocation", () => {
  const db = harness();
  try {
    const input = invocation("receipt-store-full");
    db.stageSessionCommandInvocation(input);
    db.markSessionCommandInvocationSent(input.requestId, 20);
    const receipt = {
      ...resultReceipt(input, "rejected", 0),
      code: "RECEIPT_STORE_FULL" as const,
      error: "session command receipt store is full",
    };

    const persisted = db.recordSessionCommandInvocationReceipt(RUNNER_ID, receipt, 21);
    assert.equal(persisted?.changed, true);
    assert.equal(persisted?.invocation.state, "rejected");
    assert.equal(persisted?.invocation.code, "RECEIPT_STORE_FULL");
    assert.equal(db.getSessionCommandInvocation(input.invocationId)?.state, "rejected");

    const replay = db.recordSessionCommandInvocationReceipt(RUNNER_ID, receipt, 22);
    assert.equal(replay?.changed, false, "the terminal rejection remains immutable on replay");
  } finally {
    db.close();
  }
});

test("the public receipt boundary rejects malformed frames before persistence and contains DB errors", () => {
  const db = harness();
  try {
    const warnings: string[] = [];
    const service = new SessionsService(db, { sessionChangedById() {} } as unknown as Hub, {
      info() {},
      warn(message) { warnings.push(message); },
      error() {},
    });
    const input = invocation("malformed-boundary");
    db.stageSessionCommandInvocation(input);
    db.markSessionCommandInvocationSent(input.requestId, 20, 1_000);
    const valid = resultReceipt(input, "accepted", 1);
    const malformed: unknown[] = [
      null,
      [],
      { ...valid, requestId: "" },
      { ...valid, invocationId: "x".repeat(257) },
      { ...valid, state: "pending" },
      { ...valid, revision: -1 },
      { ...valid, revision: 1.5 },
      { ...valid, revision: Number.MAX_SAFE_INTEGER },
      { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, duplicate: "false" },
      { ...valid, error: "x".repeat(513) },
      { ...valid, code: "NOT_A_COMMAND_CODE" },
      { ...updateReceipt(input, "started", 2), userEventSeq: -1 },
      { ...updateReceipt(input, "started", 2), userEventSeq: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const frame of malformed) {
      assert.doesNotThrow(() => assert.equal(service.onSessionCommandInvocationReceipt(RUNNER_ID, frame), false));
    }
    assert.equal(db.getSessionCommandInvocation(input.invocationId)?.state, "sent");
    assert.equal(warnings.length, malformed.length);
    assert.equal(service.onSessionCommandInvocationReceipt(RUNNER_ID, {
      ...valid,
      forwardCompatibleExtension: true,
    }), true, "a legitimate receipt still applies after an absurd revision is rejected");

    const original = db.recordSessionCommandInvocationReceipt.bind(db);
    (db as unknown as { recordSessionCommandInvocationReceipt: typeof original })
      .recordSessionCommandInvocationReceipt = () => { throw new Error("sqlite containment probe"); };
    assert.doesNotThrow(() => assert.equal(service.onSessionCommandInvocationReceipt(RUNNER_ID, valid), false));
    assert.match(warnings.at(-1) ?? "", /sqlite containment probe/);
  } finally {
    db.close();
  }
});

test("durable user-event evidence records exact provenance without fabricating receipt lifecycle", () => {
  const db = harness();
  try {
    const input = invocation("evidence");
    db.stageSessionCommandInvocation(input);
    db.markSessionCommandInvocationSent(input.requestId, 20);
    db.recordSessionCommandInvocationReceipt(RUNNER_ID, resultReceipt(input, "accepted", 1), 21);
    db.recordSessionCommandInvocationReceipt(RUNNER_ID, updateReceipt(input, "queued", 2), 22);

    assert.equal(db.resolveSessionCommandInvocationFromUserMessage(
      OTHER_SESSION_ID,
      input.invocationId,
      input.submissionId,
      input.providerCommandId,
      input.catalogRevision,
      input.commandName,
      input.executionMode,
      40,
      60,
    ), false);
    assert.equal(db.resolveSessionCommandInvocationFromUserMessage(
      input.sessionId,
      input.invocationId,
      "wrong-submission",
      input.providerCommandId,
      input.catalogRevision,
      input.commandName,
      input.executionMode,
      40,
      60,
    ), false);
    assert.equal(db.resolveSessionCommandInvocationFromUserMessage(
      input.sessionId,
      input.invocationId,
      input.submissionId,
      "wrong-provider-command",
      input.catalogRevision,
      input.commandName,
      input.executionMode,
      40,
      60,
    ), false);
    assert.equal(db.resolveSessionCommandInvocationFromUserMessage(
      input.sessionId,
      input.invocationId,
      input.submissionId,
      input.providerCommandId,
      input.catalogRevision,
      input.commandName,
      input.executionMode,
      40,
      60,
    ), true);
    assert.deepEqual(
      (({ state, revision, userEventSeq }) => ({ state, revision, userEventSeq }))(
        db.getSessionCommandInvocation(input.invocationId)!,
      ),
      { state: "queued", revision: 2, userEventSeq: 40 },
    );

    const rejected = db.recordSessionCommandInvocationReceipt(RUNNER_ID, {
      ...updateReceipt(input, "rejected", 3),
      error: "provider command was cancelled",
      code: "COMMAND_CANCELLED",
    }, 61);
    assert.equal(rejected?.changed, true);
    assert.equal(rejected?.invocation.state, "rejected");
    assert.equal(rejected?.invocation.revision, 3);
    assert.equal(rejected?.invocation.code, "COMMAND_CANCELLED");
    assert.equal(rejected?.invocation.userEventSeq, 40);

    const uncertain = invocation("late-uncertain", { expiresAt: 70 });
    db.stageSessionCommandInvocation(uncertain);
    db.markSessionCommandInvocationSent(uncertain.requestId, 62);
    db.expireSessionCommandInvocations(71);
    const beforeEvidence = db.getSessionCommandInvocation(uncertain.invocationId)!;
    const terminalAt = (db.raw().prepare(
      "SELECT terminal_at FROM session_command_invocations WHERE invocation_id=?",
    ).get(uncertain.invocationId) as { terminal_at: number | null }).terminal_at;
    assert.equal(db.resolveSessionCommandInvocationFromUserMessage(
      uncertain.sessionId,
      uncertain.invocationId,
      uncertain.submissionId,
      uncertain.providerCommandId,
      uncertain.catalogRevision,
      uncertain.commandName,
      uncertain.executionMode,
      41,
      72,
    ), true);
    const afterEvidence = db.getSessionCommandInvocation(uncertain.invocationId)!;
    assert.equal(afterEvidence.state, "uncertain");
    assert.equal(afterEvidence.revision, beforeEvidence.revision);
    assert.equal(afterEvidence.error, beforeEvidence.error);
    assert.equal(afterEvidence.code, beforeEvidence.code);
    assert.equal(afterEvidence.userEventSeq, 41);
    assert.equal(
      (db.raw().prepare("SELECT terminal_at FROM session_command_invocations WHERE invocation_id=?")
        .get(uncertain.invocationId) as { terminal_at: number | null }).terminal_at,
      terminalAt,
    );
  } finally {
    db.close();
  }
});

test("expiry and capability loss reject unsent work but mark delivered work uncertain", () => {
  const db = harness();
  try {
    const pendingExpiry = invocation("pending-expiry", { expiresAt: 30 });
    const sentExpiry = invocation("sent-expiry", { expiresAt: 30 });
    const startedExpiry = invocation("started-expiry", { expiresAt: 30 });
    for (const input of [pendingExpiry, sentExpiry, startedExpiry]) db.stageSessionCommandInvocation(input);
    db.markSessionCommandInvocationSent(sentExpiry.requestId, 20);
    db.markSessionCommandInvocationSent(startedExpiry.requestId, 20);
    db.recordSessionCommandInvocationReceipt(RUNNER_ID, updateReceipt(startedExpiry, "started", 3), 21);

    assert.equal(db.expireSessionCommandInvocations(31), 3);
    assert.deepEqual(
      [pendingExpiry, sentExpiry, startedExpiry].map((input) => db.getSessionCommandInvocation(input.invocationId)?.state),
      ["rejected", "uncertain", "uncertain"],
    );
    assert.equal(db.getSessionCommandInvocation(pendingExpiry.invocationId)?.code, "COMMAND_EXPIRED");

    const pendingLoss = invocation("pending-loss");
    const sentLoss = invocation("sent-loss");
    db.stageSessionCommandInvocation(pendingLoss);
    db.stageSessionCommandInvocation(sentLoss);
    db.markSessionCommandInvocationSent(sentLoss.requestId, 40);
    assert.equal(db.settleSessionCommandCapabilityLoss(RUNNER_ID, 41), 2);
    assert.equal(db.getSessionCommandInvocation(pendingLoss.invocationId)?.state, "rejected");
    assert.equal(db.getSessionCommandInvocation(pendingLoss.invocationId)?.code, "COMMAND_MODE_UNSUPPORTED");
    assert.equal(db.getSessionCommandInvocation(sentLoss.invocationId)?.state, "uncertain");

    const reclaimed = invocation("reclaimed");
    db.stageSessionCommandInvocation(reclaimed);
    db.markSessionCommandInvocationSent(reclaimed.requestId, 50);
    db.recordSessionCommandInvocationReceipt(RUNNER_ID, resultReceipt(reclaimed, "accepted", 1), 51);
    db.recordSessionCommandInvocationReceipt(RUNNER_ID, updateReceipt(reclaimed, "queued", 2), 52);
    assert.equal(
      db.recordSessionCommandInvocationReceipt(RUNNER_ID, updateReceipt(reclaimed, "accepted", 3), 53)?.invocation.state,
      "accepted",
      "a restarted runner may reclaim queued work with a higher-revision accepted receipt",
    );
  } finally {
    db.close();
  }
});

test("SessionsService resolves current catalog authority before staging and dispatches idempotently", () => {
  const db = harness();
  try {
    db.raw().prepare(
      "UPDATE sessions SET status='idle',agent_capabilities=? WHERE id=?",
    ).run(JSON.stringify({
      models: [],
      effortLevels: [],
      slashCommands: [{
        name: "review",
        source: "native",
        invocation: {
          id: "provider-command-1",
          catalogRevision: "catalog-revision-1",
          executionMode: "passthrough",
        },
      }, {
        name: "inspect",
        source: "builtin",
        invocation: {
          id: "provider-command-structured",
          catalogRevision: "catalog-revision-structured",
          executionMode: "structured",
        },
      }],
      supportsImages: false,
      supportsApprovals: false,
    }), SESSION_ID);

    const sent: ControlPlaneToRunner[] = [];
    const changed: string[] = [];
    const hub = {
      isRunnerOnline: () => true,
      sendToRunner: (_runnerId: string, message: ControlPlaneToRunner) => {
        sent.push(message);
        return true;
      },
      sessionChangedById: (sessionId: string) => changed.push(sessionId),
    } as unknown as Hub;
    const service = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
    const request = {
      submissionId: "service-submission",
      providerCommandId: "provider-command-1",
      catalogRevision: "catalog-revision-1",
      argumentText: "the arguments",
    };

    const created = service.invokeSessionCommand(SESSION_ID, request);
    assert.equal(created.status, 202);
    assert.equal(created.data?.state, "sent");
    assert.equal(created.data?.commandName, "review", "the command name is resolved server-side");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.type, "invoke_session_command");
    assert.deepEqual(changed, [SESSION_ID]);

    const duplicate = service.invokeSessionCommand(SESSION_ID, request);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data?.invocationId, created.data?.invocationId);
    assert.equal(sent.length, 1, "idempotent submissions are not dispatched twice");

    const wire = sent[0];
    assert.ok(wire?.type === "invoke_session_command");
    const accepted = {
      type: "session_command_invocation_result" as const,
      requestId: wire.requestId,
      invocationId: wire.invocationId,
      submissionId: wire.submissionId,
      sessionId: wire.sessionId,
      state: "accepted" as const,
      revision: 1,
      duplicate: false,
    };
    changed.length = 0;
    assert.equal(service.onSessionCommandInvocationReceipt(RUNNER_ID, accepted), true);
    assert.deepEqual(changed, [SESSION_ID]);
    assert.equal(service.onSessionCommandInvocationReceipt(RUNNER_ID, accepted), true);
    assert.equal(service.onSessionCommandInvocationReceipt(RUNNER_ID, {
      type: "session_command_invocation_update",
      invocationId: wire.invocationId,
      submissionId: wire.submissionId,
      sessionId: wire.sessionId,
      state: "queued",
      revision: 0,
    }), true);
    assert.deepEqual(changed, [SESSION_ID], "duplicate and stale receipts do not rebroadcast the session");

    const conflict = service.invokeSessionCommand(SESSION_ID, { ...request, argumentText: "different" });
    assert.equal(conflict.status, 409);
    assert.match(conflict.error ?? "", /submissionId/);
    assert.equal(service.invokeSessionCommand(SESSION_ID, {
      ...request,
      submissionId: "stale-catalog",
      catalogRevision: "old-catalog",
    }).status, 409);
    assert.equal(service.invokeSessionCommand(SESSION_ID, {
      ...request,
      submissionId: "missing-command",
      providerCommandId: "not-authorized",
    }).status, 409);

    const structured = service.invokeSessionCommand(SESSION_ID, {
      submissionId: "service-structured",
      providerCommandId: "provider-command-structured",
      catalogRevision: "catalog-revision-structured",
      argumentText: "the live process",
    });
    assert.equal(structured.status, 202);
    assert.equal(structured.data?.executionMode, "structured");
    assert.equal(
      sent.find((message) => message.type === "invoke_session_command" &&
        message.submissionId === "service-structured")?.expectedExecutionMode,
      "structured",
    );

    for (const [kind, label] of [
      ["cost_budget", "cost budget"],
      ["max_tool_calls", "tool-call limit"],
      ["policy_hook", "tool approval"],
    ] as const) {
      db.setPendingApproval(SESSION_ID, { requestId: `approval-${kind}`, kind, title: label, options: [] });
      db.updateSessionStatus(SESSION_ID, "input_required", Date.now());
      const blocked = service.invokeSessionCommand(SESSION_ID, {
        ...request,
        submissionId: `blocked-${kind}`,
      });
      assert.equal(blocked.status, 409);
      assert.match(blocked.error ?? "", new RegExp(label, "i"));
      db.setPendingApproval(SESSION_ID, null);
      db.updateSessionStatus(SESSION_ID, "idle", Date.now());
    }
    db.updateSessionStatus(SESSION_ID, "completed", Date.now());
    assert.equal(service.invokeSessionCommand(SESSION_ID, {
      ...request,
      submissionId: "blocked-completed",
    }).status, 409);
    db.raw().prepare("UPDATE sessions SET status='idle' WHERE id=?").run(SESSION_ID);

    db.raw().prepare("UPDATE sessions SET status='stopped',agent_capabilities=? WHERE id=?")
      .run(JSON.stringify({ slashCommands: [] }), SESSION_ID);
    db.registerRunner(runnerMeta(), Date.now(), 74);
    const durableRetry = service.invokeSessionCommand(SESSION_ID, request);
    assert.equal(durableRetry.status, 200);
    assert.equal(durableRetry.data?.invocationId, created.data?.invocationId);
    assert.equal(sent.length, 2, "a lost response retry bypasses drifted live authority after exact durable lookup");
  } finally {
    db.close();
  }
});

test("unresolved command receipts are projected independently of the terminal tail", () => {
  const db = harness();
  try {
    const uncertain = invocation("older-uncertain", { now: 10, argumentText: "x".repeat(4_096) });
    db.stageSessionCommandInvocation(uncertain);
    db.markSessionCommandInvocationSent(uncertain.requestId, 11);
    db.recordSessionCommandInvocationReceipt(RUNNER_ID, {
      ...updateReceipt(uncertain, "uncertain", 2),
      error: "delivery is uncertain",
    }, 12);
    for (let index = 0; index < 60; index++) {
      const completed = invocation(`newer-completed-${index}`, { now: 100 + index });
      db.stageSessionCommandInvocation(completed);
      db.raw().prepare(
        "UPDATE session_command_invocations SET state='completed',revision=4,terminal_at=?,updated_at=? WHERE invocation_id=?",
      ).run(100 + index, 100 + index, completed.invocationId);
    }
    const projected = db.getSession(SESSION_ID)?.commandInvocations ?? [];
    assert.equal(projected.filter((item) => item.state === "completed").length, 50);
    const projectedUncertain = projected.find((item) => item.invocationId === uncertain.invocationId);
    assert.equal(projectedUncertain?.state, "uncertain");
    assert.equal(projectedUncertain?.argumentText.length, 512, "session projections bound command argument previews");
  } finally {
    db.close();
  }
});

test("recovery drains beyond one page and maintenance notifies expiry and capability loss", () => {
  const db = harness();
  try {
    const sent: ControlPlaneToRunner[] = [];
    const changed: string[] = [];
    const hub = {
      isRunnerOnline: () => true,
      sendToRunner: (_runnerId: string, message: ControlPlaneToRunner) => {
        sent.push(message);
        return true;
      },
      sessionChangedById: (sessionId: string) => changed.push(sessionId),
    } as unknown as Hub;
    const service = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
    const now = Date.now();
    for (let index = 0; index < 125; index++) {
      db.stageSessionCommandInvocation(invocation(`page-${index}`, {
        expiresAt: now + 60_000,
        now,
      }));
    }
    assert.equal(service.recoverPendingSessionCommands(RUNNER_ID), 125);
    assert.equal(sent.length, 125);
    assert.equal(
      (db.raw().prepare("SELECT COUNT(*) AS count FROM session_command_invocations WHERE state='sent'")
        .get() as { count: number }).count,
      125,
    );

    const expiring = invocation("maintenance-expiry", { expiresAt: now + 1, now });
    db.stageSessionCommandInvocation(expiring);
    changed.length = 0;
    assert.equal(service.maintainSessionCommands(now + 2), 1);
    assert.deepEqual(changed, [SESSION_ID]);
    assert.equal(db.getSessionCommandInvocation(expiring.invocationId)?.state, "rejected");

    const capabilityLoss = invocation("maintenance-capability", { expiresAt: now + 60_000, now });
    db.stageSessionCommandInvocation(capabilityLoss);
    db.registerRunner(runnerMeta(), now + 3, 74);
    changed.length = 0;
    assert.equal(service.recoverPendingSessionCommands(RUNNER_ID), 126);
    assert.ok(changed.includes(SESSION_ID));
    assert.equal(db.getSessionCommandInvocation(capabilityLoss.invocationId)?.state, "rejected");

    assert.ok(db.pruneSessionCommandInvocations(now + 31 * 24 * 60 * 60_000) >= 2);
  } finally {
    db.close();
  }
});

test("connected runners retry due commands with durable capped backoff metadata", () => {
  const db = harness();
  try {
    const sent: ControlPlaneToRunner[] = [];
    const hub = {
      isRunnerOnline: () => true,
      sendToRunner: (_runnerId: string, message: ControlPlaneToRunner) => {
        sent.push(message);
        return true;
      },
      sessionChangedById() {},
    } as unknown as Hub;
    const service = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
    const input = invocation("periodic-retry", { now: 100, expiresAt: 100_000 });
    db.stageSessionCommandInvocation(input);

    assert.equal(service.retryDueSessionCommands(100), 1);
    assert.equal(service.retryDueSessionCommands(349), 0, "the durable backoff suppresses early retries");
    assert.equal(service.retryDueSessionCommands(350), 1);
    assert.equal(service.retryDueSessionCommands(849), 0);
    assert.equal(service.retryDueSessionCommands(850), 1);
    assert.equal(sent.length, 3);
    assert.ok(sent.every((message) => message.type === "invoke_session_command" &&
      message.invocationId === input.invocationId && message.requestId === input.requestId),
    "every retry preserves the exact deduplication identity");
    assert.deepEqual({ ...db.raw().prepare(
      "SELECT attempt_count,next_attempt_at,state FROM session_command_invocations WHERE invocation_id=?",
    ).get(input.invocationId) }, { attempt_count: 3, next_attempt_at: 1_850, state: "sent" });
    assert.equal(db.raw().prepare(
      "SELECT sent_at FROM session_command_invocation_attempts WHERE request_id=?",
    ).get(input.requestId)?.sent_at, 100, "retry metadata preserves the first-delivery audit timestamp");
    assert.equal(db.raw().prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_command_invocations_due'",
    ).get()?.name, "idx_session_command_invocations_due");

    db.raw().prepare(
      "UPDATE session_command_invocations SET attempt_count=99,next_attempt_at=2000 WHERE invocation_id=?",
    ).run(input.invocationId);
    assert.equal(service.retryDueSessionCommands(2_000), 1);
    assert.deepEqual({ ...db.raw().prepare(
      "SELECT attempt_count,next_attempt_at FROM session_command_invocations WHERE invocation_id=?",
    ).get(input.invocationId) }, { attempt_count: 100, next_attempt_at: 32_000 },
    "backoff remains capped at thirty seconds instead of stalling until the 24-hour expiry");

    assert.equal(service.onSessionCommandInvocationReceipt(
      RUNNER_ID,
      resultReceipt(input, "accepted", 1),
    ), true);
    assert.equal(service.retryDueSessionCommands(32_000), 0, "a receipt removes the command from retry eligibility");
  } finally {
    db.close();
  }
});
