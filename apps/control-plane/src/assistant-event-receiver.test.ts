import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Writable } from "node:stream";
import { ASSISTANT_WORK_EVENT_KINDS, WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE, type OutboundEventEnvelope } from "@wollipog/protocol";
import { AssistantEventInbox, dispatchAssistantWake, registerAssistantEventReceiver, wakeOpenClaw } from "./assistant-event-receiver.js";
import { signAutomationTrigger } from "./automation-trigger-ingress.js";

const secret = "synthetic-receiver-secret";
const event: OutboundEventEnvelope = {version: "v1", eventId: "event-fixture", kind: "session.completed", occurredAt: 1,
  sessionId: "session-fixture", assistant: {controlPlaneId: "control-plane-fixture", connectionId: "connection-fixture",
    work: [{workId: "work-fixture", revision: 2, attentionRevision: 1}]}};

test("signed receiver durably accepts before 202, deduplicates across restart and refuses cross-connection routing", async () => {
  const root = mkdtempSync(join(tmpdir(), "assistant-inbox-"));
  const path = join(root, "inbox.sqlite");
  const sql = new DatabaseSync(path);
  AssistantEventInbox.install(sql);
  const logs: string[] = [];
  const stream = new Writable({write(chunk, _encoding, done) { logs.push(chunk.toString()); done(); }});
  const inbox = new AssistantEventInbox(sql), app = Fastify({logger: {stream}});
  let key: string | null = secret;
  registerAssistantEventReceiver(app, {controlPlaneId: "control-plane-fixture", connectionId: "connection-fixture",
    subscriptionId: "subscription-fixture", currentSecret: () => key, inbox});
  const send = (value: OutboundEventEnvelope, overrides: Record<string, string> = {}, now = Date.now()) => {
    const body = Buffer.from(JSON.stringify(value));
    const timestamp = String(Math.floor(now / 1000)), nonce = "nonce-fixture-0123456789";
    return app.inject({method: "POST", url: "/wollipog/events", headers: {
      "content-type": WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE, "x-wollipog-subscription-id": "subscription-fixture",
      "x-wollipog-event-id": value.eventId, "x-wollipog-timestamp": timestamp, "x-wollipog-nonce": nonce,
      "x-wollipog-signature": signAutomationTrigger(secret, "subscription-fixture", timestamp, nonce, body), ...overrides}, payload: body});
  };
  try {
    assert.equal((await send(event)).statusCode, 202);
    assert.equal(inbox.pending().length, 1);
    assert.equal((await send(event)).json().duplicate, true);
    assert.equal((await send(event, {}, Date.now() - 10 * 60_000)).statusCode, 401);
    assert.equal((await send(event, {"x-wollipog-event-id": "wrong-event"})).statusCode, 400);
    assert.equal((await send({...event, assistant: {...event.assistant!, connectionId: "another-connection"}})).statusCode, 400);
    assert.equal((await send({...event, occurredAt: 2})).statusCode, 409, "same ID with different bytes conflicts");
    assert.equal((await send({...event, eventId: "unsupported-kind", kind: "cost.checkpoint"})).statusCode, 400);
    for (const kind of ASSISTANT_WORK_EVENT_KINDS) {
      assert.equal((await send({...event, eventId: `event-${kind}`, kind})).statusCode, 202);
    }
    key = null;
    assert.equal((await send(event)).statusCode, 401, "revocation is checked even for duplicate requests");
    const diagnostics = logs.flatMap(line => line.trim().split("\n")).map(line => JSON.parse(line))
      .filter(line => line.event === "assistant_event_ingress");
    assert.ok(diagnostics.some(line => line.reason === "accepted" && line.duplicate === true && line.requestId && line.eventFingerprint));
    assert.ok(diagnostics.some(line => line.reason === "invalid_signature"));
    assert.equal(logs.join("").includes(secret), false);
    assert.equal(logs.join("").includes('"envelope_json"'), false);
    sql.close();
    const reopened = new DatabaseSync(path);
    try {
      const recovered = new AssistantEventInbox(reopened);
      assert.equal(recovered.accept("control-plane-fixture", "subscription-fixture", event, Buffer.from(JSON.stringify(event))), false);
      assert.equal(recovered.reserveWake("control-plane-fixture", "subscription-fixture", event.eventId, "work-fixture"), true);
      assert.equal(recovered.reserveWake("control-plane-fixture", "subscription-fixture", event.eventId, "work-fixture"), false);
      recovered.settleWake("control-plane-fixture", "subscription-fixture", event.eventId, "work-fixture");
      assert.equal(recovered.state("control-plane-fixture", "subscription-fixture", event.eventId, "work-fixture")!.state, "uncertain");
      assert.equal(recovered.reserveWake("control-plane-fixture", "subscription-fixture", event.eventId, "work-fixture"), false);
    } finally { reopened.close(); }
  } finally { await app.close(); if (sql.isOpen) sql.close(); rmSync(root, {recursive: true, force: true}); }
});

test("wake dispatch rechecks changed channel access, prevents wrong-connection routing and never replays uncertain admission", async () => {
  const sql = new DatabaseSync(":memory:");
  AssistantEventInbox.install(sql);
  const inbox = new AssistantEventInbox(sql);
  inbox.accept("control-plane-fixture", "subscription-fixture", event, Buffer.from(JSON.stringify(event)));
  const item = inbox.pending()[0]!;
  const input = {gatewayOrigin: "http://127.0.0.1", hookToken: "synthetic-hook-token",
    controlPlaneId: "control-plane-fixture", connectionId: "connection-fixture", workId: "work-fixture", eventId: event.eventId,
    binding: {id: "binding-fixture", connectionId: "connection-fixture", requesterId: "requester-fixture",
      accountId: "account-fixture", conversationId: "conversation-fixture", destination: "channel:123",
      agentId: "agent-fixture", sessionKey: "agent:agent-fixture:discord:channel:123", projects: "all" as const, revision: 1, revoked: false}};
  let attempts = 0;
  const request = (async () => { attempts++; throw new Error("Synthetic uncertain network outcome"); }) as typeof fetch;
  try {
    await assert.rejects(dispatchAssistantWake(inbox, item, async () => input, () => false, request), /destination access changed/);
    assert.equal(attempts, 0);
    await assert.rejects(dispatchAssistantWake(inbox, item, async () => ({...input, connectionId: "another-connection"}), () => true, request), /origin/);
    assert.equal(attempts, 0);
    await dispatchAssistantWake(inbox, item, async () => input, () => true, request);
    assert.equal(attempts, 1);
    await dispatchAssistantWake(inbox, item, async () => input, () => true, request);
    assert.equal(attempts, 1);
    assert.equal(inbox.state(item.controlPlaneId, item.subscriptionId, item.eventId, item.workId)!.state, "uncertain");
  } finally { sql.close(); }
});

test("real loopback hook transport uses the bound conversation, disables auto-delivery and requires a run receipt", async () => {
  const requests: {authorization?: string; body: Record<string, unknown>}[] = [];
  let confirmed = false;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      requests.push({authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8"))});
      res.writeHead(202, {"content-type": "application/json"}).end(JSON.stringify(confirmed ? {runId: "run-fixture"} : {ok: true}));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const binding = {id: "binding-fixture", connectionId: "connection-fixture", requesterId: "requester-fixture",
    accountId: "account-fixture", conversationId: "conversation-fixture", destination: "channel:123",
    agentId: "agent-fixture", sessionKey: "agent:agent-fixture:discord:channel:123", projects: "all" as const, revision: 1, revoked: false};
  const input = {gatewayOrigin: `http://127.0.0.1:${address.port}`, hookToken: "synthetic-hook-token", binding,
    controlPlaneId: "control-plane-fixture", connectionId: "connection-fixture", workId: "work-fixture", eventId: event.eventId};
  try {
    assert.deepEqual(await wakeOpenClaw(input), {});
    confirmed = true;
    assert.deepEqual(await wakeOpenClaw(input), {runId: "run-fixture"});
    assert.equal(requests[0]!.authorization, "Bearer synthetic-hook-token");
    assert.equal(requests[0]!.body.to, binding.destination);
    assert.equal(requests[0]!.body.sessionKey, binding.sessionKey);
    assert.equal(requests[0]!.body.deliver, false);
    assert.equal(requests[0]!.body.idempotencyKey, requests[1]!.body.idempotencyKey);
    await assert.rejects(wakeOpenClaw({...input, connectionId: "another-connection"}), /binding is unavailable/);
    await assert.rejects(wakeOpenClaw({...input, binding: {...binding, revoked: true}}), /binding is unavailable/);
    await assert.rejects(wakeOpenClaw({...input, gatewayOrigin: "http://private.example.test"}), /HTTPS Gateway/);
  } finally { server.close(); await once(server, "close"); }
});
