import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToControlPlane, SessionConfig } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { claudeProjectPathKey } from "./claude-background-work.js";

function meta(config: SessionConfig): SessionMeta {
  return {
    sessionId: "s_governance",
    agentId: "claude-native",
    workspaceId: "repo",
    repoPath: "/repo",
    worktreePath: null,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: null,
    status: "running",
    title: "governance test",
    config,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function harness(config: SessionConfig) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-governance-"));
  const store = new SessionStore(root);
  store.create(meta(config));
  const sent: RunnerToControlPlane[] = [];
  let cancels = 0;
  let prompts = 0;
  const client = {
    cancel: () => { cancels += 1; },
    dispose: () => {},
    prompt: () => {
      prompts += 1;
      return Promise.resolve("cancelled" as const);
    },
    setConfig: () => {},
    agentSessionId: () => null,
  };
  const sm = new SessionManager((message) => sent.push(message), () => {}, store, "test-runner");
  const entry: any = {
    sessionId: "s_governance",
    client,
    repoPath: "/repo",
    cwd: "/repo",
    worktree: null,
    context: { kind: "native" as const },
    status: "running" as const,
    running: true,
    queue: [],
    toolCallIds: config.maxToolCalls ? new Set<string>() : undefined,
  };
  // Deliberately exercise the normalized driver callback seam without spawning a provider.
  (sm as any).active.set("s_governance", entry);
  return {
    root,
    sm,
    store,
    sent,
    entry,
    cancels: () => cancels,
    prompts: () => prompts,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a budget trip with managed work settles idle and reconciles a killed receipt without another turn", async () => {
  const h = harness({ costBudgetUsd: 8 });
  try {
    h.store.patchMeta("s_governance", {
      agentSessionId: "provider-session", env: { HOME: h.root, TMPDIR: h.root },
    });
    h.entry.client.prompt = async () => {
      (h.sm as any).onDriverBackgroundWork("s_governance", {
        state: "running", pendingTaskIds: ["job"], observedTaskIds: ["job"],
        jobs: [{ id: "job", launchType: "shell", startedAt: 1 }],
      });
      (h.sm as any).onDriverEvent("s_governance", { kind: "token_usage", costUsd: 8.33 });
      (h.sm as any).onDriverBackgroundWork("s_governance", {
        state: "orphaned", pendingTaskIds: ["job"], observedTaskIds: ["job"], reason: "process_exit",
      });
      return "cancelled";
    };
    await (h.sm as any).runPrompt("s_governance", "work", []);
    h.entry.running = false;
    assert.equal(h.cancels(), 1);
    assert.equal(h.store.readMeta("s_governance")!.status, "idle");
    await (h.sm as any).runOrphanRecovery("s_governance");
    assert.equal(h.entry.queue.length, 0, "a tripped ceiling cannot queue automatic recovery");
    assert.equal(h.store.readMeta("s_governance")!.backgroundWorkState, "orphaned", "missing receipts prove nothing");
    const ledgerDir = join(h.root, ".claude", "projects", claudeProjectPathKey("/repo"));
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, "provider-session.jsonl"), JSON.stringify({
      content: "<task-notification><task-id>job</task-id><status>killed</status></task-notification>",
    }));
    await (h.sm as any).runOrphanRecovery("s_governance");
    const settled = h.store.readMeta("s_governance")!;
    assert.equal(settled.backgroundWorkState, undefined);
    assert.equal(settled.orphanedWork, undefined);
    assert.deepEqual(settled.pendingBackgroundTaskIds, []);
    assert.equal(settled.backgroundJobs?.[0]?.terminalStatus, "killed");
    assert.equal(h.entry.queue.length, 0);
    assert.equal(h.entry.governanceTripped, "cost_budget", "receipt settlement never re-arms spending");
    assert.equal(settled.status, "idle");
    h.sm.rearmGovernance("s_governance", { costBudgetUsd: 16.33 });
    assert.equal(h.entry.governanceTripped, undefined);
  } finally {
    h.sm.shutdownAll();
    h.cleanup();
  }
});

test("runner cancels once at the distinct tool threshold and ignores duplicate frames", () => {
  const h = harness({ maxToolCalls: 2 });
  try {
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "one", title: "Read", status: "pending",
    });
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "one", title: "Read", status: "completed",
    });
    assert.equal(h.cancels(), 0);

    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "two", title: "Edit", status: "pending",
    });
    assert.equal(h.cancels(), 1);
    assert.equal(h.entry.governanceTripped, "max_tool_calls");
    const warning = h.sent.find(
      (message) => message.type === "session_event" && message.payload.kind === "stderr",
    );
    assert.ok(warning && warning.type === "session_event" && warning.payload.kind === "stderr");
    assert.match(warning.payload.text, /2 distinct tool calls/);

    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "three", title: "Bash", status: "pending",
    });
    assert.equal(h.cancels(), 1, "a tripped turn is cancelled only once");
  } finally {
    h.cleanup();
  }
});

test("runner reconnect replay pins the original trip identity, threshold, and observation", () => {
  const h = harness({ maxToolCalls: 2 });
  try {
    for (const toolCallId of ["one", "two"]) {
      (h.sm as any).onDriverEvent("s_governance", {
        kind: "tool_call", toolCallId, title: "Tool", status: "pending",
      });
    }
    const first = h.sent.find((message) => message.type === "governance_tripped");
    assert.ok(first && first.type === "governance_tripped");
    h.store.patchMeta("s_governance", { config: { maxToolCalls: 50 } });
    h.entry.toolCallIds.add("later");
    h.sm.reportGovernanceTrips();
    const replay = h.sent.filter((message) => message.type === "governance_tripped").at(-1)!;
    assert.deepEqual(replay, first, "reconnect does not reread changed metadata for an old crossing");
  } finally { h.cleanup(); }
});

test("explicit null re-arm clears runner metadata and delivers a prompt queued behind a real trip", async () => {
  const h = harness({ costBudgetUsd: 5, maxToolCalls: 1 });
  try {
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "one", title: "Tool", status: "pending",
    });
    assert.equal(h.entry.governanceTripped, "max_tool_calls");
    h.entry.running = false;
    h.entry.queue.push({ id: "queued", text: "next", images: [] });
    h.sm.rearmGovernance("s_governance", { costBudgetUsd: null, maxToolCalls: null });
    for (let i = 0; i < 20 && h.prompts() === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts(), 1);
    assert.deepEqual(h.store.readMeta("s_governance")!.config, {});
    assert.equal(h.entry.governanceTripped, undefined);
    assert.equal(h.entry.governanceTrip, undefined);
  } finally { h.cleanup(); }
});

test("runner cost gate uses authoritative parentless usage and re-arm clears the hold", () => {
  const h = harness({ costBudgetUsd: 5 });
  try {
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "token_usage", costUsd: 100, parentToolUseId: "subagent",
    });
    assert.equal(h.cancels(), 0, "parented usage is display-only and already included upstream");
    assert.equal(h.store.readMeta("s_governance")!.costUsd, 0);

    (h.sm as any).onDriverEvent("s_governance", { kind: "token_usage", costUsd: 3 });
    assert.equal(h.cancels(), 0);
    (h.sm as any).onDriverEvent("s_governance", { kind: "token_usage", costUsd: 2 });
    assert.equal(h.cancels(), 1);
    assert.equal(h.entry.governanceTripped, "cost_budget");
    assert.equal(h.store.readMeta("s_governance")!.costUsd, 5);

    h.entry.running = false; // cancellation has settled; the normal late-Continue path
    h.sm.rearmGovernance("s_governance", { costBudgetUsd: 10 });
    assert.equal(h.entry.governanceTripped, undefined);
    assert.equal(h.store.readMeta("s_governance")!.config.costBudgetUsd, 10);
    const status = h.sent.filter((message) => message.type === "session_status").at(-1);
    assert.ok(status && status.type === "session_status");
    assert.equal(status.status, "idle");
  } finally {
    h.cleanup();
  }
});

test("runner cancels a Codex turn when the acknowledged priced cost crosses its budget", () => {
  const h = harness({ costBudgetUsd: 0.003 });
  try {
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "token_usage", inputTokens: 1_000, outputTokens: 100, model: "gpt-5.5-codex",
    });
    assert.equal(h.cancels(), 0, "unpriced provider usage cannot trip the local total by itself");

    h.sm.syncPricedSessionCost("s_governance", 0.003);

    assert.equal(h.store.readMeta("s_governance")!.costUsd, 0.003);
    assert.equal(h.cancels(), 1);
    assert.equal(h.entry.governanceTripped, "cost_budget");
    const runtime = h.sent.find((message) => message.type === "session_runtime_updated");
    assert.ok(runtime && runtime.type === "session_runtime_updated");
    assert.equal(runtime.snapshot.costUsd, 0.003, "the runner reports the acknowledged total unchanged");

    h.sm.syncPricedSessionCost("s_governance", 0.004);
    assert.equal(h.cancels(), 1, "later acknowledgements cannot cancel the same turn twice");
  } finally {
    h.cleanup();
  }
});

test("a governance-cancelled prompt settles idle so the control plane can park its policy card", async () => {
  const h = harness({ maxToolCalls: 1 });
  try {
    h.entry.governanceTripped = "max_tool_calls";
    await (h.sm as any).runPrompt("s_governance", "continue work", []);
    const statuses = h.sent.filter((message) => message.type === "session_status");
    assert.equal(statuses.at(-1)?.status, "idle");
    assert.equal(h.store.readMeta("s_governance")!.status, "idle");
  } finally {
    h.cleanup();
  }
});

test("a driver that rejects during governance cancellation still settles idle, not failed", async () => {
  const h = harness({ maxToolCalls: 1 });
  try {
    h.entry.client.prompt = () => Promise.reject(new Error("interrupted"));
    h.entry.governanceTripped = "max_tool_calls";
    await (h.sm as any).runPrompt("s_governance", "continue work", []);
    const statuses = h.sent.filter((message) => message.type === "session_status");
    assert.equal(statuses.at(-1)?.status, "idle");
    assert.equal(h.sent.some(
      (message) => message.type === "session_event" && message.payload.kind === "error",
    ), false);
  } finally {
    h.cleanup();
  }
});

test("invalid re-arm thresholds fail closed without releasing the hold", () => {
  const h = harness({ maxToolCalls: 1 });
  try {
    h.entry.governanceTripped = "max_tool_calls";
    h.sm.rearmGovernance("s_governance", {});
    assert.equal(h.entry.governanceTripped, "max_tool_calls");
    h.sm.rearmGovernance("s_governance", { maxToolCalls: 0 });
    assert.equal(h.entry.governanceTripped, "max_tool_calls");
    assert.equal(h.store.readMeta("s_governance")!.config.maxToolCalls, 1);
  } finally {
    h.cleanup();
  }
});

test("re-arm never emits an idle status while an untripped turn is still running", () => {
  const h = harness({});
  try {
    assert.equal(h.entry.running, true);
    assert.equal(h.entry.governanceTripped, undefined);
    h.sm.rearmGovernance("s_governance", { costBudgetUsd: 10 });
    assert.equal(h.store.readMeta("s_governance")!.config.costBudgetUsd, 10);
    assert.equal(h.sent.some((message) => message.type === "session_status"), false);
    assert.equal(h.entry.governanceTripped, undefined);
  } finally {
    h.cleanup();
  }
});

test("live threshold synchronization preserves an unrelated turn-interruption hold", () => {
  const h = harness({});
  try {
    h.entry.activeTurnId = "turn-live";
    assert.equal(h.sm.interruptTurn("s_governance", "turn-live"), "applied");
    assert.equal(h.entry.interruptRequested, true);
    assert.equal(h.entry.holdQueuedPromptsAfterInterrupt, true);

    h.sm.rearmGovernance("s_governance", { costBudgetUsd: 10 });

    assert.equal(h.store.readMeta("s_governance")!.config.costBudgetUsd, 10);
    assert.equal(h.entry.interruptRequested, true);
    assert.equal(h.entry.holdQueuedPromptsAfterInterrupt, true);
  } finally {
    h.cleanup();
  }
});

test("held queued prompts resume only after a valid re-arm", async () => {
  const h = harness({ maxToolCalls: 1 });
  try {
    h.entry.running = false;
    h.entry.governanceTripped = "max_tool_calls";
    h.entry.queue.push({ id: "queued", text: "next", images: [] });
    void (h.sm as any).drain("s_governance");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts(), 0, "the held queue does not self-resume");

    h.sm.rearmGovernance("s_governance", { maxToolCalls: 2 });
    for (let i = 0; i < 20 && h.prompts() === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(h.prompts(), 1);
    assert.equal(h.entry.queue.length, 0);
  } finally {
    h.cleanup();
  }
});

test("an early Continue cannot clear the trip while driver cancellation is still unwinding", async () => {
  const h = harness({ costBudgetUsd: 5 });
  try {
    let resolveFirst!: (reason: "cancelled") => void;
    let promptCalls = 0;
    h.entry.client.prompt = () => {
      promptCalls += 1;
      if (promptCalls === 1) {
        return new Promise<"cancelled">((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve("end_turn" as const);
    };
    h.entry.running = false;
    h.entry.queue.push(
      { id: "first", text: "first", images: [] },
      { id: "second", text: "second", images: [] },
    );
    void (h.sm as any).drain("s_governance");
    for (let i = 0; i < 20 && promptCalls === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promptCalls, 1);

    (h.sm as any).onDriverEvent("s_governance", { kind: "token_usage", costUsd: 5 });
    assert.equal(h.entry.governanceTripped, "cost_budget");
    h.sm.rearmGovernance("s_governance", { costBudgetUsd: 10 });
    assert.equal(h.entry.governanceTripped, "cost_budget", "release waits for the cancelled turn to settle");
    assert.equal(h.entry.governanceRearmPending, "resume");

    resolveFirst("cancelled");
    for (let i = 0; i < 50 && promptCalls < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promptCalls, 2, "the held queue resumes after cancellation and lock release");
    assert.equal(h.entry.governanceTripped, undefined);
    assert.equal(h.entry.governanceRearmPending, undefined);
  } finally {
    h.cleanup();
  }
});

test("serialized policy re-arm updates held queue configs without resuming the next tripped rule", async () => {
  const h = harness({ costBudgetUsd: 5, maxToolCalls: 1 });
  try {
    h.entry.running = false;
    h.entry.governanceTripped = "cost_budget";
    h.entry.queue.push({
      id: "held",
      text: "next",
      images: [],
      config: { costBudgetUsd: 5, maxToolCalls: 1 },
    });

    h.sm.rearmGovernance("s_governance", { costBudgetUsd: 10 }, "max_tool_calls");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts(), 0);
    assert.equal(h.entry.governanceTripped, "max_tool_calls");
    assert.deepEqual(h.entry.queue[0]!.config, { costBudgetUsd: 10, maxToolCalls: 1 });

    h.sm.rearmGovernance("s_governance", { maxToolCalls: 2 });
    for (let i = 0; i < 20 && h.prompts() === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts(), 1);
    assert.deepEqual(h.store.readMeta("s_governance")!.config, { costBudgetUsd: 10, maxToolCalls: 2 });
  } finally {
    h.cleanup();
  }
});
