import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { installStartupReadinessGate } from "./startup-readiness.js";

test("startup readiness gate rejects HTTP and WebSocket traffic until durable settlement completes", async (t) => {
  const app = Fastify();
  const markReady = installStartupReadinessGate(app);
  await app.register(websocket);
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/runner", { websocket: true }, (socket) => socket.send("ready"));
  t.after(() => app.close());

  const starting = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(starting.statusCode, 503);
  assert.deepEqual(starting.json(), { error: "control plane is starting" });

  const websocketStarting = await app.inject({
    method: "GET",
    url: "/runner",
    headers: { connection: "upgrade", upgrade: "websocket" },
  });
  assert.equal(websocketStarting.statusCode, 503);
  assert.deepEqual(websocketStarting.json(), { error: "control plane is starting" });

  markReady();
  const ready = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { ok: true });
});
