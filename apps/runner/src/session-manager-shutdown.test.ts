import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
