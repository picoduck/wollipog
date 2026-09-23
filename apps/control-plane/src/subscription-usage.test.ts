import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PROTOCOL_VERSION, type AgentDefinition, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import {
  MAX_SUBSCRIPTION_USAGE_REFRESH_TIMEOUT_MS,
  subscriptionUsageRefreshTimeoutMs,
  validateSubscriptionUsageInventory,
  validateSubscriptionUsageSnapshot,
} from "./subscription-usage.js";

test("manual refresh deadlines cover sequential Codex sources with a bounded ceiling", () => {
  assert.equal(subscriptionUsageRefreshTimeoutMs(0), 10_000);
  assert.equal(subscriptionUsageRefreshTimeoutMs(1), 10_000);
  assert.equal(subscriptionUsageRefreshTimeoutMs(2), 18_000);
  assert.equal(subscriptionUsageRefreshTimeoutMs(100), MAX_SUBSCRIPTION_USAGE_REFRESH_TIMEOUT_MS);
});

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

function claudeAgent(id = "claude"): AgentDefinition {
  return {
    id, name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
    context: { kind: "native" }, available: true,
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

function sourceId(runnerId: string, agentId = "codex", providerAccountId?: string): string {
  return createHash("sha256")
    .update(JSON.stringify(providerAccountId
      ? { runnerId, provider: "codex", providerAccountId }
      : { runnerId, agentId, provider: "codex", context: "native" }))
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
    accountLabel: "account@example.com",
  } as const;
}

test("snapshot validation binds runner, advertised source, bounded display label, and drops raw account data", () => {
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
  assert.throws(() => validateSubscriptionUsageSnapshot({
    ...value,
    accountLabel: "line\nbreak@example.com",
  }, "runner-1", db, now), /accountLabel.*invalid/);
  assert.throws(() => validateSubscriptionUsageSnapshot({
    ...value,
    accountLabel: `${"a".repeat(155)}@example.com`,
  }, "runner-1", db, now), /accountLabel.*invalid/);
  assert.throws(() => validateSubscriptionUsageInventory(new Array(33).fill(value), "runner-1", db, now), /inventory/);
  db.close();
});

test("a stale unselected usage result cannot repopulate a cleared selected source", () => {
  const db = ControlPlaneDb.open(":memory:");
  const system = { ...codexAgent("system"), available: true,
    installation: { id: "system", path: "/usr/bin/codex", via: "path" as const } };
  const local = { ...codexAgent("local"), available: true,
    installation: { id: "local", path: "/home/user/.local/bin/codex", via: "common-dir" as const } };
  db.registerRunner(meta("runner-1", [system, local]), 1_000_000, PROTOCOL_VERSION);
  assert.ok(db.selectHarnessInstallation("runner-1", "local", "local"));
  const stale = { ...snapshot("runner-1", 1_000_000), agentId: "system",
    sourceId: sourceId("runner-1", "system") };
  assert.throws(() => validateSubscriptionUsageSnapshot(stale, "runner-1", db, 1_000_000),
    /selected harness installation/);
  assert.equal(validateSubscriptionUsageSnapshot({ ...stale, state: "unsupported" },
    "runner-1", db, 1_000_000).state, "unsupported");
  assert.equal(validateSubscriptionUsageSnapshot({ ...stale, agentId: "local",
    sourceId: sourceId("runner-1", "local") }, "runner-1", db, 1_000_000).agentId, "local");
  db.close();
});

test("usage projection shows one selected installation and an explicit unsupported fallback", () => {
  const db = ControlPlaneDb.open(":memory:");
  const system = { ...codexAgent("system"), available: true,
    installation: { id: "system", path: "/usr/bin/codex", via: "path" as const } };
  const local = { ...codexAgent("local"), available: true,
    installation: { id: "local", path: "/home/user/.local/bin/codex", via: "common-dir" as const } };
  const owner = { organizationId: "org_personal", owner: { kind: "user" as const, userId: "alice" } };
  db.registerRunner(meta("runner-1", [system, local]), 1_000_000, PROTOCOL_VERSION, owner);
  assert.ok(db.selectHarnessInstallation("runner-1", "local", "local"));
  assert.deepEqual(db.subscriptionUsageForPrincipal(human(), 1_000_000).sources.map((source) =>
    [source.agentId, source.state]), [["local", "unavailable"]]);

  db.registerRunner(meta("runner-1", [system, local]), 1_000_001, 175, owner);
  assert.deepEqual(db.subscriptionUsageForPrincipal(human(), 1_000_001).sources.map((source) =>
    [source.agentId, source.state]), [["local", "unsupported"]]);

  db.registerRunner(meta("runner-1", [system]), 1_000_002, PROTOCOL_VERSION, owner);
  const missing = db.subscriptionUsageForPrincipal(human(), 1_000_002).sources;
  assert.deepEqual(missing.map((source) => [source.agentId, source.state]), [["system", "unsupported"]]);
  assert.match(missing[0]!.detail!, /selected harness installation is unavailable/);
  db.close();
});

test("a missing account installation does not retain its previous available snapshot", () => {
  const db = ControlPlaneDb.open(":memory:");
  const system = { ...codexAgent("system"), available: true,
    installation: { id: "system", path: "/usr/bin/codex", via: "path" as const } };
  const local = { ...codexAgent("local"), available: true,
    installation: { id: "local", path: "/home/user/.local/bin/codex", via: "common-dir" as const } };
  const owner = { organizationId: "org_personal", owner: { kind: "user" as const, userId: "alice" } };
  const withAccount = (agents: AgentDefinition[]) => ({ ...meta("runner-1", agents),
    providerAccounts: [{ id: "work", label: "Work", provider: "codex" as const, authStatus: "authenticated" as const }] });
  db.registerRunner(withAccount([system, local]), 1_000_000, PROTOCOL_VERSION, owner);
  assert.ok(db.selectHarnessInstallation("runner-1", "local", "local"));
  const available = validateSubscriptionUsageSnapshot({ ...snapshot("runner-1", 1_000_000),
    agentId: "local", providerAccountId: "work", sourceId: sourceId("runner-1", "local", "work"),
  }, "runner-1", db, 1_000_000);
  db.upsertSubscriptionUsageSnapshot(available);
  assert.equal(db.subscriptionUsageForPrincipal(human(), 1_000_000).sources[0]?.state, "available");

  db.registerRunner(withAccount([system]), 1_000_001, PROTOCOL_VERSION, owner);
  const source = db.subscriptionUsageForPrincipal(human(), 1_000_001).sources[0];
  assert.deepEqual([source?.agentId, source?.state], ["system", "unsupported"]);
  db.close();
});

test("account usage follows a compatible WSL agent even when native is listed first", () => {
  const db = ControlPlaneDb.open(":memory:");
  const native = { ...codexAgent("native"), available: true };
  const wsl = { ...codexAgent("wsl"), available: true,
    context: { kind: "wsl" as const, distro: "Ubuntu" } };
  const owner = { organizationId: "org_personal", owner: { kind: "user" as const, userId: "alice" } };
  db.registerRunner({ ...meta("runner-1", [native, wsl]), os: "windows",
    providerAccounts: [{ id: "work", label: "Work", provider: "codex", authStatus: "authenticated" }],
  }, 1_000_000, PROTOCOL_VERSION, owner);
  const reported = validateSubscriptionUsageSnapshot({ ...snapshot("runner-1", 1_000_000),
    agentId: "wsl", providerAccountId: "work", sourceId: sourceId("runner-1", "wsl", "work"),
  }, "runner-1", db, 1_000_000);
  db.upsertSubscriptionUsageSnapshot(reported);
  const account = db.subscriptionUsageForPrincipal(human(), 1_000_000).sources.find((source) =>
    source.providerAccountId === "work");
  assert.deepEqual([account?.agentId, account?.state], ["wsl", "available"]);
  db.close();
});

test("a missing selected WSL account installation remains explicitly unsupported", () => {
  const db = ControlPlaneDb.open(":memory:");
  const native = { ...codexAgent("native"), available: true };
  const wslSystem = { ...codexAgent("wsl-system"), available: true,
    context: { kind: "wsl" as const, distro: "Ubuntu" },
    installation: { id: "system", path: "/usr/bin/codex", via: "path" as const } };
  const wslLocal = { ...codexAgent("wsl-local"), available: true,
    context: { kind: "wsl" as const, distro: "Ubuntu" },
    installation: { id: "local", path: "/home/user/bin/codex", via: "common-dir" as const } };
  const owner = { organizationId: "org_personal", owner: { kind: "user" as const, userId: "alice" } };
  const withAccount = (agents: AgentDefinition[]) => ({ ...meta("runner-1", agents), os: "windows" as const,
    providerAccounts: [{ id: "work", label: "Work", provider: "codex" as const, authStatus: "authenticated" as const }] });
  db.registerRunner(withAccount([native, wslSystem, wslLocal]), 1_000_000, PROTOCOL_VERSION, owner);
  assert.ok(db.selectHarnessInstallation("runner-1", "wsl-local", "local"));
  db.registerRunner(withAccount([native, wslSystem]), 1_000_001, PROTOCOL_VERSION, owner);
  const unsupported = validateSubscriptionUsageSnapshot({ ...snapshot("runner-1", 1_000_001),
    agentId: "wsl-system", providerAccountId: "work", sourceId: sourceId("runner-1", "wsl-system", "work"),
    state: "unsupported", detail: "The selected harness installation is unavailable in this provider account's execution context.",
    buckets: [],
  }, "runner-1", db, 1_000_001);
  db.upsertSubscriptionUsageSnapshot(unsupported);
  const account = db.subscriptionUsageForPrincipal(human(), 1_000_001).sources.find((source) =>
    source.providerAccountId === "work");
  assert.deepEqual([account?.agentId, account?.state], ["wsl-system", "unsupported"]);
  assert.match(account?.detail ?? "", /selected harness installation is unavailable/);
  db.close();
});

test("account projection does not borrow another account's selected agent", () => {
  const db = ControlPlaneDb.open(":memory:");
  const work = { ...codexAgent("work"), available: true, defaultProviderAccountId: "work",
    installation: { id: "old", path: "/opt/codex", via: "path" as const } };
  const personal = { ...codexAgent("personal"), available: true, defaultProviderAccountId: "personal",
    installation: { id: "selected", path: "/usr/bin/codex", via: "path" as const } };
  const generic = { ...codexAgent("generic"), available: true,
    installation: { id: "selected", path: "/usr/bin/codex", via: "path" as const } };
  const owner = { organizationId: "org_personal", owner: { kind: "user" as const, userId: "alice" } };
  const withAccount = (agents: AgentDefinition[]) => ({ ...meta("runner-1", agents),
    providerAccounts: [{ id: "work", label: "Work", provider: "codex" as const, authStatus: "authenticated" as const }] });
  db.registerRunner(withAccount([work, personal, generic]), 1_000_000, PROTOCOL_VERSION, owner);
  assert.ok(db.selectHarnessInstallation("runner-1", "personal", "selected"));
  const first = db.subscriptionUsageForPrincipal(human(), 1_000_000).sources.find((source) =>
    source.providerAccountId === "work");
  assert.deepEqual([first?.agentId, first?.state], ["generic", "unavailable"]);
  db.registerRunner(withAccount([work, personal]), 1_000_001, PROTOCOL_VERSION, owner);
  const missing = db.subscriptionUsageForPrincipal(human(), 1_000_001).sources.find((source) =>
    source.providerAccountId === "work");
  assert.deepEqual([missing?.agentId, missing?.state], ["work", "unsupported"]);
  db.registerRunner(withAccount([personal]), 1_000_002, PROTOCOL_VERSION, owner);
  const incompatible = db.subscriptionUsageForPrincipal(human(), 1_000_002).sources.find((source) =>
    source.providerAccountId === "work");
  assert.deepEqual([incompatible?.agentId, incompatible?.state], ["personal", "unsupported"]);
  db.close();
});

test("account labels remain isolated by runner and switch atomically with available usage", () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = 1_000_000;
  for (const runnerId of ["runner-1", "runner-2"]) {
    db.registerRunner(meta(runnerId), now, PROTOCOL_VERSION, {
      organizationId: "org_personal", owner: { kind: "user", userId: "alice" },
    });
  }
  db.upsertSubscriptionUsageSnapshot({
    ...snapshot("runner-1", now),
    accountLabel: "first@example.com",
  });
  db.upsertSubscriptionUsageSnapshot({
    ...snapshot("runner-2", now),
    accountLabel: "second@example.com",
  });
  assert.deepEqual(
    db.subscriptionUsageForPrincipal(human(), now).sources.map((source) => [
      source.runnerId, source.accountLabel, source.buckets[0]?.remainingPercent,
    ]),
    [
      ["runner-1", "first@example.com", 75],
      ["runner-2", "second@example.com", 75],
    ],
  );

  db.upsertSubscriptionUsageSnapshot({
    ...snapshot("runner-1", now + 1),
    accountLabel: "replacement@example.com",
    buckets: [{ ...snapshot("runner-1", now + 1).buckets[0], remainingPercent: 20 }],
  });
  const switched = db.subscriptionUsageForPrincipal(human(), now + 1).sources;
  assert.deepEqual(switched.map((source) => [source.accountLabel, source.buckets[0]?.remainingPercent]), [
    ["replacement@example.com", 20],
    ["second@example.com", 75],
  ]);
  db.upsertSubscriptionUsageSnapshot({
    ...snapshot("runner-2", now + 2),
    accountLabel: "replacement@example.com",
  });
  const matching = db.subscriptionUsageForPrincipal(human(), now + 2).sources;
  assert.equal(matching.length, 2, "matching display labels never deduplicate distinct runner sources");
  assert.deepEqual(matching.map((source) => source.runnerId), ["runner-1", "runner-2"]);
  db.close();
});

test("one provider account on two Machines remains two independently validated sources", () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = 1_000_000;
  for (const runnerId of ["runner-1", "runner-2"]) {
    db.registerRunner({
      ...meta(runnerId),
      providerAccounts: [{ id: "work", label: "Work", provider: "codex", authStatus: "authenticated" }],
    }, now, PROTOCOL_VERSION, {
      organizationId: "org_personal", owner: { kind: "user", userId: "alice" },
    });
  }
  const accountSnapshot = (runnerId: string, usedPercent: number) => ({
    ...snapshot(runnerId, now),
    sourceId: sourceId(runnerId, "codex", "work"),
    providerAccountId: "work",
    accountLabel: "Work",
    buckets: [{ ...snapshot(runnerId, now).buckets[0], usedPercent }],
  });
  const first = validateSubscriptionUsageSnapshot(accountSnapshot("runner-1", 10), "runner-1", db, now);
  const second = validateSubscriptionUsageSnapshot(accountSnapshot("runner-2", 80), "runner-2", db, now);
  db.upsertSubscriptionUsageSnapshot(first);
  db.upsertSubscriptionUsageSnapshot(second);

  assert.deepEqual(
    db.subscriptionUsageForPrincipal(human(), now).sources.map((source) => [
      source.runnerId, source.providerAccountId, source.accountLabel, source.buckets[0]?.usedPercent,
    ]),
    [
      ["runner-1", "work", "Work", 10],
      ["runner-2", "work", "Work", 80],
    ],
  );
  assert.throws(() => validateSubscriptionUsageSnapshot({
    ...accountSnapshot("runner-1", 10), providerAccountId: "personal",
  }, "runner-1", db, now), /not advertised/);
  db.close();
});

test("an account for one provider preserves the other provider's legacy source", () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = 1_000_000;
  db.registerRunner({
    ...meta("runner-1", [codexAgent(), claudeAgent()]),
    providerAccounts: [{ id: "work", label: "Work", provider: "codex", authStatus: "authenticated" }],
  }, now, PROTOCOL_VERSION, {
    organizationId: "org_personal", owner: { kind: "user", userId: "alice" },
  });

  const projected = db.subscriptionUsageForPrincipal(human(), now).sources;
  assert.deepEqual(projected.map((source) => [source.provider, source.providerAccountId, source.agentId]), [
    ["claude", undefined, "claude"],
    ["codex", "work", "codex"],
  ]);
  const claudeSourceId = createHash("sha256")
    .update(JSON.stringify({ runnerId: "runner-1", agentId: "claude", provider: "claude", context: "native" }))
    .digest("hex")
    .slice(0, 32);
  assert.doesNotThrow(() => validateSubscriptionUsageSnapshot({
    sourceId: claudeSourceId,
    runnerId: "runner-1",
    agentId: "claude",
    provider: "claude",
    state: "available",
    fetchedAt: now,
    buckets: [],
  }, "runner-1", db, now));
  db.close();
});

test("an unbound WSL agent keeps its legacy source beside a same-provider account", () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = 1_000_000;
  const wsl = {
    ...claudeAgent("claude-wsl"),
    context: { kind: "wsl" as const, distro: "Ubuntu" },
  };
  db.registerRunner({
    ...meta("runner-1", [claudeAgent(), wsl]),
    providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }],
  }, now, PROTOCOL_VERSION, {
    organizationId: "org_personal", owner: { kind: "user", userId: "alice" },
  });

  assert.deepEqual(
    db.subscriptionUsageForPrincipal(human(), now).sources.map((source) => [
      source.agentId, source.providerAccountId,
    ]),
    [["claude", "work"], ["claude-wsl", undefined]],
  );
  const wslSourceId = createHash("sha256")
    .update(JSON.stringify({
      runnerId: "runner-1", agentId: "claude-wsl", provider: "claude", context: "wsl:Ubuntu",
    }))
    .digest("hex")
    .slice(0, 32);
  assert.doesNotThrow(() => validateSubscriptionUsageSnapshot({
    sourceId: wslSourceId,
    runnerId: "runner-1",
    agentId: "claude-wsl",
    provider: "claude",
    state: "available",
    fetchedAt: now,
    buckets: [],
  }, "runner-1", db, now));
  db.close();
});

test("an unavailable account transition never retains another account's last-known usage", () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = 1_000_000;
  db.registerRunner(meta("runner-1"), now, PROTOCOL_VERSION, {
    organizationId: "org_personal", owner: { kind: "user", userId: "alice" },
  });
  const prior = { ...snapshot("runner-1", now), accountLabel: "first@example.com" };
  db.upsertSubscriptionUsageSnapshot(prior, now);

  db.upsertSubscriptionUsageSnapshot({
    ...prior,
    state: "unavailable",
    fetchedAt: now + 1,
    buckets: [],
    accountLabel: "second@example.com",
    detail: "Usage for the new account is not available yet.",
  }, now + 1);
  let current = db.subscriptionUsageForPrincipal(human(), now + 1).sources[0]!;
  assert.equal(current.accountLabel, "second@example.com");
  assert.equal(current.state, "unavailable");
  assert.deepEqual(current.buckets, []);

  const claudePrior = { ...prior, provider: "claude" as const };
  db.upsertSubscriptionUsageSnapshot(claudePrior, now + 2);
  const { accountLabel: _accountLabel, ...unlabeledPrior } = claudePrior;
  db.upsertSubscriptionUsageSnapshot({
    ...unlabeledPrior,
    state: "unavailable",
    fetchedAt: now + 3,
    buckets: [],
    detail: "The active account has no display label.",
  }, now + 3);
  current = db.subscriptionUsageForPrincipal(human(), now + 3).sources[0]!;
  assert.equal(current.accountLabel, undefined);
  assert.equal(current.state, "unavailable");
  assert.deepEqual(current.buckets, []);
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
  const { accountLabel: _accountLabel, ...unlabeledFirst } = first;
  db.replaceSubscriptionUsageSnapshots("runner-1", [{
    ...unlabeledFirst,
    state: "unavailable",
    fetchedAt: now + 1,
    buckets: [],
    detail: "The runner restarted before provider usage was fetched.",
  }], now + 1);
  const retained = db.subscriptionUsageForPrincipal(human(), now + 1).sources[0]!;
  assert.equal(retained.state, "available");
  assert.equal(retained.fetchedAt, first.fetchedAt);
  assert.equal(retained.accountLabel, first.accountLabel);
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
