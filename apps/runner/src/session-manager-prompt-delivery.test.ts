/**
 * Issue #1406: a prompt sent to a session that is mid-turn must never disappear without a trace.
 *
 * An Orchestrator's `prompt_session` reaches the runner on the non-durable lane, so the queued
 * entry carries neither a DurableCommandLifecycle nor a session-command lifecycle. Every
 * involuntary queue discard therefore used to settle nothing at all: no receipt, no error, and no
 * event on the child's own timeline. The sender saw HTTP 200 and the child never saw the message.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToControlPlane, SessionEventMessage } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s_mid",
    agentId: "claude-native",
    workspaceId: "repo",
    repoPath: "/home/me/repo",
    worktreePath: null,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: null,
    status: "running",
    title: "mid-turn delivery",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** A session already mid-turn (running:true), so drain() returns early and an incoming prompt is
 * held in the FIFO exactly as an Orchestrator's mid-turn `prompt_session` is. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-mid-turn-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta());
  const sm = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner");
  const stub = {
    resolvePermission: () => false,
    cancel: () => {},
    dispose: () => {},
    prompt: () => new Promise<never>(() => {}), // the in-flight turn never settles during the test
    setConfig: () => {},
    agentSessionId: () => null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sm as any).active.set("s_mid", {
    sessionId: "s_mid",
    client: stub,
    repoPath: "/home/me/repo",
    cwd: "/home/me/repo",
    worktree: null,
    status: "running",
    running: true,
    queue: [],
  });
  const events = () => sent.filter((m): m is SessionEventMessage => m.type === "session_event");
  return { sm, store, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a queued mid-turn prompt discarded by Stop is reported on the session timeline", () => {
  const { sm, events, cleanup } = harness();
  try {
    sm.prompt("s_mid", "Orchestrator: stop polling and rebase onto main instead.");

    const before = events().length;
    sm.stop("s_mid");

    const discardNotices = events()
      .slice(before)
      .filter((message) =>
        (message.payload.kind === "error" || message.payload.kind === "stderr") &&
        /queued message/i.test(
          message.payload.kind === "error" ? message.payload.message : message.payload.text,
        ));
    assert.equal(
      discardNotices.length,
      1,
      "discarding a queued prompt must leave exactly one visible record on the child's timeline",
    );
    const notice = discardNotices[0]!;
    const text = notice.payload.kind === "error" ? notice.payload.message : "";
    assert.match(
      text,
      /stop polling and rebase onto main instead/,
      "the record must quote the message that was discarded so it can be resent",
    );
  } finally {
    cleanup();
  }
});

test("cancelling a queued prompt on purpose stays silent", () => {
  const { sm, events, cleanup } = harness();
  try {
    sm.prompt("s_mid", "a queued prompt the user cancels deliberately");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptId = (sm as any).active.get("s_mid").queue[0].id as string;

    const before = events().length;
    sm.removeQueuedPrompt("s_mid", promptId);

    const notices = events()
      .slice(before)
      .filter((message) =>
        (message.payload.kind === "error" || message.payload.kind === "stderr") &&
        /queued message/i.test(
          message.payload.kind === "error" ? message.payload.message : message.payload.text,
        ));
    assert.deepEqual(notices, [], "a deliberate cancel is not a lost message and must not be reported");
  } finally {
    cleanup();
  }
});
