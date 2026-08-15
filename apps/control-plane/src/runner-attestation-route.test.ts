import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, WOLLIPOG_CONTROL_PLANE_SERVICE } from "@wollipog/protocol";
import Fastify from "fastify";
import { registerRunnerAttestationRoute } from "./runner-attestation-route.js";

const INSTANCE_ID = "8ded292f-18b6-4d36-a82f-f506ad207f2f";

test("runner attestation is exact-runner authenticated, uncached, and read-only", async (t) => {
  const app = Fastify();
  const calls: Array<{ runnerId: string; tokenHash: string; now: number }> = [];
  registerRunnerAttestationRoute(app, {
    instanceId: () => INSTANCE_ID,
    verifyRunnerCredentialForAttestation: (runnerId, tokenHash, now) => {
      calls.push({ runnerId, tokenHash, now });
      return runnerId === "runner-one" && tokenHash.length === 64;
    },
  }, () => 1234);
  await app.ready();
  t.after(() => app.close());

  const anonymous = await app.inject({ method: "GET", url: "/runner/attestation/runner-one" });
  assert.equal(anonymous.statusCode, 401);
  const invalidId = await app.inject({
    method: "GET", url: "/runner/attestation/bad%2Fid", headers: { authorization: "Bearer secret" },
  });
  assert.equal(invalidId.statusCode, 401);
  const response = await app.inject({
    method: "GET", url: "/runner/attestation/runner-one", headers: {
      authorization: "Bearer secret",
      "x-wollipog-prior-runner-credential-sha256": "a".repeat(64),
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.vary, "Authorization");
  assert.deepEqual(response.json(), {
    service: WOLLIPOG_CONTROL_PLANE_SERVICE,
    instanceId: INSTANCE_ID,
    protocolVersion: PROTOCOL_VERSION,
    priorCredentialValid: true,
  });
  assert.equal(calls.at(-1)?.runnerId, "runner-one");
  assert.equal(calls.at(-1)?.now, 1234);
  assert.equal(JSON.stringify(calls).includes("secret"), false);
  assert.equal(calls.at(-1)?.tokenHash, "a".repeat(64));
});
