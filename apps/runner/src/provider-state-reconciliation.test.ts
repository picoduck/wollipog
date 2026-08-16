import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerStateKey } from "./execution-isolation.js";
import {
  ProviderStateCleanupJournal,
  reconcileProviderState,
  retryProviderStateCleanup,
  type StateEntry,
  type StateFs,
} from "./provider-state-reconciliation.js";

const bwrap = {
  mode: "bwrap" as const,
  network: "inherit" as const,
  providerStateRetentionDays: 7,
  providerStateMaxBytes: 100,
};

test("provider-state reconciliation protects live sessions, expires owned orphans, and retains shared legacy state", async () => {
  const now = Date.UTC(2026, 6, 12);
  const day = 86_400_000;
  const activeClaude = providerStateKey("active-claude");
  const activeWslCodex = providerStateKey("active-wsl-codex");
  const expired = "a".repeat(64);
  const freshOldest = "b".repeat(64);
  const freshNewest = "c".repeat(64);
  const wslOrphan = "d".repeat(64);
  const inProgress = providerStateKey("in-progress-fork");
  const peerWsl = "f".repeat(64);
  const failedCleanup = providerStateKey("failed-cleanup");
  const ownerKey = providerStateKey("runner-a");
  const wslBase = `/home/me/.agent-manager/runner-instances/${ownerKey}`;
  const byRoot = new Map<string, StateEntry[]>([
    ["/data/provider-state/claude", [
      { name: activeClaude, mtimeMs: now - 30 * day, bytes: 500 },
      { name: expired, mtimeMs: now - 8 * day, bytes: 40, ownerKey },
      { name: "projects", mtimeMs: now - 30 * day, bytes: 900 },
    ]],
    ["/data/provider-state/codex", [
      { name: freshOldest, mtimeMs: now - 2 * day, bytes: 70, ownerKey },
      { name: freshNewest, mtimeMs: now - day, bytes: 80, ownerKey },
      { name: inProgress, mtimeMs: now - 30 * day, bytes: 1000, ownerKey },
      { name: failedCleanup, mtimeMs: now - 8 * day, bytes: 10 },
      { name: "sessions", mtimeMs: now - 30 * day, bytes: 900 },
    ]],
    [`${wslBase}/provider-state/claude`, []],
    [`${wslBase}/provider-state/codex`, [
      { name: activeWslCodex, mtimeMs: now - 30 * day, bytes: 500 },
      { name: wslOrphan, mtimeMs: now - 8 * day, bytes: 25, ownerKey },
      { name: peerWsl, mtimeMs: now - 30 * day, bytes: 500, ownerKey: providerStateKey("runner-b") },
      { name: "sessions", mtimeMs: now - 30 * day, bytes: 900 },
    ]],
  ]);
  const removed: string[] = [];
  const fs: StateFs = {
    list: async (_context, root) => byRoot.get(root.replaceAll("\\", "/")) ?? [],
    claim: async () => {},
    remove: async (_context, path) => { removed.push(path.replaceAll("\\", "/")); },
    wslHome: async () => "/home/me",
  };
  const result = await reconcileProviderState(bwrap, "/data", [
    { sessionId: "active-claude", driver: "claude-code", context: { kind: "native" }, providerStateVersion: 2 },
    { sessionId: "legacy-claude", driver: "claude-code", context: { kind: "native" } },
    { sessionId: "migrated-codex", driver: "codex", context: { kind: "native" }, providerStateVersion: 2 },
    { sessionId: "active-wsl-codex", driver: "codex-app-server", context: { kind: "wsl", distro: "Ubuntu" }, providerStateVersion: 2 },
  ], ownerKey, [
    { sessionId: "failed-cleanup", driver: "codex", context: { kind: "native" } },
  ], new Set(["in-progress-fork"]), [], now, fs);
  assert.deepEqual(removed.sort(), [
    `/data/provider-state/claude/${expired}`,
    `/data/provider-state/codex/${freshOldest}`,
    `${wslBase}/provider-state/codex/${wslOrphan}`,
  ].sort());
  assert.equal(removed.includes("/data/provider-state/claude/projects"), false, "legacy root remains until every old session migrates");
  assert.equal(removed.includes("/data/provider-state/codex/sessions"), false, "unowned shared legacy roots fail safe");
  assert.equal(removed.some((path) => path.endsWith(inProgress)), false, "an in-flight fork remains protected at any age");
  assert.equal(removed.some((path) => path.endsWith(failedCleanup)), false, "a journal-owned partition is left to exact cleanup");
  assert.equal(removed.some((path) => path.endsWith(peerWsl)), false, "a peer runner's WSL partition is never eligible");
  assert.equal(result.retainedBytes, 80);
  assert.deepEqual(result.errors, []);
});

test("failed exact cleanup survives restart and retry removes only its hashed partition", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-cleanup-"));
  try {
    const key = providerStateKey("deleted-session");
    const partition = join(root, "provider-state", "codex", key);
    mkdirSync(join(partition, "sessions"), { recursive: true });
    const first = new ProviderStateCleanupJournal(root);
    first.add({ sessionId: "deleted-session", driver: "codex", context: { kind: "native" } });
    const concurrent = new ProviderStateCleanupJournal(root);
    concurrent.add({ sessionId: "other-session", driver: "claude-code", context: { kind: "native" } });
    const restarted = new ProviderStateCleanupJournal(root);
    assert.equal(restarted.list().length, 2, "per-record journal writes from different processes do not clobber");
    await retryProviderStateCleanup(
      { mode: "provider", network: "inherit" }, root, restarted, new Set(), () => {},
    );
    assert.equal(existsSync(partition), true, "a second process gives a freshly journaled fork target time to publish");
    assert.equal(restarted.list().length, 2, "fresh exact-cleanup records retain their cross-process grace");
    await retryProviderStateCleanup(
      { mode: "provider", network: "inherit" }, root, restarted, new Set(["deleted-session"]), () => {},
      Date.now() + 2 * 60 * 60 * 1000,
    );
    assert.equal(existsSync(partition), true, "a journal written before a crash cannot delete a surviving session");
    assert.deepEqual(restarted.list(), [{
      sessionId: "deleted-session", driver: "codex", context: { kind: "native" },
    }], "the protected cleanup intent remains durable while unrelated work is retried");
    await retryProviderStateCleanup(
      { mode: "provider", network: "inherit" }, root, restarted, new Set(), () => {},
      Date.now() + 2 * 60 * 60 * 1000,
    );
    assert.equal(existsSync(partition), false);
    assert.deepEqual(restarted.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stable WSL ownership preserves the legacy native marker key during upgrade", async () => {
  const now = Date.UTC(2026, 6, 12);
  const nativeOwner = providerStateKey("runner-a");
  const stableOwner = "e".repeat(64);
  const orphan = "a".repeat(64);
  const removed: string[] = [];
  await reconcileProviderState(
    bwrap,
    "/data",
    [],
    stableOwner,
    [],
    new Set(),
    [],
    now,
    {
      list: async (context, root) => context.kind === "native" && root === "/data/provider-state/codex"
        ? [{ name: orphan, mtimeMs: 0, bytes: 1, ownerKey: nativeOwner }]
        : [],
      claim: async () => {},
      remove: async (_context, path) => { removed.push(path); },
      wslHome: async () => "/home/me",
    },
    nativeOwner,
  );
  assert.deepEqual(removed, [`/data/provider-state/codex/${orphan}`]);
});

test("one offline WSL distro does not abort later reconciliation contexts", async () => {
  const now = Date.UTC(2026, 6, 12);
  const ownerKey = providerStateKey("runner-a");
  const orphan = "9".repeat(64);
  const peer = providerStateKey("peer-live");
  const removed: string[] = [];
  const fs: StateFs = {
    wslHome: async (context) => {
      if (context.distro === "Offline") throw new Error("distro unavailable");
      return "/home/me";
    },
    claim: async (_context, path) => { if (path.endsWith(peer)) throw new Error("belongs to another runner"); },
    list: async (context, root) => context.kind === "wsl" && context.distro === "Debian" && root.endsWith("/codex")
      ? [
        { name: orphan, mtimeMs: now - 10 * 86_400_000, bytes: 5, ownerKey },
        { name: peer, mtimeMs: now - 10 * 86_400_000, bytes: 5, ownerKey: providerStateKey("runner-b") },
      ]
      : [],
    remove: async (_context, path) => { removed.push(path); },
  };
  const result = await reconcileProviderState(
    bwrap,
    "/data",
    [{ sessionId: "peer-live", driver: "codex", context: { kind: "wsl", distro: "Debian" }, providerStateVersion: 2 }],
    ownerKey,
    [],
    new Set(),
    [{ kind: "wsl", distro: "Offline" }, { kind: "wsl", distro: "Debian" }],
    now,
    fs,
  );
  assert.deepEqual(result.errors.sort(), [
    "WSL Offline: distro unavailable",
    "WSL Debian codex session peer-live: belongs to another runner",
  ].sort());
  assert.deepEqual(removed, [
    `/home/me/.agent-manager/runner-instances/${ownerKey}/provider-state/codex/${orphan}`,
  ]);
});
