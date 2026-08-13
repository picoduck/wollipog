import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEGACY_AUTOMATION_TRIGGER_HEADERS,
  selectAutomationTriggerHeaders,
  selectCompatibleHeader,
  selectSingleRawHeader,
  WOLLIPOG_AUTOMATION_TRIGGER_HEADERS,
} from "./wire-compat.js";

test("compatible headers accept either generation and identical dual values", () => {
  assert.deepEqual(selectCompatibleHeader({ "x-current": "session" }, "x-current", "x-legacy"),
    { ok: true, value: "session" });
  assert.deepEqual(selectCompatibleHeader({ "x-legacy": "session" }, "x-current", "x-legacy"),
    { ok: true, value: "session" });
  assert.deepEqual(selectCompatibleHeader({ "x-current": "session", "x-legacy": "session" }, "x-current", "x-legacy"),
    { ok: true, value: "session" });
  assert.deepEqual(selectCompatibleHeader({}, "x-current", "x-legacy"), { ok: true, value: undefined });
});

test("compatible headers reject conflicts and array values", () => {
  assert.deepEqual(selectCompatibleHeader({ "x-current": "new", "x-legacy": "old" }, "x-current", "x-legacy"),
    { ok: false });
  assert.deepEqual(selectCompatibleHeader({ "x-current": ["one", "two"] }, "x-current", "x-legacy"),
    { ok: false });
  assert.deepEqual(selectCompatibleHeader({ "x-legacy": ["one"] }, "x-current", "x-legacy"),
    { ok: false });
});

test("raw header selection rejects duplicate physical Authorization fields", () => {
  assert.deepEqual(selectSingleRawHeader({
    headers: { authorization: "first" },
    headersDistinct: { authorization: ["first", "second"] },
  }, "authorization"), { ok: false });
  assert.deepEqual(selectSingleRawHeader({
    headers: { authorization: "first" },
    rawHeaders: ["Authorization", "first", "authorization", "second"],
  }, "authorization"), { ok: false });
  assert.deepEqual(selectSingleRawHeader({
    headers: { authorization: "first" },
    headersDistinct: { authorization: ["first"] },
  }, "Authorization"), { ok: true, value: "first" });
});

const signed = (names: typeof LEGACY_AUTOMATION_TRIGGER_HEADERS, suffix = "") => ({
  [names.timestamp]: `100${suffix}`,
  [names.nonce]: `nonce_1234567890${suffix}`,
  [names.signature]: `v1=${"0".repeat(64)}${suffix}`,
});

test("automation trigger headers accept one complete generation or identical dual generations", () => {
  const legacy = signed(LEGACY_AUTOMATION_TRIGGER_HEADERS);
  const wollipog = signed(WOLLIPOG_AUTOMATION_TRIGGER_HEADERS);
  const expected = {
    timestamp: "100",
    nonce: "nonce_1234567890",
    signature: `v1=${"0".repeat(64)}`,
  };
  assert.deepEqual(selectAutomationTriggerHeaders(legacy), { ok: true, value: expected });
  assert.deepEqual(selectAutomationTriggerHeaders(wollipog), { ok: true, value: expected });
  assert.deepEqual(selectAutomationTriggerHeaders({ ...legacy, ...wollipog }), { ok: true, value: expected });
  assert.deepEqual(selectAutomationTriggerHeaders({}), { ok: true, value: {} });
});

test("automation trigger headers reject partial, mixed, conflicting, and array generations", () => {
  assert.deepEqual(selectAutomationTriggerHeaders({
    [WOLLIPOG_AUTOMATION_TRIGGER_HEADERS.timestamp]: "100",
  }), { ok: false });
  assert.deepEqual(selectAutomationTriggerHeaders({
    [WOLLIPOG_AUTOMATION_TRIGGER_HEADERS.timestamp]: "100",
    [LEGACY_AUTOMATION_TRIGGER_HEADERS.nonce]: "nonce_1234567890",
    [LEGACY_AUTOMATION_TRIGGER_HEADERS.signature]: `v1=${"0".repeat(64)}`,
  }), { ok: false });
  assert.deepEqual(selectAutomationTriggerHeaders({
    ...signed(LEGACY_AUTOMATION_TRIGGER_HEADERS),
    ...signed(WOLLIPOG_AUTOMATION_TRIGGER_HEADERS, "different"),
  }), { ok: false });
  assert.deepEqual(selectAutomationTriggerHeaders({
    ...signed(LEGACY_AUTOMATION_TRIGGER_HEADERS),
    [LEGACY_AUTOMATION_TRIGGER_HEADERS.nonce]: ["one", "two"],
  }), { ok: false });
});
