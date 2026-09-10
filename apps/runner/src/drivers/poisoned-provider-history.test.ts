import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPoisonedProviderHistory, poisonedProviderHistoryMessage } from "./poisoned-provider-history.js";

test("recognizes an oversized historical function call and reports only its structure", () => {
  const observed = classifyPoisonedProviderHistory(
    "Invalid 'input[675].arguments': string too long. Expected a string with maximum length " +
      "1048576, but got a string with length 1426210 instead.",
  );
  assert.deepEqual(observed, {
    reason: "oversized_tool_call",
    itemIndex: 675,
    field: "arguments",
    limit: 1048576,
    length: 1426210,
  });
});

test("tolerates nested and partially reported provider error paths", () => {
  assert.deepEqual(
    classifyPoisonedProviderHistory("Invalid 'input[3].content[0].arguments': string too long."),
    { reason: "oversized_tool_call", itemIndex: 3, field: "arguments" },
  );
  assert.equal(
    classifyPoisonedProviderHistory("input[12].arguments exceeded the maximum length 1048576")?.limit,
    1048576,
  );
});

test("leaves every other provider rejection on the ordinary error path", () => {
  for (const message of [
    // The prompt itself, not stored history: shortening the message repairs it in place.
    "Invalid 'input[0].content': string too long. Expected a string with maximum length 1048576.",
    // A field that is not a stored function call.
    "Invalid 'instructions': string too long. Expected a string with maximum length 1048576.",
    // Same field name, but no index proving it came from history.
    "Invalid 'arguments': string too long.",
    // A malformed historical call is unrecoverable too, but this classifier claims only the
    // oversized case; widening it would need its own evidence.
    "Invalid 'input[675].arguments': expected valid JSON.",
    "400 Bad Request: unsupported model",
    "429 rate_limit_error",
    "context_length_exceeded: this model supports at most 200000 tokens",
    "unexpected status 401 Unauthorized",
    "",
  ]) assert.equal(classifyPoisonedProviderHistory(message), null, message);

  for (const value of [null, undefined, 42, {}, ["input[1].arguments too long"]]) {
    assert.equal(classifyPoisonedProviderHistory(value), null, String(value));
  }
});

test("rejects implausible reported sizes instead of surfacing them", () => {
  const observed = classifyPoisonedProviderHistory(
    "Invalid 'input[9007199254740993].arguments': string too long. Expected a string with " +
      "maximum length 99999999999999999999, but got a string with length 1426210 instead.",
  );
  assert.deepEqual(observed, { reason: "oversized_tool_call", field: "arguments", length: 1426210 });
});

test("the rendered message states the structure without quoting the provider", () => {
  assert.equal(
    poisonedProviderHistoryMessage({
      reason: "oversized_tool_call", itemIndex: 675, field: "arguments", limit: 1048576, length: 1426210,
    }),
    "The agent provider rejected this conversation's stored history: the recorded tool call at " +
      "history position 675 cannot be resent. Its arguments field is 1,426,210 characters, over " +
      "the provider's limit of 1,048,576.",
  );
  // Partially reported rejections still render, and never fall back to raw provider text.
  assert.match(
    poisonedProviderHistoryMessage({ reason: "oversized_tool_call", field: "arguments" }),
    /^The agent provider rejected this conversation's stored history: a recorded tool call cannot be resent\./,
  );
});
