/**
 * SessionManager.resolvePermission delivery contract: permission_resolved is emitted ONLY when
 * the driver actually delivered the decision to a live ask. A dead-target click (process exited,
 * runner restarted, stale card) must be surfaced — not phantom-resolved into a forever-"running"
 * session.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s_perm",
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
    status: "idle",
    title: "perm test",
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

function makeHarness(deliver: boolean | "none") {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-perm-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta());
  const sm = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner");
  if (deliver !== "none") {
    const stub = {
      resolvePermission: () => deliver,
      answerQuestion: () => deliver,
      cancel: () => {},
      dispose: () => {},
      prompt: () => Promise.resolve("end_turn" as const),
      setConfig: () => {},
      agentSessionId: () => null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).active.set("s_perm", {
      sessionId: "s_perm",
      client: stub,
      repoPath: "/home/me/repo",
      cwd: "/home/me/repo",
      worktree: null,
      status: "running",
      running: true,
      queue: [],
    });
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { sm, sent, store, cleanup };
}

const eventsOf = (sent: RunnerToControlPlane[], kind: string) =>
  sent.filter((m) => m.type === "session_event" && (m as { payload: { kind: string } }).payload.kind === kind);

test("delivered approval emits exactly one permission_resolved and flips box meta to running", () => {
  const { sm, sent, store, cleanup } = makeHarness(true);
  try {
    sm.resolvePermission("s_perm", "req-1", "allow");
    const resolved = eventsOf(sent, "permission_resolved");
    assert.equal(resolved.length, 1);
    assert.equal((resolved[0] as { payload: { resolutionReason?: string } }).payload.resolutionReason, "submitted");
    assert.equal(store.readMeta("s_perm")!.status, "running");
  } finally {
    cleanup();
  }
});

test("approval turnaround telemetry contains duration and dimensions, never session/request content", () => {
  const { sm, sent, cleanup } = makeHarness(true);
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "permission_request",
      requestId: "secret-request-id",
      title: "run sensitive command",
      options: [{ optionId: "proceed_once", name: "Proceed", kind: "allow_once" }],
    });
    sm.resolvePermission("s_perm", "secret-request-id", "proceed_once");
    const telemetry = sent.find((message) => message.type === "driver_telemetry");
    assert.ok(telemetry && telemetry.type === "driver_telemetry");
    assert.equal(telemetry.metric, "approval");
    assert.equal(telemetry.outcome, "allowed");
    assert.equal(telemetry.driver, "claude-code");
    assert.ok((telemetry.durationMs ?? -1) >= 0);
    const wire = JSON.stringify(telemetry);
    assert.doesNotMatch(wire, /s_perm|secret-request-id|sensitive command/);
  } finally {
    cleanup();
  }
});

test("an explicit Cancel option records cancelled telemetry and a dismissed lifecycle reason", () => {
  const { sm, sent, cleanup } = makeHarness(true);
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "permission_request",
      requestId: "req-cancel-option",
      title: "approval",
      options: [{ optionId: "cancel", name: "Cancel", kind: "cancel" }],
    });
    sm.resolvePermission("s_perm", "req-cancel-option", "cancel");
    const telemetry = sent.find(
      (message) => message.type === "driver_telemetry" && message.metric === "approval",
    );
    assert.ok(telemetry && telemetry.type === "driver_telemetry");
    assert.equal(telemetry.outcome, "cancelled");
    const resolved = eventsOf(sent, "permission_resolved");
    assert.equal(resolved.length, 1);
    assert.deepEqual((resolved[0] as { payload: unknown }).payload, {
      kind: "permission_resolved",
      requestId: "req-cancel-option",
      optionId: "cancel",
      resolutionReason: "dismissed",
    });
  } finally {
    cleanup();
  }
});

test("a delivered Cancel remains dismissed after its approval card was cleared", () => {
  const { sm, sent, store, cleanup } = makeHarness(true);
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "permission_request",
      requestId: "req-cleared-cancel",
      title: "approval",
      options: [{ optionId: "choice", name: "Cancel", kind: "cancel" }],
    });
    store.patchMeta("s_perm", { pendingApproval: null, status: "idle" });

    sm.resolvePermission("s_perm", "req-cleared-cancel", "choice");

    const telemetry = sent.find(
      (message) => message.type === "driver_telemetry" && message.metric === "approval",
    );
    assert.ok(telemetry && telemetry.type === "driver_telemetry");
    assert.equal(telemetry.outcome, "cancelled");
    assert.deepEqual((eventsOf(sent, "permission_resolved").at(-1) as { payload: unknown }).payload, {
      kind: "permission_resolved",
      requestId: "req-cleared-cancel",
      optionId: "choice",
      resolutionReason: "dismissed",
    });
  } finally {
    cleanup();
  }
});

test("a delivered Cancel uses its own semantics when another approval card is current", () => {
  const { sm, sent, store, cleanup } = makeHarness(true);
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "permission_request",
      requestId: "req-original-cancel",
      title: "original approval",
      options: [{ optionId: "shared-choice", name: "Cancel", kind: "cancel" }],
    });
    store.patchMeta("s_perm", {
      pendingApproval: {
        requestId: "req-current-allow",
        title: "current approval",
        options: [{ optionId: "shared-choice", name: "Allow", kind: "allow_once" }],
      },
      status: "input_required",
    });

    sm.resolvePermission("s_perm", "req-original-cancel", "shared-choice");

    const telemetry = sent.find(
      (message) => message.type === "driver_telemetry" && message.metric === "approval",
    );
    assert.ok(telemetry && telemetry.type === "driver_telemetry");
    assert.equal(telemetry.outcome, "cancelled");
    assert.deepEqual((eventsOf(sent, "permission_resolved").at(-1) as { payload: unknown }).payload, {
      kind: "permission_resolved",
      requestId: "req-original-cancel",
      optionId: "shared-choice",
      resolutionReason: "dismissed",
    });
  } finally {
    cleanup();
  }
});

test("delivered allow and reject options do not borrow Cancel semantics from another card", () => {
  for (const [optionKind, expectedOutcome] of [
    ["allow_always", "allowed"],
    ["reject_once", "denied"],
  ] as const) {
    const { sm, sent, store, cleanup } = makeHarness(true);
    try {
      (sm as any).emitEvent("s_perm", {
        kind: "permission_request",
        requestId: `req-original-${optionKind}`,
        title: "original approval",
        options: [{ optionId: "shared-choice", name: "Choose", kind: optionKind }],
      });
      store.patchMeta("s_perm", {
        pendingApproval: {
          requestId: "req-current-cancel",
          title: "current approval",
          options: [{ optionId: "shared-choice", name: "Cancel", kind: "cancel" }],
        },
        status: "input_required",
      });

      sm.resolvePermission("s_perm", `req-original-${optionKind}`, "shared-choice");

      const telemetry = sent.find(
        (message) => message.type === "driver_telemetry" && message.metric === "approval",
      );
      assert.ok(telemetry && telemetry.type === "driver_telemetry");
      assert.equal(telemetry.outcome, expectedOutcome);
      const resolved = eventsOf(sent, "permission_resolved").at(-1) as {
        payload: { resolutionReason?: string };
      };
      assert.equal(resolved.payload.resolutionReason, "submitted");
    } finally {
      cleanup();
    }
  }
});

test("explicit question dismissal records cancelled telemetry and a dismissed lifecycle reason", () => {
  const { sm, sent, cleanup } = makeHarness(true);
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "question_request",
      requestId: "question-dismiss",
      questions: [{ id: "note", question: "Optional note", options: [], required: false }],
    });
    sm.answerQuestion("s_perm", "question-dismiss", {}, "dismiss");
    const telemetry = sent.find(
      (message) => message.type === "driver_telemetry" && message.metric === "approval",
    );
    assert.ok(telemetry && telemetry.type === "driver_telemetry");
    assert.equal(telemetry.outcome, "cancelled");
    assert.deepEqual((eventsOf(sent, "question_resolved")[0] as { payload: unknown }).payload, {
      kind: "question_resolved",
      requestId: "question-dismiss",
      answered: false,
      resolutionReason: "dismissed",
    });
  } finally {
    cleanup();
  }
});

test("startup preserves a stranded question as a dismissible recovery and resolves it exactly once", () => {
  const { sm, sent, store, cleanup } = makeHarness("none");
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "question_request",
      requestId: "question-before-restart",
      questions: [{ id: "target", question: "Which target?", options: [{ label: "Production" }] }],
    });
    // Reproduce the metadata left by the affected older startup path: history still contains the
    // unresolved request, but the actionable card and waiting status were erased.
    store.patchMeta("s_perm", { status: "idle", pendingApproval: null });
    // Recovery must use bounded pages instead of the legacy whole-history materializer.
    (store as SessionStore & { readEvents: () => never }).readEvents = () => {
      throw new Error("legacy whole-history reads are forbidden during startup reconciliation");
    };

    sm.reconcileStore();

    const recovered = store.readMeta("s_perm")!;
    assert.equal(recovered.status, "input_required");
    assert.equal(recovered.questionRecoveryReconciled, true);
    assert.deepEqual(recovered.pendingApproval, {
      requestId: "question-before-restart",
      title: "Which target?",
      options: [],
      kind: "question",
      questions: [{ id: "target", question: "Which target?", options: [{ label: "Production" }] }],
      recoveryReason: "provider_restart",
    });

    sm.answerQuestion("s_perm", "question-before-restart", {}, "dismiss");
    sm.answerQuestion("s_perm", "question-before-restart", {}, "dismiss");

    assert.equal(eventsOf(sent, "question_resolved").length, 1);
    assert.deepEqual((eventsOf(sent, "question_resolved")[0] as { payload: unknown }).payload, {
      kind: "question_resolved",
      requestId: "question-before-restart",
      answered: false,
      resolutionReason: "dismissed",
    });
    assert.equal(store.readMeta("s_perm")?.status, "idle");
    assert.equal(store.readMeta("s_perm")?.pendingApproval, null);
  } finally {
    cleanup();
  }
});

test("startup preserves a still-pending question through the primary metadata path", () => {
  const { sm, store, cleanup } = makeHarness("none");
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "question_request",
      requestId: "pending-before-restart",
      questions: [{ id: "target", question: "Which target?", options: [{ label: "Production" }] }],
    });

    sm.reconcileStore();

    assert.equal(store.readMeta("s_perm")?.status, "input_required");
    assert.equal(store.readMeta("s_perm")?.pendingApproval?.requestId, "pending-before-restart");
    assert.equal(store.readMeta("s_perm")?.pendingApproval?.recoveryReason, "provider_restart");
  } finally {
    cleanup();
  }
});

test("startup retries historical question recovery after a transient history read failure", () => {
  const { sm, store, cleanup } = makeHarness("none");
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "question_request",
      requestId: "question-after-read-retry",
      questions: [{ id: "target", question: "Which target?", options: [{ label: "Production" }] }],
    });
    store.patchMeta("s_perm", { status: "idle", pendingApproval: null });
    const logTailSeqResult = store.logTailSeqResult.bind(store);
    store.logTailSeqResult = () => ({ ok: false });

    sm.reconcileStore();

    assert.equal(store.readMeta("s_perm")?.questionRecoveryReconciled, undefined);
    assert.equal(store.readMeta("s_perm")?.pendingApproval, null);

    store.logTailSeqResult = logTailSeqResult;
    sm.reconcileStore();

    assert.equal(store.readMeta("s_perm")?.questionRecoveryReconciled, true);
    assert.equal(store.readMeta("s_perm")?.pendingApproval?.requestId, "question-after-read-retry");
    assert.equal(store.readMeta("s_perm")?.pendingApproval?.recoveryReason, "provider_restart");
  } finally {
    cleanup();
  }
});

test("recovered dismissal preserves a newer running turn status", () => {
  const { sm, sent, store, cleanup } = makeHarness(false);
  try {
    store.patchMeta("s_perm", {
      status: "running",
      pendingApproval: {
        requestId: "recovery-during-new-turn",
        title: "Which target?",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Which target?", options: [{ label: "Production" }] }],
        recoveryReason: "provider_restart",
      },
    });

    sm.answerQuestion("s_perm", "recovery-during-new-turn", {}, "dismiss");

    assert.equal(eventsOf(sent, "question_resolved").length, 1);
    assert.equal(store.readMeta("s_perm")?.status, "running");
    assert.equal(store.readMeta("s_perm")?.pendingApproval, null);
    assert.equal(sent.filter((message) => message.type === "session_status").at(-1)?.status, "running");
  } finally {
    cleanup();
  }
});

test("startup never resurrects a question that already has a durable resolution", () => {
  const { sm, store, cleanup } = makeHarness("none");
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "question_request",
      requestId: "older-replaced-question",
      questions: [{ id: "target", question: "Old target?", options: [{ label: "Staging" }] }],
    });
    (sm as any).emitEvent("s_perm", {
      kind: "question_request",
      requestId: "resolved-before-restart",
      questions: [{ id: "target", question: "Which target?", options: [{ label: "Production" }] }],
    });
    (sm as any).emitEvent("s_perm", {
      kind: "question_resolved",
      requestId: "resolved-before-restart",
      answered: true,
      resolutionReason: "submitted",
    });
    (sm as any).emitStatus("s_perm", "idle");

    sm.reconcileStore();

    assert.equal(store.readMeta("s_perm")?.status, "idle");
    assert.equal(store.readMeta("s_perm")?.pendingApproval, null);
  } finally {
    cleanup();
  }
});

test("authentication requests persist as sign-in input without exposing a distinct routing path", () => {
  const { sm, store, cleanup } = makeHarness(true);
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "permission_request",
      purpose: "authentication",
      requestId: "auth_1",
      title: "Sign in to Gemini CLI",
      options: [{ optionId: "auth_1_method_1", name: "Browser sign-in", kind: "allow_once" }],
    });
    const meta = store.readMeta("s_perm")!;
    assert.equal(meta.status, "input_required");
    assert.equal(meta.pendingApproval?.kind, "authentication");
    assert.equal(meta.pendingApproval?.options[0]?.name, "Browser sign-in");
  } finally {
    cleanup();
  }
});

test("an ACP option without kind uses neutral observed instead of guessing denied", () => {
  const { sm, sent, cleanup } = makeHarness(true);
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "permission_request",
      requestId: "req-custom",
      title: "approval",
      options: [{ optionId: "proceed_once", name: "Proceed" }],
    });
    sm.resolvePermission("s_perm", "req-custom", "proceed_once");
    const telemetry = sent.find(
      (message) => message.type === "driver_telemetry" && message.metric === "approval",
    );
    assert.ok(telemetry && telemetry.type === "driver_telemetry");
    assert.equal(telemetry.outcome, "observed");
  } finally {
    cleanup();
  }
});

test("historical approval backfill never starts a live timer or fabricates cancellation telemetry", () => {
  const resolved = makeHarness("none");
  try {
    resolved.sm.backfillTranscript("s_perm", [
      {
        kind: "permission_request",
        requestId: "old-resolved",
        title: "historical",
        options: [{ optionId: "allow", name: "Allow" }],
      },
      { kind: "permission_resolved", requestId: "old-resolved", optionId: "allow" },
    ]);
    assert.equal((resolved.sm as any).approvalStarted.size, 0);
  } finally {
    resolved.cleanup();
  }

  const unresolved = makeHarness("none");
  try {
    unresolved.sm.backfillTranscript("s_perm", [
      {
        kind: "permission_request",
        requestId: "old-unresolved",
        title: "historical",
        options: [{ optionId: "allow", name: "Allow" }],
      },
    ]);
    unresolved.sm.stop("s_perm");
    assert.equal((unresolved.sm as any).approvalStarted.size, 0);
    assert.equal(unresolved.sent.some((message) => message.type === "driver_telemetry"), false);
  } finally {
    unresolved.cleanup();
  }
});

test("cancelling a parked approval records a cancelled turnaround", () => {
  const { sm, sent, cleanup } = makeHarness(true);
  try {
    (sm as any).emitEvent("s_perm", {
      kind: "permission_request",
      requestId: "req-cancel",
      title: "approval",
      options: [{ optionId: "allow", name: "Allow" }],
    });
    sm.cancel("s_perm");
    const telemetry = sent.find(
      (message) => message.type === "driver_telemetry" && message.metric === "approval",
    );
    assert.ok(telemetry && telemetry.type === "driver_telemetry");
    assert.equal(telemetry.outcome, "cancelled");
  } finally {
    cleanup();
  }
});

test("a dead-target approval (driver returns false) surfaces stderr + the store's real status — no phantom resolution", () => {
  const { sm, sent, store, cleanup } = makeHarness(false);
  try {
    sm.resolvePermission("s_perm", "req-1", "allow");
    assert.equal(eventsOf(sent, "permission_resolved").length, 0, "never pretend the decision landed");
    const stderr = eventsOf(sent, "stderr");
    assert.equal(stderr.length, 1);
    assert.match((stderr[0] as { payload: { text: string } }).payload.text, /could not be delivered/);
    // The corrective status frame carries the store's REAL status (idle — set at meta creation),
    // which also clears any stale card through the settled-status path everywhere.
    const statuses = sent.filter((m) => m.type === "session_status");
    assert.equal(statuses.length, 1);
    assert.equal((statuses[0] as { status: string }).status, "idle");
    assert.equal(store.readMeta("s_perm")!.status, "idle", "box meta NOT phantom-flipped to running");
  } finally {
    cleanup();
  }
});

test("an approval for a session with no live entry surfaces the same correction path", () => {
  const { sm, sent, cleanup } = makeHarness("none");
  try {
    sm.resolvePermission("s_perm", "req-1", "deny");
    assert.equal(eventsOf(sent, "permission_resolved").length, 0);
    assert.equal(eventsOf(sent, "stderr").length, 1);
  } finally {
    cleanup();
  }
});

test("an approval for a session absent from the store is a total no-op", () => {
  const { sm, sent, cleanup } = makeHarness("none");
  try {
    (sm as any).approvalStarted.set("s_ghost:req-1", 1);
    sm.resolvePermission("s_ghost", "req-1", "allow");
    assert.equal(sent.length, 0);
    assert.equal((sm as any).approvalStarted.size, 0, "ephemeral timer is still reaped");
  } finally {
    cleanup();
  }
});

test("a dead-target click for an OLD ask cannot wipe a LIVE parked card in the box store", () => {
  // Shared-store scenario: another runner process on this box has the session parked on req-2
  // (store: input_required + card). A stale click for req-1 routes here, the driver has nothing
  // waiting, and the corrective status re-emit must NOT destroy the live card — input_required
  // is the parked state, not a settle.
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-perm-"));
  const sent = [];
  const store = new SessionStore(root);
  store.create(
    meta({
      status: "input_required",
      pendingApproval: {
        requestId: "req-2",
        title: "Allow Bash?",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    }),
  );
  const sm = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner");
  try {
    sm.resolvePermission("s_perm", "req-1", "allow");
    const m = store.readMeta("s_perm");
    assert.equal(m.status, "input_required");
    assert.equal(m.pendingApproval?.requestId, "req-2", "the live card survives the correction");
    assert.equal(sent.filter((x) => x.type === "session_event" && x.payload.kind === "permission_resolved").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logoutAgent is capability-gated and refuses to race a running turn", async () => {
  const { sm, cleanup } = makeHarness(true);
  try {
    const entry = (sm as any).active.get("s_perm");
    entry.running = false;
    assert.deepEqual(await sm.logoutAgent("s_perm"), {
      ok: false,
      error: "this agent does not support in-app logout",
    });
    entry.client.logout = async () => undefined;
    entry.running = true;
    assert.deepEqual(await sm.logoutAgent("s_perm"), {
      ok: false,
      error: "wait for the running and queued turns to finish before signing out",
    });
  } finally {
    cleanup();
  }
});

test("logoutAgent delegates only to the live quiescent driver", async () => {
  const { sm, sent, store, cleanup } = makeHarness(true);
  let calls = 0;
  try {
    const entry = (sm as any).active.get("s_perm");
    entry.running = false;
    entry.client.logout = async () => {
      calls += 1;
    };
    entry.providerReady = true;
    store.patchMeta("s_perm", {
      capabilities: { slashCommands: [{ name: "review", source: "project" }] },
    });
    (sm as any).sessionCommandAuthority.refresh(
      "s_perm",
      [{ name: "review", source: "project" }],
      "logout-test",
    );
    assert.deepEqual(await sm.logoutAgent("s_perm"), { ok: true });
    assert.equal(calls, 1);
    assert.equal(entry.providerReady, false);
    const revoked = sent.filter((message) => message.type === "session_runtime_updated").at(-1);
    assert.equal(
      revoked?.type === "session_runtime_updated"
        ? revoked.snapshot.agentCapabilities?.slashCommands?.[0]?.invocation
        : "missing",
      undefined,
    );
    assert.deepEqual(await sm.logoutAgent("missing"), { ok: false, error: "session not found" });
  } finally {
    cleanup();
  }
});

test("logoutAgent fences prompts and duplicate logout until the provider settles", async () => {
  const { sm, sent, cleanup } = makeHarness(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const entry = (sm as any).active.get("s_perm");
    entry.running = false;
    entry.client.logout = () => gate;
    const logout = sm.logoutAgent("s_perm");
    assert.deepEqual(await sm.logoutAgent("s_perm"), {
      ok: false,
      error: "agent sign-out is already in progress",
    });
    sm.prompt("s_perm", "must not run during logout");
    assert.equal(eventsOf(sent, "error").some((message) =>
      message.type === "session_event" && /sign-out is in progress/.test(String(message.payload.kind === "error" ? message.payload.message : ""))), true);
    release();
    assert.deepEqual(await logout, { ok: true });
  } finally {
    cleanup();
  }
});
