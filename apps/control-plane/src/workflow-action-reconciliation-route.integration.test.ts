import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { canonicalPrMergeEnqueueCommand } from "./sessions.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-workflow-action-reconciliation";
const WORKSPACE_ID = "workspace-workflow-action-reconciliation";
const PARENT_SESSION_ID = "session-workflow-action-parent";
const CHILD_SESSION_ID = "session-workflow-action-child";
const OCCURRENCE_ID = "workflow_action_reconciliation_occurrence";
const RUNNER_TOKEN = `wollipogr_${"w".repeat(43)}`;
const AGENT_TOKEN = "agent_workflow_action_reconciliation_token";
const HEAD_SHA = "a".repeat(40);
const SNAPSHOT = {
  category: "pr_merge" as const,
  repository: "picoduck/wollipog",
  pullRequest: 1109,
  headSha: HEAD_SHA,
  reviewResult: "merge" as const,
  requiredChecks: {
    headSha: HEAD_SHA,
    status: "passed" as const,
    checkedAt: 10,
    checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" as const }],
  },
};

type JsonObject = Record<string, unknown>;

class JsonInbox {
  private readonly queued: JsonObject[] = [];
  private readonly waiters = new Set<{
    predicate: (message: JsonObject) => boolean;
    resolve: (message: JsonObject) => void;
  }>();

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const object = message as JsonObject;
      for (const waiter of this.waiters) {
        if (!waiter.predicate(object)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(object);
        return;
      }
      this.queued.push(object);
    });
  }

  take(predicate: (message: JsonObject) => boolean, timeoutMs = 5_000): Promise<JsonObject> {
    const existing = this.queued.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(this.queued.splice(existing, 1)[0]!);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonObject) => {
          clearTimeout(timer);
          resolvePromise(message);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("timed out waiting for websocket message"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

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

async function waitForHealth(port: number, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs()}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // Startup races are expected.
    }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy:\n${logs()}`);
}

function runnerMetadata(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID,
    hostname: "workflow-action-reconciliation-host",
    os: "linux",
    version: "integration",
    workspaces: [{ id: WORKSPACE_ID, name: "Wollipog", path: "/workspace" }],
    agents: [
      {
        id: "orchestrator-agent",
        name: "Orchestrator",
        command: "claude",
        args: [],
        env: {},
        driver: "claude-code",
        context: { kind: "native" },
      },
      {
        id: "codex-agent",
        name: "Codex",
        command: "codex",
        args: [],
        env: {},
        driver: "codex-app-server",
        context: { kind: "native" },
      },
    ],
  };
}

function seed(database: string): string {
  const db = ControlPlaneDb.open(database);
  try {
    const now = Date.now();
    const identity = db.localIdentityContext();
    const runner = runnerMetadata();
    db.registerRunner(runner, now, PROTOCOL_VERSION);
    db.issueRunnerCredential({
      credentialId: `rcred_${"workflowreconcile".padEnd(32, "0")}`,
      runnerId: RUNNER_ID,
      organizationId: identity.organizationId,
      ownerKind: "organization",
      ownerId: identity.organizationId,
      label: "Workflow action reconciliation route fixture",
      tokenHash: hashToken(RUNNER_TOKEN),
      createdByUserId: identity.userId,
      now,
      expiresAt: now + 60_000,
    });
    const scope = {
      organizationId: identity.organizationId,
      owner: { kind: "organization" as const, organizationId: identity.organizationId },
    };
    db.createSession({
      id: PARENT_SESSION_ID,
      runnerId: RUNNER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: "orchestrator-agent",
      title: "Workflow Action Parent",
      useWorktree: false,
      driver: "claude-code",
      config: { permissionMode: "orchestrator" },
      parentControl: "questions_and_approvals",
      parentControlPolicy: { decisions: {
        implementation_question: "human",
        pr_merge: "orchestrator",
        merged_branch_deletion: "human",
        follow_up_issue_publication: "human",
        ui_evidence_approval: "human",
      } },
      scope,
      now,
    });
    db.createSession({
      id: CHILD_SESSION_ID,
      parentSessionId: PARENT_SESSION_ID,
      runnerId: RUNNER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: "codex-agent",
      title: "Workflow Action Child",
      useWorktree: false,
      driver: "codex-app-server",
      config: {},
      scope,
      now: now + 1,
    });
    db.updateSessionStatus(PARENT_SESSION_ID, "running", now + 2);
    db.updateSessionStatus(CHILD_SESSION_ID, "running", now + 2);
    const created = db.createWorkflowDecision({
      requestId: "workflow-action-reconciliation-request",
      occurrenceId: OCCURRENCE_ID,
      sessionId: CHILD_SESSION_ID,
      controllingSessionId: PARENT_SESSION_ID,
      category: "pr_merge",
      resourceKey: "picoduck/wollipog#1109",
      resourceSnapshot: SNAPSHOT,
      resourceDigest: digest(SNAPSHOT),
      policyRevision: 1,
      authority: "orchestrator",
      createdAt: now + 3,
    });
    assert.ok(created);
    assert.ok(db.resolveWorkflowDecision(OCCURRENCE_ID, "orchestrator", "approved", now + 4));
    const command = canonicalPrMergeEnqueueCommand(SNAPSHOT);
    assert.ok(db.armWorkflowDecisionAction(OCCURRENCE_ID, {
      kind: "pr_merge_enqueue",
      command,
      commandDigest: digest({ kind: "pr_merge_enqueue", command }),
      armedAt: now + 5,
    }));
    assert.equal(db.setAgentControlCredential(CHILD_SESSION_ID, RUNNER_ID, hashToken(AGENT_TOKEN), now + 6), true);
    return command;
  } finally {
    db.close();
  }
}

function sessionSnapshot(id: string, agentId: string, driver: "claude-code" | "codex-app-server") {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    agentId,
    title: id,
    status: "running" as const,
    driver,
    useWorktree: false,
    worktreePath: null,
    config: {},
    preview: null,
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    seq: 0,
    historyEpoch: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("the real runner socket delivers a workflow action reconciliation receipt", { timeout: 30_000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-workflow-action-reconciliation-"));
  const database = join(temp, "control-plane.db");
  const port = await reservePort();
  const command = seed(database);
  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database,
      CONTROL_PLANE_LOCAL_TOKEN_FILE: join(temp, "local-device.token"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let runner: WebSocket | null = null;
  t.after(async () => {
    runner?.close();
    await stopChild(child);
    rmSync(temp, { recursive: true, force: true });
  });

  await waitForHealth(port, child, () => logs);
  runner = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  const inbox = new JsonInbox(runner);
  await new Promise<void>((resolvePromise, reject) => {
    runner!.addEventListener("open", () => resolvePromise(), { once: true });
    runner!.addEventListener("error", () => reject(new Error("runner websocket failed to open")), { once: true });
  });
  runner.send(JSON.stringify({
    type: "register",
    token: RUNNER_TOKEN,
    protocolVersion: PROTOCOL_VERSION,
    runner: runnerMetadata(),
    sessionSnapshots: [
      sessionSnapshot(PARENT_SESSION_ID, "orchestrator-agent", "claude-code"),
      sessionSnapshot(CHILD_SESSION_ID, "codex-agent", "codex-app-server"),
    ],
  }));
  await inbox.take((message) => message.type === "registered");

  const responsePromise = fetch(
    `http://127.0.0.1:${port}/api/sessions/${CHILD_SESSION_ID}/workflow-decisions/${OCCURRENCE_ID}/reconcile`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: CHILD_SESSION_ID,
        "content-type": "application/json",
      },
      body: JSON.stringify({ resourceSnapshot: SNAPSHOT }),
    },
  );
  const request = await inbox.take((message) => message.type === "reconcile_workflow_action");
  assert.equal(request.sessionId, CHILD_SESSION_ID);
  assert.equal(request.occurrenceId, OCCURRENCE_ID);
  assert.equal(request.command, command);
  assert.equal(request.expectedHeadSha, HEAD_SHA);
  runner.send(JSON.stringify({
    type: "workflow_action_reconciliation_result",
    requestId: request.requestId,
    sessionId: CHILD_SESSION_ID,
    occurrenceId: OCCURRENCE_ID,
    accepted: true,
    commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
    providerThreadId: "thread-reconciliation",
    providerTurnId: "turn-reconciliation",
    providerAdmissionItemId: "admission-reconciliation",
    providerItemId: "command-reconciliation",
    forgeHeadSha: HEAD_SHA,
  }));

  const response = await responsePromise;
  const body = await response.json() as { status?: string; error?: string };
  assert.equal(response.status, 200, body.error);
  assert.equal(body.status, "consumed");
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const row = db.prepare("SELECT status FROM workflow_decisions WHERE occurrence_id=?")
      .get(OCCURRENCE_ID) as { status: string } | undefined;
    assert.equal(row?.status, "consumed");
  } finally {
    db.close();
  }
});
