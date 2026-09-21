import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAccountDefinition, SubscriptionUsageSnapshot } from "@wollipog/protocol";
import { selectAutomaticProviderAccount, usageWindowRejection } from "./automatic-provider-account-switch.js";

const now = 1_000_000;
const account = (id: string, authStatus: ProviderAccountDefinition["authStatus"] = "authenticated") =>
  ({ id, label: id, provider: "claude" as const, authStatus });
const usage = (id: string, remainingPercent: number, resetsAt = now + 60_000): SubscriptionUsageSnapshot => ({
  sourceId: id, runnerId: "runner", agentId: "claude", provider: "claude", providerAccountId: id,
  state: "available", fetchedAt: now, buckets: [{ id: "five_hour", label: "Five Hour",
    remainingPercent, usedPercent: 100 - remainingPercent,
    status: remainingPercent === 0 ? "exhausted" : "available", resetsAt }],
});

test("classifies active structured exhaustion but not an expired weekly window", () => {
  assert.deepEqual(usageWindowRejection(usage("current", 0), now), { resetsAt: now + 60_000 });
  assert.equal(usageWindowRejection(usage("current", 0, now - 1), now), null);
});

test("selects the authenticated same-provider account with the most usable headroom", () => {
  assert.equal(selectAutomaticProviderAccount({
    accounts: [account("current"), account("low"), account("high"), account("signed-out", "unauthenticated")],
    snapshots: [usage("low", 20), usage("high", 80), usage("signed-out", 99)],
    provider: "claude", currentAccountId: "current", cooldowns: {}, now,
  })?.id, "high");
});

test("excludes exhausted and cooling-down accounts", () => {
  assert.equal(selectAutomaticProviderAccount({
    accounts: [account("current"), account("exhausted"), account("cooling")],
    snapshots: [usage("exhausted", 0), usage("cooling", 90)],
    provider: "claude", currentAccountId: "current", cooldowns: { cooling: now + 1 }, now,
  }), null);
});

test("excludes authenticated accounts whose allowance state is unknown", () => {
  assert.equal(selectAutomaticProviderAccount({
    accounts: [account("current"), account("unknown")],
    snapshots: [],
    provider: "claude", currentAccountId: "current", cooldowns: {}, now,
  }), null);
});
