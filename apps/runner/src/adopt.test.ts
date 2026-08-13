import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpRuntimeCapabilities, ExternalSessionDescriptor, RunnerToControlPlane, SessionStatusMessage } from "@wollipog/protocol";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { SessionManager, type LaunchResolver } from "./session-manager.js";

function harness(resolveLaunch?: LaunchResolver) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-adopt-"));
  const store = new SessionStore(root);
  const sent: RunnerToControlPlane[] = [];
  const mgr = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner", resolveLaunch);
  return { mgr, store, root, sent };
}

const DESCRIPTOR: ExternalSessionDescriptor = {
  agentSessionId: "cli-conversation-1",
  driver: "codex",
  cwd: "/home/me/proj",
  context: { kind: "native" },
  title: "Refactor the parser",
  createdAt: 1000,
  updatedAt: 2000,
  messageCount: 3,
};
const LAUNCH = { command: "codex", args: [], env: {} };
const ACP_CAPABILITIES: AcpRuntimeCapabilities = {
  logout: false,
  loadSession: true,
  sessionList: true,
  sessionDelete: false,
  sessionResume: false,
  sessionClose: true,
};

test("adopt creates a resumable, in-place, event-free session row", () => {
  const { mgr, store, root } = harness();
  try {
    assert.equal(mgr.adopt("s1", DESCRIPTOR, LAUNCH), true);
    const meta = store.readMeta("s1")!;
    assert.equal(meta.agentSessionId, "cli-conversation-1"); // resumable by the CLI id
    assert.equal(meta.driver, "codex");
    assert.equal(meta.repoPath, "/home/me/proj");
    assert.equal(meta.worktreePath, null); // ran in-place
    assert.equal(meta.status, "idle"); // immediately promptable
    assert.equal(meta.seq, 0); // no events until backfill
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adopt refuses a duplicate agentSessionId so two box sessions can't drive one CLI conversation (P2b)", () => {
  const { mgr, store, root } = harness();
  try {
    assert.equal(mgr.adopt("s1", DESCRIPTOR, LAUNCH), true);
    assert.equal(mgr.adopt("s2", DESCRIPTOR, LAUNCH), false);
    assert.equal(store.has("s2"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACP adoption binds the exact agent and permits provider-local session id collisions", () => {
  const { mgr, store, root } = harness();
  const acp = { ...DESCRIPTOR, driver: "acp" as const, agentId: "provider-a" };
  try {
    assert.equal(mgr.adopt("s1", acp, LAUNCH, ACP_CAPABILITIES), true);
    assert.equal(mgr.adopt("s2", { ...acp, agentId: "provider-b" }, LAUNCH, ACP_CAPABILITIES), true);
    assert.equal(mgr.adopt("s3", acp, LAUNCH, ACP_CAPABILITIES), false);
    assert.equal(store.readMeta("s1")!.agentId, "provider-a");
    assert.equal(store.readMeta("s2")!.agentId, "provider-b");
    assert.deepEqual(store.readMeta("s1")!.acpCapabilities, ACP_CAPABILITIES);
    assert.equal(store.has("s3"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adopt with the read-only sentinel (no resuming agent) still creates the session, and a prompt refuses clearly (gap 9)", async () => {
  const { mgr, store, root, sent } = harness();
  try {
    // handleAdopt stores command "" when resolveLaunchForDriver found nothing for driver+context.
    assert.equal(mgr.adopt("s1", DESCRIPTOR, { command: "", args: [], env: {} }), true);
    assert.equal(store.readMeta("s1")!.command, "");
    assert.equal(store.readMeta("s1")!.status, "idle"); // history renders like any adopted session

    mgr.prompt("s1", "continue please");
    await new Promise((r) => setImmediate(r)); // resumeAndPrompt is fire-and-forget

    const err = sent.find((m) => m.type === "session_event" && m.payload.kind === "error");
    assert.ok(err, "a clear error event was emitted instead of spawning an empty command");
    const message = (err as { payload: { message: string } }).payload.message;
    assert.match(message, /no agent on this box that can resume it/);
    assert.match(message, /driver codex, context native/);
    assert.match(message, /read-only history/);
    // Settles to stopped (mirrors the acp/codex-app-server read-only path) — never "failed".
    const statuses = sent.filter((m): m is SessionStatusMessage => m.type === "session_status");
    assert.equal(statuses.at(-1)!.status, "stopped");
    assert.equal(store.readMeta("s1")!.status, "stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the read-only refusal names the WSL distro so the user knows which context lacks the agent", async () => {
  const { mgr, root, sent } = harness();
  try {
    const wslDescriptor: ExternalSessionDescriptor = {
      ...DESCRIPTOR,
      driver: "claude-code",
      context: { kind: "wsl", distro: "Ubuntu" },
    };
    mgr.adopt("s1", wslDescriptor, { command: "", args: [], env: {} });
    mgr.prompt("s1", "hi");
    await new Promise((r) => setImmediate(r));

    const err = sent.find((m) => m.type === "session_event" && m.payload.kind === "error");
    assert.ok(err);
    assert.match(
      (err as { payload: { message: string } }).payload.message,
      /driver claude-code, context wsl:Ubuntu/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a read-only adopt HEALS once the box gains a matching agent: resume re-resolves and patches the launch in place", async () => {
  // The no-agent condition at adopt time can be transient (adopt raced discovery, or the CLI was
  // installed later) — the resolver sees the live agent list, so the session must stop being
  // read-only the moment a match exists.
  const { mgr, store, root, sent } = harness(() => ({ command: "codex", args: ["exec"], env: { K: "v" } }));
  // Stub the spawn path — this test pins the heal decision, not process launching.
  const launched: { command: string; resumeId?: string }[] = [];
  (mgr as unknown as { launch: (m: SessionMeta, resumeId?: string) => Promise<boolean> }).launch = async (
    m,
    resumeId,
  ) => {
    launched.push({ command: m.command, resumeId });
    return false; // stop before the prompt turn — spawn/turn behavior is covered elsewhere
  };
  try {
    mgr.adopt("s1", DESCRIPTOR, { command: "", args: [], env: {} });
    mgr.prompt("s1", "continue");
    await new Promise((r) => setImmediate(r));

    const m = store.readMeta("s1")!;
    assert.equal(m.command, "codex"); // healed in place — no longer the read-only sentinel
    assert.deepEqual(m.args, ["exec"]);
    assert.deepEqual(m.env, {}, "resolved launch env is never persisted in adopted session metadata");
    // The normal resume path ran with the healed params + the CLI conversation id — no refusal.
    assert.deepEqual(launched, [{ command: "codex", resumeId: "cli-conversation-1" }]);
    assert.equal(
      sent.find((x) => x.type === "session_event" && x.payload.kind === "error"),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sentinel prompt still refuses when the live resolver ALSO finds no matching agent", async () => {
  const { mgr, store, root, sent } = harness(() => null);
  try {
    mgr.adopt("s1", DESCRIPTOR, { command: "", args: [], env: {} });
    mgr.prompt("s1", "hi");
    await new Promise((r) => setImmediate(r));

    const err = sent.find((m) => m.type === "session_event" && m.payload.kind === "error");
    assert.ok(err, "refused — nothing to heal with");
    assert.match((err as { payload: { message: string } }).payload.message, /read-only history/);
    assert.equal(store.readMeta("s1")!.command, ""); // sentinel untouched
    assert.equal(store.readMeta("s1")!.status, "stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the read-only refusal is SEND-ONLY, so a slow transcript backfill still lands after it (seq-0 guard)", async () => {
  const { mgr, store, root, sent } = harness();
  try {
    mgr.adopt("s1", DESCRIPTOR, { command: "", args: [], env: {} });
    // A prompt can race the (up to ~8s on WSL) transcript read handleAdopt kicks off after
    // creating the row. If the refusal persisted its error event, seq would pass 0 and
    // backfillTranscript would silently discard the history — the session's entire value.
    mgr.prompt("s1", "too early");
    await new Promise((r) => setImmediate(r));

    assert.ok(
      sent.some((m) => m.type === "session_event" && m.payload.kind === "error"),
      "the refusal still reached the wire",
    );
    assert.equal(store.readMeta("s1")!.seq, 0, "but nothing was persisted");
    assert.equal(store.readEvents("s1", 0).length, 0);

    mgr.backfillTranscript("s1", [
      { kind: "user_message", text: "hi", final: true },
      { kind: "agent_message", text: "hello", final: true },
    ]);
    assert.equal(store.readMeta("s1")!.seq, 2, "the transcript landed after the refusal");
    assert.equal(store.readEvents("s1", 0).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backfillTranscript appends to a fresh session but skips one that already has events (P1b)", () => {
  const { mgr, store, root } = harness();
  try {
    mgr.adopt("s1", DESCRIPTOR, LAUNCH);
    mgr.backfillTranscript("s1", [
      { kind: "user_message", text: "hi" },
      { kind: "agent_message", text: "hello" },
    ]);
    assert.equal(store.readEvents("s1", 0).length, 2);
    assert.equal(store.readMeta("s1")!.seq, 2);

    // A session that already has events (e.g. a prompt won the race) must NOT get history grafted
    // in after the new turn.
    mgr.backfillTranscript("s1", [{ kind: "agent_message", text: "late history" }]);
    assert.equal(store.readEvents("s1", 0).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backfill keeps parented usage for rollups without adding it to authoritative runner totals", () => {
  const { mgr, store, root } = harness();
  try {
    mgr.adopt("s1", { ...DESCRIPTOR, driver: "claude-code" }, LAUNCH);
    mgr.backfillTranscript("s1", [
      { kind: "token_usage", inputTokens: 90, outputTokens: 10, costUsd: 9, parentToolUseId: "task-1" },
      { kind: "token_usage", inputTokens: 12, outputTokens: 3, costUsd: 1 },
    ]);
    const meta = store.readMeta("s1")!;
    assert.equal(meta.tokensIn, 12);
    assert.equal(meta.tokensOut, 3);
    assert.equal(meta.costUsd, 1);
    assert.equal(store.readEvents("s1", 0).length, 2, "both the display breakdown and authoritative total remain in history");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileStore clears a stranded worktreePending flag (crash mid-worktree-setup)", () => {
  const { mgr, store, root } = harness();
  try {
    // Simulate a runner that died between persisting the session and resolving worktree setup:
    // the flag would otherwise block Files/shells root resolution forever.
    mgr.adopt("s1", DESCRIPTOR, LAUNCH);
    store.patchMeta("s1", { worktreePending: true, status: "starting" });
    mgr.reconcileStore();
    const meta = store.readMeta("s1")!;
    assert.equal(meta.worktreePending, false, "pending flag cleared on reconcile");
    assert.equal(meta.status, "idle", "mid-flight status demoted as before");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
