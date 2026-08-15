import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";

function request(home: string) {
  return {
    driver: "claude-code" as const,
    command: "claude",
    context: { kind: "native" as const },
    env: { HOME: home },
  };
}

test("provider-home leases are process-reentrant and reject a live competing owner", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 101,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === 101,
  });
  const second = new ProviderHomeLeaseRegistry("b".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === 101,
  });
  first.acquire(request(home));
  first.acquire(request(home));
  assert.throws(() => second.acquire(request(home)), /already in use by process 101/);
  first.releaseAll();
  second.acquire(request(home));
  second.releaseAll();
});

test("provider-home leases recover only a validated stale same-host record", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-stale-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stale = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: 101, hostname: "host-a" });
  stale.acquire(request(home));
  const replacement = new ProviderHomeLeaseRegistry("b".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
  });
  replacement.acquire(request(home));
  stale.releaseAll();
  assert.throws(() => new ProviderHomeLeaseRegistry("c".repeat(64), {
    pid: 303,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === 202,
  }).acquire(request(home)), /already in use by process 202/);
  replacement.releaseAll();
});

test("provider-home leases fail closed for WSL direct mode and bypass redirected bwrap homes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-wsl-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "work"));
  const registry = new ProviderHomeLeaseRegistry("a".repeat(64));
  assert.throws(() => registry.acquire({
    ...request(home),
    context: { kind: "wsl", distro: "Ubuntu" },
  }), /cannot be safely owner-leased.*bwrap/);
  registry.acquire({
    ...request(home),
    context: { kind: "wsl", distro: "Ubuntu" },
    isolation: { backend: "bwrap", command: "bwrap", args: [], network: "inherit" },
  });
});

test("the whole effective HOME is shared across providers and relative HOME fails closed", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-whole-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 101, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  first.acquire(request(home));
  const second = new ProviderHomeLeaseRegistry("b".repeat(64), {
    pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  assert.throws(() => second.acquire({ ...request(home), driver: "codex", command: "codex" }),
    /already in use by process 101/);
  assert.throws(() => first.acquire({ ...request(home), env: { HOME: "relative" } }), /HOME must be absolute/);
  first.releaseAll();
});
