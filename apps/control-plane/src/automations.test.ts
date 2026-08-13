import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AutomationSpec,
  CreateSessionRequest,
  CreateWorkflowRunRequest,
  DurableSessionCommand,
  RunnerMetadata,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { PreStagedDeliveryOptions, SessionsService } from "./sessions.js";
import { AutomationsService, validateAutomationSpec } from "./automations.js";
import { signAutomationTrigger } from "./automation-trigger-ingress.js";

function runner(runnerId: string): RunnerMetadata {
  return {
    runnerId,
    hostname: runnerId,
    os: "linux",
    arch: "x64",
    version: "test",
    workspaces: [{ id: "ws-1", name: "Repo", path: `/repos/${runnerId}` }],
    agents: [{
      id: "agent-1", name: "Agent", command: "agent", args: [], env: {}, driver: "acp",
      context: { kind: "native" }, available: true,
    }],
  };
}

function baseSpec(overrides: Partial<AutomationSpec> = {}): AutomationSpec {
  return {
    name: "Every minute",
    cron: "* * * * *",
    timezone: "UTC",
    enabled: true,
    misfirePolicy: { kind: "fire_once" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "wait",
    limits: { maxCostUsd: 1.5, maxToolCalls: 12 },
    notifications: { pushEvents: ["started", "succeeded", "failed", "expired"] },
    action: {
      kind: "create_session",
      request: { runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1", prompt: "Build" },
    },
    ...overrides,
  };
}

function harness(protocolVersion = 53) {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-1"), 1, protocolVersion);
  db.registerRunner(runner("runner-2"), 1, protocolVersion);
  const online = new Set(["runner-1"]);
  const delivered: unknown[] = [];
  const hub = {
    isRunnerOnline: (runnerId: string) => online.has(runnerId),
    sendToRunner: (runnerId: string, message: unknown) => {
      if (!online.has(runnerId)) return false;
      delivered.push(message);
      return true;
    },
    sessionChangedById() {},
  } as unknown as Hub;
  const created: CreateSessionRequest[] = [];
  const prompted: Array<{ id: string; config: unknown }> = [];
  const workflows: CreateWorkflowRunRequest[] = [];
  const failures = { create: false, throwCreate: false, throwAfterStage: false };
  const recoveredSnapshots: DurableSessionCommand[][] = [];
  let nextSession = 1;
  const sessions = {
    createSession(request: CreateSessionRequest, delivery?: PreStagedDeliveryOptions) {
      created.push(request);
      if (delivery?.commandSnapshots) recoveredSnapshots.push(delivery.commandSnapshots);
      if (failures.throwCreate) throw new Error("sensitive simulated exception");
      if (failures.create) return { ok: false, status: 409, error: "simulated launch rejection" };
      const id = delivery?.sessionId ?? `auto-session-${nextSession++}`;
      const plan = delivery ? {
        runnerId: request.runnerId,
        sessionId: id,
        commands: [{ type: "start_session" as const, spec: { sessionId: id } as never }],
      } : undefined;
      if (plan) delivery!.stage(plan);
      if (failures.throwAfterStage) throw new Error("simulated crash after staging");
      db.createSession({
        id, runnerId: request.runnerId, workspaceId: request.workspaceId, agentId: request.agentId,
        title: request.title ?? "Automation", useWorktree: request.useWorktree ?? false,
        driver: "acp", config: request.config ?? {}, now: 100,
      });
      db.updateSessionStatus(id, "starting", 101);
      if (plan) delivery!.activate(plan);
      return { ok: true, status: 201, data: db.getSession(id)! };
    },
    prompt(id: string, text: string, _images: unknown[], slashCommand: string | undefined, config: unknown,
      delivery?: PreStagedDeliveryOptions) {
      prompted.push({ id, config });
      const session = db.getSession(id)!;
      const plan = delivery ? {
        runnerId: session.runnerId,
        sessionId: id,
        commands: [{ type: "prompt_session" as const, sessionId: id, text,
          ...(slashCommand ? { slashCommand } : {}), config: config as never }],
      } : undefined;
      if (plan) delivery!.stage(plan);
      db.updateSessionStatus(id, "running", 101);
      if (plan) delivery!.activate(plan);
      return { ok: true, status: 200, data: db.getSession(id)! };
    },
    createWorkflowRun(request: CreateWorkflowRunRequest, _actor: unknown, delivery?: PreStagedDeliveryOptions) {
      workflows.push(request);
      const runId = delivery?.runId ?? "run-auto";
      const instanceId = delivery?.workflowInstanceId ?? "instance-auto";
      const memberIds = delivery
        ? [delivery.memberSessionId?.(0) ?? "workflow-session-0", delivery.memberSessionId?.(1) ?? "workflow-session-1"]
        : ["workflow-session-0", "workflow-session-1"];
      const plan = delivery ? {
        runnerId: request.runnerId,
        runId,
        workflowInstanceId: instanceId,
        commands: memberIds.map((memberId) => (
          { type: "start_session" as const, spec: { sessionId: memberId } as never }
        )),
      } : undefined;
      if (plan) delivery!.stage(plan);
      if (plan) delivery!.activate(plan);
      return {
        ok: true,
        status: 201,
        data: {
          run: { id: runId, title: "Run", prompt: request.task, workspaceId: request.workspaceId,
            workspaceName: "Repo", createdAt: 100, updatedAt: 100, sessionIds: [] },
          sessions: [],
          instance: { instanceId, workflowId: request.workflowId, workflowVersion: 1,
            runId, status: "running", transitionCount: 0, nodeStates: [],
            createdBy: { kind: "system", id: "test" }, createdAt: 100, updatedAt: 100,
            definition: { workflowId: request.workflowId, version: 1, name: "Workflow", maxTransitions: 1,
              nodes: [], edges: [], source: "custom", createdBy: { kind: "system", id: "test" }, createdAt: 100 },
            attempts: [], events: [] },
        },
      };
    },
  } as unknown as SessionsService;
  const notifications: string[] = [];
  const service = new AutomationsService(db, hub, sessions, { info() {}, warn() {} },
    (_automation, execution, event) => notifications.push(`${execution.executionId}:${event}`));
  return { db, online, service, created, prompted, workflows, notifications, failures, delivered, recoveredSnapshots };
}

function receiveSignedTrigger(
  service: AutomationsService,
  triggerId: string,
  secret: string,
  body: Buffer,
  now: number,
) {
  const timestamp = String(Math.floor(now / 1_000));
  const nonce = `nonce_${String(now).padStart(10, "0")}`;
  return service.receiveTrigger(triggerId, {
    timestamp,
    nonce,
    signature: signAutomationTrigger(secret, triggerId, timestamp, nonce, body),
  }, body, now);
}

test("signed webhook triggers are one-time-secret, idempotent, cron-independent, and rotation-safe", () => {
  const { db, service, created } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  const credential = service.createTrigger(automation.automationId,
    { kind: "webhook", name: "Deploy hook" }, { kind: "human", id: "device" }, 1_000).data!;
  assert.match(credential.secret, /^wollipogwhsec_[A-Za-z0-9_-]{43}$/);
  assert.equal("secret" in service.triggers(automation.automationId).data!.triggers[0]!, false);

  const body = Buffer.from('{"eventId":"delivery-1"}');
  const invoked = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret, body, 2_000);
  assert.equal(invoked.status, 200);
  assert.equal(invoked.data?.invocation.state, "dispatched");
  assert.deepEqual(Object.keys(invoked.data!.invocation).sort(),
    ["eventId", "executionId", "invocationId", "receivedAt", "state", "triggerId", "updatedAt"],
  "the ingress response must not expose the accepted spec, body digest, revision, or sender hash");
  assert.equal(created.length, 1);
  assert.equal(db.getAutomation(automation.automationId)?.nextFireAt, 60_000,
    "out-of-band dispatch must not advance the cron cursor");

  const replay = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret, body, 2_100);
  assert.equal(replay.data?.duplicate, true);
  assert.equal(replay.data?.invocation.executionId, invoked.data?.invocation.executionId);
  assert.equal(created.length, 1, "a replayed event id must not materialize a second action");
  const conflict = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId": "delivery-1"}'), 2_200);
  assert.equal(conflict.status, 409);

  service.update(automation.automationId, baseSpec({ enabled: false }),
    { kind: "human", id: "device" }, 2_300);
  const pausedReplay = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret, body, 2_400);
  assert.equal(pausedReplay.status, 200);
  assert.equal(pausedReplay.data?.duplicate, true,
    "the master pause blocks new event ids without hiding an existing durable receipt");
  service.update(automation.automationId, baseSpec(), { kind: "human", id: "device" }, 2_500);

  const rotated = service.rotateTrigger(automation.automationId, credential.trigger.triggerId,
    { kind: "human", id: "device" }, 3_000).data!;
  assert.match(rotated.secret, /^wollipogwhsec_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated.secret, credential.secret);
  assert.equal(receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId":"delivery-old"}'), 3_100).status, 401);
  assert.equal(receiveSignedTrigger(service, credential.trigger.triggerId, rotated.secret,
    Buffer.from('{"eventId":"delivery-2"}'), 3_200).status, 202,
  "concurrency-wait keeps a second valid delivery durably pending");
  assert.doesNotMatch(JSON.stringify(db.listAutomationEvents(automation.automationId)), new RegExp(credential.secret));
  assert.doesNotMatch(JSON.stringify(db.raw().prepare("SELECT * FROM automation_trigger_invocations").all()),
    /delivery-old|(?:mam|wollipog)whsec_/);
});

test("persisted legacy trigger secrets remain valid until rotation", () => {
  const { db, service } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  const credential = service.createTrigger(automation.automationId,
    { kind: "webhook", name: "Legacy hook" }, { kind: "human", id: "device" }, 1_000).data!;
  const legacySecret = `mamwhsec_${"A".repeat(43)}`;
  db.raw().prepare("UPDATE automation_triggers SET secret_key=? WHERE trigger_id=?")
    .run(legacySecret, credential.trigger.triggerId);

  assert.equal(receiveSignedTrigger(service, credential.trigger.triggerId, legacySecret,
    Buffer.from('{"eventId":"legacy-delivery"}'), 2_000).status, 200);

  const rotated = service.rotateTrigger(automation.automationId, credential.trigger.triggerId,
    { kind: "human", id: "device" }, 3_000).data!;
  assert.match(rotated.secret, /^wollipogwhsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(receiveSignedTrigger(service, credential.trigger.triggerId, legacySecret,
    Buffer.from('{"eventId":"retired-legacy-secret"}'), 3_100).status, 401);
});

test("compacted invocation detail preserves exact receipts and lifetime trigger counters", () => {
  const { db, service } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  const credential = service.createTrigger(automation.automationId,
    { kind: "webhook", name: "Retention hook" }, { kind: "human", id: "device" }, 1_000).data!;
  const body = Buffer.from('{"eventId":"retained-1"}');
  const first = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret, body, 2_000);
  assert.equal(first.data?.invocation.state, "dispatched");
  assert.equal(db.compactAutomationTriggerInvocations(31 * 24 * 60 * 60 * 1_000), 1);
  const tombstone = db.getAutomationTriggerInvocation(first.data!.invocation.invocationId)!;
  assert.equal(tombstone.specJson, "{}");
  assert.equal(tombstone.senderHash, undefined);

  const lateReplay = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    body, 31 * 24 * 60 * 60 * 1_000 + 1_000);
  assert.equal(lateReplay.status, 200);
  assert.equal(lateReplay.data?.duplicate, true);
  assert.equal(lateReplay.data?.invocation.invocationId, first.data?.invocation.invocationId);
  assert.equal(lateReplay.data?.invocation.executionId, first.data?.invocation.executionId);
  assert.equal(receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId": "retained-1"}'), 31 * 24 * 60 * 60 * 1_000 + 2_000).status, 409,
  "a compact receipt must retain the exact body fingerprint for conflict detection");
  assert.equal(db.pendingAutomationTriggerInvocations().length, 0,
    "a retained execution key must reject rather than strand a fresh pending invocation");
  assert.equal(db.listAutomationExecutions(automation.automationId).length, 1);
  const trigger = service.triggers(automation.automationId).data!.triggers[0]!;
  assert.equal(trigger.invocationCount, 1);
  assert.equal(trigger.lastInvokedAt, 2_000);
});

test("chat-ops retains only a sender hash and pause or revoke rejects pending work", () => {
  const { db, online, service } = harness();
  online.clear();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  const credential = service.createTrigger(automation.automationId,
    { kind: "chatops", name: "Release command" }, { kind: "human", id: "device" }, 1_000).data!;
  const body = Buffer.from('{"eventId":"slack:42","command":"run","sender":"person@example.com"}');
  const pending = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret, body, 2_000);
  assert.equal(pending.status, 202);
  assert.equal(pending.data?.invocation.state, "pending");
  assert.equal(JSON.stringify(pending).includes("person@example.com"), false);
  const stored = db.getAutomationTriggerInvocation(pending.data!.invocation.invocationId)!;
  assert.match(stored.senderHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(stored.senderHash?.includes("person@example.com"), false);
  assert.doesNotMatch(JSON.stringify(db.listAutomationEvents(automation.automationId)), /person@example\.com/);

  service.update(automation.automationId, baseSpec({ enabled: false }),
    { kind: "human", id: "device" }, 3_000);
  assert.equal(db.getAutomationTriggerInvocation(stored.invocationId)?.state, "rejected",
    "pause must terminalize accepted work in the same transaction");
  assert.equal(db.getAutomationTriggerInvocation(stored.invocationId)?.specJson, "{}");
  service.update(automation.automationId, baseSpec(), { kind: "human", id: "device" }, 4_000);
  online.add("runner-1");
  service.recover(5_000);
  assert.equal(db.listAutomationExecutions(automation.automationId).length, 0,
    "re-enable must not resurrect work rejected by the master pause");
  const rejectedReplay = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    body, 5_500);
  assert.equal(rejectedReplay.status, 200);
  assert.equal(rejectedReplay.data?.duplicate, true);
  assert.equal(rejectedReplay.data?.invocation.state, "rejected");
  assert.equal(db.listAutomationExecutions(automation.automationId).length, 0);
  assert.equal(db.compactAutomationTriggerInvocations(31 * 24 * 60 * 60 * 1_000), 0,
    "pre-claim rejection already stores only the compact tombstone");
  const lateRejectedReplay = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    body, 31 * 24 * 60 * 60 * 1_000 + 1_000);
  assert.equal(lateRejectedReplay.status, 200);
  assert.equal(lateRejectedReplay.data?.duplicate, true);
  assert.equal(lateRejectedReplay.data?.invocation.invocationId, stored.invocationId);

  online.clear();
  const second = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId":"slack:43","command":"run","sender":"another actor"}'), 6_000);
  assert.equal(second.data?.invocation.state, "pending");
  assert.equal(service.deleteTrigger(automation.automationId, credential.trigger.triggerId,
    { kind: "human", id: "device" }, 7_000).ok, true);
  assert.equal(db.getAutomationTriggerInvocation(second.data!.invocation.invocationId)?.state, "rejected");
  assert.equal(receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId":"slack:44","command":"run","sender":"actor"}'), 8_000).status, 401);
});

test("trigger concurrency wait drains after settlement while skip records one terminal receipt", () => {
  {
    const { db, service, created } = harness();
    const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
    const credential = service.createTrigger(automation.automationId,
      { kind: "webhook", name: "Wait hook" }, { kind: "human", id: "device" }, 1_000).data!;
    const first = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
      Buffer.from('{"eventId":"wait-1"}'), 2_000);
    const second = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
      Buffer.from('{"eventId":"wait-2"}'), 3_000);
    assert.equal(first.data?.invocation.state, "dispatched");
    assert.equal(second.data?.invocation.state, "pending");
    db.settleAutomationExecution({ executionId: first.data!.invocation.executionId!, status: "succeeded",
      actor: { kind: "system", id: "test" }, now: 4_000 });
    service.recover(5_000);
    assert.equal(db.getAutomationTriggerInvocation(second.data!.invocation.invocationId)?.state, "dispatched");
    assert.equal(created.length, 2);
  }
  {
    const { db, service, created } = harness();
    const automation = service.create(baseSpec({ concurrencyPolicy: "skip" }),
      { kind: "human", id: "device" }, 0).data!;
    const credential = service.createTrigger(automation.automationId,
      { kind: "webhook", name: "Skip hook" }, { kind: "human", id: "device" }, 1_000).data!;
    receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
      Buffer.from('{"eventId":"skip-1"}'), 2_000);
    const skipped = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
      Buffer.from('{"eventId":"skip-2"}'), 3_000);
    assert.equal(skipped.data?.invocation.state, "skipped");
    assert.equal(db.getAutomationExecution(skipped.data!.invocation.executionId!)?.status, "skipped");
    assert.equal(created.length, 1);
  }
});

test("pending trigger invocations retain their accepted revision across edits and resume after restart", () => {
  const { db, online, service, created } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  const credential = service.createTrigger(automation.automationId,
    { kind: "webhook", name: "Restart hook" }, { kind: "human", id: "device" }, 1_000).data!;
  online.clear();
  const pending = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId":"pending-1"}'), 2_000);
  assert.equal(pending.status, 202);
  assert.equal(pending.data?.invocation.state, "pending");
  assert.equal(created.length, 0);

  service.update(automation.automationId, baseSpec({
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1", prompt: "Changed after acceptance",
    } },
  }), { kind: "human", id: "device" }, 3_000);
  assert.equal(db.compactAutomationTriggerInvocations(31 * 24 * 60 * 60 * 1_000), 0,
    "retention must never scrub an action snapshot that is still pending");
  assert.notEqual(db.getAutomationTriggerInvocation(pending.data!.invocation.invocationId)?.specJson, "{}");
  online.add("runner-1");
  service.recover(31 * 24 * 60 * 60 * 1_000 + 1);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.prompt, "Build", "accepted trigger work must use its secret-free revision snapshot");
  const stored = db.getAutomationTriggerInvocation(pending.data!.invocation.invocationId)!;
  assert.equal(stored.state, "dispatched");
  assert.equal(stored.automationRevision, 1);
});

test("trigger inbox bounds traffic and expires same-millisecond offline deliveries without collisions", () => {
  const { db, online, service } = harness();
  online.clear();
  const automation = service.create(baseSpec({ runnerPolicy: { kind: "expire", afterMinutes: 1 } }),
    { kind: "human", id: "device" }, 0).data!;
  const credential = service.createTrigger(automation.automationId,
    { kind: "webhook", name: "Bounded hook" }, { kind: "human", id: "device" }, 1_000).data!;
  for (let index = 0; index < 30; index += 1) {
    const result = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
      Buffer.from(`{"eventId":"burst-${index}"}`), 10_000);
    assert.equal(result.status, 202);
  }
  assert.equal(receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId":"burst-30"}'), 10_000).status, 429);
  const replay = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId":"burst-0"}'), 10_000);
  assert.equal(replay.data?.duplicate, true, "verified duplicates bypass the new-delivery rate bound");

  service.recover(70_001);
  const executions = db.listAutomationExecutions(automation.automationId, 100);
  assert.equal(executions.length, 30);
  assert.equal(executions.every((execution) => execution.status === "expired"), true);
  assert.equal(new Set(executions.map((execution) => execution.scheduledFor)).size, 30,
    "same-millisecond trigger events must coexist with the scheduler uniqueness constraint");
  assert.equal(db.getAutomation(automation.automationId)?.nextFireAt, 60_000);
});

test("automation validation is strict, finite-ceiling, image-free, and fail-closed for prompt alternates", () => {
  assert.equal(validateAutomationSpec(baseSpec()).ok, true);
  assert.equal(validateAutomationSpec(baseSpec({
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "ws-1", projectId: "project-1",
      projectLocationId: "location-1", agentId: "agent-1",
    } },
  })).ok, true);
  assert.match(validateAutomationSpec(baseSpec({
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "ws-1", projectId: "project-1", agentId: "agent-1",
    } },
  })).error ?? "", /Project|project/i);
  assert.match(validateAutomationSpec(baseSpec({
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "ws-1", projectId: "project-1",
      projectLocationId: "location-1", agentId: "agent-1",
    } },
    runnerPolicy: { kind: "alternate", targets: [{
      runnerId: "runner-2", workspaceId: "ws-1", projectId: "project-2",
      projectLocationId: "location-2", agentId: "agent-1",
    }] },
  })).error ?? "", /preserve.*Project/i);
  assert.match(validateAutomationSpec(baseSpec({
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1",
    } },
    runnerPolicy: { kind: "alternate", targets: [{
      runnerId: "runner-2", workspaceId: "ws-1", projectId: "project-2",
      projectLocationId: "location-2", agentId: "agent-1",
    }] },
  })).error ?? "", /preserve.*Project/i);
  assert.match(validateAutomationSpec(baseSpec({ limits: { maxCostUsd: 0, maxToolCalls: 1 } })).error ?? "", /finite positive/);
  assert.match(validateAutomationSpec(baseSpec({
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1",
      images: [{ mimeType: "image/png", data: "AA==" }],
    } },
  })).error ?? "", /cannot persist images/);
  assert.match(validateAutomationSpec(baseSpec({
    action: { kind: "prompt_session", sessionId: "s-1", request: { text: "continue" } },
    runnerPolicy: { kind: "alternate", targets: [{ runnerId: "runner-2", workspaceId: "ws-1" }] },
  })).error ?? "", /cannot move provider state/);
  assert.match(validateAutomationSpec({ ...baseSpec(), extra: true }).error ?? "", /malformed/);
  assert.match(validateAutomationSpec(baseSpec({
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1",
      acpSessionContext: { mcpServers: [] },
    } },
  })).error ?? "", /secret-free/);
  assert.match(validateAutomationSpec(baseSpec({
    action: { kind: "prompt_session", sessionId: "s-1", request: { text: "", slashCommand: "" } },
  })).error ?? "", /text or slash command/);
});

test("calendar-impossible cron schedules fail cleanly before create or update", () => {
  const { db, service } = harness();
  const actor = { kind: "human" as const, id: "device" };
  const impossible = baseSpec({ cron: "0 0 30 2 *" });

  const created = service.create(impossible, actor, 0);
  assert.equal(created.ok, false);
  assert.equal(created.status, 400);
  assert.match(created.error ?? "", /no fire time within five years/);
  assert.equal(service.list().automations.length, 0);

  const existing = service.create(baseSpec(), actor, 0).data!;
  const updated = service.update(existing.automationId, impossible, actor, 0);
  assert.equal(updated.ok, false);
  assert.equal(updated.status, 400);
  assert.match(updated.error ?? "", /no fire time within five years/);
  assert.equal(db.getAutomation(existing.automationId)?.cron, "* * * * *");
});

test("a due create-session occurrence claims once, applies ceilings, and reconciles to success", () => {
  const { db, service, created, notifications } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device-1" }, 0).data!;
  assert.equal(automation.nextFireAt, 60_000);
  assert.equal(service.tick(60_000), 1);
  assert.equal(service.tick(60_000), 0, "the next-fire CAS prevents a duplicate tick");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.config?.costBudgetUsd, 1.5);
  assert.equal(created[0]?.config?.maxToolCalls, 12);
  const running = db.listAutomationExecutions(automation.automationId)[0]!;
  assert.equal(running.status, "dispatching");
  assert.equal(running.commands?.[0]?.state, "sent");
  assert.equal(notifications.length, 0, "socket send is not a started notification");
  const command = running.commands![0]!;
  service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "started", revision: 2,
  }, 60_500);
  assert.equal(db.getAutomationExecution(running.executionId)?.status, "running");
  assert.equal(notifications.at(-1)?.endsWith(":started"), true);
  service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "completed", revision: 3,
  }, 60_750);
  const dueAutomationCommands = db.dueAutomationCommands.bind(db);
  let replayOutboxScans = 0;
  db.dueAutomationCommands = (now, runnerId, limit) => {
    replayOutboxScans += 1;
    return dueAutomationCommands(now, runnerId, limit);
  };
  assert.equal(service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "completed", revision: 3,
  }, 60_800), true, "a replayed terminal receipt remains recognized");
  assert.equal(replayOutboxScans, 0, "a no-op replay must not trigger another outbox scan");
  db.updateSessionStatus(running.sessionId!, "idle", 61_000);
  service.tick(61_000);
  assert.equal(db.getAutomationExecution(running.executionId)?.status, "succeeded");
  assert.equal(notifications.at(-1)?.endsWith(":succeeded"), true);
});

test("runner wait, bounded expiry, and explicit alternate target policies are durable", () => {
  const { db, online, service, created, notifications } = harness();
  online.clear();
  const expiring = service.create(baseSpec({ runnerPolicy: { kind: "expire", afterMinutes: 1 } }),
    { kind: "human", id: "device" }, 0).data!;
  assert.equal(service.tick(60_000), 0);
  assert.equal(db.listAutomationExecutions(expiring.automationId).length, 0, "offline wait is safe to retry because nothing was sent");
  assert.equal(service.tick(120_000), 1);
  assert.equal(db.listAutomationExecutions(expiring.automationId)[0]?.status, "expired");
  assert.equal(notifications.at(-1)?.endsWith(":expired"), true);

  online.add("runner-2");
  const alternate = service.create(baseSpec({
    runnerPolicy: {
      kind: "alternate",
      targets: [{ runnerId: "runner-2", workspaceId: "ws-1", agentId: "agent-1" }],
    },
  }), { kind: "human", id: "device" }, 0).data!;
  assert.equal(service.tick(60_000), 1);
  assert.equal(created.at(-1)?.runnerId, "runner-2");
  assert.equal(db.listAutomationExecutions(alternate.automationId)[0]?.runnerId, "runner-2");
});

test("alternate automation actions preserve exact team Project identity for sessions and workflows", () => {
  const { db, online, service, created, workflows } = harness();
  const primaryLocation = db.findProjectLocation("runner-1", "ws-1")!;
  const alternateLocation = db.findProjectLocation("runner-2", "ws-1")!;
  db.moveProjectLocation(alternateLocation.id, primaryLocation.projectId, 2);
  const local = db.localIdentityContext();
  db.createIdentityTeam({
    teamId: "team-automation",
    organizationId: local.organizationId,
    name: "Automation Team",
    memberUserIds: [local.userId],
    now: 3,
  });
  assert.equal(db.setResourceScope({
    resource: "project",
    resourceId: primaryLocation.projectId,
    scope: { organizationId: local.organizationId, owner: { kind: "team", teamId: "team-automation" } },
    now: 4,
  }), true);
  assert.equal(db.projectScope(primaryLocation.projectId)?.owner.kind, "team");
  online.clear();
  online.add("runner-2");

  const createAutomation = service.create(baseSpec({
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "ws-1", projectId: primaryLocation.projectId,
      projectLocationId: primaryLocation.id, agentId: "agent-1", prompt: "Build",
    } },
    runnerPolicy: { kind: "alternate", targets: [{
      runnerId: "runner-2", workspaceId: "ws-1", projectId: primaryLocation.projectId,
      projectLocationId: alternateLocation.id, agentId: "agent-1",
    }] },
  }), { kind: "human", id: "device" }, 0).data!;
  assert.equal(service.tick(60_000), 1);
  assert.equal(created.at(-1)?.runnerId, "runner-2");
  assert.equal(created.at(-1)?.projectId, primaryLocation.projectId);
  assert.equal(created.at(-1)?.projectLocationId, alternateLocation.id);
  assert.equal(db.listAutomationExecutions(createAutomation.automationId)[0]?.runnerId, "runner-2");

  const workflowAutomation = service.create(baseSpec({
    action: { kind: "workflow_run", request: {
      runnerId: "runner-1", workspaceId: "ws-1", projectId: primaryLocation.projectId,
      projectLocationId: primaryLocation.id, workflowId: "workflow-1", task: "Review",
      agentBindings: { worker: "agent-1" },
    } },
    runnerPolicy: { kind: "alternate", targets: [{
      runnerId: "runner-2", workspaceId: "ws-1", projectId: primaryLocation.projectId,
      projectLocationId: alternateLocation.id, agentBindings: { worker: "agent-1" },
    }] },
  }), { kind: "human", id: "device" }, 0).data!;
  assert.equal(service.tick(60_000), 1);
  assert.equal(workflows.at(-1)?.runnerId, "runner-2");
  assert.equal(workflows.at(-1)?.projectId, primaryLocation.projectId);
  assert.equal(workflows.at(-1)?.projectLocationId, alternateLocation.id);
  assert.equal(db.listAutomationExecutions(workflowAutomation.automationId)[0]?.runnerId, "runner-2");
});

test("misfire, concurrency, prompt ceilings, workflow links, and restart uncertainty stay explicit", () => {
  const { db, service, prompted, workflows } = harness();
  const skipped = service.create(baseSpec({ misfirePolicy: { kind: "skip" } }),
    { kind: "human", id: "device" }, 0).data!;
  assert.equal(service.tick(5 * 60_000), 1);
  assert.equal(db.listAutomationExecutions(skipped.automationId)[0]?.status, "skipped");

  db.createSession({
    id: "existing", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1", title: "Existing",
    useWorktree: false, driver: "acp", config: {}, now: 0,
  });
  db.updateSessionStatus("existing", "idle", 1);
  db.addSessionUsage("existing", { inputTokens: 10, outputTokens: 20, costUsd: 3.25 }, 1);
  const prompt = service.create(baseSpec({
    action: { kind: "prompt_session", sessionId: "existing", request: { text: "continue" } },
  }), { kind: "human", id: "device" }, 0).data!;
  service.tick(60_000);
  assert.equal(prompted.length, 1);
  assert.deepEqual(prompted[0]?.config, { costBudgetUsd: 4.75, maxToolCalls: 12 });
  assert.equal(db.listAutomationExecutions(prompt.automationId)[0]?.sessionId, "existing");

  const workflow = service.create(baseSpec({
    action: { kind: "workflow_run", request: {
      runnerId: "runner-1", workspaceId: "ws-1", workflowId: "build-review", task: "Ship",
    } },
  }), { kind: "human", id: "device" }, 0).data!;
  service.tick(60_000);
  assert.equal(workflows[0]?.costBudgetUsd, 1.5);
  assert.equal(workflows[0]?.maxToolCalls, 12);
  assert.match(db.listAutomationExecutions(workflow.automationId)[0]?.workflowInstanceId ?? "", /^wfi_auto_axe_/);

  const uncertain = db.claimAutomationExecution({
    executionId: "uncertain", automationId: workflow.automationId,
    expectedNextFireAt: 120_000, scheduledFor: 120_000, nextFireAt: 180_000,
    actionKind: "workflow_run", status: "dispatching",
    actor: { kind: "system", id: "automation:test" }, now: 120_000,
  });
  assert.ok(uncertain);
  assert.equal(service.recover(121_000), 1);
  assert.match(db.getAutomationExecution("uncertain")?.error ?? "", /delivery uncertain.*not replayed/);
});

test("catch-up is batch-bounded while wait and skip concurrency remain explicit", () => {
  {
    const { db, service, created } = harness();
    const catchUp = service.create(baseSpec({
      misfirePolicy: { kind: "catch_up", maxRuns: 2 },
      concurrencyPolicy: "parallel",
    }), { kind: "human", id: "device" }, 0).data!;
    assert.equal(service.tick(5 * 60_000), 2);
    assert.equal(created.length, 2);
    assert.equal(db.getAutomation(catchUp.automationId)?.nextFireAt, 3 * 60_000,
      "a bounded batch leaves the remaining backlog durable for the next tick");
  }
  {
    const { db, service } = harness();
    const waiting = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
    assert.equal(service.tick(60_000), 1);
    assert.equal(service.tick(120_000), 0);
    assert.equal(db.getAutomation(waiting.automationId)?.nextFireAt, 120_000,
      "wait policy does not consume an occurrence while the previous run is active");

    const skipped = service.update(waiting.automationId, {
      ...baseSpec(), concurrencyPolicy: "skip",
    }, { kind: "human", id: "device" }, 60_001).data!;
    assert.equal(skipped.revision, 2);
    assert.equal(service.tick(120_000), 1);
    assert.equal(db.listAutomationExecutions(waiting.automationId)[0]?.status, "skipped");
  }
});

test("prompt actions remain unclaimed until their existing provider session is idle", () => {
  const { db, service, prompted } = harness();
  db.createSession({
    id: "busy", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1", title: "Busy",
    useWorktree: false, driver: "acp", config: {}, now: 0,
  });
  db.updateSessionStatus("busy", "running", 1);
  const automation = service.create(baseSpec({
    action: { kind: "prompt_session", sessionId: "busy", request: { text: "continue" } },
  }), { kind: "human", id: "device" }, 0).data!;
  assert.equal(service.tick(60_000), 0);
  assert.equal(db.listAutomationExecutions(automation.automationId).length, 0);
  db.updateSessionStatus("busy", "idle", 60_001);
  assert.equal(service.tick(60_001), 1);
  assert.equal(prompted.length, 1);
});

test("edits, pause, deletion, failed actions, and stricter prompt guardrails are durable", () => {
  const { db, service, prompted, failures, notifications } = harness();
  const paused = service.create(baseSpec({ enabled: false }), { kind: "human", id: "device" }, 0).data!;
  assert.equal(paused.nextFireAt, undefined);
  assert.equal(service.tick(60_000), 0);
  const enabled = service.update(paused.automationId, baseSpec(), { kind: "human", id: "device" }, 0).data!;
  assert.equal(enabled.revision, 2);
  assert.equal(enabled.nextFireAt, 60_000);

  failures.create = true;
  assert.equal(service.tick(60_000), 1);
  const failed = db.listAutomationExecutions(paused.automationId)[0]!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /simulated launch rejection/);
  assert.equal(notifications.at(-1), `${failed.executionId}:failed`);
  assert.equal(service.delete(paused.automationId, { kind: "human", id: "device" }, 70_000).ok, true);
  assert.equal(service.get(paused.automationId).status, 404);
  assert.equal(db.listAutomationExecutions(paused.automationId).length, 1,
    "soft deletion keeps immutable execution history");

  failures.create = false;
  failures.throwCreate = true;
  const throwing = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  assert.doesNotThrow(() => service.tick(60_000));
  assert.equal(db.listAutomationExecutions(throwing.automationId)[0]?.status, "failed");
  assert.doesNotMatch(db.listAutomationExecutions(throwing.automationId)[0]?.error ?? "", /sensitive/);
  failures.throwCreate = false;

  db.createSession({
    id: "guarded", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1", title: "Guarded",
    useWorktree: false, driver: "acp", config: { costBudgetUsd: 3.5, maxToolCalls: 5 }, now: 0,
  });
  db.updateSessionStatus("guarded", "idle", 0);
  db.updateSessionCostBudget("guarded", 3.5, 0);
  db.updateSessionMaxToolCalls("guarded", 5, 0);
  db.addSessionUsage("guarded", { inputTokens: 1, outputTokens: 1, costUsd: 3.25 }, 1);
  const prompt = service.create(baseSpec({
    action: { kind: "prompt_session", sessionId: "guarded", request: { text: "continue" } },
  }), { kind: "human", id: "device" }, 0).data!;
  service.tick(60_000);
  assert.deepEqual(prompted.at(-1)?.config, { costBudgetUsd: 3.5, maxToolCalls: 5 },
    "an automation may tighten but never widen existing guardrails");

  db.updateSessionCostBudget("guarded", 3.25, 61_000);
  db.updateSessionStatus("guarded", "idle", 61_000);
  const exhausted = service.create(baseSpec({
    action: { kind: "prompt_session", sessionId: "guarded", request: { text: "again" } },
  }), { kind: "human", id: "device" }, 0).data!;
  service.tick(61_000);
  assert.equal(db.listAutomationExecutions(exhausted.automationId)[0]?.status, "failed");
  assert.match(db.listAutomationExecutions(exhausted.automationId)[0]?.error ?? "", /exhausted a stricter guardrail/);
  assert.equal(prompted.length, 1);
  assert.equal(prompt.automationId.length > 0, true);
});

test("sent commands retry with the same id while receipted recovery preserves them and fails legacy dispatches", () => {
  const { db, service, delivered } = harness();
  const actor = { kind: "human" as const, id: "device" };
  const receipted = service.create(baseSpec(), actor, 0).data!;

  assert.equal(service.tick(60_000), 1);
  const receiptedExecution = db.listAutomationExecutions(receipted.automationId)[0]!;
  const command = receiptedExecution.commands![0]!;
  const firstDelivery = delivered[0] as { type: string; commandId: string; requestId: string };
  assert.equal(firstDelivery.type, "durable_session_command");
  assert.equal(firstDelivery.commandId, command.commandId);
  assert.equal(receiptedExecution.status, "dispatching", "a successful socket write is not a runner receipt");
  assert.equal(command.state, "sent");
  assert.equal(command.attemptCount, 1);

  const legacy = service.create(baseSpec({ name: "Legacy dispatch" }), actor, 0).data!;
  assert.ok(db.claimAutomationExecution({
    executionId: "legacy-dispatch", automationId: legacy.automationId,
    expectedNextFireAt: 60_000, scheduledFor: 60_000, nextFireAt: 120_000,
    actionKind: "create_session", status: "dispatching",
    actor: { kind: "system", id: "automation:test" }, now: 60_000,
  }));
  assert.equal(service.recover(60_249), 1, "legacy at-most-once dispatch remains fail-closed after restart");
  assert.equal(delivered.length, 1, "the retry backoff is durable");
  assert.equal(db.getAutomationExecution("legacy-dispatch")?.status, "failed");
  assert.match(db.getAutomationExecution("legacy-dispatch")?.error ?? "", /delivery uncertain.*not replayed/);
  assert.equal(db.getAutomationExecution(receiptedExecution.executionId)?.status, "dispatching");

  assert.equal(service.recover(60_250), 0);
  assert.equal(delivered.length, 2);
  const retry = delivered[1] as { type: string; commandId: string; requestId: string };
  assert.equal(retry.commandId, firstDelivery.commandId, "retries preserve the idempotency key");
  assert.notEqual(retry.requestId, firstDelivery.requestId, "each transport attempt has its own correlation id");
  assert.equal(db.getAutomationExecution(receiptedExecution.executionId)?.status, "dispatching");
  assert.equal(db.listAutomationCommands(receiptedExecution.executionId)[0]?.attemptCount, 2);
});

test("receipted recovery passes the exact persisted command snapshot back to materialization", () => {
  const { db, service, failures, recoveredSnapshots } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  failures.throwAfterStage = true;
  assert.equal(service.tick(60_000), 1);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  const records = db.listAutomationCommands(execution.executionId);
  assert.equal(execution.status, "dispatching");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, "staged");

  const changed = runner("runner-1");
  changed.agents[0]!.command = "agent-v2";
  changed.agents[0]!.args = ["--new-launch-contract"];
  changed.agents[0]!.env = { CHANGED: "yes" };
  db.registerRunner(changed, 60_100, 53);
  failures.throwAfterStage = false;

  assert.equal(service.recover(60_250), 0);
  assert.equal(recoveredSnapshots.length, 1);
  assert.deepEqual(recoveredSnapshots[0], records.map((record) => JSON.parse(record.payloadJson)),
    "recovery must use the durable payload instead of rebuilding from current runner metadata");
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "sent");
});

test("wrong-runner, wrong-session, malformed, and stale receipts cannot mutate a receipted execution", () => {
  const { db, service, delivered } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  const command = execution.commands![0]!;

  assert.equal(service.onDurableCommandReceipt("runner-2", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "started", revision: 2,
  }, 60_100), false);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "dispatching");
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "sent");

  assert.equal(service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: "crossed-session", state: "started", revision: 2,
  }, 60_125), false);
  assert.equal(service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "bogus", revision: 2,
  } as never, 60_150), false);
  assert.equal(service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_result", requestId: "unknown-attempt",
    commandId: command.commandId, sessionId: command.sessionId,
    state: "accepted", revision: 1, duplicate: false,
  }, 60_175), false);
  assert.equal((delivered[0] as { requestId: string }).requestId.length > 0, true);

  assert.equal(service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "started", revision: 2,
  }, 60_200), true);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "running");
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "started");

  assert.equal(service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "accepted", revision: 1,
  }, 60_300), true);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "running");
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "started");
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.revision, 2);
});

test("a workflow command rejection terminalizes siblings before any retry can launch them", () => {
  const { db, service, delivered } = harness();
  const automation = service.create(baseSpec({
    action: { kind: "workflow_run", request: {
      workflowId: "wf-1", runnerId: "runner-1", workspaceId: "ws-1", task: "Build",
    } },
  }), { kind: "human", id: "device" }, 0).data!;
  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  const commands = execution.commands!;
  assert.equal(commands.length, 2);
  const sentBeforeFailure = delivered.length;
  assert.equal(service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: commands[0]!.commandId,
    sessionId: commands[0]!.sessionId, state: "failed", revision: 1,
    error: "launch rejected",
  }, 60_100), true);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "failed");
  assert.equal(db.listAutomationCommands(execution.executionId)[1]?.state, "uncertain",
    "a sent sibling may have been accepted before its ACK was lost");
  service.recover(90_000);
  assert.equal(delivered.length, sentBeforeFailure + 1, "only the best-effort sibling cancellation is emitted");
});

test("restart cannot dispatch a workflow sibling after a failed receipt committed before reconciliation", () => {
  const { db, service, delivered } = harness();
  const automation = service.create(baseSpec({
    action: { kind: "workflow_run", request: {
      workflowId: "wf-1", runnerId: "runner-1", workspaceId: "ws-1", task: "Build",
    } },
  }), { kind: "human", id: "device" }, 0).data!;
  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  const commands = execution.commands!;
  const durableSendsBefore = delivered.filter((message) =>
    (message as { type?: string }).type === "durable_session_command").length;
  assert.ok(db.recordAutomationCommandReceipt({
    commandId: commands[0]!.commandId,
    runnerId: commands[0]!.runnerId,
    sessionId: commands[0]!.sessionId,
    state: "rejected",
    revision: 1,
    error: "committed immediately before simulated crash",
    now: 60_100,
  }));
  service.recover(90_000);
  assert.equal(delivered.filter((message) =>
    (message as { type?: string }).type === "durable_session_command").length, durableSendsBefore);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "failed");
  assert.equal(db.listAutomationCommands(execution.executionId)[1]?.state, "uncertain");
});

test("a runner capability downgrade makes a sent/lost-ACK command uncertain", () => {
  const { db, service } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  db.registerRunner(runner("runner-1"), 60_100, 52);
  service.recover(60_250);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "failed");
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "uncertain");
});

test("registration-time capability loss also terminalizes commands stranded in staged preparation", () => {
  const { db, service, failures } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  failures.throwAfterStage = true;
  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "staged");
  db.registerRunner(runner("runner-1"), 60_100, 52);
  service.commandOutbox.flush(60_100, "runner-1");
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "failed");
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "rejected");
});

test("a staged command expires at its explicit pre-acceptance horizon", () => {
  const { db, service, failures } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  failures.throwAfterStage = true;
  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  const command = db.listAutomationCommands(execution.executionId)[0]!;
  assert.equal(command.state, "staged");
  service.recover(command.expiresAt + 1);
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "rejected");
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "failed");
});

test("a sent command with no receipt expires as uncertain because its ACK may be lost", () => {
  const { db, service } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  const command = db.listAutomationCommands(execution.executionId)[0]!;
  assert.equal(command.state, "sent");
  service.recover(command.expiresAt + 1);
  assert.equal(db.listAutomationCommands(execution.executionId)[0]?.state, "uncertain");
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "failed");
});

test("registration-time capability loss drains more than one staged-command batch", () => {
  const { db, service } = harness();
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;
  let expected = automation.nextFireAt!;
  for (let index = 0; index < 101; index += 1) {
    const executionId = `axe_batch_${index}`;
    const next = expected + 60_000;
    assert.ok(db.claimAutomationExecution({
      executionId,
      automationId: automation.automationId,
      expectedNextFireAt: expected,
      scheduledFor: expected,
      nextFireAt: next,
      actionKind: "create_session",
      status: "dispatching",
      deliveryMode: "receipted_v53",
      actor: { kind: "system", id: "test" },
      now: expected,
    }));
    const sessionId = `s_batch_${index}`;
    db.stageAutomationDeliveryPlan({
      executionId,
      runnerId: "runner-1",
      sessionId,
      planJson: JSON.stringify({ target: { runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1" } }),
      commands: [{
        commandId: `cmd_batch_${index}`,
        ordinal: 0,
        runnerId: "runner-1",
        sessionId,
        kind: "start_session",
        payloadJson: JSON.stringify({ type: "start_session", spec: { sessionId } }),
        payloadSha256: "0".repeat(64),
      }],
      now: expected,
    });
    expected = next;
  }
  db.registerRunner(runner("runner-1"), expected, 52);
  service.commandOutbox.flush(expected, "runner-1");
  assert.equal(db.activeAutomationExecutions().length, 0);
  const failed = db.raw().prepare(
    "SELECT COUNT(*) AS count FROM automation_executions WHERE automation_id=? AND status='failed'",
  ).get(automation.automationId) as { count: number };
  assert.equal(Number(failed.count), 101);
});

test("receipted prompts ignore unrelated idle state until their matching command completes", () => {
  const { db, service } = harness();
  db.createSession({
    id: "prompt-target", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1",
    title: "Prompt target", useWorktree: false, driver: "acp", config: {}, now: 0,
  });
  db.updateSessionStatus("prompt-target", "idle", 1);
  const automation = service.create(baseSpec({
    action: { kind: "prompt_session", sessionId: "prompt-target", request: { text: "continue" } },
  }), { kind: "human", id: "device" }, 0).data!;

  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  const command = execution.commands![0]!;
  assert.equal(execution.status, "dispatching");
  db.updateSessionStatus("prompt-target", "idle", 60_050);
  service.tick(60_050);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "dispatching");

  service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "started", revision: 2,
  }, 60_100);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "running");
  db.updateSessionStatus("prompt-target", "idle", 60_125);
  service.tick(60_125);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "running");

  service.onDurableCommandReceipt("runner-1", {
    type: "durable_session_command_update", commandId: command.commandId,
    sessionId: command.sessionId, state: "completed", revision: 3,
  }, 60_150);
  assert.equal(db.getAutomationExecution(execution.executionId)?.status, "succeeded");
});

test("protocol-v52 runners fail closed before claiming or delivering durable automation work", () => {
  const { db, service, created, delivered } = harness(52);
  const automation = service.create(baseSpec(), { kind: "human", id: "device" }, 0).data!;

  assert.equal(service.tick(60_000), 0);
  assert.equal(created.length, 0);
  assert.equal(delivered.length, 0);
  assert.equal(db.listAutomationExecutions(automation.automationId).length, 0);
  assert.equal(db.getAutomation(automation.automationId)?.nextFireAt, 60_000);

  const credential = service.createTrigger(automation.automationId,
    { kind: "webhook", name: "Old runner hook" }, { kind: "human", id: "device" }, 61_000).data!;
  const triggered = receiveSignedTrigger(service, credential.trigger.triggerId, credential.secret,
    Buffer.from('{"eventId":"old-runner-1"}'), 62_000);
  assert.equal(triggered.status, 202);
  assert.equal(triggered.data?.invocation.state, "pending");
  assert.equal(created.length, 0);
  assert.equal(delivered.length, 0);
  assert.equal(db.listAutomationExecutions(automation.automationId).length, 0,
    "signed ingress must not bypass the protocol-v53 admission boundary");
});

test("workflow members receive stable distinct command and session ids", () => {
  const { db, service } = harness();
  const automation = service.create(baseSpec({
    action: { kind: "workflow_run", request: {
      runnerId: "runner-1", workspaceId: "ws-1", workflowId: "build-review", task: "Ship",
    } },
  }), { kind: "human", id: "device" }, 0).data!;

  service.tick(60_000);
  const execution = db.listAutomationExecutions(automation.automationId)[0]!;
  const commands = db.listAutomationCommands(execution.executionId);
  assert.deepEqual(commands.map((command) => command.commandId), [
    `ac_${execution.executionId}_000`,
    `ac_${execution.executionId}_001`,
  ]);
  assert.deepEqual(commands.map((command) => command.sessionId), [
    `s_auto_${execution.executionId}_000`,
    `s_auto_${execution.executionId}_001`,
  ]);
  assert.equal(new Set(commands.map((command) => command.commandId)).size, 2);
});
