import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { metaToSnapshot, type SessionMeta } from "../../runner/src/session-store.js";
import { ControlPlaneDb } from "./db.js";

test("runner restart capability survives control-plane storage and older snapshots clear it", () => {
  const root = mkdtempSync(join(tmpdir(), "restart-capability-"));
  const path = join(root, "state.sqlite");
  let db = ControlPlaneDb.open(path);
  const stored: SessionMeta = {
    sessionId: "session", workspaceId: "workspace", agentId: "claude", driver: "claude-code",
    command: "claude", args: [], env: {}, context: { kind: "native" }, repoPath: "/repo",
    worktreePath: null, agentSessionId: "private-provider-coordinate", status: "failed", title: "Fixture",
    config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
    seq: 1, createdAt: 1, updatedAt: 1,
  };
  const snap = metaToSnapshot(stored, PROTOCOL_VERSION);
  try {
    db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test", agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
    db.createSessionFromSnapshot(snap, "runner", 1);
    assert.equal(db.getSession("session")?.agentCapabilities?.restartResumesConversation, true);
    assert.equal(JSON.stringify(db.getSession("session")).includes("private-provider-coordinate"), false);
    db.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.getSession("session")?.agentCapabilities?.restartResumesConversation, true);
    db.updateSessionFromSnapshot("session", { ...snap, seq: 2, agentCapabilities: { restartResumesConversation: false } }, 2);
    assert.equal(db.getSession("session")?.agentCapabilities?.restartResumesConversation, false);
    db.updateSessionFromSnapshot("session", { ...snap, seq: 3, agentCapabilities: undefined }, 3);
    assert.equal(db.getSession("session")?.agentCapabilities?.restartResumesConversation, undefined);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
