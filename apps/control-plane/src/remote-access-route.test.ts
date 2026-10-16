import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerAuthGate } from "./http-auth.js";
import { isTrustedLoopback } from "./auth.js";
import { isLoopback } from "./net.js";
import { RemoteAccess } from "./remote-access.js";
import { registerRemoteAccessRoutes } from "./remote-access-route.js";

test("host configuration requires a local administrator; remote status cannot authorize a mutation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-access-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const remote = new RemoteAccess({ statePath: join(root, "remote.json"), port: 4317, instanceId: "fixture", configuredOrigin: null,
    exec: async (args) => { calls.push(args); return { ok: false, stdout: "", stderr: "" }; } });
  const app = Fastify(); t.after(() => app.close());
  registerAuthGate(app, { isAllowedOrigin: () => true,
    authenticate: (req) => req.headers.authorization?.startsWith("Bearer ") ? { id: "fixture", name: "Fixture" } : null });
  registerRemoteAccessRoutes(app, remote, (req) => isTrustedLoopback(req.ip, req.headers, isLoopback) && req.headers.authorization === "Bearer owner");
  for (const [address, token, headers] of [
    ["192.0.2.10", "owner", {}], ["127.0.0.1", "viewer", {}], ["127.0.0.1", "owner", { "x-forwarded-for": "192.0.2.10" }],
  ] as const) {
    for (const [method, url] of [["POST", "/api/remote-access"], ["POST", "/api/remote-access/cancel"], ["DELETE", "/api/remote-access"]] as const) {
      const response = await app.inject({ method, url, remoteAddress: address, headers: { authorization: `Bearer ${token}`, ...headers },
        ...(method === "POST" && !url.endsWith("cancel") ? { payload: { provider: "tailscale" } } : {}) });
      assert.equal(response.statusCode, 403);
    }
    const view = await app.inject({ method: "GET", url: "/api/remote-access", remoteAddress: address, headers: { authorization: `Bearer ${token}`, ...headers } });
    assert.equal(view.statusCode, 200); assert.equal(view.json().canConfigure, false);
  }
  assert.equal(calls.length, 0, "no rejected request reaches the host executor");
  assert.equal((await app.inject({ method: "GET", url: "/api/remote-access" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/remote-access-proof/unguessable" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/remote-access", remoteAddress: "127.0.0.1", headers: { authorization: "Bearer owner" }, payload: { provider: "arbitrary", command: "anything" } })).statusCode, 400);
});
