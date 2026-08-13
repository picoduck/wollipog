import assert from "node:assert/strict";
import { test } from "node:test";
import { computeContextFill } from "./context-meter.js";

test("computeContextFill: small fill keeps one decimal", () => {
  const r = computeContextFill({ tokensIn: 1000, tokensOut: 500, contextWindow: 200_000 });
  assert.equal(r.formatPct, "0.8%"); // 1500 / 200000 = 0.75% → "0.8%"
  assert.ok(Math.abs(r.fillPct - 0.75) < 1e-9);
  assert.equal(r.known, true);
  assert.equal(r.isFull, false);
});

test("computeContextFill: larger fill rounds to a whole percent", () => {
  const r = computeContextFill({ tokensIn: 90_000, tokensOut: 10_000, contextWindow: 200_000 });
  assert.equal(r.formatPct, "50%");
  assert.equal(r.fillPct, 50);
});

test("computeContextFill: provider current-context gauge overrides additive session totals", () => {
  const r = computeContextFill({
    tokensIn: 900_000,
    tokensOut: 100_000,
    usedTokens: 50_000,
    contextWindow: 200_000,
  });
  assert.equal(r.formatPct, "25%");
  assert.equal(r.fillPct, 25);
});

test("computeContextFill: unknown / zero window ⇒ dash, not known", () => {
  for (const contextWindow of [undefined, null, 0]) {
    const r = computeContextFill({ tokensIn: 100, tokensOut: 100, contextWindow });
    assert.equal(r.formatPct, "—");
    assert.equal(r.known, false);
    assert.equal(r.fillPct, 0);
  }
});

test("computeContextFill: zero tokens is a known 0", () => {
  const r = computeContextFill({ tokensIn: 0, tokensOut: 0, contextWindow: 200_000 });
  assert.equal(r.formatPct, "0.0%");
  assert.equal(r.fillPct, 0);
  assert.equal(r.known, true);
});

test("computeContextFill: overflow clamps to 100% and flags full", () => {
  const r = computeContextFill({ tokensIn: 250_000, tokensOut: 0, contextWindow: 200_000 });
  assert.equal(r.formatPct, "100%");
  assert.equal(r.fillPct, 100);
  assert.equal(r.isFull, true);
});
