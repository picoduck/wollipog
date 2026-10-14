import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeFailureCategory, codexFailureCategory } from "./provider-failure.js";
import { isProviderCapacityFailure } from "../provider-turn-retry.js";

test("structured provider categories outrank diagnostic wording", () => {
  for (const info of ["serverOverloaded", "flexUnavailable"]) {
    assert.equal(isProviderCapacityFailure("unrelated wording", codexFailureCategory({ codexErrorInfo: info })), true);
  }
  for (const info of ["contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded",
    "unauthorized", "sandboxError", "badRequest", "internalServerError", "cyberPolicy"]) {
    assert.equal(isProviderCapacityFailure("overloaded_error", codexFailureCategory({ codexErrorInfo: info })), false, info);
  }
  assert.equal(isProviderCapacityFailure("quota in unrelated display text", claudeFailureCategory({ is_error: true, api_error_status: 529 })), true);
  for (const status of [400, 401, 402, 403, 404, 409, 413, 429, 500, 502, 503, 504]) {
    assert.equal(isProviderCapacityFailure("overloaded_error", claudeFailureCategory({ is_error: true, api_error_status: status })), false);
  }
});

test("unknown structured errors preserve conservative fallback without reading prose as a code", () => {
  for (const info of ["other", "newErrorCode", "__proto__", "constructor", { newErrorCode: {} }]) {
    assert.equal(codexFailureCategory({ codexErrorInfo: info }), null);
  }
  assert.equal(codexFailureCategory({ message: "serverOverloaded" }), null);
  assert.equal(claudeFailureCategory({ is_error: false, api_error_status: 529 }), null);
  assert.equal(claudeFailureCategory({ is_error: true, api_error_status: "529" }), null);
  assert.equal(isProviderCapacityFailure("overloaded_error", null), true);
  assert.equal(isProviderCapacityFailure("billing error: model at capacity", null), false);
});

test("Codex request errors retain structured data and local transport evidence", () => {
  assert.equal(codexFailureCategory({ data: { codexErrorInfo: "serverOverloaded" } }), "capacity");
  assert.equal(codexFailureCategory({ transportFailure: true, data: { codexErrorInfo: "serverOverloaded" } }), "transport");
  for (const key of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
    assert.equal(codexFailureCategory({ codexErrorInfo: { [key]: { httpStatusCode: 502 } } }), "transport");
    assert.equal(codexFailureCategory({ codexErrorInfo: { [key]: { httpStatusCode: 429 } } }), "rate_limit");
  }
});

test("standard JSON-RPC request rejection cannot become capacity from display wording", () => {
  for (const code of [-32600, -32601, -32602]) {
    assert.equal(isProviderCapacityFailure("overloaded_error", codexFailureCategory({ code })), false);
  }
});


test("unknown Codex HTTP status evidence retains conservative text fallback", () => {
  for (const status of [503, 599]) {
    const category = codexFailureCategory({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: status } } });
    assert.equal(category, null);
    assert.equal(isProviderCapacityFailure("overloaded_error", category), true);
    assert.equal(isProviderCapacityFailure("billing quota exceeded", category), false);
  }
  assert.equal(codexFailureCategory({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }), "transport");
});
