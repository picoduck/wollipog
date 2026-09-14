import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationSpec, RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { OutboundEventsService } from "./outbound-events.js";

function runner(): RunnerMetadata {
  return {
    runnerId: "runner-1",
    hostname: "runner-1",
    os: "linux",
    arch: "x64",
    version: "test",
    workspaces: [{ id: "ws-1", name: "Repo", path: "/repos/one" }],
    agents: [{
      id: "agent-1", name: "Agent", command: "agent", args: [], env: {}, driver: "acp",
      context: { kind: "native" }, available: true,
    }],
  };
}

function spec(): AutomationSpec {
  return {
    name: "Triggered Session",
    cron: "* * * * *",
    timezone: "UTC",
    enabled: true,
    misfirePolicy: { kind: "fire_once" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "wait",
    limits: { maxCostUsd: 2, maxToolCalls: 20 },
    notifications: { pushEvents: [] },
    action: {
      kind: "create_session",
      request: { runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent-1", prompt: "Build" },
    },
  };
}

function database(): ControlPlaneDb {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner(), 1);
  return db;
}

test("project subscriptions atomically queue created and input events without default content opt-ins", () => {
  const db = database();
  const project = db.createProject({ name: "Outbound", now: 2 });
  const location = db.addProjectLocation(project.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 3);
  const subscription = db.createOutboundEventSubscription({
    subscriptionId: "oes_project",
    callbackUrl: "https://events.example.test/hook",
    secret: "secret-not-readable",
    scope: { kind: "project", projectId: project.id },
    eventKinds: [
      "session.created", "session.input_required", "session.idle", "session.completed",
      "pull_request.opened", "cost.budget_exhausted",
    ],
    includeSessionName: false,
    includeQuestionTitle: false,
    actor: { kind: "human", id: "user-1" },
    now: 4,
  });
  assert.ok(subscription);
  assert.equal("secret" in subscription, false);
  db.createSession({
    id: "s_project",
    runnerId: "runner-1",
    workspaceId: "ws-1",
    projectId: project.id,
    projectLocationId: location.id,
    agentId: "agent-1",
    title: "Private Session Name",
    useWorktree: true,
    driver: "acp",
    config: {},
    now: 5,
  });
  db.setPendingApproval("s_project", {
    requestId: "question-1",
    occurrenceId: "occurrence-1",
    kind: "question",
    title: "Private Question Text",
    options: [],
  });
  db.updateSessionStatus("s_project", "input_required", 6);
  assert.equal(db.recordOutboundPullRequestOpened({
    sessionId: "s_project",
    branch: "agent/s_project",
    pullRequestUrl: "https://github.com/example/repo/pull/1",
    now: 7,
  }), true);
  assert.equal(db.recordOutboundPullRequestOpened({
    sessionId: "s_project",
    branch: "agent/s_project",
    pullRequestUrl: "https://github.com/example/repo/pull/1",
    now: 8,
  }), false);
  db.updateSessionStatus("s_project", "input_required", 9);
  assert.equal(db.listOutboundEventDeliveries("oes_project")!.length, 3,
    "the stable request occurrence suppresses duplicate input-required delivery");
  db.updateSessionStatus("s_project", "idle", 10);
  db.raw().prepare("UPDATE sessions SET cost_usd=1.25 WHERE id='s_project'").run();
  db.updateSessionCostBudget("s_project", 1, 11);
  db.setPendingApproval("s_project", {
    requestId: "cost-1",
    occurrenceId: "cost-occurrence-1",
    kind: "cost_budget",
    title: "Private Cost Text",
    options: [],
  });
  db.updateSessionStatus("s_project", "input_required", 12);
  db.updateSessionStatus("s_project", "completed", 13);

  const receipts = db.listOutboundEventDeliveries("oes_project")!;
  assert.deepEqual(receipts.map((receipt) => receipt.kind).sort(),
    [
      "cost.budget_exhausted", "pull_request.opened", "session.completed", "session.created",
      "session.idle", "session.input_required", "session.input_required",
    ]);
  assert.equal(receipts.every((receipt) => !("payloadJson" in receipt) && !("secret" in receipt)), true);
  const payloads = (db.raw().prepare(
    "SELECT payload_json FROM outbound_event_deliveries ORDER BY created_at",
  ).all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json));
  assert.equal(payloads[0].projectId, project.id);
  assert.equal(JSON.stringify(payloads).includes("Private Session Name"), false);
  assert.equal(JSON.stringify(payloads).includes("Private Question Text"), false);
  assert.equal(JSON.stringify(payloads).includes("Private Cost Text"), false);
  const budgetPayload = payloads.find((payload) => payload.kind === "cost.budget_exhausted");
  assert.deepEqual(budgetPayload.cost, { costUsd: 1.25, budgetUsd: 1 });
  db.close();
});

test("accepted trigger parameters and stable linkage become session origin in the creation transaction", () => {
  const db = database();
  const automationSpec = spec();
  db.createAutomation({
    automationId: "auto_1", spec: automationSpec, nextFireAt: 60_000,
    actor: { kind: "human", id: "user-1" }, now: 10,
  });
  db.createAutomationTrigger({
    triggerId: "atr_1",
    automationId: "auto_1",
    kind: "webhook",
    name: "Webhook",
    secret: "inbound-secret",
    deliveryPolicy: { allowPrompt: false, parameterNames: ["issue"], missingReferences: "reject" },
    actor: { kind: "human", id: "user-1" },
    now: 11,
  });
  const invocation = db.recordAutomationTriggerInvocation({
    invocationId: "ati_1",
    triggerId: "atr_1",
    eventId: "provider-event-1",
    bodySha256: "a".repeat(64),
    expectedAutomationRevision: 1,
    specSnapshot: automationSpec,
    acceptedParameters: { issue: "1100" },
    now: 12,
  });
  assert.equal(invocation?.invocation?.acceptedParameters?.issue, "1100");
  assert.ok(db.claimAutomationTriggerExecution({
    invocationId: "ati_1",
    executionId: "aex_1",
    status: "dispatching",
    actor: { kind: "policy", id: "webhook:atr_1" },
    now: 13,
  }));
  db.createOutboundEventSubscription({
    subscriptionId: "oes_automation",
    callbackUrl: "https://events.example.test/hook",
    secret: "outbound-secret",
    scope: { kind: "automation", automationId: "auto_1" },
    eventKinds: ["session.created"],
    includeSessionName: false,
    includeQuestionTitle: false,
    actor: { kind: "human", id: "user-1" },
    now: 14,
  });
  db.createSession({
    id: "s_triggered",
    runnerId: "runner-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    title: "Triggered",
    useWorktree: true,
    driver: "acp",
    config: {},
    automationOrigin: {
      automationId: "auto_1",
      executionId: "aex_1",
      triggerId: "atr_1",
      invocationId: "ati_1",
    },
    now: 15,
  });
  const payloadRow = db.raw().prepare(
    "SELECT payload_json FROM outbound_event_deliveries WHERE subscription_id='oes_automation'",
  ).get() as { payload_json: string };
  const payload = JSON.parse(payloadRow.payload_json);
  assert.deepEqual(payload.parameters, { issue: "1100" });
  assert.equal(payload.automationId, "auto_1");
  assert.equal(payload.triggerId, "atr_1");
  assert.equal(payload.triggerInvocationId, "ati_1");

  assert.throws(() => db.createSession({
    id: "s_bad_origin",
    runnerId: "runner-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    title: "Bad",
    useWorktree: true,
    driver: "acp",
    config: {},
    automationOrigin: { automationId: "auto_1", executionId: "aex_1", invocationId: "missing" },
    now: 16,
  }), /does not match its trigger invocation/);
  assert.equal(db.getSession("s_bad_origin"), null, "origin validation rolls back session creation");
  db.close();
});

test("a subscription pauses at the fixed 100-delivery pending bound", () => {
  const db = database();
  const project = db.createProject({ name: "Bounded", now: 2 });
  const location = db.addProjectLocation(project.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 3);
  db.createOutboundEventSubscription({
    subscriptionId: "oes_bounded",
    callbackUrl: "https://events.example.test/hook",
    secret: "secret",
    scope: { kind: "project", projectId: project.id },
    eventKinds: ["pull_request.opened"],
    includeSessionName: false,
    includeQuestionTitle: false,
    actor: { kind: "human", id: "user-1" },
    now: 4,
  });
  db.createSession({
    id: "s_bounded", runnerId: "runner-1", workspaceId: "ws-1", projectId: project.id,
    projectLocationId: location.id, agentId: "agent-1", title: "Bounded", useWorktree: true,
    driver: "acp", config: {}, now: 5,
  });
  for (let index = 0; index < 101; index += 1) {
    db.recordOutboundPullRequestOpened({
      sessionId: "s_bounded",
      branch: `branch-${index}`,
      pullRequestUrl: `https://github.com/example/repo/pull/${index}`,
      now: 10 + index,
    });
  }
  assert.equal(db.listOutboundEventDeliveries("oes_bounded")!.length, 100);
  const subscription = db.getOutboundEventSubscription("oes_bounded")!;
  assert.equal(subscription.state, "paused");
  assert.match(subscription.pauseReason ?? "", /100 deliveries are pending/);
  assert.ok(db.deleteProject(project.id), "a scoped subscription does not prevent project deletion");
  assert.equal(db.getOutboundEventSubscription("oes_bounded"), null);
  db.close();
});

test("administrative deferral refunds a claimed attempt and preserves durable retry state", () => {
  const db = database();
  const project = db.createProject({ name: "Deferred Delivery", now: 2 });
  const location = db.addProjectLocation(project.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 3);
  db.createOutboundEventSubscription({
    subscriptionId: "oes_deferred",
    callbackUrl: "https://events.example.test/hook",
    secret: "secret",
    scope: { kind: "project", projectId: project.id },
    eventKinds: ["session.created"],
    includeSessionName: false,
    includeQuestionTitle: false,
    actor: { kind: "human", id: "user-1" },
    now: 4,
  });
  db.createSession({
    id: "s_deferred", runnerId: "runner-1", workspaceId: "ws-1", projectId: project.id,
    projectLocationId: location.id, agentId: "agent-1", title: "Deferred", useWorktree: true,
    driver: "acp", config: {}, now: 5,
  });
  db.raw().prepare(
    "UPDATE outbound_event_deliveries SET status='retrying',attempt_count=5,next_attempt_at=10",
  ).run();
  const claimed = db.claimOutboundEventDeliveries(10, 1, 30_000);
  assert.equal(claimed[0]?.attempt, 6);
  assert.equal(db.settleOutboundEventDelivery({
    deliveryId: claimed[0]!.deliveryId,
    subscriptionId: claimed[0]!.subscriptionId,
    leaseId: claimed[0]!.leaseId,
    disposition: "deferred",
    nextAttemptAt: 11,
    error: "Delivery deferred during control-plane shutdown",
    now: 11,
  }), true);
  const receipt = db.listOutboundEventDeliveries("oes_deferred")![0]!;
  assert.equal(receipt.status, "retrying");
  assert.equal(receipt.attemptCount, 5);
  assert.equal(receipt.nextRetryAt, 11);
  assert.equal(db.getOutboundEventSubscriptionRecord("oes_deferred")?.consecutiveFailures, 0);
  const payload = db.raw().prepare("SELECT payload_json FROM outbound_event_deliveries").get() as {
    payload_json: string | null;
  };
  assert.ok(payload.payload_json, "administrative deferral retains the payload for recovery");
  db.rotateOutboundEventSubscription({ subscriptionId: "oes_deferred", secret: "current-secret", now: 12 });
  const retry = db.claimOutboundEventDeliveries(12, 1, 30_000)[0]!;
  assert.equal(retry.attempt, 6, "the administrative abort did not consume the sixth attempt");
  assert.equal(retry.secret, "current-secret", "the preserved delivery is signed with the rotated secret");
  db.close();
});

test("check failure observations deduplicate the bounded public receipt shape", () => {
  const db = database();
  const project = db.createProject({ name: "Checks", now: 2 });
  const location = db.addProjectLocation(project.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 3);
  db.createOutboundEventSubscription({
    subscriptionId: "oes_checks",
    callbackUrl: "https://events.example.test/hook",
    secret: "secret",
    scope: { kind: "project", projectId: project.id },
    eventKinds: ["checks.failed"],
    includeSessionName: false,
    includeQuestionTitle: false,
    actor: { kind: "human", id: "user-1" },
    now: 4,
  });
  db.createSession({
    id: "s_checks", runnerId: "runner-1", workspaceId: "ws-1", projectId: project.id,
    projectLocationId: location.id, agentId: "agent-1", title: "Checks", useWorktree: true,
    driver: "acp", config: {}, now: 5,
  });
  const firstTwenty = Array.from({ length: 20 }, (_, index) => `check-${String(index).padStart(2, "0")}`);
  assert.equal(db.recordOutboundCheckObservation({
    sessionId: "s_checks",
    branch: "a".repeat(300),
    pullRequestUrl: "https://github.com/example/repo/pull/1",
    failing: 21,
    failingNames: [...firstTwenty, "ignored-one"],
    checksUrl: `https://github.com/${"x".repeat(3_000)}`,
    now: 6,
  }), true);
  assert.equal(db.recordOutboundCheckObservation({
    sessionId: "s_checks",
    branch: "a".repeat(300),
    pullRequestUrl: "https://github.com/example/repo/pull/1",
    failing: 21,
    failingNames: [...firstTwenty, "ignored-two"],
    now: 7,
  }), false, "names outside the delivered bound cannot create a second occurrence");
  const row = db.raw().prepare(
    "SELECT payload_json FROM outbound_event_deliveries WHERE subscription_id='oes_checks'",
  ).get() as { payload_json: string };
  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.branch.length, 256);
  assert.equal(payload.checks.failingNames.length, 20);
  assert.equal(payload.checks.url.length, 2_048);
  db.close();
});

test("check candidates exclude closed pull requests and rotate every attempted open session", () => {
  const db = database();
  const project = db.createProject({ name: "Candidate Rotation", now: 2 });
  const location = db.addProjectLocation(project.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 3);
  db.createOutboundEventSubscription({
    subscriptionId: "oes_candidate_rotation",
    callbackUrl: "https://events.example.test/hook",
    secret: "secret",
    scope: { kind: "project", projectId: project.id },
    eventKinds: ["checks.failed"],
    includeSessionName: false,
    includeQuestionTitle: false,
    actor: { kind: "human", id: "user-1" },
    now: 4,
  });
  const addSession = (index: number, state: "open" | "closed") => {
    const id = `s_candidate_${state}_${index}`;
    const url = `https://github.com/example/repo/pull/${state}-${index}`;
    db.createSession({
      id, runnerId: "runner-1", workspaceId: "ws-1", projectId: project.id,
      projectLocationId: location.id, agentId: "agent-1", title: id, useWorktree: true,
      driver: "acp", config: {}, now: 10 + index,
    });
    db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?").run(JSON.stringify([{
      id: `wt_${id}`, path: `/repos/${id}`, branch: `branch-${id}`, source: "created",
      pullRequest: { url, state },
    }]), id);
  };
  for (let index = 0; index < 30; index += 1) addSession(index, "closed");
  for (let index = 0; index < 26; index += 1) addSession(100 + index, "open");

  const first = db.outboundCheckObservationCandidates();
  assert.equal(first.length, 25);
  assert.equal(first.every((candidate) => candidate.sessionId.includes("_open_")), true);
  for (const candidate of first) {
    db.markOutboundCheckObservationAttempt(candidate.sessionId, candidate.pullRequestUrl, 1_000);
  }
  const second = db.outboundCheckObservationCandidates();
  assert.equal(second.some((candidate) => candidate.sessionId === "s_candidate_open_125"), true,
    "the first unattempted open pull request is not starved by the bounded first cohort");
  db.close();
});

test("malformed open-PR worktrees do not consume the bounded candidate cohort", () => {
  const db = database();
  const project = db.createProject({ name: "Malformed Candidate Bound", now: 2 });
  const location = db.addProjectLocation(project.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 3);
  db.createOutboundEventSubscription({
    subscriptionId: "oes_malformed_candidates",
    callbackUrl: "https://events.example.test/hook",
    secret: "secret",
    scope: { kind: "project", projectId: project.id },
    eventKinds: ["checks.failed"],
    includeSessionName: false,
    includeQuestionTitle: false,
    actor: { kind: "human", id: "user-1" },
    now: 4,
  });
  for (let index = 0; index < 25; index += 1) {
    const id = `s_malformed_${index}`;
    db.createSession({
      id, runnerId: "runner-1", workspaceId: "ws-1", projectId: project.id,
      projectLocationId: location.id, agentId: "agent-1", title: id, useWorktree: true,
      driver: "acp", config: {}, now: 10 + index,
    });
    db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?").run(JSON.stringify([{
      id: `wt_${index}`, path: "", branch: `branch-${index}`, source: "created",
      pullRequest: { url: `https://github.com/example/repo/pull/${index}`, state: "open" },
    }]), id);
  }
  db.createSession({
    id: "s_valid_after_malformed", runnerId: "runner-1", workspaceId: "ws-1", projectId: project.id,
    projectLocationId: location.id, agentId: "agent-1", title: "Valid", useWorktree: true,
    driver: "acp", config: {}, now: 100,
  });
  db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?").run(JSON.stringify([{
    id: "wt_valid", path: "/repos/valid", branch: "branch-valid", source: "created",
    pullRequest: { url: "https://github.com/example/repo/pull/valid", state: "open" },
  }]), "s_valid_after_malformed");

  assert.deepEqual(db.outboundCheckObservationCandidates().map((candidate) => candidate.sessionId),
    ["s_valid_after_malformed"]);
  db.close();
});

test("check sweep queries the open PR's linked worktree and rejects stale attribution", async () => {
  const db = database();
  const project = db.createProject({ name: "Matched Worktree", now: 2 });
  const location = db.addProjectLocation(project.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 3);
  db.createOutboundEventSubscription({
    subscriptionId: "oes_matched_worktree",
    callbackUrl: "https://events.example.test/hook",
    secret: "secret",
    scope: { kind: "project", projectId: project.id },
    eventKinds: ["checks.failed"],
    includeSessionName: false,
    includeQuestionTitle: false,
    actor: { kind: "human", id: "user-1" },
    now: 4,
  });
  db.createSession({
    id: "s_matched", runnerId: "runner-1", workspaceId: "ws-1", projectId: project.id,
    projectLocationId: location.id, agentId: "agent-1", title: "Matched", useWorktree: true,
    driver: "acp", config: {}, now: 5,
  });
  const worktrees = [{
    id: "wt_a", path: "/repos/a", branch: "branch-a", source: "created",
  }, {
    id: "wt_b", path: "/repos/b", branch: "branch-b", source: "created",
    pullRequest: { url: "https://github.com/example/repo/pull/2", state: "open" },
  }];
  db.raw().prepare("UPDATE sessions SET worktree_path=?,worktrees=? WHERE id=?")
    .run("/repos/a", JSON.stringify(worktrees), "s_matched");

  const requestedPaths: string[] = [];
  let summaryPullRequestUrl = "https://github.com/example/repo/pull/2";
  let replaceAssociationDuringRequest: typeof worktrees | undefined;
  const hub = {
    isRunnerOnline: () => true,
    requestFromRunner: async (_runnerId: string, requestId: string, message: { worktreePath?: string }) => {
      requestedPaths.push(message.worktreePath ?? "");
      if (replaceAssociationDuringRequest) {
        db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?")
          .run(JSON.stringify(replaceAssociationDuringRequest), "s_matched");
      }
      return {
        type: "git_result", requestId, ok: true,
        data: { summary: {
          branch: "branch-b", ahead: 1, behind: 0, hasChanges: false, addedLines: 1, deletedLines: 0,
          remoteUrl: "https://github.com/example/repo.git",
          pr: { number: 2, title: "PR", url: summaryPullRequestUrl, state: "OPEN" },
          checks: { failing: 1, pending: 0, passing: 1, failingNames: ["CI"], url: null },
        } },
      };
    },
  };
  const service = new OutboundEventsService(db, { info: () => {}, warn: () => {} });
  await service.sweepCheckObservations(hub as never, 10);
  assert.deepEqual(requestedPaths, ["/repos/b"]);
  assert.equal(db.listOutboundEventDeliveries("oes_matched_worktree")!.length, 1);

  worktrees[1] = {
    ...worktrees[1]!, path: "/repos/c", branch: "branch-c",
    pullRequest: { url: "https://github.com/example/repo/pull/3", state: "open" },
  };
  db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?").run(JSON.stringify(worktrees), "s_matched");
  summaryPullRequestUrl = "https://github.com/example/repo/pull/3";
  replaceAssociationDuringRequest = [{ ...worktrees[0]! }, {
    ...worktrees[1]!, path: "/repos/d", branch: "branch-d",
  }];
  await service.sweepCheckObservations(hub as never, 11);
  assert.deepEqual(requestedPaths, ["/repos/b", "/repos/c"]);
  assert.equal(db.listOutboundEventDeliveries("oes_matched_worktree")!.length, 1,
    "a summary from an association that changed in flight is not attributed to the selected candidate");

  replaceAssociationDuringRequest = undefined;
  worktrees[1] = { ...worktrees[1]!, path: "" };
  db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?").run(JSON.stringify(worktrees), "s_matched");
  await service.sweepCheckObservations(hub as never, 12);
  assert.deepEqual(requestedPaths, ["/repos/b", "/repos/c"],
    "a missing linked-worktree path fails closed before querying the runner");
  db.close();
});
