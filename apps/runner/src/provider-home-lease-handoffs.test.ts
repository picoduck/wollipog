import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";

const previousMask = process.umask(0o077);
after(() => process.umask(previousMask));

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);

function request(home: string) {
  return {
    driver: "claude-code" as const,
    command: "claude",
    context: { kind: "native" as const },
    env: { HOME: home },
  };
}

function leasePaths(home: string) {
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  return { root, lock: join(root, "mutable-home.lock") };
}

test("a long journal remains valid and never empties across repeated orderly handoffs", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-long-chain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (let pass = 0; pass < 64; pass++) {
    const registry = new ProviderHomeLeaseRegistry(pass % 2 === 0 ? OWNER_A : OWNER_B);
    try { registry.acquire(request(home)); registry.releaseAll(); }
    catch (error) {
      // Fixture records contain no provider credentials. Keep physical retirement witnesses
      // visible on actual-platform failures instead of losing them in the public remedy.
      const { root, lock } = leasePaths(home);
      t.diagnostic(`failed handoff ${pass}: ${String(error)}`);
      for (const directory of [root, lock]) for (const name of readdirSync(directory)) {
        if (name === "mutable-home.lock") continue;
        const raw = readFileSync(join(directory, name), "utf8");
        t.diagnostic(`${directory === root ? "root" : "lock"}/${name}: ${raw}`);
      }
      throw error;
    }
    assert.ok(readdirSync(leasePaths(home).lock).length > 0);
    assert.deepEqual(registry.getDiagnostics(), []);
  }
  assert.ok(readdirSync(leasePaths(home).lock).length <= 34);
  assert.equal(JSON.parse(readFileSync(join(leasePaths(home).root, "mutable-home.recovery.json"), "utf8")).version, 4);
});
