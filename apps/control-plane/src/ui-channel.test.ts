import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_UI_CLIENT_MESSAGE_BYTES,
  MAX_UI_SESSION_ID_LENGTH,
  MAX_UI_SESSION_SUBSCRIPTIONS,
  normalizeUiClientRawData,
  parseUiClientMessage,
} from "./ui-channel.js";

test("UI subscription messages are strict, unique, and bounded", () => {
  assert.deepEqual(parseUiClientMessage('{"type":"session_subscriptions","revision":1,"sessionIds":["s1","s2"]}'), {
    type: "session_subscriptions",
    revision: 1,
    sessionIds: ["s1", "s2"],
  });
  assert.deepEqual(parseUiClientMessage('{"type":"session_subscriptions","revision":2,"sessionIds":[]}'), {
    type: "session_subscriptions",
    revision: 2,
    sessionIds: [],
  });
  for (const invalid of [
    "not-json",
    "null",
    '{"type":"unknown","revision":1,"sessionIds":[]}',
    '{"type":"session_subscriptions","revision":0,"sessionIds":[]}',
    '{"type":"session_subscriptions","revision":1.5,"sessionIds":[]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":"s1"}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":["s1","s1"]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":[""]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":["bad\\n"]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":[],"extra":true}',
  ]) assert.equal(parseUiClientMessage(invalid), null, invalid);

  assert.equal(parseUiClientMessage(JSON.stringify({
    type: "session_subscriptions",
    revision: 1,
    sessionIds: Array.from({ length: MAX_UI_SESSION_SUBSCRIPTIONS + 1 }, (_, i) => `s${i}`),
  })), null);
  assert.equal(parseUiClientMessage(JSON.stringify({
    type: "session_subscriptions",
    revision: 1,
    sessionIds: ["s".repeat(MAX_UI_SESSION_ID_LENGTH + 1)],
  })), null);
  assert.equal(parseUiClientMessage(" ".repeat(MAX_UI_CLIENT_MESSAGE_BYTES + 1)), null);
});

test("background delivery observation messages are strict and bounded", () => {
  assert.deepEqual(parseUiClientMessage(
    '{"type":"background_delivery_observed","sessionId":"s1","continuationId":"bgcont-1"}',
  ), {
    type: "background_delivery_observed",
    sessionId: "s1",
    continuationId: "bgcont-1",
  });
  for (const invalid of [
    '{"type":"background_delivery_observed","sessionId":"","continuationId":"bgcont-1"}',
    '{"type":"background_delivery_observed","sessionId":"s1","continuationId":""}',
    '{"type":"background_delivery_observed","sessionId":"s1","continuationId":"bad\\n"}',
    '{"type":"background_delivery_observed","sessionId":"s1","continuationId":"bgcont-1","extra":true}',
  ]) assert.equal(parseUiClientMessage(invalid), null, invalid);
});

test("UI websocket raw-data normalization preserves text across supported ws shapes", () => {
  const text = Buffer.from('{"type":"session_subscriptions"}');
  assert.equal(normalizeUiClientRawData(text)?.toString("utf8"), text.toString("utf8"));
  assert.equal(normalizeUiClientRawData([text.subarray(0, 10), text.subarray(10)])?.toString("utf8"), text.toString("utf8"));
  const arrayBuffer = text.buffer.slice(text.byteOffset, text.byteOffset + text.byteLength);
  assert.equal(normalizeUiClientRawData(arrayBuffer)?.toString("utf8"), text.toString("utf8"));
  assert.equal(normalizeUiClientRawData([text, "not-a-buffer"]), null);
  assert.equal(normalizeUiClientRawData("text"), null);
});
