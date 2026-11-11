import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, type SessionSnapshot, type ManagedBackgroundJobSnapshot } from "@wollipog/protocol";
import type { AssistantOperations } from "../src/assistant-connections.js";
import { ControlPlaneDb } from "../src/db.js";
import { resolveOrchestratorCampaignPolicy } from "../src/orchestrator-settings.js";
import { hashToken } from "../src/auth.js";
import { AssistantCommandReceipts } from "../src/assistant-command-receipts.js";

/** Actual production owner/MCP composition with a wholly synthetic database and no runner launch. */
export async function verifyStatus(app: FastifyInstance, operations: AssistantOperations, path: string) {
  const db = ControlPlaneDb.open(path);
  try {
    const local = db.localIdentityContext(), owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
    const granted = db.createProject({name: "Granted"}), hidden = db.createProject({name: "Hidden"});
    db.registerRunner({runnerId: "status-runner", hostname: "fixture", os: "linux", version: "test", agents: [], workspaces: []}, Date.now(), PROTOCOL_VERSION);
    const create = (id: string, projectId: string, parentSessionId?: string, campaign = false) => {
      db.createSession({id, runnerId: "status-runner", workspaceId: null, agentId: null,
        title: id, useWorktree: false, driver: "codex-app-server", config: {}, now: Date.now(),
        ...(parentSessionId ? {parentSessionId} : {}), ...(campaign ? {role: "orchestrator" as const,
          orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default")} : {})});
      db.setSessionProject(id, projectId, null);
      db.updateSessionStatus(id, "idle", Date.now());
    };
    create("status-visible", granted.id);
    create("status-hidden", hidden.id);
    const issued = db.assistantConnections.create(owner, "Status Fixture", {operations: "all", projects: "all"});
    const credential = db.assistantConnections.authenticate(issued.token)!;
    const call = async (name: string, args: unknown = {}): Promise<any> => JSON.parse(JSON.stringify(await operations.call(credential, name, args)));
    db.createDevice({id: "status-device", name: "Fixture", tokenHash: hashToken("status-synthetic-device"), userId: owner.userId, organizationId: owner.organizationId, now: Date.now()});
    const headers = {authorization: "Bearer status-synthetic-device", "x-wollipog-ui-protocol": String(PROTOCOL_VERSION)};
    const get = async (suffix: string, query = "") => (await app.inject({url: `/api/sessions/status-visible${suffix}${query}`, headers})).json();
    const complete = (text: string) => {
      db.appendEvent("status-visible", {kind: "agent_message", text, final: true}, Date.now());
      db.appendEvent("status-visible", {kind: "agent_response_completed"}, Date.now());
      return db.getSession("status-visible")!.attention!.result!.revision;
    };
    const first = complete("First fixture result");
    const state = await call("session_status", {sessionId: "status-visible"});
    assert.equal(state.status, 200);
    assert.deepEqual(state.body, await get(""));
    assert.equal(state.body.session.attention.result.revision, first);
    assert.equal((await call("session_lookup", {sessionId: "status-visible"})).body.session.id, "status-visible");
    await assert.rejects(call("session_lookup", {sessionId: "status-visible", query: {id: "status-hidden"}}), /match/);
    for (const [name, suffix] of [["session_usage", "/usage"], ["worktree_ops", "/worktrees/operations"], ["review_list", "/review-sessions"], ["review_findings", "/review-findings"], ["decision_list", "/workflow-decisions"]] as const) {
      const result = await call(name!, {sessionId: "status-visible"});
      assert.equal(result.status, 200, name);
      assert.deepEqual(result.body, await get(suffix!), name);
    }
    const events = await call("session_events", {sessionId: "status-visible", query: {limit: "1", eventEpoch: "0"}});
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length, 1);
    assert.deepEqual(events.body, await get("/events", "?limit=1&eventEpoch=0"));
    assert.equal((await call("session_events", {sessionId: "status-visible", query: {limit: "201"}})).status, 400);
    assert.equal((await call("session_events", {sessionId: "status-visible", query: {eventEpoch: "999"}})).status, 409);
    assert.equal((await call("session_history", {sessionId: "status-visible", query: {limit: "201"}})).status, 400);

    const reminderArgs = {sessionId: "status-visible", commandId: "reminder-once", payload: {
      scheduleKind: "timed", scheduledFor: Date.now() + 86_400_000, timeZone: "UTC", originalExpression: "Tomorrow", wakePolicy: "until_activity"}};
    const saved = await call("reminder_set", reminderArgs);
    assert.equal(saved.receipt.status, "succeeded");
    const reminder = (await call("reminder_get", {sessionId: "status-visible"})).body.reminder;
    assert.equal(reminder.reminderId, db.getSessionReminder("status-visible", owner.userId)!.reminderId);
    db.raw().prepare("INSERT INTO identity_users(user_id,display_name,created_at,updated_at) VALUES ('status-peer','Peer',1,1)").run();
    db.setSessionReminder({sessionId: "status-visible", userId: "status-peer", scheduleKind: "someday", originalExpression: "Someday", wakePolicy: "until_activity", now: Date.now()});
    assert.equal((await call("reminder_get", {sessionId: "status-visible"})).body.reminder.reminderId, reminder.reminderId);
    assert.deepEqual((await call("reminder_set", reminderArgs)).receipt, saved.receipt);
    assert.equal(db.getSessionReminder("status-visible", owner.userId)!.revision, reminder.revision);
    await assert.rejects(call("reminder_set", {...reminderArgs, payload: {...reminderArgs.payload, originalExpression: "Changed"}}), /different|digest|arguments/i);
    const conflict = await call("reminder_set", {...reminderArgs, commandId: "stale-reminder", payload: {...reminderArgs.payload, expectedRevision: reminder.revision + 1}});
    assert.equal(conflict.status, 409);
    assert.equal(conflict.receipt.status, "failed");
    assert.deepEqual((await call("reminder_get", {sessionId: "status-visible"})).body, await get("/reminder"));

    const ack = {sessionId: "status-visible", commandId: "ack-first", payload: {revision: first}};
    assert.equal((await call("result_ack", ack)).body.acknowledged, true);
    assert.deepEqual((await call("session_status", {sessionId: "status-visible"})).body, await get(""));
    const second = complete("Second fixture result");
    assert.equal((await call("result_ack", ack)).receipt.status, "succeeded");
    assert.equal(db.sessionAttentionForUser(db.getSession("status-visible")!, owner.userId).attention!.acknowledgedRevision, first);
    assert.notEqual(first, second);
    assert.equal((await call("result_ack", {...ack, commandId: "stale-ack"})).body.acknowledged, false);
    assert.equal((await call("result_handoff", {sessionId: "status-visible", commandId: "no-controller", payload: {revision: second}})).status, 403);
    for (const name of ["result_missing_ack", "result_retry_ack"]) {
      const missing = await call(name, {sessionId: "status-visible", continuationId: "absent", commandId: name});
      assert.equal(missing.status, 404);
      assert.equal(missing.receipt.status, "failed");
    }
    assert.equal((await call("result_blocked_ack", {sessionId: "status-visible", commandId: "invalid-targets", payload: {targets: []}})).status, 400);
    const baseJob = {id: "finished", parentTurnId: "fixture-turn", runnerId: "status-runner", workspaceId: null,
      launchType: "agent" as const, registeredAt: 1_000, terminalStatus: "completed" as const, terminalObservedAt: 1_100, continuationRequired: true};
    const background = (id: string, jobs: ManagedBackgroundJobSnapshot[]) => {
      const snapshot: SessionSnapshot = {id, workspaceId: null, agentId: null, title: id, status: "idle", driver: "claude-code",
        useWorktree: false, worktreePath: null, config: {}, preview: null, pendingApproval: null, tokensIn: 0, tokensOut: 0,
        costUsd: 0, seq: 0, createdAt: 1_000, updatedAt: 2_000, backgroundWorkTracking: "managed", backgroundJobs: jobs};
      db.createSessionFromSnapshot(snapshot, "status-runner", Date.now());
      db.setSessionProject(id, granted.id, null);
    };
    background("status-blocked", [baseJob, {id: "monitor", parentTurnId: "fixture-turn", runnerId: "status-runner", workspaceId: null, launchType: "monitor", registeredAt: 1_000}]);
    const blocked = db.getSession("status-blocked")!.backgroundDeliveries![0]!;
    assert.equal(blocked.watchdogState, "continuation_blocked");
    const blockedArgs = {sessionId: "status-blocked", commandId: "blocked-once", payload: {targets: [{parentTurnId: blocked.parentTurnId, revision: blocked.blockedResultRevision}]}};
    assert.equal((await call("result_blocked_ack", blockedArgs)).receipt.status, "succeeded");
    assert.equal(db.getSession("status-blocked")!.backgroundDeliveries?.[0]?.watchdogState, undefined);
    assert.equal((await call("result_blocked_ack", blockedArgs)).receipt.status, "succeeded");
    background("status-missing", [{...baseJob, continuationId: "missing-continuation", continuationQueuedAt: 1_200,
      continuationSubmittedAt: 1_300, continuationAcceptedAt: 1_400, continuationMissingResultAt: 1_450}]);
    assert.equal(db.getSession("status-missing")!.backgroundDeliveries![0]!.watchdogState, "accepted_without_result");
    assert.equal((await call("result_missing_ack", {sessionId: "status-missing", commandId: "missing-once", continuationId: "missing-continuation"})).receipt.status, "succeeded");
    assert.equal(db.getSession("status-missing")!.backgroundDeliveries?.[0]?.watchdogState, undefined);
    background("status-exhausted", [{...baseJob, continuationId: "exhausted-continuation", continuationQueuedAt: 1_200, continuationSubmittedAt: 1_300, continuationRetryExhaustedAt: 1_450}]);
    assert.equal(db.getSession("status-exhausted")!.backgroundDeliveries![0]!.watchdogState, "capacity_retry_exhausted");
    assert.equal((await call("result_retry_ack", {sessionId: "status-exhausted", commandId: "exhausted-once", continuationId: "exhausted-continuation"})).receipt.status, "succeeded");
    assert.equal(db.getSession("status-exhausted")!.backgroundDeliveries?.[0]?.watchdogState, undefined);
    db.assistantConnections.configure(issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const confirmed = {sessionId: "status-visible", commandId: "confirm-ack", payload: {revision: second}};
    const preview = await call("result_ack", confirmed);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(db.getSession("status-visible")!.attention!.result!.revision, second);
    complete("Changed after preview");
    await assert.rejects(call("result_ack", {...confirmed, confirmationId: preview.confirmationId}), /confirmation/i);
    const remove = {sessionId: "status-visible", commandId: "remove-reminder", query: {revision: String(reminder.revision), reminderId: reminder.reminderId}};
    const removal = await call("reminder_remove", remove);
    assert.equal(removal.confirmationRequired, true);
    assert.equal((await call("reminder_remove", {...remove, confirmationId: removal.confirmationId})).receipt.status, "succeeded");
    assert.equal(db.getSessionReminder("status-visible", owner.userId), null);
    assert.equal((await call("reminder_remove", remove)).receipt.status, "succeeded");

    create("status-root", granted.id, undefined, true);
    create("status-child", granted.id, "status-root");
    db.appendEvent("status-child", {kind: "agent_message", text: "Child fixture result", final: true}, Date.now());
    db.appendEvent("status-child", {kind: "agent_response_completed"}, Date.now());
    const childRevision = db.getSession("status-child")!.attention!.result!.revision;
    db.assistantConnections.configure(issued.connection.id, {operations: "all", projects: "all"});
    // configure preserves an established confirmation preference unless explicitly changed.
    db.assistantConnections.configure(issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "none"});
    assert.equal((await call("result_handoff", {sessionId: "status-child", commandId: "handoff-once", payload: {revision: childRevision}})).body.handedOff, true);
    for (const name of ["campaign_status", "campaign_decisions", "campaign_items", "campaign_recommendations", "campaign_get", "campaign_work_items"]) {
      const read = await call(name, {sessionId: "status-root"});
      assert.equal(read.status, 200, name);
    }
    db.assistantConnections.configure(issued.connection.id, {operations: "all", projects: [granted.id]});
    await assert.rejects(call("session_status", {sessionId: "status-hidden"}), /excluded/);
    const archive = await call("session_archive_list", {query: {archive: "all"}});
    assert.equal(archive.status, 200);
    assert.ok(!JSON.stringify(archive.body).includes("status-hidden"));
    assert.ok(!JSON.stringify(archive.body.facets).includes("Hidden"));
    assert.equal((await call("campaign_status", {sessionId: "status-root"})).status, 200);
    await assert.rejects(call("campaign_get", {sessionId: "status-root"}), /installation-wide/);
    db.setSessionProject("status-child", hidden.id, null);
    await assert.rejects(call("campaign_status", {sessionId: "status-root"}), /excluded/);
    await assert.rejects(call("session_status", {sessionId: "status-root"}), /excluded/);
    await assert.rejects(call("request_list", {sessionId: "status-root"}), /excluded/);
    db.assistantConnections.configure(issued.connection.id, {operations: ["session_status"], projects: [granted.id]});
    await assert.rejects(call("result_ack", {sessionId: "status-visible", commandId: "excluded-op", payload: {revision: second}}), /excluded/);
    assert.equal(new AssistantCommandReceipts(db.raw()).get(issued.connection.id, "excluded-op"), null);
    const mcp = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${issued.token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "session_status", arguments: {sessionId: "status-visible"}}}});
    assert.equal(mcp.statusCode, 200);
    assert.equal(JSON.parse(mcp.json().result.content[0].text).body.session.id, "status-visible");
    db.assistantConnections.revoke(issued.connection.id);
    await assert.rejects(call("session_status", {sessionId: "status-visible"}), /revoked|reconnect|credential/i);
    console.log("STATUS_ACCEPTANCE " + JSON.stringify({ownerHttp: true, mcp: true, receipts: true,
      exactRevisions: true, grantNarrowing: true, archiveFacets: true, confirmationStaleness: true, realRunner: false}));
  } finally {db.close();}
}
