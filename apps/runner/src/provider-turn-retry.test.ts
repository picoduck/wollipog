import assert from "node:assert/strict";
import { test } from "node:test";
import { isProviderCapacityFailure } from "./provider-turn-retry.js";

test("capacity recovery recognizes provider overload but excludes account and tool failures", () => {
  for (const message of ["overloaded", "overloaded_error", "model_capacity_exceeded",
    "Model is at capacity. Please try again later.", "The provider is temporarily overloaded",
    "Insufficient model capacity", "Model capacity exhausted", "No available capacity for this model"]) {
    assert.equal(isProviderCapacityFailure(message), true, message);
  }
  for (const message of ["quota exceeded", "billing limit reached", "usage limit reached",
    "MCP server is overloaded", "tool_call failed: model is at capacity", "context window exceeded",
    "invalid API key", "rate limit exceeded", "connection reset", "disk capacity exceeded", "Tool server overloaded", "authentication failed: provider overloaded",
    "billing account: model_capacity_exceeded", "context window exceeded: server overloaded"]) {
    assert.equal(isProviderCapacityFailure(message), false, message);
  }
});
