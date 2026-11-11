import assert from "node:assert/strict";
import {test} from "node:test";
import {PROTOCOL_VERSION, type RunnerMetadata} from "@wollipog/protocol";
import {ControlPlaneDb} from "./db.js";
import {Hub} from "./hub.js";
import {SessionsService} from "./sessions.js";
import {createAssistantOperations} from "./assistant-routes.js";
import {registerAssistantSessionOperations} from "./assistant-session-operations.js";
import {registerAssistantSessionContent, ASSISTANT_SESSION_CONTENT_ROUTES} from "./assistant-session-content.js";
import {createSessionContentManagement} from "./session-content-management.js";
import {HistoryPreviewReader} from "./history-preview.js";
import {buildAuthorizedSessionTranscriptExport} from "./session-exports.js";
import {createAuthorizedTranscriptShare} from "./transcript-shares.js";
import {ShellRegistry} from "./shell-registry.js";
import {createSessionShellManagement} from "./session-shell-management.js";

function harness() {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const metadata: RunnerMetadata = {runnerId: "r", hostname: "Fixture", os: "linux", version: "test",
    agents: [{id: "agent", name: "Agent", driver: "acp", command: "fixture", args: [], env: {}, available: true,
      capabilities: {models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true}}],
    workspaces: [{id: "w", name: "Repository", path: "/fixture/repo"}]};
  db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
  const project = db.createProject({name: "First"}), other = db.createProject({name: "Other"});
  const location = db.addProjectLocation(project.id, {runnerId: "r", workspaceId: "w"});
  for (const id of ["s", "target"]) {
    db.createSession({id, runnerId: "r", workspaceId: "w", agentId: "agent", title: "Fixture", driver: "acp", useWorktree: false, config: {}, now: Date.now()});
    db.setSessionProject(id, id === "s" ? project.id : other.id, id === "s" ? location.id : null);
    db.updateSessionStatus(id, "idle", Date.now());
  }
  const hub = new Hub(db), sent: unknown[] = []; hub.isRunnerOnline = () => true;
  hub.sendToRunner = (_id, message) => {sent.push(message); return true;};
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  svc.hydrateHistory = async () => {};
  const operations = createAssistantOperations(db), receipts = registerAssistantSessionOperations(operations, db, svc);
  const registry = new ShellRegistry(db);
  const shells = createSessionShellManagement({hub, registry, open: async (id, _input, options) => {
    await options?.recheck?.();
    return {ok: true, status: 200, shell: registry.create({sessionId: id, shellId: "shell", runnerId: "r", name: "Shell", createdAt: Date.now()})};
  }});
  registerAssistantSessionContent(operations, {db, hub, svc, receipts, content: createSessionContentManagement({db, svc, historyPreviews: new HistoryPreviewReader(db, hub)}), shells});
  const issued = db.assistantConnections.create(owner, "Fixture", {operations: "all", projects: "all"}), credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: Record<string, unknown> = {}) => operations.call(credential, name, {sessionId: "s", ...args}) as Promise<any>;
  return {db, owner, project, other, hub, svc, operations, receipts, issued, call, sent};
}

test("Assistant reads a genuine runtime watch but cannot replace it under a session identity", async () => {
  const h = harness();
  try {
    for (const tool of Object.values(ASSISTANT_SESSION_CONTENT_ROUTES)) assert.ok(h.operations.inventory().some(t => t.name === tool && tool.length <= 32));
    const args = {commandId: "watch", repository: "fixture/repo", number: 7, headSha: "a".repeat(40)};
    const {commandId: _commandId, ...request} = args;
    assert.equal(h.svc.requestPullRequestWatch("s", request).ok, true);
    assert.equal((await h.call("session_watch_get")).watch.headSha, args.headSha);
    const before = h.sent.length, watch = h.db.pullRequestWatches.visibleFor("s");
    await assert.rejects(h.call("session_watch", {...args, headSha: "b".repeat(40)}), /not registered/);
    assert.equal(h.sent.length, before);
    assert.deepEqual(h.db.pullRequestWatches.visibleFor("s"), watch);
    assert.equal(h.receipts.get(h.issued.connection.id, "watch"), null);
  } finally {h.db.close();}
});

test("terminal process management exposes metadata/open/close, confirms deletion and keeps raw streams out of tools", async () => {
  const h = harness();
  try {
    const opened = await h.call("shell_open", {commandId: "open", kind: "shell"});
    assert.equal(opened.receipt.status, "succeeded");
    assert.equal((await h.call("shell_list")).shells[0].shellId, "shell");
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "close", shellId: "shell"};
    const preview = await h.call("shell_close", args); assert.equal(preview.confirmationRequired, true);
    assert.equal((await h.call("shell_close", {...args, confirmationId: preview.confirmationId})).receipt.status, "succeeded");
    assert.deepEqual((await h.call("shell_list")).shells, []);
    const sends = h.sent.length; await h.call("shell_close", args); assert.equal(h.sent.length, sends);
    assert.ok(!h.operations.inventory().some(t => /^shell_(input|resize|history)$/.test(t.name)));
  } finally {h.db.close();}
});

test("Assistant observes masked runtime waits but cannot manufacture progress or end their reports", async () => {
  const h = harness();
  try {
    h.db.updateSessionStatus("s", "running", Date.now());
    const report = {waitId: "wait_fixture0001", kind: "wait_session", state: "active", target: {kind: "session", sessionId: "target", states: ["idle"]}, elapsedMs: 0, remainingMs: 10000, intervalMs: 1000};
    assert.equal(h.svc.reportSessionWait("s", report).ok, true);
    const before = h.db.sessionWaits.views("s");
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    assert.deepEqual((await h.call("session_watch_get")).waits[0].target, {kind: "session", child: false});
    await assert.rejects(h.call("session_wait_report", {commandId: "progress", report: {...report, elapsedMs: 1000}}), /not registered/);
    await assert.rejects(h.call("session_wait_report", {commandId: "end", report: {...report, state: "ended"}}), /not registered/);
    assert.deepEqual(h.db.sessionWaits.views("s"), before);
    assert.equal(h.receipts.get(h.issued.connection.id, "progress"), null);
    assert.equal(h.receipts.get(h.issued.connection.id, "end"), null);
    assert.equal(h.sent.length, 0);
  } finally {h.db.close();}
});

test("side chats are managed work with access checks for both parent and auxiliary session", async () => {
  const h = harness();
  try {
    const created = await h.call("side_chat_create", {commandId: "side"});
    assert.equal(created.receipt.status, "succeeded");
    const child = created.result.session.id;
    assert.equal(h.db.getSession(child)!.projectId, h.project.id);
    assert.equal((await h.call("side_chat_get")).sideChat.session.id, child);
    const before = h.sent.length; await h.call("side_chat_create", {commandId: "side"}); assert.equal(h.sent.length, before);
    h.db.setSessionProject(child, h.other.id, null);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    await assert.rejects(h.call("side_chat_get"), /outside current access/);
    await assert.rejects(h.call("side_chat_create", {commandId: "replace", replaceEnded: true}), /outside current access/);
  } finally {h.db.close();}
});

test("bounded export pages equal the owner redacted snapshot and require a stable digest and UTF-8 boundaries", async () => {
  const h = harness();
  try {
    h.db.appendEvent("s", {kind: "user_message", text: "Review café 🦆 and preserve Unicode."}, Date.now());
    h.db.appendEvent("s", {kind: "agent_message", text: "A bounded response."}, Date.now());
    const owner = buildAuthorizedSessionTranscriptExport(h.db, h.owner, "s", "markdown"); assert.equal(owner.ok, true); if (!owner.ok) return;
    let page = await h.call("session_export", {format: "markdown", limitBytes: 21}), combined = page.text;
    assert.equal(page.completeness, "possibly-partial");
    while (page.nextOffset !== null) {
      page = await h.call("session_export", {format: "markdown", limitBytes: 21, offset: page.nextOffset, sha256: page.sha256});
      assert.ok(Buffer.byteLength(page.text, "utf8") <= 21); combined += page.text;
    }
    assert.equal(combined, owner.body.toString("utf8")); assert.ok(!combined.includes("�"));
    const first = await h.call("session_export", {format: "markdown", limitBytes: 21});
    await assert.rejects(h.call("session_export", {format: "markdown", offset: first.nextOffset}), /sha256 is missing/);
    h.db.appendEvent("s", {kind: "user_message", text: "Changed snapshot"}, Date.now());
    await assert.rejects(h.call("session_export", {format: "markdown", offset: first.nextOffset, sha256: first.sha256}), /snapshot changed/);
  } finally {h.db.close();}
});

test("history reads share bounded epoch contracts and recheck grants after hydration", async () => {
  const h = harness();
  try {
    h.db.appendEvent("s", {kind: "user_message", text: "Recall this prompt"}, Date.now());
    const eventEpoch = h.db.getRunnerHistoryState("s")!.eventEpoch;
    assert.equal((await h.call("prompt_history", {eventEpoch, limit: 1})).prompts.length, 1);
    await assert.rejects(h.call("prompt_history", {eventEpoch: eventEpoch + 1}), /history was replaced/);
    assert.equal((await h.call("attachment_history", {eventEpoch, limit: 1, after: 0})).events.length, 0);
    await assert.rejects(h.call("history_preview", {eventEpoch, logEpoch: 0, throughSeq: 1, turnStartSeq: 1, limit: 201}), /invalid history preview/);
    h.svc.hydrateHistory = async () => {h.db.assistantConnections.revoke(h.issued.connection.id);};
    await assert.rejects(h.call("prompt_history", {eventEpoch, limit: 1}), /revoked/);
  } finally {h.db.close();}
});

test("transcript share inspection is metadata only, with no Assistant credential-issuance path", async () => {
  const h = harness();
  try {
    h.db.appendEvent("s", {kind: "user_message", text: "Shared snapshot"}, Date.now());
    const share = createAuthorizedTranscriptShare(h.db, h.owner, "s", {expiresInSeconds: 300}); assert.equal(share.ok, true); if (!share.ok) return;
    const listed = await h.call("transcript_shares"); assert.equal(listed.shares[0].shareId, share.value.share.shareId);
    assert.ok(!JSON.stringify(listed).includes(share.value.token));
    assert.ok(!h.operations.inventory().some(t => /transcript_share_(create|revoke)/.test(t.name)));
    assert.deepEqual((await h.call("session_artifacts", {limit: 1})).artifacts, []);
  } finally {h.db.close();}
});

test("reminders use the granting owner's private row, optimistic revisions and destructive confirmation", async () => {
  const h = harness();
  try {
    const set = await h.call("reminder_set", {commandId: "set", reminder: {scheduleKind: "someday", originalExpression: "Someday", wakePolicy: "regardless"}});
    assert.equal(set.receipt.status, "succeeded");
    const reminder = (await h.call("reminder_get")).reminder;
    assert.equal(reminder.scheduleKind, "someday");
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "remove", revision: reminder.revision, reminderId: reminder.reminderId};
    const preview = await h.call("reminder_remove", args); assert.equal(preview.confirmationRequired, true);
    assert.equal((await h.call("reminder_remove", {...args, confirmationId: preview.confirmationId})).receipt.status, "succeeded");
    assert.equal((await h.call("reminder_get")).reminder, null);
  } finally {h.db.close();}
});
