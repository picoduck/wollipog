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

test("HTTP agent management requires visible descendants and archive retains history", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "descendant-route-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));
  const seed = ControlPlaneDb.open(database);
  try {
    const local = seed.localIdentityContext();
    seed.createIdentityMember({ userId: "other-user", displayName: "Other", organizationId: local.organizationId, role: "operator", now: 1 });
    seed.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
    for (const mode of ["normal", "orchestrator"]) {
      for (const [suffix, parent] of [["", undefined], ["-child", mode], ["-grandchild", `${mode}-child`], ["-hidden", mode]] as const) {
        seed.createSession({ id: mode + suffix, parentSessionId: parent, runnerId: "r", workspaceId: null,
          agentId: null, title: mode + suffix, useWorktree: false, driver: "codex",
          config: mode === "orchestrator" && suffix === "" ? { permissionMode: "orchestrator" } : {},
          scope: { organizationId: local.organizationId, owner: { kind: "user", userId: suffix === "-hidden" ? "other-user" : local.userId } }, now: 2 });
        seed.updateSessionStatus(mode + suffix, "idle", 3);
      }
    }
  } finally { seed.close(); }
  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database, CONTROL_PLANE_TOKEN: "descendant-fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-8192); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  try {
    const deadline = Date.now() + 15_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; } } catch {}
      await delay(50);
    }
    assert.ok(healthy, logs);
    const live = ControlPlaneDb.open(database);
    try {
      for (const mode of ["normal", "orchestrator"]) {
        live.updateSessionStatus(mode, "running", Date.now());
        assert.equal(live.setAgentControlCredential(mode, "r", hashToken(`token-${mode}`), Date.now()), true);
      }
    } finally { live.close(); }
    for (const mode of ["normal", "orchestrator"]) {
      const request = (target: string, operation: string, body: unknown, method = "POST") => fetch(
        `http://127.0.0.1:${port}/api/sessions/${target}${operation ? `/${operation}` : ""}`, {
          method, signal: AbortSignal.timeout(3000), headers: { authorization: `Bearer token-${mode}`,
            [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: mode, "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        });
      const other = mode === "normal" ? "orchestrator" : "normal";
      for (const target of [mode, other, `${other}-child`, `${mode}-hidden`, "missing"]) {
        for (const operation of ["prompt", "stop", "archive"]) {
          assert.equal((await request(target, operation, { text: "test", archived: true })).status, 404, `${mode} ${operation} ${target}`);
        }
      }
      assert.equal((await request(other, "", undefined, "GET")).status, 200, "authorized reads remain available");
      const target = `${mode}-grandchild`;
      assert.notEqual((await request(target, "prompt", { text: "test" })).status, 404, "grandchild reaches normal admission checks");
      assert.ok((await request(target, "stop", {})).ok);
      assert.equal((await request(target, "archive", { archived: false })).status, 403);
      assert.equal((await request(target, "archive", {})).status, 400);
      const archived = await request(target, "archive", { archived: true });
      assert.equal(archived.status, 202, "archive waits for the preceding Stop to settle");
      assert.equal((await archived.json() as { archived: boolean }).archived, false);
      assert.equal((await request(target, "", undefined, "GET")).status, 200, "archive retains the session");
      const idleArchive = await request(`${mode}-child`, "archive", { archived: true });
      assert.equal(idleArchive.status, 200);
      assert.equal((await idleArchive.json() as { archived: boolean }).archived, true);
      const ownWorktree = await request(mode, "worktrees", {});
      assert.equal(ownWorktree.status, mode === "orchestrator" ? 404 : 400);
      const childWorktree = await request(`${mode}-child`, "worktrees", {});
      assert.equal(childWorktree.status, mode === "normal" ? 404 : 400);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
        child.kill("SIGKILL"); await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
