import assert from "node:assert/strict";
import test from "node:test";
import type { OutboundEventDeliveryView, OutboundEventSubscriptionView } from "@wollipog/protocol";
import {
  alsoIncludesLabel,
  callbackParts,
  callbackUrlError,
  CALLBACK_URL_ERROR,
  deliveryFailure,
  deliveryResult,
  lastDeliveryLabel,
  nextRetryLabel,
  OUTBOUND_EVENT_GROUPS,
  outboundEventLabel,
  spanInWords,
  subscriptionStatus,
} from "./outbound-events.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const subscription = (overrides: Partial<OutboundEventSubscriptionView> = {}): OutboundEventSubscriptionView => ({
  subscriptionId: "sub",
  callbackUrl: "https://events.example.com/hooks",
  scope: { kind: "project", projectId: "project" },
  eventKinds: ["session.completed"],
  includeSessionName: false,
  includeQuestionTitle: false,
  state: "active",
  generation: 1,
  createdBy: { kind: "human", id: "test" },
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const delivery = (overrides: Partial<OutboundEventDeliveryView> = {}): OutboundEventDeliveryView => ({
  deliveryId: "delivery",
  subscriptionId: "sub",
  eventId: "event",
  kind: "session.completed",
  status: "delivered",
  attemptCount: 1,
  createdAt: NOW - 10 * MINUTE,
  // Settled as it was attempted, unless a test says otherwise.
  updatedAt: overrides.lastAttemptAt ?? NOW - 10 * MINUTE,
  lastAttemptAt: NOW - 10 * MINUTE,
  ...overrides,
});

test("the callback check accepts only a full HTTPS address", () => {
  for (const value of ["https://example.com/hooks", " https://events.example.com:8443/a?b=c ", "https://[::1]/hooks"]) {
    assert.equal(callbackUrlError(value), null, value);
  }
  for (const value of ["", "not a url", "example.com/hooks", "http://example.com/hooks", "ftp://example.com", "https://"]) {
    assert.equal(callbackUrlError(value), CALLBACK_URL_ERROR, value);
  }
});

test("a callback reads as its host and path, never its scheme or query", () => {
  assert.deepEqual(callbackParts("https://events.example.com/hooks/wollipog?token=secret#x"),
    { host: "events.example.com", hostAndPath: "events.example.com/hooks/wollipog" });
  assert.deepEqual(callbackParts("https://events.example.com:8443/"), { host: "events.example.com:8443", hostAndPath: "events.example.com:8443" });
});

test("every event kind has a Title Case name and one group", () => {
  const kinds = OUTBOUND_EVENT_GROUPS.flatMap((group) => group.kinds);
  assert.equal(new Set(kinds).size, 11);
  for (const kind of kinds) assert.match(outboundEventLabel(kind), /^[A-Z][a-z]+( [A-Z][a-z]+)*$/, kind);
  assert.equal(outboundEventLabel("checks.failed"), "Checks Failed");
});

test("a failed attempt reads in words", () => {
  const failed = (overrides: Partial<OutboundEventDeliveryView>) => deliveryFailure(delivery({ status: "failed", ...overrides }));
  assert.equal(failed({ statusCode: 500, error: "Callback returned 500" }), "HTTP 500");
  assert.equal(failed({ statusCode: 302, error: "Callback redirect 302 was not followed" }), "HTTP 302");
  assert.equal(failed({ error: "connect ECONNREFUSED 10.0.0.1:443" }), "Connection Refused");
  assert.equal(failed({ error: "Delivery timed out" }), "Timed Out");
  assert.equal(failed({ error: "callback hostname could not be resolved" }), "Address Not Found");
  assert.equal(failed({ error: "callback hostname did not resolve to an address" }), "Address Not Found");
  assert.equal(failed({ error: "callback hostname resolves to a private, loopback, link-local, or reserved address" }), "Address Not Allowed");
  assert.equal(failed({ error: "callback hostname did not resolve to an allowed address" }), "Address Not Allowed");
  assert.equal(failed({ error: "self-signed certificate in certificate chain" }), "Certificate Error");
  assert.equal(failed({ error: "Delivery transport failed" }), "Delivery Failed");
  assert.equal(deliveryFailure(delivery({ status: "retrying", statusCode: 503 })), "HTTP 503");
  // A retry the server deferred after a rotation is not a failure.
  assert.equal(deliveryFailure(delivery({ status: "retrying", error: "Delivery deferred after subscription secret rotation" })), null);
  assert.equal(deliveryFailure(delivery()), null);
});

test("a delivery's result is one badge: Delivered, the failure in words, or where it stands", () => {
  assert.deepEqual(deliveryResult(delivery()), { label: "Delivered", tone: "success", pulse: false });
  assert.deepEqual(deliveryResult(delivery({ status: "failed", statusCode: 500 })), { label: "HTTP 500", tone: "danger", pulse: false });
  assert.equal(deliveryResult(delivery({ status: "pending", attemptCount: 0 })).label, "Pending");
  assert.equal(deliveryResult(delivery({ status: "delivering" })).label, "Sending");
  assert.equal(deliveryResult(delivery({ status: "dropped", error: "Subscription revoked before delivery" })).label, "Dropped");
});

test("the next retry is in words, and a delivery out of attempts gave up", () => {
  assert.equal(nextRetryLabel(delivery({ status: "retrying", nextRetryAt: NOW + 6 * MINUTE }), NOW), "In 6 minutes");
  assert.equal(nextRetryLabel(delivery({ status: "retrying", nextRetryAt: NOW + 2 * 60 * MINUTE }), NOW), "In 2 hours");
  assert.equal(nextRetryLabel(delivery({ status: "retrying", nextRetryAt: NOW + 45_000 }), NOW), "In less than a minute");
  assert.equal(nextRetryLabel(delivery({ status: "retrying", nextRetryAt: NOW - 1_000 }), NOW), "Due now");
  assert.equal(nextRetryLabel(delivery({ status: "failed" }), NOW), "Gave up");
  assert.equal(nextRetryLabel(delivery(), NOW), null);
  assert.equal(spanInWords(MINUTE), "1 minute");
  assert.equal(spanInWords(3 * 24 * 60 * MINUTE), "3 days");
});

test("the subscription's badge: Delivery Failed when its latest settled delivery failed, else Paused or Active", () => {
  assert.equal(subscriptionStatus(subscription(), []), "active");
  assert.equal(subscriptionStatus(subscription({ state: "paused" }), []), "paused");
  const failedLatest = [
    delivery({ deliveryId: "a", lastAttemptAt: NOW - 30 * MINUTE }),
    delivery({ deliveryId: "b", status: "failed", statusCode: 500, lastAttemptAt: NOW - MINUTE }),
  ];
  assert.equal(subscriptionStatus(subscription(), failedLatest), "delivery_failed");
  assert.equal(subscriptionStatus(subscription({ state: "paused", pauseReason: "Paused after 6 bounded delivery attempts" }), failedLatest),
    "delivery_failed", "a pause the failures caused");
  // Delivered after the failure, and a newer delivery not attempted yet, are healthy.
  assert.equal(subscriptionStatus(subscription(), [
    delivery({ deliveryId: "c", status: "pending", attemptCount: 0, lastAttemptAt: undefined, updatedAt: NOW }),
    delivery({ deliveryId: "b", status: "failed", statusCode: 500, lastAttemptAt: NOW - 30 * MINUTE }),
    delivery({ deliveryId: "a", lastAttemptAt: NOW - MINUTE }),
  ]), "active");
  // A pause for a backlog, with the last delivery delivered, is Paused.
  assert.equal(subscriptionStatus(subscription({ state: "paused", pauseReason: "Paused because 1000 deliveries are pending" }),
    [delivery()]), "paused");
});

test("deliveries claimed in one tick are ordered by when they settled, in either API order (CR-1.1)", () => {
  // The control plane gives every delivery it claims in one tick the same lastAttemptAt; updatedAt
  // is when each settled.
  const claimedAt = NOW - 5 * MINUTE;
  const delivered = delivery({ deliveryId: "ok", lastAttemptAt: claimedAt, updatedAt: claimedAt + 1_000 });
  const failed = delivery({ deliveryId: "bad", status: "failed", statusCode: 500, lastAttemptAt: claimedAt, updatedAt: claimedAt + 2_000 });
  for (const order of [[delivered, failed], [failed, delivered]]) {
    assert.equal(subscriptionStatus(subscription(), order), "delivery_failed");
    assert.equal(lastDeliveryLabel(subscription(), order, NOW), "Last delivery failed 5 minutes ago");
  }
  const recovered = delivery({ deliveryId: "ok", lastAttemptAt: claimedAt, updatedAt: claimedAt + 3_000 });
  for (const order of [[recovered, failed], [failed, recovered]]) {
    assert.equal(subscriptionStatus(subscription(), order), "active");
  }
});

test("the last delivery reads in words", () => {
  assert.equal(lastDeliveryLabel(subscription(), [], NOW), "No deliveries yet");
  assert.equal(lastDeliveryLabel(subscription({ lastDeliveredAt: NOW - 4 * MINUTE }), [], NOW), "Last delivered 4 minutes ago");
  assert.equal(lastDeliveryLabel(subscription(), [delivery({ lastAttemptAt: NOW - 10_000 })], NOW), "Last delivered just now");
  assert.equal(lastDeliveryLabel(subscription(), [delivery({ status: "failed", statusCode: 500, lastAttemptAt: NOW - 2 * 60 * MINUTE })], NOW),
    "Last delivery failed 2 hours ago");
});

test("Also Includes names only what is included", () => {
  assert.equal(alsoIncludesLabel({ includeSessionName: false, includeQuestionTitle: false }), null);
  assert.equal(alsoIncludesLabel({ includeSessionName: true, includeQuestionTitle: false }), "Session names");
  assert.equal(alsoIncludesLabel({ includeSessionName: false, includeQuestionTitle: true }), "Question titles");
  assert.equal(alsoIncludesLabel({ includeSessionName: true, includeQuestionTitle: true }), "Session names and question titles");
});
