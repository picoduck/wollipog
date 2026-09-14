import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { verifyAutomationTriggerSignature } from "./automation-trigger-ingress.js";
import type { ClaimedOutboundEventDelivery, ControlPlaneDb } from "./db.js";
import {
  OUTBOUND_EVENT_RETRY_DELAYS_MS,
  OutboundEventsService,
  isBlockedOutboundAddress,
  resolveOutboundTarget,
  validateOutboundCallbackUrl,
} from "./outbound-events.js";

function delivery(overrides: Partial<ClaimedOutboundEventDelivery> = {}): ClaimedOutboundEventDelivery {
  return {
    deliveryId: "oed_1",
    subscriptionId: "oes_1",
    eventId: "oev_1",
    kind: "session.created",
    callbackUrl: "https://events.example.test/hook",
    secret: "wollipogwhsec_test",
    payloadJson: JSON.stringify({ version: "v1", eventId: "oev_1", kind: "session.created", sessionId: "s_1" }),
    attempt: 1,
    leaseId: "lease_1",
    ...overrides,
  };
}

function fakeDb(input: {
  claims?: ClaimedOutboundEventDelivery[];
  settled?: Array<Record<string, unknown>>;
  revoked?: boolean;
} = {}): ControlPlaneDb {
  let claimed = false;
  return {
    claimOutboundEventDeliveries: () => claimed ? [] : (claimed = true, input.claims ?? []),
    settleOutboundEventDelivery: (receipt: Record<string, unknown>) => {
      input.settled?.push(receipt);
      return true;
    },
    compactOutboundEventDeliveries: () => 0,
    revokeOutboundEventSubscription: () => input.revoked ?? true,
  } as unknown as ControlPlaneDb;
}

const quietLogger = { info: () => {}, warn: () => {} };

test("callback validation rejects credentials, redirects-to-private candidates, and non-HTTPS public URLs", async () => {
  assert.equal(validateOutboundCallbackUrl("https://user:pass@example.com/hook").ok, false);
  assert.equal(validateOutboundCallbackUrl("https://example.com/hook#secret").ok, false);
  assert.equal(validateOutboundCallbackUrl("http://example.com/hook").ok, false);
  assert.equal(validateOutboundCallbackUrl("http://127.0.0.1:9876/hook").ok, true);
  assert.equal(validateOutboundCallbackUrl("https://example.com/hook").ok, true);

  const privateDns = await resolveOutboundTarget("https://events.example.test/hook",
    (async () => [{ address: "10.1.2.3", family: 4 }]) as never);
  assert.equal(privateDns.ok, false);
  const mixedDns = await resolveOutboundTarget("https://events.example.test/hook",
    (async () => [
      { address: "203.0.113.10", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ]) as never);
  assert.equal(mixedDns.ok, false, "one private or reserved answer rejects the whole DNS set");
  const publicDns = await resolveOutboundTarget("https://events.example.test/hook",
    (async () => [{ address: "93.184.216.34", family: 4 }]) as never);
  assert.equal(publicDns.ok, true);
});

test("generated address classes fail closed for private, link-local, multicast, and documentation networks", () => {
  const blocked = [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.99.1.2", "169.254.1.1",
    "172.16.0.1", "172.31.255.255", "192.0.2.1", "192.168.1.1", "198.18.0.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::10.0.0.1", "64:ff9b::a00:1", "64:ff9b:1::a00:1",
    "fc00::1", "fdff::1", "fe80::1", "ff02::1", "2001:db8::1",
  ];
  for (const address of blocked) assert.equal(isBlockedOutboundAddress(address), true, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedOutboundAddress(address), false, address);
  }
});

test("503 retries use the documented bounded first delay and journal only content-free error data", async () => {
  const settled: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const claimedAt = 50_000;
  const item = delivery();
  const service = new OutboundEventsService(fakeDb({ claims: [item], settled }), {
    info: (fields) => logs.push(fields),
    warn: (fields) => logs.push(fields),
  }, (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
  async () => ({ statusCode: 503 }));
  await service.tick(claimedAt);
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.disposition, "retry");
  assert.equal(settled[0]?.nextAttemptAt, claimedAt + OUTBOUND_EVENT_RETRY_DELAYS_MS[0]);
  assert.equal(settled[0]?.statusCode, 503);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(item.secret), false);
  assert.equal(serialized.includes(item.callbackUrl), false);
  assert.equal(serialized.includes(item.payloadJson), false);
});

test("410 fails immediately, pauses the subscription, and never schedules a retry", async () => {
  const settled: Array<Record<string, unknown>> = [];
  const service = new OutboundEventsService(fakeDb({ claims: [delivery()], settled }), quietLogger,
    (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    async () => ({ statusCode: 410 }));
  await service.tick(10_000);
  assert.equal(settled[0]?.disposition, "failed");
  assert.match(String(settled[0]?.pauseReason), /410 Gone/);
  assert.equal("nextAttemptAt" in settled[0]!, false);
});

test("the sixth retryable failure exhausts the bounded chain and records a visible pause reason", async () => {
  const settled: Array<Record<string, unknown>> = [];
  const service = new OutboundEventsService(fakeDb({
    claims: [delivery({ attempt: OUTBOUND_EVENT_RETRY_DELAYS_MS.length + 1 })],
    settled,
  }), quietLogger, (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
  async () => ({ statusCode: 503 }));
  await service.tick(10_000);
  assert.equal(settled[0]?.disposition, "failed");
  assert.match(String(settled[0]?.pauseReason), /6 bounded delivery attempts/);
  assert.equal("nextAttemptAt" in settled[0]!, false);
});

test("a loopback delivery is signed over its exact bytes and carries stable correlation headers", async (t) => {
  let received: { headers: Record<string, string | string[] | undefined>; body: Buffer } | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = { headers: request.headers, body: Buffer.concat(chunks) };
      response.writeHead(204).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const settled: Array<Record<string, unknown>> = [];
  const item = delivery({ callbackUrl: `http://127.0.0.1:${address.port}/hook?source=test` });
  const service = new OutboundEventsService(fakeDb({ claims: [item], settled }), quietLogger);
  await service.tick(10_000);
  assert.equal(settled[0]?.disposition, "delivered");
  assert.ok(received);
  assert.equal(received.body.toString("utf8"), item.payloadJson);
  assert.equal(received.headers["content-type"], "application/vnd.wollipog.outbound-event+json");
  assert.equal(received.headers["x-wollipog-subscription-id"], item.subscriptionId);
  assert.equal(received.headers["x-wollipog-event-id"], item.eventId);
  assert.equal(verifyAutomationTriggerSignature(item.secret, item.subscriptionId, {
    timestamp: String(received.headers["x-wollipog-timestamp"]),
    nonce: String(received.headers["x-wollipog-nonce"]),
    signature: String(received.headers["x-wollipog-signature"]),
  }, received.body, Number(received.headers["x-wollipog-timestamp"]) * 1_000), true);
});

test("a hostname delivery uses its DNS-pinned address on Node with automatic family selection", async (t) => {
  let receivedHost: string | undefined;
  const server = createServer((request, response) => {
    receivedHost = request.headers.host;
    request.resume();
    response.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const settled: Array<Record<string, unknown>> = [];
  const item = delivery({ callbackUrl: `http://pinned.localhost:${address.port}/hook` });
  const service = new OutboundEventsService(fakeDb({ claims: [item], settled }), quietLogger,
    (async () => [{ address: "127.0.0.1", family: 4 }]) as never);
  await service.tick(10_000);
  assert.equal(settled[0]?.disposition, "delivered");
  assert.equal(receivedHost, `pinned.localhost:${address.port}`);
});

test("revocation aborts an in-flight request before recording any successful receipt", async () => {
  const settled: Array<Record<string, unknown>> = [];
  let observedAbort = false;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const service = new OutboundEventsService(fakeDb({ claims: [delivery()], settled }), quietLogger,
    (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    async (_target, _delivery, signal) => {
      started();
      return await new Promise((_, reject) => signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("aborted"));
      }, { once: true }));
    });
  const ticking = service.tick(10_000);
  await begun;
  assert.equal(service.revoke("oes_1").ok, true);
  await ticking;
  assert.equal(observedAbort, true);
  assert.notEqual(settled[0]?.disposition, "delivered");
});
