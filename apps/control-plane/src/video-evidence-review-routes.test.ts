import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { AuthPrincipal } from "./identity.js";
import type { EvidenceReviewService } from "./evidence-review-service.js";
import { registerVideoEvidenceReviewRoutes } from "./video-evidence-review-routes.js";
const agent = (id: string): AuthPrincipal => ({
  kind: "agent", actorId: id, credentialSessionId: id, organizationId: "test",
  delegatedScope: { organizationId: "test", owner: { kind: "user", userId: "owner" } },
});
/** Route credential/input boundary only. Test service returns no evidence or live proof. */
function fixture(t: { after(fn: () => Promise<void>): void }) {
  const app = Fastify();
  t.after(async () => { await app.close(); });
  let principal: AuthPrincipal | null = null, calls = 0;
  const service = {
    prepare: async () => { calls++; return { ok: false, code: "live_validation" }; },
    deliver: () => { calls++; throw new Error("No real media grant in this route test."); },
    acknowledge: () => { calls++; throw new Error("No real receipt in this route test."); },
    verdict: () => { calls++; throw new Error("No real verdict in this route test."); },
    ownerProvenance: () => { calls++; throw new Error("No real provenance in this route test."); },
  } as unknown as EvidenceReviewService;
  registerVideoEvidenceReviewRoutes(app, { service, requestPrincipal: () => principal });
  return { app, calls: () => calls, setPrincipal: (p: AuthPrincipal | null) => { principal = p; } };
}
const prefix = "/api/sessions/worker/video-evidence-review";
test("all media routes bind their path to the authenticated Session credential before parsing or calling service", async (t) => {
  const f = fixture(t);
  for (const principal of [null, agent("implementer"), agent("other-campaign")]) {
    f.setPrincipal(principal);
    for (const action of ["prepare", "frame", "acknowledge", "verdict", "provenance"]) {
      const result = await f.app.inject({ method: "POST", url: prefix + "/" + action, payload: {} });
      assert.equal(result.statusCode, 403);
    }
  }
  assert.equal(f.calls(), 0);
});
test("untrusted grant claims, URLs, unbounded indices and extra fields never reach the service", async (t) => {
  const f = fixture(t); f.setPrincipal(agent("worker"));
  for (const [action, payload] of [
    ["prepare", { childSessionId: "child", occurrenceId: "workflow", evidenceId: "video", grant: true }],
    ["frame", { reviewId: "review", index: 900 }],
    ["frame", { reviewId: "review", index: 0, url: "http://localhost/private" }],
    ["acknowledge", { reviewId: "review", receiptId: "receipt", sha256: "bad" }],
    ["verdict", { reviewId: "review", report: { outcome: "accept", criteria: [], rationale: "test", authority: "human" } }],
    ["provenance", { reviewId: "review", reviewerSessionId: "claimed" }],
  ] as const) {
    const result = await f.app.inject({ method: "POST", url: prefix + "/" + action, payload });
    assert.equal(result.statusCode, 400);
  }
  assert.equal(f.calls(), 0);
});
test("unsupported readiness and absent grants return bounded no-store errors with no source bytes", async (t) => {
  const f = fixture(t); f.setPrincipal(agent("worker"));
  for (const [action, payload] of [
    ["prepare", { childSessionId: "child", occurrenceId: "workflow", evidenceId: "video" }],
    ["frame", { reviewId: "review", index: 0 }],
    ["acknowledge", { reviewId: "review", receiptId: "receipt", sha256: "a".repeat(64) }],
    ["verdict", { reviewId: "review", report: { outcome: "accept", criteria: [], rationale: "test" } }],
    ["provenance", { reviewId: "review" }],
  ] as const) {
    const result = await f.app.inject({ method: "POST", url: prefix + "/" + action, payload });
    assert.equal(result.statusCode, 409);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.doesNotMatch(result.body, /base64|grant in this route|receipt in this route|provenance in this route/u);
  }
  assert.equal(f.calls(), 5);
});
