import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderProfileGrants } from "./provider-profile-grants.js";
import { createProviderProfileLoginSettlement } from "./provider-profile-login-settlement.js";

const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const GRANT = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

test("the production settlement callback drops unknown access without revoking retained evidence", async t => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-settlement-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const recorded of [true, false, "unknown"] as const) {
    for (const revoked of [false, true]) {
      const grants = new ProviderProfileGrants({ controlPlaneInstanceId: undefined, accounts: () => [] });
      grants.synchronize(225, []); grants.recordCreated(PROFILE, GRANT);
      if (revoked) grants.recordRevoked(PROFILE, GRANT);
      const revocations: unknown[][] = [];
      const settle = createProviderProfileLoginSettlement({
        settleCreated: (profileId, grantId, value) => grants.settleCreated(profileId, grantId, value),
        revoke: async (...args) => { revocations.push(args); }, log: () => {},
      });
      await settle({ home, provider: "claude", profileId: PROFILE, grantId: GRANT, recorded, homeRemoved: false });
      assert.deepEqual(grants.access().activeProfileIds, recorded === true && !revoked ? [PROFILE] : []);
      assert.equal(revocations.length, recorded === false ? 1 : 0);
      assert.equal(existsSync(home), true);
    }
  }
});

test("the production settlement callback retains removed or absent HOMEs and sanitizes revoke errors", async t => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-settlement-guards-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const logs: string[] = []; let attempts = 0;
  const settle = createProviderProfileLoginSettlement({ settleCreated: () => {},
    revoke: async () => { attempts++; throw new Error("private path and credential bytes"); }, log: value => logs.push(value) });
  const input = { home, provider: "claude" as const, profileId: PROFILE, grantId: GRANT, recorded: false, homeRemoved: false };
  await settle({ ...input, homeRemoved: true });
  await settle({ ...input, home: join(home, "absent") });
  assert.equal(attempts, 0);
  await settle(input);
  assert.equal(attempts, 1);
  assert.deepEqual(logs, ["a discarded provider profile's grant could not be removed from its marker"]);
});
