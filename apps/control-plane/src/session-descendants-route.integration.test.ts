import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, WOLLIPOG_AGENT_ACTOR_SESSION_HEADER, type GovernancePolicy } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

test("HTTP agent management scopes descendants and composes governance policy visibility", { timeout: 30_000 }, async () => {
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
    seed.createIdentityMember({ userId: "policy-admin", displayName: "Policy Admin", organizationId: local.organizationId, role: "admin", now: 1 });
    seed.createIdentityMember({ userId: "inactive-user", displayName: "Inactive", organizationId: local.organizationId, role: "operator", now: 1 });
    seed.updateIdentityMember({ userId: "inactive-user", displayName: "Inactive", organizationId: local.organizationId, role: "operator", status: "suspended", now: 2 });
    for (const userId of [local.userId, "policy-admin", "other-user"]) {
      seed.createDevice({ id: `device-${userId}`, name: "Policy Test", tokenHash: hashToken(`device-${userId}`), userId, organizationId: local.organizationId, now: 2 });
    }
    for (const [policyId, ownerUserId, organizationId, question] of [
      ["fixture-global", undefined, undefined, false],
      ["fixture-same-org", undefined, local.organizationId, false],
      ["fixture-foreign-org", undefined, "foreign-org", false],
      ["fixture-owner-question", local.userId, local.organizationId, true],
      ["fixture-admin-question", "policy-admin", local.organizationId, true],
      ["fixture-other-question", "other-user", local.organizationId, true],
      ["fixture-inactive-question", "inactive-user", local.organizationId, true],
      ["fixture-foreign-question", "other-user", "foreign-org", true],
      ["fixture-unscoped-owner-question", local.userId, undefined, true],
      ["fixture-unscoped-admin-question", "policy-admin", undefined, true],
    ] as const) {
      seed.upsertGovernancePolicy({ policyId, name: policyId, enabled: true, effect: "allow", priority: 1,
        scope: organizationId ? { organizationId } : {}, ownerUserId,
        ...(question ? { questionRule: { headerPattern: "Test", answer: { option: "Proceed" } } } : {}),
      }, 2);
    }
    seed.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
    seed.createSession({ id: "policy-agent", runnerId: "r", workspaceId: null, agentId: null, title: "Policy Agent", useWorktree: false, driver: "codex", config: {},
      scope: { organizationId: local.organizationId, owner: { kind: "organization", organizationId: local.organizationId } }, now: 2 });
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
      for (const mode of ["normal", "orchestrator", "policy-agent"]) {
        live.updateSessionStatus(mode, "running", Date.now());
        assert.equal(live.setAgentControlCredential(mode, "r", hashToken(`token-${mode}`), Date.now()), true);
      }
    } finally { live.close(); }
    const policies = async (token: string, agent?: string) => fetch(`http://127.0.0.1:${port}/api/governance/policies`, {
      signal: AbortSignal.timeout(3000), headers: { authorization: `Bearer ${token}`,
        ...(agent ? { [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: agent } : {}) },
    });
    const assertPolicies = async (token: string, expected: string[], agent?: string) => {
      const response = await policies(token, agent);
      assert.equal(response.status, 200);
      const result = (await response.json() as { policies: GovernancePolicy[] }).policies;
      assert.deepEqual(result.map((p) => p.policyId).sort(), [...expected, "builtin:session-spawn-human-gate"].sort());
    };
    const ordinary = ["fixture-global", "fixture-same-org", "fixture-foreign-org"];
    const humanQuestions = ["fixture-owner-question", "fixture-admin-question", "fixture-other-question"];
    const ownerDb = ControlPlaneDb.open(database);
    const ownerId = ownerDb.localIdentityContext().userId;
    ownerDb.close();
    await assertPolicies(`device-${ownerId}`, [...ordinary, ...humanQuestions, "fixture-unscoped-owner-question"]);
    await assertPolicies("device-policy-admin", [...ordinary, ...humanQuestions, "fixture-unscoped-admin-question"]);
    assert.equal((await policies("device-other-user")).status, 403, "ordinary human global-route admission is preserved");
    assert.equal((await policies("token-normal", "normal")).status, 403, "user-scoped ordinary agents do not gain global routes");
    await assertPolicies("token-policy-agent", ordinary, "policy-agent");
    await assertPolicies("token-orchestrator", ["fixture-global", "fixture-same-org"], "orchestrator");
    for (const mode of ["normal", "orchestrator"]) {
      const request = (target: string, operation: string, body: unknown, method = "POST") => fetch(
        `http://127.0.0.1:${port}/api/sessions/${target}${operation ? `/${operation}` : ""}`, {
          method, signal: AbortSignal.timeout(3000), headers: { authorization: `Bearer token-${mode}`,
            [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: mode, "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        });
      const other = mode === "normal" ? "orchestrator" : "normal";
      if (mode === "normal") {
        assert.equal((await request(mode, "descendant-requests", undefined, "GET")).status, 401,
          "ordinary agent credentials never gain Parent Control routes");
      } else {
        assert.equal((await request(mode, "parent-control", { mode: "questions" })).status, 401,
          "agent credentials cannot enable their own Parent Control");
        const humanRequest = (operation: string, body: unknown) => fetch(
          `http://127.0.0.1:${port}/api/sessions/${mode}/${operation}`, {
            method: "POST", signal: AbortSignal.timeout(3000),
            headers: { authorization: `Bearer device-${ownerId}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        assert.equal((await humanRequest("parent-control", { mode: "questions" })).status, 200,
          "the owning human can enable Parent Control");
        assert.equal((await humanRequest("descendant-requests/resolve", {
          sessionId: `${mode}-child`, occurrenceId: "request", resolution: { action: "dismiss" },
        })).status, 403, "human credentials cannot use the parent-agent resolution route");
        assert.equal((await request(`${mode}-child`, "descendant-requests", undefined, "GET")).status, 404,
          "an orchestrator credential cannot pose as its descendant");
        assert.equal((await request(mode, "descendant-requests", undefined, "GET")).status, 200,
          "the matching orchestrator credential can inspect its own descendants");
        for (const body of [
          { sessionId: `${mode}-child`, occurrenceId: "bad\nid", resolution: { action: "dismiss" } },
          { sessionId: `${mode}-child`, occurrenceId: "request", resolution: [] },
          { sessionId: `${mode}-child`, occurrenceId: "request", resolution: { action: "answer", answers: [] } },
          { sessionId: `${mode}-child`, occurrenceId: "request", resolution: { action: "approve", optionId: "" } },
        ]) {
          assert.equal((await request(mode, "descendant-requests/resolve", body)).status, 400,
            "malformed Parent Control coordinates and resolutions fail closed");
        }
      }
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
