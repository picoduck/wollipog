import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import type { HumanPrincipal } from "./identity.js";
import type { RunnerMetadata, WorkflowArtifact } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { registerAuthGate } from "./http-auth.js";
import { isAllowedOrigin } from "./net.js";
import { registerWorkflowArtifactExportRoute } from "./artifact-export-route.js";

const TOKEN = "d".repeat(43);
const runner: RunnerMetadata = {
  runnerId: "artifact-route-runner", hostname: "host", os: "linux", version: "1", agents: [],
  workspaces: [{ id: "artifact-route-workspace", name: "Workspace", path: "/repo" }],
};

test("the real artifact export route requires paired auth and returns exact hardened bytes", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, 1, 53);
  db.createSession({
    id: "artifact-route-session", runnerId: runner.runnerId, agentId: null,
    workspaceId: "artifact-route-workspace", title: "Session", useWorktree: false,
    driver: "acp", config: {}, now: 1,
  });
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { kind: "human", actorId: identity.userId, ...identity, role: "viewer" };
  const data = "raw log with <script>alert(1)</script>\n";
  const artifact: WorkflowArtifact = {
    artifactId: "artifact-route", sessionId: "artifact-route-session", kind: "test_log",
    name: "raw test.log", mimeType: "text/plain", encoding: "utf8", data,
    sizeBytes: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex"),
    createdBy: { kind: "human", id: identity.userId }, createdAt: 2,
  };
  db.createWorkflowArtifact(artifact);

  const app = Fastify();
  const authenticated = (authorization: string | undefined) => authorization === `Bearer ${TOKEN}`;
  registerAuthGate(app, {
    authenticate: (req) => authenticated(req.headers.authorization)
      ? { id: "device", name: "Device", principal }
      : null,
    isAllowedOrigin,
  });
  registerWorkflowArtifactExportRoute(app, {
    db,
    requestHuman: (req) => authenticated(req.headers.authorization) ? principal : null,
  });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); });

  const unauthenticated = await app.inject({
    method: "GET", url: "/api/artifacts/artifact-route/export", remoteAddress: "10.0.0.8",
  });
  assert.equal(unauthenticated.statusCode, 401);
  const queryCredential = await app.inject({
    method: "GET", url: `/api/artifacts/artifact-route/export?token=${TOKEN}`, remoteAddress: "10.0.0.8",
  });
  assert.equal(queryCredential.statusCode, 401);
  const foreign = await app.inject({
    method: "GET", url: "/api/artifacts/artifact-route/export", remoteAddress: "10.0.0.8",
    headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
  });
  assert.equal(foreign.statusCode, 200, "paired-token possession follows the existing API policy and outranks Origin");

  const response = await app.inject({
    method: "GET", url: "/api/artifacts/artifact-route/export", remoteAddress: "10.0.0.8",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, Buffer.from(data));
  assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(response.headers["content-length"], String(Buffer.byteLength(data)));
  assert.match(String(response.headers["content-disposition"]), /^attachment;/);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Authorization");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(String(response.headers["content-security-policy"]), /default-src 'none'/);
});
