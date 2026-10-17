import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, WOLLIPOG_AGENT_ACTOR_SESSION_HEADER } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

/** The real hosting entry point composes the video evidence pieces and every new route refuses. */
test("hosting composes inert video evidence and refuses every new route in the current state", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hosting-video-evidence-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));
  const seed = ControlPlaneDb.open(database);
  let ownerId: string;
  try {
    const local = seed.localIdentityContext();
    ownerId = local.userId;
    seed.createIdentityMember({ userId: "fixture-operator", displayName: "Operator", organizationId: local.organizationId, role: "operator", now: 1 });
    seed.raw().prepare("INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("org_foreign", "Foreign", 1, 1);
    seed.createIdentityMember({ userId: "fixture-foreign-admin", displayName: "Foreign Admin", organizationId: "org_foreign", role: "admin", now: 1 });
    for (const [userId, organizationId] of [[local.userId, local.organizationId], ["fixture-operator", local.organizationId],
      ["fixture-foreign-admin", "org_foreign"]] as const) {
      seed.createDevice({ id: `device-${userId}`, name: "Video Test", tokenHash: hashToken(`device-${userId}`), userId,
        organizationId, now: 2 });
    }
    seed.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
    seed.createSession({ id: "orchestrator", runnerId: "r", workspaceId: null, agentId: null, title: "Orchestrator", useWorktree: false,
      driver: "claude-code", config: { permissionMode: "orchestrator" }, role: "orchestrator",
      scope: { organizationId: local.organizationId, owner: { kind: "user", userId: local.userId } }, now: 2 });
  } finally { seed.close(); }
  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database, CONTROL_PLANE_TOKEN: "video-evidence-fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-8192); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  let live: ControlPlaneDb | null = null;
  try {
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; } } catch {}
      await delay(50);
    }
    assert.ok(healthy, logs);
    live = ControlPlaneDb.open(database);
    // Startup composed the pieces: their durable schema exists, empty, in the hosting database.
    for (const table of ["video_profile_live_validation", "temporal_video_reviews", "workflow_video_approvals",
      "prepared_media_sessions", "prepared_media_active_stops"]) {
      assert.equal(live.raw().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
    }
    live.updateSessionStatus("orchestrator", "running", Date.now());
    assert.equal(live.setAgentControlCredential("orchestrator", "r", hashToken("token-orchestrator"), Date.now()), true);
    const devices = { owner: ownerId, operator: "fixture-operator", foreignAdmin: "fixture-foreign-admin" };
    const call = async (as: keyof typeof devices | "orchestrator", method: "GET" | "POST", path: string, body?: unknown) => {
      const headers: Record<string, string> = as === "orchestrator"
        ? { authorization: "Bearer token-orchestrator", [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: "orchestrator" }
        : { authorization: `Bearer device-${devices[as]}` };
      if (method === "POST") headers["content-type"] = "application/json";
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, signal: AbortSignal.timeout(5000),
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    const listed = await call("owner", "GET", "/api/video-evidence/live-validations");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.proofs, []);
    assert.equal((listed.body.readiness as { code: string }).code, "no_paced_video_peer");
    const recorded = await call("owner", "POST", "/api/video-evidence/live-validations", { target: { runnerId: "r" }, runs: [] });
    assert.deepEqual([recorded.status, recorded.body.code], [409, "no_paced_video_peer"]);
    const revoked = await call("owner", "POST", "/api/video-evidence/live-validations/video_live_proof_missing/revoke");
    assert.deepEqual([revoked.status, revoked.body.code], [409, "no_current_proof"]);
    // The credential is valid on its own allowlist, so the refusals below are route refusals.
    assert.equal((await call("orchestrator", "GET", "/api/sessions/orchestrator")).status, 200);
    // A Session credential is never authenticated outside its allowlist (401); members are refused (403).
    const refusedFor = (as: string) => as === "orchestrator" ? 401 : 403;
    // Proofs are installation-wide, so another organization's admin is refused like any member.
    for (const as of ["operator", "foreignAdmin", "orchestrator"] as const) {
      assert.equal((await call(as, "GET", "/api/video-evidence/live-validations")).status, refusedFor(as), `list as ${as}`);
      assert.equal((await call(as, "POST", "/api/video-evidence/live-validations", {})).status, refusedFor(as), `record as ${as}`);
      assert.equal((await call(as, "POST", "/api/video-evidence/live-validations/any/revoke")).status, refusedFor(as), `revoke as ${as}`);
    }
    // Ordinary Session credentials stay outside the review routes; Humans never hold a reviewer credential.
    for (const route of ["prepare", "frame", "frames", "acknowledge-frames", "acknowledge", "verdict", "provenance"]) {
      for (const as of ["owner", "orchestrator"] as const) {
        assert.equal((await call(as, "POST", `/api/sessions/orchestrator/video-evidence-review/${route}`, {})).status, refusedFor(as),
          `${route} as ${as}`);
      }
    }
  } finally {
    live?.close();
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
    rmSync(root, { recursive: true, force: true });
  }
});
