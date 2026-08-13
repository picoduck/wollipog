import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import {
  LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  LEGACY_POLICY_HOOK_SESSION_HEADER,
  POLICY_HOOK_POLL_CAPABILITY,
  PROTOCOL_VERSION,
  WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  WOLLIPOG_POLICY_HOOK_SESSION_HEADER,
} from "@wollipog/protocol";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-hook-route";
const WORKSPACE_ID = "workspace-hook-route";
const HOOK_TOKEN = "mamh_exact_session_secret";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(3_000),
  ]);
}

async function waitForHealth(port: number, logs: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // Startup races are expected.
    }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy:\n${logs()}`);
}

function seed(database: string): void {
  const db = ControlPlaneDb.open(database);
  try {
    db.registerRunner({
      runnerId: RUNNER_ID,
      hostname: "hook-host",
      os: "windows",
      version: "test",
      agents: [],
      workspaces: [{ id: WORKSPACE_ID, name: "Hook Repo", path: "C:/hook-repo" }],
    }, 1, PROTOCOL_VERSION);
    const create = (id: string, driver: "claude-code" | "codex", status: "running" | "idle") => {
      db.createSession({
        id,
        runnerId: RUNNER_ID,
        workspaceId: WORKSPACE_ID,
        agentId: null,
        title: id,
        useWorktree: false,
        driver,
        config: {},
        now: 2,
      });
      db.updateSessionStatus(id, status, 3);
    };
    create("session-exact", "claude-code", "running");
    create("session-other", "claude-code", "running");
    create("session-idle", "claude-code", "idle");
    create("session-codex", "codex", "running");
    assert.equal(
      db.setPolicyHookCredential("session-exact", RUNNER_ID, hashToken(HOOK_TOKEN), 4),
      true,
    );
    db.setPolicyHookCredential("session-other", RUNNER_ID, hashToken("mamh_other"), 4);
    db.setPolicyHookCredential("session-idle", RUNNER_ID, hashToken(HOOK_TOKEN), 4);
    db.setPolicyHookCredential("session-codex", RUNNER_ID, hashToken(HOOK_TOKEN), 4);
    db.upsertGovernancePolicy({
      policyId: "ask-route-read",
      name: "Ask Route Read",
      effect: "ask",
      priority: 100,
      enabled: true,
      scope: { toolName: "Read" },
    }, 5);
  } finally {
    db.close();
  }
}

test("real policy-hook route enforces the per-session credential, lifecycle, driver, and route", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-hook-route-"));
  const database = join(root, "control-plane.db");
  const port = await reservePort();
  seed(database);
  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database,
      CONTROL_PLANE_LOCAL_TOKEN_FILE: join(root, "local-device.token"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => (logs += String(chunk)));
  child.stderr?.on("data", (chunk) => (logs += String(chunk)));
  let hookChild: ChildProcess | null = null;
  try {
    await waitForHealth(port, () => logs);
    const live = new DatabaseSync(database);
    live.prepare(
      "UPDATE sessions SET status=CASE WHEN id='session-idle' THEN 'idle' ELSE 'running' END",
    ).run();
    live.close();
    const hookBody = {
      hookEventName: "PreToolUse",
      providerSessionId: "provider-session",
      permissionMode: "acceptEdits",
      toolUseId: "tool-1",
      context: { toolName: "Read", path: "C:/hook-repo/README.md" },
    };
    const request = (
      sessionId: string,
      token = HOOK_TOKEN,
      claim = sessionId,
      payload: Record<string, unknown> = hookBody,
      pollProof: string | string[] | null = POLICY_HOOK_POLL_CAPABILITY,
    ) => {
      const headers = new Headers({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-mam-hook-session": claim,
      });
      for (const value of Array.isArray(pollProof) ? pollProof : pollProof == null ? [] : [pollProof]) {
        headers.append(LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER, value);
      }
      return fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/policy-hook`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    };

    const unmarked = await request("session-exact", HOOK_TOKEN, "session-exact", {
      ...hookBody,
      toolUseId: "tool-unmarked-route",
    }, null);
    assert.equal((await unmarked.json() as { decision: string }).decision, "deny");

    const malformed = await request("session-exact", HOOK_TOKEN, "session-exact", {
      ...hookBody,
      toolUseId: "tool-malformed-proof",
    }, `${POLICY_HOOK_POLL_CAPABILITY},other`);
    assert.equal((await malformed.json() as { decision: string }).decision, "deny");

    const duplicated = await request("session-exact", HOOK_TOKEN, "session-exact", {
      ...hookBody,
      toolUseId: "tool-duplicate-proof",
    }, [POLICY_HOOK_POLL_CAPABILITY, POLICY_HOOK_POLL_CAPABILITY]);
    assert.equal((await duplicated.json() as { decision: string }).decision, "deny");

    const exact = await request("session-exact");
    const exactBody = await exact.json() as { decision?: string; error?: string; approvalRequestId?: string };
    assert.equal(exact.status, 200, exactBody.error);
    assert.equal(exactBody.decision, "ask");
    assert.ok(exactBody.approvalRequestId);

    const compatibleRequest = (headers: Record<string, string>, toolUseId: string) => fetch(
      `http://127.0.0.1:${port}/api/sessions/session-exact/policy-hook`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${HOOK_TOKEN}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          ...hookBody,
          toolUseId,
          context: { ...hookBody.context, toolName: "Write" },
        }),
      },
    );
    const wollipog = await compatibleRequest({
      [WOLLIPOG_POLICY_HOOK_SESSION_HEADER]: "session-exact",
      [LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER]: POLICY_HOOK_POLL_CAPABILITY,
    }, "tool-wollipog-headers");
    assert.equal(wollipog.status, 200, await wollipog.text());
    const crossGeneration = await compatibleRequest({
      [LEGACY_POLICY_HOOK_SESSION_HEADER]: "session-exact",
      [WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER]: POLICY_HOOK_POLL_CAPABILITY,
    }, "tool-cross-generation-headers");
    assert.equal(crossGeneration.status, 200, await crossGeneration.text());
    const identicalDual = await compatibleRequest({
      [LEGACY_POLICY_HOOK_SESSION_HEADER]: "session-exact",
      [WOLLIPOG_POLICY_HOOK_SESSION_HEADER]: "session-exact",
      [LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER]: POLICY_HOOK_POLL_CAPABILITY,
      [WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER]: POLICY_HOOK_POLL_CAPABILITY,
    }, "tool-identical-dual-headers");
    assert.equal(identicalDual.status, 200, await identicalDual.text());
    const conflictingDual = await compatibleRequest({
      [LEGACY_POLICY_HOOK_SESSION_HEADER]: "session-exact",
      [WOLLIPOG_POLICY_HOOK_SESSION_HEADER]: "session-other",
      [LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER]: POLICY_HOOK_POLL_CAPABILITY,
    }, "tool-conflicting-dual-headers");
    assert.equal(conflictingDual.status, 401);
    const localToken = readFileSync(join(root, "local-device.token"), "utf8").trim();
    const approved = await fetch(`http://127.0.0.1:${port}/api/sessions/session-exact/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${localToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: exactBody.approvalRequestId, optionId: "allow" }),
    });
    assert.equal(approved.status, 200, await approved.text());
    const polled = await request("session-exact", HOOK_TOKEN, "session-exact", {
      ...hookBody,
      approvalRequestId: exactBody.approvalRequestId!,
    });
    assert.equal((await polled.json() as { decision: string }).decision, "allow");

    const hookTokenFile = join(root, "hook.token");
    const hookReadyFile = join(root, "hook.ready");
    writeFileSync(hookTokenFile, HOOK_TOKEN, "utf8");
    writeFileSync(hookReadyFile, createHash("sha256").update(HOOK_TOKEN).digest("hex"), "utf8");
    let hookStdout = "";
    let hookStderr = "";
    const packagedRunner = process.env.WOLLIPOG_POLICY_HOOK_RUNNER_BINARY;
    hookChild = spawn(
      packagedRunner ?? process.execPath,
      packagedRunner
        ? ["--policy-hook", "--hook-event", "PreToolUse"]
        : ["--import", "tsx", "apps/runner/src/cli.ts", "--policy-hook", "--hook-event", "PreToolUse"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MANAGER_TOKEN_FILE: hookTokenFile,
          WOLLIPOG_POLICY_HOOK_CP_URL: `http://127.0.0.1:${port}`,
          WOLLIPOG_POLICY_HOOK_SESSION_ID: "session-exact",
          WOLLIPOG_POLICY_HOOK_SETTINGS_FILE: join(root, "hook.settings.json"),
          WOLLIPOG_POLICY_HOOK_CIRCUIT_FILE: join(root, "hook.circuit.json"),
          WOLLIPOG_POLICY_HOOK_READY_FILE: hookReadyFile,
          WOLLIPOG_POLICY_HOOK_ASK_CAPABLE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    hookChild.stdout?.on("data", (chunk) => (hookStdout += String(chunk)));
    hookChild.stderr?.on("data", (chunk) => (hookStderr += String(chunk)));
    hookChild.stdin?.end(JSON.stringify({
      session_id: "provider-session",
      cwd: "C:/hook-repo",
      permission_mode: "acceptEdits",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "tool-same-process",
      tool_input: { file_path: "C:/hook-repo/package.json" },
    }));

    let childApprovalId: string | undefined;
    const approvalDeadline = Date.now() + 10_000;
    while (!childApprovalId && Date.now() < approvalDeadline) {
      const pendingResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/session-exact`, {
        headers: { authorization: `Bearer ${localToken}` },
      });
      const pendingBody = await pendingResponse.json() as {
        session?: { pendingApproval?: { requestId?: string; kind?: string } | null };
      };
      if (pendingBody.session?.pendingApproval?.kind === "policy_hook") {
        childApprovalId = pendingBody.session.pendingApproval.requestId;
        break;
      }
      if (hookChild.exitCode !== null) {
        throw new Error(`hook exited before approval was parked: ${hookStderr || hookStdout}`);
      }
      await delay(50);
    }
    assert.ok(childApprovalId, `runner hook did not park an approval: ${hookStderr || logs}`);
    assert.equal(hookChild.exitCode, null, "the same hook process stays alive while the manager decides");

    const childApproved = await fetch(`http://127.0.0.1:${port}/api/sessions/session-exact/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${localToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: childApprovalId, optionId: "allow" }),
    });
    assert.equal(childApproved.status, 200, await childApproved.text());
    const hookExit = await Promise.race([
      new Promise<number | null>((resolvePromise) =>
        hookChild!.once("exit", (code) => resolvePromise(code))),
      delay(10_000).then(() => -999),
    ]);
    assert.equal(hookExit, 0, `hook did not finish after approval: ${hookStderr || hookStdout}`);
    const hookOutput = JSON.parse(hookStdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    assert.equal(hookOutput.hookSpecificOutput?.permissionDecision, "allow");

    assert.equal((await request("session-exact", "mamh_wrong")).status, 401);
    assert.equal((await request("session-other")).status, 401, "one session token cannot claim another");
    assert.equal((await request("session-idle")).status, 200, "an idle transition cannot strand a polling hook");
    assert.equal((await request("session-codex")).status, 401);
    assert.equal((await request("session-exact", HOOK_TOKEN, "session-other")).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/session-exact`, {
      headers: { authorization: `Bearer ${HOOK_TOKEN}` },
    })).status, 401, "a hook token is not a general API credential");
  } finally {
    if (hookChild) await stopChild(hookChild);
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  }
});
