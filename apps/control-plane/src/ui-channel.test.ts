import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_UI_CLIENT_MESSAGE_BYTES,
  MAX_UI_POD_SUBSCRIPTIONS,
  MAX_UI_SESSION_ID_LENGTH,
  MAX_UI_SESSION_SUBSCRIPTIONS,
  normalizeUiClientRawData,
  parseUiClientMessage,
} from "./ui-channel.js";

test("UI subscription messages are strict, unique, and bounded", () => {
  assert.deepEqual(parseUiClientMessage('{"type":"session_subscriptions","revision":1,"sessionIds":["s1","s2"],"podIds":["p1"]}'), {
    type: "session_subscriptions",
    revision: 1,
    sessionIds: ["s1", "s2"],
    podIds: ["p1"],
  });
  assert.deepEqual(parseUiClientMessage('{"type":"session_subscriptions","revision":2,"sessionIds":[],"podIds":[]}'), {
    type: "session_subscriptions",
    revision: 2,
    sessionIds: [],
    podIds: [],
  });
  for (const invalid of [
    "not-json",
    "null",
    '{"type":"unknown","revision":1,"sessionIds":[],"podIds":[]}',
    '{"type":"session_subscriptions","revision":0,"sessionIds":[],"podIds":[]}',
    '{"type":"session_subscriptions","revision":1.5,"sessionIds":[],"podIds":[]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":"s1","podIds":[]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":[],"podIds":"p1"}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":["s1","s1"],"podIds":[]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":[],"podIds":["p1","p1"]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":[""],"podIds":[]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":["bad\\n"],"podIds":[]}',
    '{"type":"session_subscriptions","revision":1,"sessionIds":[],"podIds":[],"extra":true}',
  ]) assert.equal(parseUiClientMessage(invalid), null, invalid);

  assert.equal(parseUiClientMessage(JSON.stringify({
    type: "session_subscriptions",
    revision: 1,
    sessionIds: Array.from({ length: MAX_UI_SESSION_SUBSCRIPTIONS + 1 }, (_, i) => `s${i}`),
    podIds: [],
  })), null);
  assert.equal(parseUiClientMessage(JSON.stringify({
    type: "session_subscriptions",
    revision: 1,
    sessionIds: [],
    podIds: Array.from({ length: MAX_UI_POD_SUBSCRIPTIONS + 1 }, (_, i) => `p${i}`),
  })), null);
  assert.equal(parseUiClientMessage(JSON.stringify({
    type: "session_subscriptions",
    revision: 1,
    sessionIds: ["s".repeat(MAX_UI_SESSION_ID_LENGTH + 1)],
    podIds: [],
  })), null);
  assert.equal(parseUiClientMessage(" ".repeat(MAX_UI_CLIENT_MESSAGE_BYTES + 1)), null);
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
