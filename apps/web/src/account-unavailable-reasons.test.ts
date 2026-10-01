import assert from "node:assert/strict";
import test from "node:test";
import {
  accountUnavailableReason,
  derivedAccountUnavailableReason,
  subscriptionResetLabel,
} from "./account-unavailable-reasons.js";

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
