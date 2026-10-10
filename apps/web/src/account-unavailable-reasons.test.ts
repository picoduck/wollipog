import assert from "node:assert/strict";
import test from "node:test";
import {
  accountUnavailableReason,
  derivedAccountUnavailableReason,
  subscriptionResetChangesIn,
  subscriptionResetLabel,
} from "./account-unavailable-reasons.js";

test("subscriptionResetChangesIn never lets the reset countdown change unseen (#2872)", () => {
  const now = 1_800_000_000_000;
  const lefts = [1, 59_999, 60_000, 60_001, 3_599_999, 3_600_000, 3_600_001, 47 * 3_600_000 + 1, 49 * 3_600_000];
  for (let left = 1; left < 5 * 86_400_000; left = Math.round(left * 1.41 + 977)) lefts.push(left);
  for (const left of lefts) {
    const wait = subscriptionResetChangesIn(now + left, now)!;
    assert.ok(wait > 0 && wait <= 60_000, `a wait within a minute for ${left}`);
    assert.equal(subscriptionResetLabel(now + left, now + wait - 1), subscriptionResetLabel(now + left, now), `unchanged before, from ${left}`);
    // Minutes change at every minute; hours and days only at some of them.
    if (left <= 60 * 60_000) {
      assert.notEqual(subscriptionResetLabel(now + left, now + wait), subscriptionResetLabel(now + left, now), `changed at, from ${left}`);
    }
  }
  assert.equal(subscriptionResetChangesIn(now, now), null, "a reset that has passed changes no more");
});

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

test("each unavailable code reads as its own sentence", () => {
  assert.equal(accountUnavailableReason({ reason: "signed_out" }, "build-box", NOW), "Signed out on build-box.");
  assert.equal(accountUnavailableReason({ reason: "sign_in_unknown" }, "build-box", NOW), "Sign-in status unknown on build-box.");
  assert.equal(accountUnavailableReason({ reason: "usage_unknown" }, "build-box", NOW), "No current usage reading is available.");
  assert.equal(accountUnavailableReason({ reason: "usage_exhausted" }, "build-box", NOW), "A usage window is used up.");
  assert.equal(
    accountUnavailableReason({ reason: "unheard_of" as "usage_unknown" }, "build-box", NOW),
    "Not available for this session right now.",
  );
});

test("an exhausted window is named, with its reset time only while it is still ahead", () => {
  const window = { id: "five-hour", label: "5-Hour", remainingPercent: 0 };
  const exhausted = (resetsAt?: number) => accountUnavailableReason(
    { reason: "usage_exhausted", exhaustedWindow: { ...window, ...(resetsAt === undefined ? {} : { resetsAt }) } },
    "build-box",
    NOW,
  );
  assert.equal(exhausted(), "The 5-Hour window is used up.");
  assert.equal(exhausted(NOW + 2 * HOUR), "The 5-Hour window is used up and resets in 2 hours.");
  assert.equal(exhausted(NOW + 90_000), "The 5-Hour window is used up and resets in 2 minutes.");
  assert.equal(exhausted(NOW + 3 * 24 * HOUR), "The 5-Hour window is used up and resets in 3 days.");
  assert.equal(exhausted(NOW - 1), "The 5-Hour window is used up.");
});

test("an older control plane's omissions keep the reasons the dashboard derived before #2276", () => {
  assert.equal(derivedAccountUnavailableReason({ authStatus: "unauthenticated" }, "build-box"), "Signed out on build-box.");
  assert.equal(derivedAccountUnavailableReason({ authStatus: "unknown" }, "build-box"), "Sign-in status unknown on build-box.");
  assert.equal(derivedAccountUnavailableReason({ authStatus: "authenticated" }, "build-box"), "No usage headroom reported.");
});

test("the reset label is unchanged by its move out of the Usage page", () => {
  assert.equal(subscriptionResetLabel(NOW - 1, NOW), "Reset time has passed");
  assert.equal(subscriptionResetLabel(NOW + 60_000, NOW), "Resets in 1 minute");
  assert.equal(subscriptionResetLabel(NOW + HOUR + 1, NOW), "Resets in 2 hours");
  assert.equal(subscriptionResetLabel(NOW + 47 * HOUR, NOW), "Resets in 47 hours");
  assert.equal(subscriptionResetLabel(NOW + 49 * HOUR, NOW), "Resets in 3 days");
});
