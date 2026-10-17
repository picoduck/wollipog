import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PACED_VIDEO_REVIEW_MIN_PROTOCOL, PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { composeHostingVideoEvidence, registerHostingVideoEvidenceRoutes } from "./hosting-video-evidence.js";
import { SessionsService } from "./sessions.js";
import { syntheticInspectedVideoRuns, syntheticVideoReviewerTarget } from "./video-live-validation-test-fixture.js";

const contract = { id: "wollipog-paced-video-review-v1", revision: 1 } as const;
const REVIEW_ROUTES = ["prepare", "frame", "frames", "acknowledge-frames", "acknowledge", "verdict", "provenance"];

function runner(pacedVideo: boolean): RunnerMetadata {
  return { runnerId: "r", hostname: "fixture", os: "linux", version: "test", workspaces: [],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" },
      available: true, capabilities: { models: [{ id: "claude-opus-5-5", default: true }], effortLevels: [], slashCommands: [],
        permissionModes: ["default"], supportsImages: true, supportsApprovals: true, imageToolResults: true,
        ...(pacedVideo ? { pacedVideoReviewContract: contract } : {}) } }] };
}

async function harness(t: { after(fn: () => unknown): void }) {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner(false), Date.now(), PROTOCOL_VERSION);
  const video = composeHostingVideoEvidence(db);
  // The same SessionsService wiring as hosting; constructing it must accept the composed pieces.
  new SessionsService(db, new Hub(db), { info() {}, warn() {}, error() {} }, undefined, undefined, undefined, undefined, undefined,
    undefined, false, undefined, undefined, video.workflowVideoApprovals, undefined, undefined, video.preparedMediaActiveStops);
  const identity = db.localIdentityContext();
  const human = (role: HumanPrincipal["role"]): HumanPrincipal => ({ ...identity, kind: "human", actorId: identity.userId, role });
  const agent = (orchestrator: boolean): AuthPrincipal => ({ kind: "agent", actorId: "agent", credentialSessionId: "media-session",
    orchestrator, organizationId: identity.organizationId, delegatedScope: { organizationId: identity.organizationId,
      owner: { kind: "user", userId: identity.userId } } });
  const principals: Record<string, AuthPrincipal> = { owner: human("owner"), admin: human("admin"), operator: human("operator"),
    viewer: human("viewer"), orchestrator: agent(true), reviewer: agent(false) };
  const server = Fastify();
  registerHostingVideoEvidenceRoutes(server, { video,
    requestPrincipal: (req) => principals[String(req.headers["x-fixture-principal"])] ?? null });
  t.after(async () => { await server.close(); db.close(); });
  const call = async (as: string | null, method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await server.inject({ method, url, headers: as ? { "x-fixture-principal": as } : {},
      ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  const register = (pacedVideo: boolean, protocol = PROTOCOL_VERSION) => db.registerRunner(runner(pacedVideo), Date.now(), protocol);
  return { db, video, call, register, owner: principals.owner as HumanPrincipal };
}
const review = (route: string) => `/api/sessions/media-session/video-evidence-review/${route}`;

test("every video evidence route refuses in the current state with a specific reason", async (t) => {
  const h = await harness(t);
  assert.deepEqual(h.video.pacedPeers(), []);
  assert.equal(h.video.readiness().code, "no_paced_video_peer");
  for (const route of REVIEW_ROUTES) {
    for (const as of [null, "owner", "admin", "operator"]) {
      assert.equal((await h.call(as, "POST", review(route), {})).status, 403, `${route} as ${as}`);
    }
    for (const as of ["orchestrator", "reviewer"]) {
      const refused = await h.call(as, "POST", review(route), {});
      assert.equal(refused.status, 409, `${route} as ${as}`);
      assert.equal(refused.body.code, "no_paced_video_peer", "the reason comes before any body validation");
      assert.match(String(refused.body.error), /stays with the Human/u);
    }
  }
  for (const as of [null, "operator", "viewer", "orchestrator", "reviewer"]) {
    assert.equal((await h.call(as, "GET", "/api/video-evidence/live-validations")).status, 403, `list as ${as}`);
    assert.equal((await h.call(as, "POST", "/api/video-evidence/live-validations", {})).status, 403, `record as ${as}`);
    assert.equal((await h.call(as, "POST", "/api/video-evidence/live-validations/any/revoke")).status, 403, `revoke as ${as}`);
  }
  for (const as of ["owner", "admin"]) {
    const listed = await h.call(as, "GET", "/api/video-evidence/live-validations");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.proofs, []);
    assert.equal((listed.body.readiness as { code: string }).code, "no_paced_video_peer");
    const target = syntheticVideoReviewerTarget({ runnerId: "r", agentId: "claude", driver: "claude-code", modelId: "claude-opus-5-5",
      protocolVersion: PROTOCOL_VERSION, contract });
    const recorded = await h.call(as, "POST", "/api/video-evidence/live-validations",
      { target, runs: syntheticInspectedVideoRuns(target, h.owner.userId) });
    assert.equal(recorded.status, 409);
    assert.equal(recorded.body.code, "no_paced_video_peer");
    const revoked = await h.call(as, "POST", "/api/video-evidence/live-validations/video_live_proof_missing/revoke");
    assert.equal(revoked.status, 409);
    assert.equal(revoked.body.code, "no_current_proof");
  }
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM video_profile_live_validation").get()!.n, 0);
});

test("readiness advances only through a paced peer and a Human proof, and still refuses without the media reviewer", async (t) => {
  const h = await harness(t);
  h.register(true, PACED_VIDEO_REVIEW_MIN_PROTOCOL - 1);
  assert.equal(h.video.readiness().code, "no_paced_video_peer", "an older protocol cannot carry the contract");
  h.register(true);
  assert.equal(h.video.readiness().code, "live_validation");
  const peer = h.video.pacedPeers()[0]!;
  assert.deepEqual(peer, { runnerId: "r", agentId: "claude", driver: "claude-code", models: ["claude-opus-5-5"],
    protocolVersion: PROTOCOL_VERSION, contract });
  for (const route of REVIEW_ROUTES) assert.equal((await h.call("reviewer", "POST", review(route), {})).body.code, "live_validation");

  const target = syntheticVideoReviewerTarget({ ...peer, modelId: "claude-opus-5-5" });
  const runs = syntheticInspectedVideoRuns(target, h.owner.userId);
  const record = (body: unknown) => h.call("owner", "POST", "/api/video-evidence/live-validations", body);
  for (const mismatch of [{ runnerId: "other" }, { agentId: "other" }, { modelId: "other-model" },
    { runnerProtocolVersion: PROTOCOL_VERSION - 1 }, { pacedVideoReviewContract: { ...contract, revision: 2 } }]) {
    const changed = { ...target, ...mismatch };
    assert.equal((await record({ target: changed, runs: syntheticInspectedVideoRuns(changed, h.owner.userId) })).body.code,
      "no_paced_video_peer", JSON.stringify(mismatch));
  }
  assert.equal((await record({ target })).status, 400);
  assert.equal((await record({ target, runs, extra: true })).status, 400);
  assert.equal((await record({ target, runs: runs.slice(1) })).body.code, "invalid_validation");
  assert.equal((await record({ target, runs: [null, null, null] })).body.code, "invalid_validation");
  assert.equal((await record({ target, runs: syntheticInspectedVideoRuns(target, "someone-else") })).body.code, "invalid_validation",
    "the recording Human must be the one who inspected the runs");

  const recorded = await record({ target, runs });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  const proof = recorded.body.proof as { proofId: string; verifiedByUserId: string; revoked: boolean };
  assert.equal(proof.verifiedByUserId, h.owner.userId);
  assert.equal(proof.revoked, false);
  assert.equal(h.video.readiness().code, "reviewer_unavailable");
  for (const route of REVIEW_ROUTES) {
    const refused = await h.call("orchestrator", "POST", review(route), {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "reviewer_unavailable", "a proof never enables review without the media-only reviewer");
  }
  const listed = await h.call("admin", "GET", "/api/video-evidence/live-validations");
  assert.deepEqual((listed.body.proofs as Array<{ proofId: string }>).map((item) => item.proofId), [proof.proofId]);

  const revoked = await h.call("admin", "POST", `/api/video-evidence/live-validations/${proof.proofId}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal((revoked.body.readiness as { code: string }).code, "live_validation");
  assert.equal((await h.call("admin", "POST", `/api/video-evidence/live-validations/${proof.proofId}/revoke`)).body.code, "no_current_proof");
  h.register(false);
  assert.equal(h.video.readiness().code, "no_paced_video_peer", "removing the contract withdraws readiness at once");
});

test("the composed pieces are inert: no gate, binding, source or owned Stop handle is available", async (t) => {
  const h = await harness(t);
  h.register(true);
  assert.equal(h.video.preparedMediaActiveStops.request("any-session"), null);
  assert.equal(h.video.preparedMediaActiveStops.owns("any-session"), false);
  assert.equal(h.video.preparedMediaActiveStops.acknowledge("r", {} as never), false);
  const result = await h.video.reviewService.prepare({ kind: "agent", actorId: "root", credentialSessionId: "root", orchestrator: true,
    organizationId: "org", delegatedScope: { organizationId: "org", owner: { kind: "user", userId: "user" } } },
  { childSessionId: "child", occurrenceId: "occurrence", evidenceId: "video" });
  assert.deepEqual(result, { ok: false, code: "not_authorized" });
  for (const table of ["video_profile_live_validation", "temporal_video_reviews", "workflow_video_approvals",
    "prepared_media_sessions", "prepared_media_active_stops"]) {
    assert.equal(h.db.raw().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
  }
  // Recomposing over the same database, as a restart does, keeps the schema and adds nothing.
  composeHostingVideoEvidence(h.db);
  assert.equal(h.video.readiness().code, "live_validation");
});
