import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";

test("provider-home ownership is released only after shutdown process trees are reaped", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-shutdown-provider-home-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new SessionManager(
    () => {},
    () => {},
    new SessionStore(join(root, "sessions")),
    "runner",
    undefined,
    undefined,
    root,
  );
  const providerHome = join(root, "provider-home");
  mkdirSync(providerHome);
  const ownerHash = "a".repeat(64);
  const registry = new ProviderHomeLeaseRegistry(ownerHash, {
    pid: 101,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === 101,
  });
  registry.acquire({
    driver: "claude-code",
    command: "claude",
    context: { kind: "native" },
    env: { HOME: providerHome },
  });
  let releases = 0;
  (manager as unknown as { providerHomeLeases: { releaseAll(): void } }).providerHomeLeases = {
    releaseAll: () => { releases++; registry.releaseAll(); },
  };

  assert.throws(() => manager.releaseProviderHomeLeasesAfterShutdown(true), /only be released after shutdown begins/);
  manager.shutdownAll();
  assert.equal(releases, 0, "shutdown initiation must retain ownership while process kills drain");
  assert.equal(manager.releaseProviderHomeLeasesAfterShutdown(false), false);
  assert.equal(releases, 0, "a reap deadline retains the durable lease for fail-closed recovery");
  const restarted = new ProviderHomeLeaseRegistry(ownerHash, {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
  });
  assert.throws(() => restarted.acquire({
    driver: "claude-code",
    command: "claude",
    context: { kind: "native" },
    env: { HOME: providerHome },
  }), /stale lease.*manually quarantine/);
  assert.equal(manager.releaseProviderHomeLeasesAfterShutdown(true), true);
  assert.equal(releases, 1);
  restarted.acquire({
    driver: "claude-code",
    command: "claude",
    context: { kind: "native" },
    env: { HOME: providerHome },
  });
  restarted.releaseAll();
});

test("subscription probes resolve runner isolation before acquiring provider-HOME ownership", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-subscription-probe-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new SessionManager(
    () => {},
    () => {},
    new SessionStore(join(root, "sessions")),
    "runner",
    undefined,
    undefined,
    root,
  );
  const isolation = { backend: "bwrap" as const, command: "bwrap", args: [], network: "deny" as const };
  let resolvedState: unknown;
  let leaseRequest: unknown;
  (manager as unknown as { resolveIsolation: (...args: unknown[]) => Promise<typeof isolation> }).resolveIsolation =
    async (...args: unknown[]) => {
      resolvedState = args[3];
      return isolation;
    };
  (manager as unknown as { providerHomeLeases: { acquire(request: unknown): void } }).providerHomeLeases = {
    acquire: (request) => { leaseRequest = request; },
  };
  const agent: AgentDefinition = {
    id: "codex", name: "Codex", command: "codex", args: [], env: {},
    driver: "codex-app-server", context: { kind: "wsl", distro: "Ubuntu" },
  };
  assert.equal(await manager.prepareSubscriptionUsageProbe(agent, { HOME: "/home/alice" }, "a".repeat(32)), isolation);
  assert.deepEqual(resolvedState, {
    driver: "codex-app-server",
    dataDir: root,
    env: { HOME: "/home/alice" },
    sessionId: `subscription-usage:${"a".repeat(32)}`,
    cwd: root,
  });
  assert.deepEqual(leaseRequest, {
    driver: "codex-app-server",
    command: "codex",
    context: { kind: "wsl", distro: "Ubuntu" },
    env: { HOME: "/home/alice" },
    isolation,
  });
  manager.shutdownAll();
});
