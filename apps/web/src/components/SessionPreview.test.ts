import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { sessionPreviewUsage } from "../session-preview.js";

function usage(overrides: Partial<SessionView> = {}): SessionView {
  return {
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    ...overrides,
  } as SessionView;
}

test("session preview usage prefers the current context fill and includes cost", () => {
  assert.equal(sessionPreviewUsage(usage({
    tokensIn: 1_000,
    tokensOut: 500,
    contextTokensUsed: 8_250,
    contextWindow: 100_000,
    costUsd: 0.034,
  })), "8.3k of 100k context · $0.03");
});

test("session preview usage falls back to aggregate tokens and omits empty usage", () => {
  assert.equal(sessionPreviewUsage(usage({ tokensIn: 900, tokensOut: 334 })), "1.2k tokens");
  assert.equal(sessionPreviewUsage(usage()), null);
});
