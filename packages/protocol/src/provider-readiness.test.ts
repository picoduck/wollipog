import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { safeProviderReadiness, providerLoginInstallationMissing, type ProviderReadiness } from "./provider-readiness.js";

const now = 1_800_000_000_000;
const reports = fc.record({ checkedAt: fc.integer({ min: 0, max: now }),
  installation: fc.constantFrom("compatible", "missing", "incompatible", "unknown"),
  installationAdmission: fc.option(fc.constantFrom("permitted", "blocked", "unknown"), { nil: undefined }),
  reason: fc.constantFrom("ready", "sign_in_required", "in_use", "restricted", "unknown"),
}).map(({ installationAdmission, ...value }) => ({ ...value, ...(installationAdmission ? { installationAdmission } : {}), authentication: value.reason === "ready" ? "authenticated"
  : value.reason === "sign_in_required" ? "unauthenticated" : "unknown" } as ProviderReadiness));

test("provider observations survive JSON roundtrip while arbitrary extra diagnostics are stripped", () => {
  fc.assert(fc.property(reports, fc.string(), (report, secret) => {
    assert.deepEqual(safeProviderReadiness(JSON.parse(JSON.stringify({ ...report, diagnostic: secret })), now), report);
    assert.deepEqual(safeProviderReadiness(safeProviderReadiness(report, now), now), report);
  }));
});

test("content-free observations reject contradictory authentication and future timestamps", () => {
  fc.assert(fc.property(reports, (report) => {
    const changed = { ...report, authentication: report.authentication === "authenticated" ? "unauthenticated" : "authenticated" };
    assert.equal(safeProviderReadiness(changed, now), undefined);
    assert.equal(safeProviderReadiness({ ...report, checkedAt: now + 300_001 }, now), undefined);
  }));
  for (const value of [null, [], "ready", {}, { checkedAt: NaN }, { checkedAt: Infinity }]) assert.equal(safeProviderReadiness(value, now), undefined);
});

test("setup installation gate never depends on default authentication or App Server integration support", () => {
  for (const status of ["ready", "unauthenticated", "unsupported"]) assert.equal(providerLoginInstallationMissing({ claudeCode: { status } }), false);
  for (const status of ["supported", "unsupported"]) assert.equal(providerLoginInstallationMissing({ codexAppServer: { status } }), false);
  assert.equal(providerLoginInstallationMissing({}), false, "old or unknown peers stay unknown");
  assert.equal(providerLoginInstallationMissing({ codexAppServer: { status: "unavailable", failure: { code: "probe_failed", retryable: true } } }), false);
  assert.equal(providerLoginInstallationMissing({ claudeCode: { status: "unavailable" } }), true);
  for (const reason of ["ready", "sign_in_required", "in_use", "restricted", "unknown"] as const) {
    assert.equal(providerLoginInstallationMissing({ providerReadiness: { checkedAt: now, installation: "compatible", authentication: "unknown", reason } }), false);
  }
});
