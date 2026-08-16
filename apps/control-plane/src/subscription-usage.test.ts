import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PROTOCOL_VERSION, type AgentDefinition, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import {
  validateSubscriptionUsageInventory,
  validateSubscriptionUsageSnapshot,
} from "./subscription-usage.js";

function codexAgent(id = "codex"): AgentDefinition {
  return {
    id,
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    context: { kind: "native" },
    codexAppServer: { status: "supported", appServerAvailable: true, transport: "stdio", contractFingerprint: "test" },
  };
}

function meta(runnerId: string, agents: AgentDefinition[] = [codexAgent()]): RunnerMetadata {
  return { runnerId, hostname: `${runnerId}-host`, os: "linux", version: "1", agents, workspaces: [] };
}

function human(userId = "alice", organizationId = "org_personal"): HumanPrincipal {
  return {
    kind: "human",
    actorId: userId,
    userId,
    userName: userId,
    organizationId,
    organizationName: organizationId,
    role: "operator",
    deviceId: `${userId}-device`,
    localBootstrap: false,
  };
}

function sourceId(runnerId: string, agentId = "codex"): string {
  return createHash("sha256")
    .update(JSON.stringify({ runnerId, agentId, provider: "codex", context: "native" }))
    .digest("hex")
    .slice(0, 32);
}

function snapshot(runnerId: string, fetchedAt: number) {
  return {
    sourceId: sourceId(runnerId),
    runnerId,
    agentId: "codex",
    provider: "codex",
    state: "available",
    fetchedAt,
    buckets: [{
      id: "future-model:primary",
      label: "Future Model — Five-Hour Window",
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: fetchedAt + 60_000,
      status: "available",
    }],
    plan: "plus",
  } as const;
}

test("snapshot validation binds runner, advertised source, schema bounds, and drops unknown account data", () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = 1_000_000;
  db.registerRunner(meta("runner-1"), now, PROTOCOL_VERSION);
  const value = { ...snapshot("runner-1", now), accountId: "private-account", email: "alice@example.com" };
  const validated = validateSubscriptionUsageSnapshot(value, "runner-1", db, now);
  assert.deepEqual(validated, snapshot("runner-1", now));
  assert.doesNotMatch(JSON.stringify(validated), /private-account|alice@example/);
  assert.throws(() => validateSubscriptionUsageSnapshot(value, "runner-2", db, now), /runner binding/);
  assert.throws(() => validateSubscriptionUsageSnapshot({ ...value, sourceId: "b".repeat(32) }, "runner-1", db, now), /not advertised/);
  assert.throws(() => validateSubscriptionUsageSnapshot({
    ...value,
    buckets: [{ ...value.buckets[0], usedPercent: 101 }],
  }, "runner-1", db, now), /out of range/);
  assert.throws(() => validateSubscriptionUsageInventory(new Array(33).fill(value), "runner-1", db, now), /inventory/);
  db.close();
});

test("principal projection preserves stale last-known data and synthesizes mixed-version support", () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = 20 * 60_000;
  db.registerRunner(meta("current"), 1, PROTOCOL_VERSION, {
    organizationId: "org_personal", owner: { kind: "user", userId: "alice" },
  });
  db.registerRunner(meta("old"), 1, 77, {
    organizationId: "org_personal", owner: { kind: "user", userId: "alice" },
  });
  db.registerRunner(meta("private"), 1, PROTOCOL_VERSION, {
    organizationId: "org_personal", owner: { kind: "user", userId: "bob" },
  });
  db.upsertSubscriptionUsageSnapshot(snapshot("current", 1));
  db.upsertSubscriptionUsageSnapshot(snapshot("private", 1));
  db.markOffline("current", now);
  const view = db.subscriptionUsageForPrincipal(human("alice"), now, 10 * 60_000);
  assert.deepEqual(view.sources.map((source) => [source.runnerId, source.state, source.freshness]), [
    ["current", "available", "stale"],
    ["old", "unsupported", "stale"],
  ]);
  assert.equal(view.sources[0]?.buckets[0]?.id, "future-model:primary", "last-known provider data is retained");
  assert.doesNotMatch(JSON.stringify(view), /private-host|\"private\"/);
  db.close();
});

test("authoritative inventories replace removed sources atomically", () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = 1_000_000;
  db.registerRunner(meta("runner-1", [codexAgent(), codexAgent("codex-2")]), now, PROTOCOL_VERSION);
  const first = snapshot("runner-1", now);
  const second = {
    ...first,
    sourceId: sourceId("runner-1", "codex-2"),
    agentId: "codex-2",
  };
  db.replaceSubscriptionUsageSnapshots("runner-1", [first, second]);
  assert.equal(db.subscriptionUsageForPrincipal(human(), now).sources.length, 2);
  db.replaceSubscriptionUsageSnapshots("runner-1", [{
    ...first,
    state: "unavailable",
    fetchedAt: now + 1,
    buckets: [],
    detail: "The runner restarted before provider usage was fetched.",
  }], now + 1);
  const retained = db.subscriptionUsageForPrincipal(human(), now + 1).sources[0]!;
  assert.equal(retained.state, "available");
  assert.equal(retained.fetchedAt, first.fetchedAt);
  assert.equal(retained.buckets[0]?.id, "future-model:primary");
  assert.equal(retained.detail, "The runner restarted before provider usage was fetched.");
  db.upsertSubscriptionUsageSnapshot({
    ...first,
    state: "unavailable",
    fetchedAt: now + 2,
    buckets: [],
    detail: "The provider query failed.",
  }, now + 2);
  assert.equal(db.subscriptionUsageForPrincipal(human(), now + 2).sources[0]?.buckets.length, 1);
  db.upsertSubscriptionUsageSnapshot({
    ...first,
    state: "unauthenticated",
    fetchedAt: now + 3,
    buckets: [],
    detail: "Sign in to Codex.",
  }, now + 3);
  assert.equal(db.subscriptionUsageForPrincipal(human(), now + 3).sources[0]?.state, "unauthenticated");
  db.replaceSubscriptionUsageSnapshots("runner-1", [first, second]);
  db.replaceSubscriptionUsageSnapshots("runner-1", [first], now + 1);
  const stored = db.raw().prepare("SELECT source_id FROM subscription_usage_snapshots ORDER BY source_id").all();
  assert.deepEqual(stored.map((row) => ({ ...row })), [{ source_id: first.sourceId }]);
  db.close();
});
