import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import {
  PROTOCOL_VERSION,
  type RunnerMetadata,
  type RunnerToControlPlane,
  type SessionSnapshot,
} from "@wollipog/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "../../runner/src/session-manager.js";
import { SessionStore, type SessionMeta } from "../../runner/src/session-store.js";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";

const RUNNER_ID = "runner-verification";
const WORKSPACE_ID = "workspace-verification";
const AGENT_ID = "agent-verification";
const NOOP_LOG = { info() {}, warn() {}, error() {} };

function runnerMetadata(repoPath: string): RunnerMetadata {
  return {
    runnerId: RUNNER_ID,
    hostname: "test-host",
    os: "linux",
    version: "test",
    workspaces: [{ id: WORKSPACE_ID, name: "Verification", path: repoPath }],
    agents: [{
      id: AGENT_ID,
      name: "Verification Agent",
      command: "verification-agent",
      args: [],
      env: {},
      driver: "claude-code",
      available: true,
      context: { kind: "native" },
    }],
  };
}

function snapshot(id: string, repoPath: string, worktreePath: string, status: SessionSnapshot["status"]): SessionSnapshot {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    workspacePath: repoPath,
    agentId: AGENT_ID,
    title: "Verification",
    status,
    driver: "claude-code",
    useWorktree: true,
    worktreePath,
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

test("pre-launch worktree verification produces one control-plane transcript error", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-verification-integration-"));
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "missing-worktree");
  const sessionId = "s_verification_integration";
  const runnerStore = new SessionStore(join(root, "runner-sessions"));
  const db = ControlPlaneDb.open(":memory:");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repoPath]);
    execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", repoPath, "branch", "-M", "main"]);

    db.registerRunner(runnerMetadata(repoPath), Date.now(), PROTOCOL_VERSION);
    db.createSessionFromSnapshot(snapshot(sessionId, repoPath, worktreePath, "running"), RUNNER_ID, Date.now());
    const hub = {
      sessionChangedById() {},
      sessionEvent() {},
    } as unknown as Hub;
    const sessions = new SessionsService(db, hub, NOOP_LOG);

    const meta: SessionMeta = {
      sessionId,
      agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      repoPath,
      worktreePath,
      worktreeBranch: "agent/s_verification_integration",
      driver: "claude-code",
      command: "verification-agent",
      args: [],
      env: {},
      context: { kind: "native" },
      agentSessionId: null,
      status: "running",
      title: "Verification",
      config: {},
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      preview: null,
      pendingApproval: null,
      seq: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    runnerStore.create(meta);

    const sent: RunnerToControlPlane[] = [];
    const deliver = (message: RunnerToControlPlane) => {
      sent.push(message);
      if (message.type === "session_event") {
        sessions.onSessionEvent(
          message.sessionId,
          message.payload,
          message.seq,
          message.ts,
          RUNNER_ID,
        );
      } else if (message.type === "session_status") {
        sessions.onSessionStatus(
          message.sessionId,
          message.status,
          message.detail,
          message.worktreePath,
          RUNNER_ID,
          message.controlPlaneLaunchId,
          message.capacityWait,
        );
      }
    };
    manager = new SessionManager(deliver, () => {}, runnerStore, RUNNER_ID, undefined, undefined, join(root, "data"));

    sessions.onSessionEvent(
      sessionId,
      { kind: "error", message: "the earlier deferred worktree rebind failed" },
      1,
      1,
      RUNNER_ID,
    );
    const internals = manager as unknown as {
      launchGenerations: Map<string, number>;
      verifySelectedWorktreeBeforeLaunch(
        current: SessionMeta,
        worktree: { path: string; branch: string },
        generation: number,
      ): Promise<boolean>;
    };
    internals.launchGenerations.set(sessionId, 1);
    assert.equal(await internals.verifySelectedWorktreeBeforeLaunch(
      meta,
      { path: worktreePath, branch: meta.worktreeBranch! },
      1,
    ), false);

    const failure = sent.find((message) => message.type === "session_status" && message.status === "failed");
    assert.ok(failure?.type === "session_status");
    assert.match(failure.detail ?? "", /restore .*missing-worktree or select another worktree/);
    assert.equal(sent.some((message) => message.type === "session_event" && message.payload.kind === "error"), false,
      "the runner does not duplicate the control-plane-owned transcript event");
    assert.equal(runnerStore.readMeta(sessionId)?.status, "failed");
    assert.equal(db.getSession(sessionId)?.status, "failed");

    const verificationErrors = () => db.listEvents(sessionId).filter((event) =>
      event.payload.kind === "error" && /could not be verified before provider launch/.test(event.payload.message));
    assert.equal(verificationErrors().length, 1);
    assert.deepEqual(db.listEvents(sessionId).filter((event) => event.payload.kind === "error")
      .map((event) => event.payload.kind === "error" ? event.payload.message : ""), [
      "the earlier deferred worktree rebind failed",
      failure.detail,
    ], "a distinct earlier lifecycle failure remains visible");

    deliver(failure);
    sessions.hydrateRunnerSessions(
      RUNNER_ID,
      [snapshot(sessionId, repoPath, worktreePath, "failed")],
    );
    assert.equal(verificationErrors().length, 1,
      "duplicate status delivery and reconnect hydration do not append another card");
  } finally {
    manager?.shutdownAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
