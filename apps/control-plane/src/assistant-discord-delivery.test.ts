import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantManagement } from "./assistant-composition.js";
import { registerAssistantDiscordIngress } from "./assistant-discord-ingress.js";
import { AssistantDiscordDelivery, type DiscordDeliveryConnection } from "./assistant-discord-delivery.js";
import { startDiscordBridge, type BridgeSettings } from "./assistant-discord-bridge.js";
import { signAutomationTrigger } from "./automation-trigger-ingress.js";

async function harness(options: {direct?: boolean; privateThread?: boolean} = {}) {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({runnerId: "runner-fixture", hostname: "fixture", os: "linux", version: "fixture", workspaces: [], agents: []}, 1);
  const identity = db.localIdentityContext(), owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const issued = db.assistantConnections.create(owner, "Fixture", {operations: "all", projects: "all"});
  const {operations, ingress} = createAssistantManagement(db, new SessionsService(db, new Hub(db), {info() {}, warn() {}, error() {}}));
  const binding = db.assistantWork.createBinding(owner, issued.connection.id, {requesterId: "234", accountId: "account-fixture",
    conversationId: "conversation-fixture", destination: options.direct ? "user:234" : "channel:123", agentId: "assistant-fixture",
    sessionKey: options.direct ? "agent:assistant-fixture:discord:account-fixture:direct:234" : "agent:assistant-fixture:discord:channel:123", projects: "all"});
  const session = db.createSession({id: "session-fixture", runnerId: "runner-fixture", workspaceId: null, agentId: null,
    title: "Private fixture title", useWorktree: false, driver: "acp", config: {}, now: 2});
  db.assistantWork.track(operations, issued.connection.id, {workId: "work-fixture", sessionId: session.id, bindingId: binding.id});
  db.updateSessionStatus(session.id, "completed", 3);
  const connector = ingress.issue(owner, issued.connection.id, binding.id, ["work_updates"]);
  const env: Record<string, string> = {ASSISTANT_FIXTURE: issued.token, CONNECTOR_FIXTURE: connector.token, BOT_FIXTURE: "synthetic-bot-fixture", HOOK_FIXTURE: "synthetic-hook-fixture", SIGNING_FIXTURE: "synthetic-signing-fixture"};
  const connections: DiscordDeliveryConnection[] = [{name: "local", origin: "http://127.0.0.1:38000", controlPlaneId: db.instanceId(),
    connectionId: issued.connection.id, assistantTokenEnv: "ASSISTANT_FIXTURE", bindings: [{...binding,
      bindingId: binding.id, connectorTokenEnv: "CONNECTOR_FIXTURE", updates: {enabled: true, botTokenEnv: "BOT_FIXTURE", botUserId: "345", ...(options.direct ? {dmChannelId: "123"} : {})}}]}];
  const app = Fastify();
  registerAssistantDiscordIngress(app, {db, ingress, requestHuman: () => null});
  let canView = true, wrongChannel = false, failConfirm = false, loseSendResponse = false, revokeDuringBegin = false, policy = true;
  let memberPresent = true, wrongRecipient = false;
  let sends = 0, hooks = 0;
  let discordCalls = 0;
  const messages: any[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)), body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (target.origin === connections[0]!.origin) {
      if (failConfirm && body?.action === "confirm") return json({error: "fixture outage"}, 503);
      const response = await app.inject({method: (init?.method ?? "GET") as "GET" | "POST", url: target.pathname + target.search,
        headers: init?.headers as Record<string, string>, ...(body === undefined ? {} : {payload: body})});
      if (revokeDuringBegin && body?.action === "begin") canView = false;
      return json(response.json(), response.statusCode);
    }
    if (target.origin === "http://127.0.0.1:38001") {hooks++; return json({runId: "hook-run-fixture"});}
    assert.equal(target.origin, "https://discord.com");
    discordCalls++;
    assert.equal((init?.headers as Record<string, string>).authorization, "Bot synthetic-bot-fixture");
    const path = target.pathname.replace("/api/v10", "");
    if (path === "/users/@me") return json({id: "345", bot: true});
    if (path === "/guilds/567/members/234") return json({user: {id: "234"}, roles: []});
    if (path === "/channels/123") return json({id: wrongChannel ? "456" : "123", ...(options.direct
      ? {type: 1, recipients: [{id: wrongRecipient ? "789" : "234"}]}
      : {type: options.privateThread ? 12 : 0, guild_id: "567", ...(options.privateThread ? {parent_id: "456", thread_metadata: {archived: false, locked: false}} : {})})});
    if (path.startsWith("/channels/123/permissions/member/")) return json({permissions: canView ? String(68608n | (options.privateThread ? 1n << 38n : 0n)) : "0"});
    if (path.startsWith("/channels/123/thread-members/")) return memberPresent
      ? json({id: "123", user_id: path.split("/").at(-1)}) : json({error: "synthetic missing membership"}, 404);
    if (path === "/channels/123/messages" && init?.method === "POST") {
      sends++;
      assert.deepEqual(body.allowed_mentions, {parse: []});
      assert.equal(body.enforce_nonce, true);
      assert.equal(body.content.includes("Private fixture"), false);
      messages.push({id: String(677 + sends), channel_id: "123", author: {id: "345"}, nonce: body.nonce, content: body.content});
      if (loseSendResponse) throw new Error("synthetic disconnected response");
      return json(messages.at(-1));
    }
    // The official message contract makes nonce optional; REST reads need not retain it.
    const readback = (message: any) => {const {nonce: _ephemeral, ...stored} = message; return stored;};
    if (path === "/channels/123/messages") return json(messages.map(readback));
    if (/^\/channels\/123\/messages\/[0-9]+$/.test(path)) return json(readback(messages.find(message => message.id === path.split("/").at(-1))));
    throw new Error("unexpected fixture route");
  }) as typeof fetch;
  const deps = {connections: () => connections, secret: (name: string) => env[name], currentPolicy: () => policy, request};
  return {db, owner, issued, operations, ingress, binding, session, connector, connections, deps, app, env, messages,
    counts: () => ({sends, hooks}), apiCalls: () => discordCalls, access: (value: boolean) => {canView = value;}, wrong: () => {wrongChannel = true;},
    outage: (value: boolean) => {failConfirm = value;}, lost: (value: boolean) => {loseSendResponse = value;},
    race: () => {revokeDuringBegin = true;}, policy: (value: boolean) => {policy = value;},
    leave: () => {memberPresent = false;}, recipient: () => {wrongRecipient = true;},
    close: async () => {await app.close(); db.close();}};
}

test("production sender composes real source/binding/reply fences, keeps private content out, and deduplicates", async () => {
  const h = await harness(), sql = new DatabaseSync(":memory:");
  try {
    const sender = new AssistantDiscordDelivery(sql, h.deps);
    assert.deepEqual(await sender.deliver("local", h.binding.id, "work-fixture"), {state: "confirmed"});
    const calls = h.apiCalls();
    assert.ok(calls <= 15, `one public-channel send uses at most 15 Discord calls, got ${calls}`);
    assert.deepEqual(await sender.deliver("local", h.binding.id, "work-fixture"), {state: "confirmed"});
    assert.equal(h.apiCalls(), calls, "confirmed work performs no new Discord reads on a reconciliation sweep");
    assert.equal(h.counts().sends, 1);
    assert.match(h.messages[0].content, /^Work completed\. http:\/\/127\.0\.0\.1:38000\/sessions\//);
    assert.equal(h.db.raw().prepare("SELECT state FROM assistant_reply_intents").get()!.state, "confirmed");
    h.db.setPendingApproval(h.session.id, {requestId: "question-fixture", kind: "question", title: "Private fixture question", options: [], async: true});
    await sender.deliver("local", h.binding.id, "work-fixture");
    assert.match(h.messages[1].content, /\/attention\/.*Discord reply grants no approval/);
    assert.equal(h.messages[1].content.includes("Private fixture"), false);
    h.db.assistantWork.revokeBinding(h.owner, h.issued.connection.id, h.binding.id);
    await assert.rejects(sender.deliver("local", h.binding.id, "work-fixture"));
    assert.equal(h.counts().sends, 2);
  } finally {sql.close(); await h.close();}
});

test("private-thread membership and exact DM recipients are rechecked without falling back to the parent or another conversation", async () => {
  for (const options of [{direct: true}, {privateThread: true}]) {
    const h = await harness(options), sql = new DatabaseSync(":memory:");
    try {
      const sender = new AssistantDiscordDelivery(sql, h.deps);
      if (options.direct) h.recipient(); else h.leave();
      await assert.rejects(sender.deliver("local", h.binding.id, "work-fixture"));
      assert.equal(h.counts().sends, 0);
    } finally {sql.close(); await h.close();}
    const allowed = await harness(options), journal = new DatabaseSync(":memory:");
    try {
      await new AssistantDiscordDelivery(journal, allowed.deps).deliver("local", allowed.binding.id, "work-fixture");
      assert.equal(allowed.counts().sends, 1);
    } finally {journal.close(); await allowed.close();}
  }
});

test("unknown Discord sends reconcile durable notice references after restart without nonce on reads or a second POST", async () => {
  const h = await harness(), root = mkdtempSync(join(tmpdir(), "discord-delivery-fixture-")), path = join(root, "inbox.sqlite");
  let sql = new DatabaseSync(path);
  try {
    h.lost(true);
    await assert.rejects(new AssistantDiscordDelivery(sql, h.deps).deliver("local", h.binding.id, "work-fixture"));
    assert.equal(h.counts().sends, 1);
    sql.close(); sql = new DatabaseSync(path);
    h.lost(false);
    assert.deepEqual(await new AssistantDiscordDelivery(sql, h.deps).deliver("local", h.binding.id, "work-fixture"), {state: "confirmed"});
    assert.equal(h.counts().sends, 1);
  } finally {sql.close(); rmSync(root, {recursive: true, force: true}); await h.close();}
});

test("lost-response readback refuses ambiguous or changed notice bodies instead of guessing a receipt", async () => {
  const h = await harness(), sql = new DatabaseSync(":memory:");
  try {
    const sender = new AssistantDiscordDelivery(sql, h.deps);
    h.lost(true);
    await assert.rejects(sender.deliver("local", h.binding.id, "work-fixture"));
    const original = h.messages[0].content;
    h.messages.push({...h.messages[0], id: "679"});
    assert.deepEqual(await sender.deliver("local", h.binding.id, "work-fixture"), {state: "uncertain"});
    h.messages.pop(); h.messages[0].content = `${original} changed`;
    assert.deepEqual(await sender.deliver("local", h.binding.id, "work-fixture"), {state: "uncertain"});
    h.messages[0].content = original;
    assert.deepEqual(await sender.deliver("local", h.binding.id, "work-fixture"), {state: "confirmed"});
    assert.equal(h.counts().sends, 1);
  } finally {sql.close(); await h.close();}
});

test("older local journals without exact notice evidence remain uncertain after schema upgrade", async () => {
  const h = await harness(), sql = new DatabaseSync(":memory:");
  try {
    h.lost(true);
    await assert.rejects(new AssistantDiscordDelivery(sql, h.deps).deliver("local", h.binding.id, "work-fixture"));
    sql.exec("ALTER TABLE assistant_discord_reply_journal DROP COLUMN notice_digest");
    const sender = new AssistantDiscordDelivery(sql, h.deps);
    assert.deepEqual(await sender.deliver("local", h.binding.id, "work-fixture"), {state: "uncertain"});
    assert.equal(h.counts().sends, 1);
  } finally {sql.close(); await h.close();}
});

test("oversized resolution notices are refused before reply reservation or Discord transport", async () => {
  const h = await harness(), sql = new DatabaseSync(":memory:");
  try {
    h.db.setPendingApproval(h.session.id, {requestId: "q".repeat(2000), kind: "question", title: "Private fixture", options: [], async: true});
    await assert.rejects(new AssistantDiscordDelivery(sql, h.deps).deliver("local", h.binding.id, "work-fixture"), /notice_exceeds/);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM assistant_reply_intents").get()!.n, 0);
    assert.equal(h.counts().sends, 0);
  } finally {sql.close(); await h.close();}
});

test("a control-plane confirmation outage retains real message IDs and confirms after restart without resending", async () => {
  const h = await harness(), sql = new DatabaseSync(":memory:");
  try {
    h.outage(true);
    await assert.rejects(new AssistantDiscordDelivery(sql, h.deps).deliver("local", h.binding.id, "work-fixture"));
    assert.equal(sql.prepare("SELECT message_id FROM assistant_discord_reply_journal").get()!.message_id, "678");
    h.outage(false);
    await new AssistantDiscordDelivery(sql, h.deps).deliver("local", h.binding.id, "work-fixture");
    assert.equal(h.counts().sends, 1);
  } finally {sql.close(); await h.close();}
});

test("changed channel access, wrong conversation, policy withdrawal and a post-reservation access race prevent sends", async () => {
  for (const configure of [(h: Awaited<ReturnType<typeof harness>>) => h.access(false), h => h.wrong(), h => h.policy(false), h => h.race()] as ((h: Awaited<ReturnType<typeof harness>>) => void)[]) {
    const h = await harness(), sql = new DatabaseSync(":memory:");
    try {configure(h); await assert.rejects(new AssistantDiscordDelivery(sql, h.deps).deliver("local", h.binding.id, "work-fixture")); assert.equal(h.counts().sends, 0);}
    finally {sql.close(); await h.close();}
  }
});

test("signed receiver and reconciliation drive one hook admission and one reply across duplicate events and bridge recreation", async () => {
  const h = await harness(), sql = new DatabaseSync(":memory:");
  const settings: BridgeSettings = {connections: h.connections.map(connection => ({...connection,
    events: {subscriptionId: "subscription-fixture", path: "fixture", signingSecretEnv: "SIGNING_FIXTURE"}})),
    bridge: {port: 38002, gatewayOrigin: "http://127.0.0.1:38001", hookTokenEnv: "HOOK_FIXTURE"}};
  const reasons: string[] = [];
  const deps = {...h.deps, sql, settings: () => settings, diagnostic: (reason: string) => reasons.push(reason), listen: false};
  let bridge = await startDiscordBridge(deps);
  try {
    const work = h.db.assistantWork.get(h.issued.connection.id, "work-fixture")!;
    const body = Buffer.from(JSON.stringify({version: "v1", eventId: "event-fixture", kind: "session.completed", occurredAt: 1,
      sessionId: h.session.id, assistant: {controlPlaneId: h.db.instanceId(), connectionId: h.issued.connection.id,
        work: [{workId: work.workId, revision: work.revision, attentionRevision: work.attentionRevision}]}}));
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = "nonce-fixture-0123456789";
    const send = () => bridge.app.inject({method: "POST", url: "/events/fixture/wollipog/events", payload: body,
      headers: {"content-type": WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE, "x-wollipog-subscription-id": "subscription-fixture", "x-wollipog-event-id": "event-fixture",
        "x-wollipog-timestamp": timestamp, "x-wollipog-nonce": nonce, "x-wollipog-signature": signAutomationTrigger(h.env.SIGNING_FIXTURE!, "subscription-fixture", timestamp, nonce, body)}});
    assert.equal((await send()).statusCode, 202);
    assert.equal((await send()).json().duplicate, true);
    await bridge.tick();
    assert.deepEqual(h.counts(), {sends: 1, hooks: 1});
    await bridge.close(); bridge = await startDiscordBridge(deps);
    await bridge.tick();
    assert.deepEqual(h.counts(), {sends: 1, hooks: 1});
    assert.ok(reasons.includes("signed_event_accepted"));
    assert.equal(reasons.filter(reason => reason === "hook_admission_accepted").length, 1);
    assert.ok(reasons.includes("work_reply_confirmed"));
    assert.equal(reasons.some(reason => reason.includes("blocked") || reason.includes("unavailable") || reason.includes("uncertain")), false);
  } finally {await bridge.close(); sql.close(); await h.close();}
});
