import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTROL_PLANE_API_VERSION,
  CONTROL_PLANE_CAPABILITIES,
  WOLLIPOG_CONTROL_PLANE_SERVICE,
  type ControlPlaneInstanceInfo,
} from "@wollipog/protocol";
import Fastify, { type FastifyRequest } from "fastify";
import { registerAuthGate } from "./http-auth.js";
import { registerInstanceRoute } from "./instance-route.js";
import { APP_RELEASE_VERSION } from "./release-version.js";

const INSTANCE_ID = "8ded292f-18b6-4d36-a82f-f506ad207f2f";
const DEVICE_TOKEN = "paired-device-token";

async function buildApp() {
  const app = Fastify();
  registerAuthGate(app, {
    authenticate: (req: FastifyRequest) => req.headers.authorization === `Bearer ${DEVICE_TOKEN}`
      ? { id: "dev_remote", name: "Remote Device" }
      : null,
    isAllowedOrigin: (origin) => !origin || origin === "http://localhost:4317",
  });
  registerInstanceRoute(app, { instanceId: () => INSTANCE_ID, displayName: () => "Test Organization" });
  await app.ready();
  return app;
}

test("GET /api/instance requires a paired device remotely and returns the versioned identity contract", async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const anonymous = await app.inject({
    method: "GET",
    url: "/api/instance",
    remoteAddress: "100.64.0.10",
  });
  assert.equal(anonymous.statusCode, 401);

  const invalid = await app.inject({
    method: "GET",
    url: "/api/instance",
    remoteAddress: "100.64.0.10",
    headers: { authorization: "Bearer invalid" },
  });
  assert.equal(invalid.statusCode, 401);

  const response = await app.inject({
    method: "GET",
    url: "/api/instance",
    remoteAddress: "100.64.0.10",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json<ControlPlaneInstanceInfo>(), {
    service: WOLLIPOG_CONTROL_PLANE_SERVICE,
    instanceId: INSTANCE_ID,
    displayName: "Test Organization",
    apiVersion: CONTROL_PLANE_API_VERSION,
    appVersion: APP_RELEASE_VERSION,
    capabilities: [...CONTROL_PLANE_CAPABILITIES],
  });
});

test("GET /api/instance requires a credential on loopback too", async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const anonymous = await app.inject({ method: "GET", url: "/api/instance", remoteAddress: "127.0.0.1" });
  assert.equal(anonymous.statusCode, 401);
  const response = await app.inject({
    method: "GET",
    url: "/api/instance",
    remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<ControlPlaneInstanceInfo>().instanceId, INSTANCE_ID);
});
