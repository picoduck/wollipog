import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LeaseCancellation } from "./provider-home-lease-async.js";
import { LEASE_WORKER_ERRORS } from "./provider-home-lease-worker-protocol.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

/** Counts references per HOME the way the lease registry does; release reports whether the last
 * reference went away. */
class CountingRegistry {
  readonly references = new Map<string, number>();
  readonly releases: string[] = [];
  /** Runs after the worker would have granted the reference, before the caller resumes. */
  afterGrant?: () => void;

  async acquireHome(home: string, _provider: string, cancellation: LeaseCancellation = {}): Promise<boolean> {
    if (cancellation.signal?.aborted || cancellation.isCurrent?.() === false) throw new Error(LEASE_WORKER_ERRORS.cancelled);
    const count = this.references.get(home) ?? 0;
    this.references.set(home, count + 1);
    this.afterGrant?.();
    return count === 0;
  }

  async acquire(request: { env?: Record<string, string> }, cancellation: LeaseCancellation = {}): Promise<string | null> {
    const home = request.env?.HOME ?? null;
    if (home) await this.acquireHome(home, "claude", cancellation);
    return home;
  }

  async releaseHome(home: string): Promise<boolean> {
    this.releases.push(home);
    const count = this.references.get(home) ?? 0;
    if (count <= 1) {
      this.references.delete(home);
      return count === 1;
    }
    this.references.set(home, count - 1);
    return false;
  }

  stopAcquisitions(): void {}
  async close(): Promise<boolean> { return true; }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-skill-provider-home-"));
  const store = new SessionStore(join(root, "sessions"));
  const home = join(root, "home");
  const meta: SessionMeta = {
    sessionId: "s1", agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: { HOME: home }, context: { kind: "native" },
    agentSessionId: null, status: "idle", title: "Fixture", config: {}, tokensIn: 0,
    tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  };
  store.create(meta);
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    (() => { throw new Error("fixture provider must not start"); }) as never);
  const registry = new CountingRegistry();
  const internals = manager as unknown as { providerHomeLeases: CountingRegistry; shuttingDown: boolean };
  internals.providerHomeLeases = registry;
  return {
    home, manager, registry, internals, meta,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("a skill transaction releases exactly its own references and never a session's", async () => {
  const h = fixture();
  try {
    await h.registry.acquireHome(h.home, "claude"); // a running session's reference
    const scope = h.manager.skillProviderHomeScope();
    await scope.acquire(h.home);
    await scope.acquire(h.home);
    assert.equal(h.registry.references.get(h.home), 3);
    await scope.release();
    assert.equal(h.registry.references.get(h.home), 1, "the session keeps its reference");
    assert.deepEqual(h.registry.releases, [h.home, h.home]);
    await scope.release();
    assert.equal(h.registry.releases.length, 2, "release is idempotent");
    await assert.rejects(scope.acquire(h.home), /already released/);
  } finally { h.cleanup(); }
});

test("an idle runner's skill reconciliation leaves no provider-HOME reference behind", async () => {
  const h = fixture();
  try {
    const scope = h.manager.skillProviderHomeScope();
    await scope.acquire(h.home);
    await scope.release();
    assert.equal(h.registry.references.has(h.home), false);
  } finally { h.cleanup(); }
});

test("a skill acquisition cancelled after its grant drops the granted reference", async () => {
  const h = fixture();
  try {
    let current = true;
    h.registry.afterGrant = () => { current = false; };
    await assert.rejects(
      h.manager.acquireSkillReconciliationProviderHome(h.home, { isCurrent: () => current }),
      /provider-home acquisition was cancelled/,
    );
    assert.equal(h.registry.references.has(h.home), false);
    assert.deepEqual(h.registry.releases, [h.home]);
  } finally { h.cleanup(); }
});

test("a scope that never acquired does not release a reference it does not hold", async () => {
  const h = fixture();
  try {
    await h.registry.acquireHome(h.home, "claude");
    let current = true;
    h.registry.afterGrant = () => { current = false; };
    await assert.rejects(h.manager.acquireSkillReconciliationProviderHome(h.home, { isCurrent: () => current }));
    h.registry.afterGrant = undefined;
    const scope = h.manager.skillProviderHomeScope();
    await scope.release();
    assert.equal(h.registry.references.get(h.home), 1, "only the cancelled grant was dropped");
  } finally { h.cleanup(); }
});

test("an Agent TUI launch superseded after its grant drops the granted reference", async () => {
  const h = fixture();
  try {
    h.registry.afterGrant = () => { h.internals.shuttingDown = true; };
    await assert.rejects(h.manager.acquireAgentTuiProviderHome(h.meta), /Agent TUI launch changed/);
    assert.equal(h.registry.references.has(h.home), false);
  } finally {
    h.internals.shuttingDown = false;
    h.cleanup();
  }
});
