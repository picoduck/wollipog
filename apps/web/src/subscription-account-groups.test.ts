import assert from "node:assert/strict";
import test from "node:test";
import type { SubscriptionUsageBucket, SubscriptionUsageSourceView } from "@wollipog/protocol";
import { subscriptionAccountGroups } from "./subscription-account-groups.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const bucket = (id: string, left: number, extra: Partial<SubscriptionUsageBucket> = {}): SubscriptionUsageBucket => ({
  id,
  label: id,
  remainingPercent: left,
  usedPercent: 100 - left,
  resetsAt: NOW + 5 * HOUR,
  status: "available",
  ...extra,
});

let nextSource = 0;
const source = (over: Partial<SubscriptionUsageSourceView> = {}): SubscriptionUsageSourceView => {
  nextSource += 1;
  return {
    sourceId: nextSource.toString(16).padStart(32, "0"),
    runnerId: `runner-${nextSource}`,
    runnerName: `machine-${nextSource}`,
    runnerStatus: "online",
    agentId: "claude",
    agentName: "Claude Code",
    provider: "claude",
    state: "available",
    freshness: "fresh",
    fetchedAt: NOW,
    buckets: [],
    ...over,
  };
};

test("sources with one subscription key collapse into a single group listing every machine", () => {
  const laptop = source({ subscriptionKey: "shared", buckets: [bucket("five_hour", 40)] });
  const box = source({ subscriptionKey: "shared", buckets: [bucket("five_hour", 40)] });
  const groups = subscriptionAccountGroups([laptop, box]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.members.map((member) => member.runnerId), [laptop.runnerId, box.runnerId]);
  assert.equal(groups[0]!.machineCount, 2);
});

test("a source with no subscription key is never merged, even with an identical label and plan", () => {
  const groups = subscriptionAccountGroups([
    source({ accountLabel: "person@example.test", plan: "max", buckets: [bucket("five_hour", 40)] }),
    source({ accountLabel: "person@example.test", plan: "max", buckets: [bucket("five_hour", 40)] }),
  ]);
  assert.equal(groups.length, 2);
});

test("different subscription keys stay separate", () => {
  const groups = subscriptionAccountGroups([
    source({ subscriptionKey: "personal", buckets: [bucket("five_hour", 40)] }),
    source({ subscriptionKey: "team", buckets: [bucket("five_hour", 90)] }),
  ]);
  assert.equal(groups.length, 2);
});

test("the most recent reading of a window wins, whichever machine reported it", () => {
  const [group] = subscriptionAccountGroups([
    source({ subscriptionKey: "shared", fetchedAt: NOW - HOUR, buckets: [bucket("five_hour", 80)] }),
    source({ subscriptionKey: "shared", fetchedAt: NOW, buckets: [bucket("five_hour", 35)] }),
    source({ subscriptionKey: "shared", fetchedAt: NOW - 2 * HOUR, buckets: [bucket("five_hour", 95)] }),
  ]);
  assert.equal(group!.account.buckets[0]!.remainingPercent, 35);
});

test("a machine's reading of a newer window beats a more recent reading of the old one", () => {
  const [group] = subscriptionAccountGroups([
    source({ subscriptionKey: "shared", fetchedAt: NOW, buckets: [bucket("five_hour", 5, { resetsAt: NOW + HOUR })] }),
    source({ subscriptionKey: "shared", fetchedAt: NOW - 10 * 60_000, buckets: [bucket("five_hour", 90, { resetsAt: NOW + 6 * HOUR })] }),
  ]);
  assert.equal(group!.account.buckets[0]!.remainingPercent, 90);
  assert.equal(group!.account.buckets[0]!.resetsAt, NOW + 6 * HOUR);
});

test("reset times that differ by provider jitter are one window, so recency still decides", () => {
  const [group] = subscriptionAccountGroups([
    source({ subscriptionKey: "shared", fetchedAt: NOW, buckets: [bucket("five_hour", 35, { resetsAt: NOW + 5 * HOUR })] }),
    source({ subscriptionKey: "shared", fetchedAt: NOW - HOUR, buckets: [bucket("five_hour", 80, { resetsAt: NOW + 5 * HOUR + 30_000 })] }),
  ]);
  assert.equal(group!.account.buckets[0]!.remainingPercent, 35);
});

test("each machine contributes the windows the others have not reported", () => {
  const [group] = subscriptionAccountGroups([
    source({ subscriptionKey: "shared", fetchedAt: NOW, buckets: [bucket("five_hour", 35)] }),
    source({ subscriptionKey: "shared", fetchedAt: NOW - HOUR, buckets: [bucket("five_hour", 80), bucket("seven_day", 60)] }),
  ]);
  assert.deepEqual(group!.account.buckets.map((item) => [item.id, item.remainingPercent]), [["five_hour", 35], ["seven_day", 60]]);
});

test("a newer status-only reading keeps the window's last known percentage", () => {
  const { usedPercent: _used, remainingPercent: _left, ...statusOnly } = bucket("five_hour", 0, { status: "warning" });
  const [group] = subscriptionAccountGroups([
    source({ subscriptionKey: "shared", fetchedAt: NOW, buckets: [statusOnly] }),
    source({ subscriptionKey: "shared", fetchedAt: NOW - HOUR, buckets: [bucket("five_hour", 15)] }),
  ]);
  assert.equal(group!.account.buckets[0]!.remainingPercent, 15);
  assert.equal(group!.account.buckets[0]!.status, "warning");
});

test("a machine that has not reported yet joins the group without changing its numbers", () => {
  const reported = source({ subscriptionKey: "shared", fetchedAt: NOW - HOUR, plan: "max", buckets: [bucket("five_hour", 35)] });
  const waiting = source({ subscriptionKey: "shared", fetchedAt: NOW, state: "unavailable", detail: "Waiting for a first response." });
  const [group] = subscriptionAccountGroups([waiting, reported]);
  assert.equal(group!.account.state, "available");
  assert.equal(group!.account.plan, "max");
  assert.equal(group!.account.detail, undefined, "the waiting machine's note stays on its own row");
  assert.equal(group!.members.length, 2);
  assert.equal(group!.hasWindows, true);
});

test("the merged account is fresh and online while any reporting machine is", () => {
  const [group] = subscriptionAccountGroups([
    source({ subscriptionKey: "shared", fetchedAt: NOW - HOUR, runnerStatus: "offline", freshness: "stale", buckets: [bucket("five_hour", 80)] }),
    source({ subscriptionKey: "shared", fetchedAt: NOW - 2 * HOUR, buckets: [bucket("five_hour", 90)] }),
  ]);
  assert.equal(group!.account.freshness, "fresh");
  assert.equal(group!.account.runnerStatus, "online");
});

test("every machine's Codex account is a refresh target, and a Claude source is not", () => {
  const codex = (runnerId: string, providerAccountId?: string) => source({
    subscriptionKey: "codex-shared", provider: "codex", agentId: "codex", runnerId,
    ...(providerAccountId ? { providerAccountId } : {}), buckets: [bucket("codex:primary", 50)],
  });
  const [merged, claude] = subscriptionAccountGroups([
    codex("laptop", "work"), codex("box", "work-copy"), codex("legacy"),
    source({ subscriptionKey: "claude-shared", providerAccountId: "personal", buckets: [bucket("five_hour", 50)] }),
  ]);
  assert.deepEqual(merged!.refreshTargets, [
    { runnerId: "laptop", providerAccountId: "work" },
    { runnerId: "box", providerAccountId: "work-copy" },
  ]);
  assert.deepEqual(claude!.refreshTargets, []);
});

test("two sources of one subscription on the same machine count as one machine", () => {
  const [group] = subscriptionAccountGroups([
    source({ subscriptionKey: "shared", runnerId: "box", buckets: [bucket("five_hour", 40)] }),
    source({ subscriptionKey: "shared", runnerId: "box", buckets: [bucket("five_hour", 40)] }),
  ]);
  assert.equal(group!.machineCount, 1);
  assert.equal(group!.members.length, 2);
});

test("a single source passes through untouched", () => {
  const only = source({ subscriptionKey: "shared", plan: "max", detail: "A note.", buckets: [bucket("five_hour", 40)] });
  const [group] = subscriptionAccountGroups([only]);
  assert.ok(group!.account === only);
});
