import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import Fastify from "fastify";
import type { RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { registerAuthGate } from "./http-auth.js";
import { isAllowedOrigin } from "./net.js";
import { registerPublicTranscriptShareRoute } from "./transcript-share-route.js";
import {
  MAX_TRANSCRIPT_SHARE_READS_PER_TOKEN_PER_MINUTE,
  TranscriptShareReadLimiter,
  createAuthorizedTranscriptShare,
  revokeAuthorizedTranscriptShare,
} from "./transcript-shares.js";

const runner: RunnerMetadata = {
  runnerId: "route-runner",
  hostname: "host",
  os: "linux",
  version: "1",
  agents: [],
  workspaces: [],
};

function rawGet(url: string, headers: Record<string, string | string[]>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "GET", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("the real public share route enforces capability lifecycle, headers, origin, and rate bounds", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, 1, 53);
  db.createSession({
    id: "route-session", runnerId: runner.runnerId, agentId: null, workspaceId: null,
    title: "Never public", useWorktree: false, driver: "acp", config: {}, now: 1,
  });
  db.appendEvent("route-session", { kind: "user_message", text: "public message" }, 2);
  const identity = db.localIdentityContext();
  const principal = { kind: "human" as const, actorId: identity.userId, ...identity };
  let now = 10_000;
  const created = createAuthorizedTranscriptShare(db, principal, "route-session", { expiresInSeconds: 3600 }, now);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const app = Fastify();
  registerAuthGate(app, {
    authenticate: () => null,
    isAllowedOrigin,
  });
  registerPublicTranscriptShareRoute(app, { db, limiter: new TranscriptShareReadLimiter(), now: () => now });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); });
  const authorization = `MAM-Share ${created.value.token}`;

  const success = await app.inject({ method: "GET", url: "/api/public/transcript-share", remoteAddress: "10.0.0.8", headers: { authorization } });
  assert.equal(success.statusCode, 200);
  assert.equal(success.headers["cache-control"], "no-store, max-age=0");
  assert.equal(success.headers.pragma, "no-cache");
  assert.equal(success.headers.vary, "Authorization");
  assert.equal(success.headers["referrer-policy"], "no-referrer");
  assert.equal(success.headers["x-content-type-options"], "nosniff");
  assert.match(String(success.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.deepEqual(success.json(), {
    expiresAt: 3_610_000,
    transcript: {
      schemaVersion: 1,
      source: "control-plane-cache",
      completeness: "possibly-partial",
      messages: [{ role: "user", text: "public message" }],
    },
  });
  assert.equal(success.body.includes("route-session"), false);
  assert.equal(success.body.includes("Never public"), false);

  const wollipogSuccess = await app.inject({
    method: "GET",
    url: "/api/public/transcript-share",
    remoteAddress: "10.0.0.8",
    headers: { authorization: `Wollipog-Share ${created.value.token}` },
  });
  assert.equal(wollipogSuccess.statusCode, 200);

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.equal(await rawGet(`${address}/api/public/transcript-share`, {
    Authorization: [authorization, authorization],
  }), 404, "duplicate physical Authorization fields fail closed even when their values agree");

  for (const header of [undefined, "Bearer wrong", "MAM-Share short", `MAM-Share ${"x".repeat(43)}`]) {
    const missing = await app.inject({ method: "GET", url: "/api/public/transcript-share", remoteAddress: "10.0.0.8",
      ...(header ? { headers: { authorization: header } } : {}) });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { error: "shared transcript unavailable" });
    assert.equal(missing.headers["cache-control"], "no-store, max-age=0");
  }

  const foreign = await app.inject({ method: "GET", url: "/api/public/transcript-share", remoteAddress: "10.0.0.8",
    headers: { authorization, origin: "https://evil.example" } });
  assert.equal(foreign.statusCode, 403);
  assert.equal((await app.inject({ method: "HEAD", url: "/api/public/transcript-share", remoteAddress: "10.0.0.8" })).statusCode, 401);

  const expiring = createAuthorizedTranscriptShare(db, principal, "route-session", { expiresInSeconds: 300 }, now);
  assert.equal(expiring.ok, true);
  if (!expiring.ok) return;
  now += 300_000;
  const expired = await app.inject({ method: "GET", url: "/api/public/transcript-share", remoteAddress: "10.0.0.8",
    headers: { authorization: `MAM-Share ${expiring.value.token}` } });
  assert.equal(expired.statusCode, 404);

  now = 20_000;
  const revokedShare = createAuthorizedTranscriptShare(db, principal, "route-session", { expiresInSeconds: 3600 }, now);
  assert.equal(revokedShare.ok, true);
  if (!revokedShare.ok) return;
  assert.equal(revokeAuthorizedTranscriptShare(db, principal, "route-session", revokedShare.value.share.shareId, now + 1).ok, true);
  const revoked = await app.inject({ method: "GET", url: "/api/public/transcript-share", remoteAddress: "10.0.0.8",
    headers: { authorization: `MAM-Share ${revokedShare.value.token}` } });
  assert.equal(revoked.statusCode, 404);

  // The legacy and Wollipog successes already consumed two units in this fixed limiter window.
  for (let index = 2; index < MAX_TRANSCRIPT_SHARE_READS_PER_TOKEN_PER_MINUTE; index += 1) {
    const admitted = await app.inject({ method: "GET", url: "/api/public/transcript-share", remoteAddress: "10.0.0.8", headers: { authorization } });
    assert.equal(admitted.statusCode, 200);
  }
  const limited = await app.inject({ method: "GET", url: "/api/public/transcript-share", remoteAddress: "10.0.0.8", headers: { authorization } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(limited.headers["cache-control"], "no-store, max-age=0");
});
