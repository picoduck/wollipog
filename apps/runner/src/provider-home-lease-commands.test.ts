import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_HOME_RECOVERY_CAUSES } from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { inspectProviderHomeLeaseCommand, providerHomeLeaseRecoveryCode, recoverProviderHomeLeaseCommand, type ProviderHomeLeaseCommandDeps } from "./provider-home-lease-commands.js";
import { ProviderHomeLeaseError, type LeaseWorkerError } from "./provider-home-lease-worker-protocol.js";

const TIP = "a".repeat(64);
const AUTHORIZATION = "5a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const ACCOUNT = { id: "work", label: "Work", provider: "claude", directory: "/home/u/.claude-work" } as RunnerProviderAccount;

function deps(overrides: Partial<ProviderHomeLeaseCommandDeps> = {}) {
  const calls: unknown[][] = [];
  const value: ProviderHomeLeaseCommandDeps = {
    platform: "linux",
    accounts: () => [ACCOUNT],
    inspect: async (home) => { calls.push(["inspect", home]); return { state: "stale", tipHash: TIP, createdAt: "2026-08-19T00:00:00.000Z", sameHost: true, hasEvidence: false, refusal: "no_reboot_proof" }; },
    recover: async (...args) => { calls.push(["recover", ...args]); },
    log: () => {},
    ...overrides,
  };
  return { value, calls };
}

test("an inspection reports the stale record with the control plane's refusal code", async () => {
  const { value, calls } = deps();
  assert.deepEqual(await inspectProviderHomeLeaseCommand(value, { type: "inspect_provider_home_lease", requestId: "r1", accountId: "work" }), {
    type: "inspect_provider_home_lease_result", requestId: "r1", ok: true,
    inspection: { state: "stale", tipHash: TIP, createdAt: "2026-08-19T00:00:00.000Z", sameHost: true, hasEvidence: false, refusal: "NO_REBOOT_PROOF" },
  });
  assert.deepEqual(calls, [["inspect", ACCOUNT.directory]]);
  const free = deps({ inspect: async () => ({ state: "released" }) });
  assert.deepEqual((await inspectProviderHomeLeaseCommand(free.value, { type: "inspect_provider_home_lease", requestId: "r2", accountId: "work" })).inspection,
    { state: "released" });
});

test("unknown accounts and Windows or non-POSIX homes are refused before the worker", async () => {
  for (const [name, overrides, code] of [
    ["unknown", { accounts: () => [] }, undefined],
    ["windows", { platform: "win32" as const }, "UNSUPPORTED_HOME"],
    ["non-posix", { accounts: () => [{ ...ACCOUNT, directory: "C:\\Users\\u\\.claude" }] }, "UNSUPPORTED_HOME"],
  ] as const) {
    const { value, calls } = deps(overrides);
    const inspected = await inspectProviderHomeLeaseCommand(value, { type: "inspect_provider_home_lease", requestId: "r", accountId: "work" });
    const recovered = await recoverProviderHomeLeaseCommand(value, { type: "recover_provider_home_lease", requestId: "r", accountId: "work", staleTipHash: TIP, authorizationId: AUTHORIZATION });
    assert.deepEqual([inspected.ok, inspected.code, recovered.ok, recovered.code], [false, code, false, code], name);
    assert.deepEqual(calls, [], name);
  }
});

test("a recovery passes the exact authorization through and maps refusals; transient failures stay uncoded", async () => {
  const { value, calls } = deps();
  assert.deepEqual(await recoverProviderHomeLeaseCommand(value, { type: "recover_provider_home_lease", requestId: "r1", accountId: "work", staleTipHash: TIP, authorizationId: AUTHORIZATION }),
    { type: "recover_provider_home_lease_result", requestId: "r1", ok: true });
  assert.deepEqual(calls, [["recover", ACCOUNT.directory, "claude", TIP, AUTHORIZATION]]);
  for (const bad of [{ staleTipHash: "z".repeat(64) }, { authorizationId: "not-a-uuid" }]) {
    const malformed = deps();
    const result = await recoverProviderHomeLeaseCommand(malformed.value, { type: "recover_provider_home_lease", requestId: "r", accountId: "work", staleTipHash: TIP, authorizationId: AUTHORIZATION, ...bad });
    assert.deepEqual([result.ok, result.code, malformed.calls.length], [false, undefined, 0]);
  }
  const expected: Array<[LeaseWorkerError, string | undefined]> = [
    ["stale_tip_changed", "TIP_CHANGED"], ["no_reboot_proof", "NO_REBOOT_PROOF"], ["busy", "HOME_IN_USE"], ["foreign_host", "FOREIGN_HOST"],
    ["profile_not_granted", "PROFILE_REFUSED"], ["refusal", "UNVERIFIABLE"], ["foreign_owner", "UNVERIFIABLE"], ["unavailable", undefined], ["expired", undefined], ["recovery_unconfirmed", undefined],
  ];
  for (const [worker, code] of expected) {
    assert.equal(providerHomeLeaseRecoveryCode(worker), code, worker);
    const refused = deps({ recover: async () => { throw new ProviderHomeLeaseError(worker); } });
    const result = await recoverProviderHomeLeaseCommand(refused.value, { type: "recover_provider_home_lease", requestId: "r", accountId: "work", staleTipHash: TIP, authorizationId: AUTHORIZATION });
    assert.deepEqual([result.ok, result.code], [false, code], worker);
  }
});

test("authorized inspection keeps specific causes and process facts only for capable peers", async () => {
  const blockingProcess = { pid: 42, startTime: "12345", kind: "boundary_member" as const, cgroupMembership: "recorded_boundary" as const };
  for (const cause of PROVIDER_HOME_RECOVERY_CAUSES) {
    for (const version of [229, 233, 234, 235]) {
      const { value } = deps({ controlPlaneProtocolVersion: () => version,
        inspect: async () => ({ state: "stale", tipHash: TIP, sameHost: true, hasEvidence: true, refusal: cause, blockingProcess }) });
      const { inspection } = await inspectProviderHomeLeaseCommand(value, { type: "inspect_provider_home_lease", requestId: "r", accountId: "work" });
      assert.equal(inspection?.cause, version >= 235 ? cause : undefined);
      assert.deepEqual(inspection?.blockingProcess, version >= 235 ? blockingProcess : undefined);
      assert.ok(!JSON.stringify(inspection).includes(ACCOUNT.directory));
    }
  }
});
