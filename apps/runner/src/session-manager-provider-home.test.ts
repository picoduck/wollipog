import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

test("a refused home lease reaches failed status and the visible conversation error before any provider starts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-home-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const lock = join(home, ".agent-manager", "provider-home-leases-v1", "mutable-home.lock");
  mkdirSync(lock, { recursive: true });
  const store = new SessionStore(join(root, "sessions"));
  const meta: SessionMeta = {
    sessionId: "lease-refusal", agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: { HOME: home }, context: { kind: "native" },
    agentSessionId: null, status: "starting", title: "Lease Refusal", config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  };
  store.create(meta);
  const messages: RunnerToControlPlane[] = [];
  let driversCreated = 0;
  const manager = new SessionManager(
    (message) => messages.push(message), () => {}, store, "runner", undefined,
    (() => { driversCreated++; throw new Error("provider must not start"); }) as never,
    join(root, "runner-data"), 1, undefined, undefined, undefined,
    { mode: "provider", network: "inherit" }, async () => undefined,
    undefined, undefined, async () => {}, undefined, [], undefined, undefined, undefined, undefined,
    undefined, "a".repeat(64),
  );
  t.after(() => manager.shutdownAll());
  const internals = manager as unknown as {
    acquireAdmission: (sessionId: string) => Promise<boolean>;
    launch: (meta: SessionMeta) => Promise<boolean>;
  };
  assert.equal(await internals.acquireAdmission(meta.sessionId), true);
  assert.equal(await internals.launch(store.readMeta(meta.sessionId)!), false);
  assert.equal(driversCreated, 0);
  assert.equal(store.readMeta(meta.sessionId)?.status, "failed");
  const failed = messages.find((message) => message.type === "session_status" && message.status === "failed");
  assert.ok(failed?.type === "session_status");
  assert.ok(failed.detail?.includes(lock));
  assert.match(failed.detail!, /quarantine the entire.*do not remove individual records/);
  const error = store.readEvents(meta.sessionId).find((event) => event.payload.kind === "error");
  assert.ok(error?.payload.kind === "error");
  assert.ok(error.payload.message.includes(failed.detail!));
});
