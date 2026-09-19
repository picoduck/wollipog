import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type RunnerToControlPlane, type SessionConfig } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { claudeProjectPathKey } from "./claude-background-work.js";

function meta(config: SessionConfig, appServer = false): SessionMeta {
  return {
    sessionId: "s_governance",
    agentId: appServer ? "codex-app-server" : "claude-native",
    workspaceId: "repo",
    repoPath: "/repo",
    worktreePath: null,
    driver: appServer ? "codex-app-server" : "claude-code",
    command: appServer ? "codex" : "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: appServer ? "thread-exact" : null,
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

function harness(config: SessionConfig, appServer = false) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-governance-"));
  const store = new SessionStore(root);
  store.create(meta(config, appServer));
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
    agentSessionId: () => appServer ? "thread-exact" : null,
    agentTurnId: () => appServer ? "provider-turn-exact" : null,
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
    activeTurnId: appServer ? "turn-exact" : undefined,
    queue: [],
    toolCallIds: config.maxToolCalls ? new Set<string>() : undefined,
    policyHookToolCallIds: new Set<string>(),
    policyHookDecisionEvents: new Map(),
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

test("App Server action admission distinguishes the runner turn from the provider turn", () => {
  const h = harness({}, true);
  try {
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "old-command", title: "Run", status: "in_progress",
    });
    const recorded = h.sm.recordWorkflowActionAdmission("s_governance", {
      occurrenceId: "workflow-exact",
      commandDigest: "a".repeat(64),
      sessionTurnId: "turn-exact",
    });
    assert.deepEqual(recorded, {
      accepted: true,
      occurrenceId: "workflow-exact",
      sessionTurnId: "turn-exact",
      providerTurnId: "provider-turn-exact",
      providerThreadId: "thread-exact",
      historyEpoch: 0,
      eventSeq: 2,
    });
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "fresh-command", title: "Run", status: "in_progress",
    });
    assert.deepEqual(h.store.readEvents("s_governance").map((event) => ({
      seq: event.seq,
      kind: event.payload.kind,
    })), [
      { seq: 1, kind: "tool_call" },
      { seq: 2, kind: "workflow_action_admission_armed" },
      { seq: 3, kind: "tool_call" },
    ]);
    assert.equal(h.sm.recordWorkflowActionAdmission("s_governance", {
      occurrenceId: "workflow-stale-turn",
      commandDigest: "b".repeat(64),
      sessionTurnId: "turn-stale",
    }).accepted, false, "a control-plane turn projection cannot override the runner's active turn");
  } finally {
    h.cleanup();
  }
});

test("retroactive action reconciliation binds exact provider admission, command, and forge evidence", async () => {
  const h = harness({}, true);
  try {
    const command = `gh pr merge https://github.com/picoduck/wollipog/pull/1146 --squash --match-head-commit ${"a".repeat(40)}`;
    (h.entry.client as any).reconcileCompletedCommand = async (occurrenceId: string, candidate: string) =>
      occurrenceId === "workflow-history" && candidate === command ? {
        commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
        providerThreadId: "thread-exact",
        providerTurnId: "turn-history",
        providerAdmissionItemId: "admission-history",
        providerItemId: "command-history",
      } : null;
    (h.sm as any).resolveWorktreePullRequestState = async (path: string, url: string) => {
      assert.equal(path, "/repo");
      assert.equal(url, "https://github.com/picoduck/wollipog/pull/1146");
      return { state: "merged", headOid: "a".repeat(40) };
    };
    assert.deepEqual(await h.sm.reconcileWorkflowAction("s_governance", {
      occurrenceId: "workflow-history",
      command,
      commandDigest: "b".repeat(64),
      pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1146",
      expectedHeadSha: "a".repeat(40),
    }), {
      accepted: true,
      occurrenceId: "workflow-history",
      commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
      providerThreadId: "thread-exact",
      providerTurnId: "turn-history",
      providerAdmissionItemId: "admission-history",
      providerItemId: "command-history",
      forgeHeadSha: "a".repeat(40),
    });
  } finally {
    h.cleanup();
  }
});

test("retroactive action reconciliation binds a CLI arm to its later durable Guardian receipt", async () => {
  const h = harness({}, true);
  try {
    const command = `gh pr merge https://github.com/picoduck/wollipog/pull/1162 --squash --match-head-commit ${"c".repeat(40)}`;
    const commandDigest = createHash("sha256").update(command, "utf8").digest("hex");
    const arm = h.store.appendEvent("s_governance", {
      kind: "workflow_action_admission_armed",
      occurrenceId: "workflow-cli",
      commandDigest: "d".repeat(64),
      sessionTurnId: "session-turn-cli",
      providerTurnId: "legacy-session-turn-stored-as-provider",
    });
    assert.ok(arm);
    h.store.appendEvent("s_governance", {
      kind: "tool_call",
      toolCallId: "command-cli",
      title: "merge",
      toolKind: "execute",
      status: "in_progress",
    });
    const receipt = h.store.appendEvent("s_governance", {
      kind: "review_decision",
      reviewId: "review-cli",
      reviewer: { kind: "agent", id: "codex-guardian" },
      outcome: "allowed",
      approvalReviewReceipt: {
        transport: "codex-app-server",
        threadId: "thread-exact",
        turnId: "provider-turn-cli",
        itemId: "command-cli",
        toolName: "commandExecution",
        input: command,
        inputSha256: commandDigest,
      },
    });
    assert.ok(receipt);
    (h.entry.client as any).reconcileCompletedCommand = async (
      occurrenceId: string,
      candidate: string,
      fence: unknown,
    ) => {
      assert.equal(occurrenceId, "workflow-cli");
      assert.equal(candidate, command);
      assert.deepEqual(fence, {
        providerThreadId: "thread-exact",
        providerTurnId: "provider-turn-cli",
        providerItemId: "command-cli",
      });
      return {
        commandDigest,
        providerThreadId: "thread-exact",
        providerTurnId: "provider-turn-cli",
        providerItemId: "command-cli",
      };
    };
    (h.sm as any).resolveWorktreePullRequestState = async () => ({
      state: "merged", headOid: "c".repeat(40),
    });
    assert.deepEqual(await h.sm.reconcileWorkflowAction("s_governance", {
      occurrenceId: "workflow-cli",
      command,
      commandDigest: "d".repeat(64),
      pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1162",
      expectedHeadSha: "c".repeat(40),
      armedAfterEventSeq: arm.seq,
      runnerHistoryEpoch: 0,
      actionProviderThreadId: "thread-exact",
      actionProviderTurnId: "legacy-session-turn-stored-as-provider",
    }), {
      accepted: true,
      occurrenceId: "workflow-cli",
      commandDigest,
      providerThreadId: "thread-exact",
      providerTurnId: "provider-turn-cli",
      providerItemId: "command-cli",
      runnerHistoryEpoch: 0,
      armedAfterEventSeq: arm.seq,
      providerReviewEventSeq: receipt.seq,
      forgeHeadSha: "c".repeat(40),
    });
  } finally {
    h.cleanup();
  }
});

test("durable command completion survives provider history loss after restart", async () => {
  const h = harness({}, true);
  try {
    const command = `gh pr merge https://github.com/picoduck/wollipog/pull/1165 --squash --match-head-commit ${"c".repeat(40)}`;
    const commandDigest = createHash("sha256").update(command, "utf8").digest("hex");
    const arm = h.store.appendEvent("s_governance", {
      kind: "workflow_action_admission_armed",
      occurrenceId: "workflow-restarted",
      commandDigest: "d".repeat(64),
      sessionTurnId: "session-turn-cli",
      providerTurnId: "provider-turn-before-restart",
    });
    assert.ok(arm);
    h.store.appendEvent("s_governance", {
      kind: "tool_call",
      toolCallId: "command-cli",
      title: "merge",
      toolKind: "execute",
      status: "in_progress",
    });
    const receipt = h.store.appendEvent("s_governance", {
      kind: "review_decision",
      reviewId: "review-cli",
      reviewer: { kind: "agent", id: "codex-guardian" },
      outcome: "allowed",
      approvalReviewReceipt: {
        transport: "codex-app-server",
        threadId: "thread-exact",
        turnId: "provider-turn-cli",
        itemId: "command-cli",
        toolName: "commandExecution",
        input: command,
        inputSha256: commandDigest,
      },
    });
    assert.ok(receipt);
    const completion = h.store.appendEvent("s_governance", {
      kind: "tool_call_update",
      toolCallId: "command-cli",
      status: "completed",
    });
    assert.ok(completion);
    (h.entry.client as any).reconcileCompletedCommand = async () => null;
    (h.sm as any).resolveWorktreePullRequestState = async () => ({
      state: "merged", headOid: "c".repeat(40),
    });

    const result = await h.sm.reconcileWorkflowAction("s_governance", {
      occurrenceId: "workflow-restarted",
      command,
      commandDigest: "d".repeat(64),
      pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1165",
      expectedHeadSha: "c".repeat(40),
      armedAfterEventSeq: arm.seq,
      runnerHistoryEpoch: 0,
      actionProviderThreadId: "thread-exact",
      actionProviderTurnId: "provider-turn-before-restart",
    });
    assert.equal(result.accepted, true);
    assert.equal(result.providerItemId, "command-cli");
    assert.equal(result.providerReviewEventSeq, receipt.seq);
    assert.equal(result.providerCompletionEventSeq, completion.seq);
  } finally {
    h.cleanup();
  }
});

test("retained PR #1165 receipt resolves projected runner history coordinates", async () => {
  const h = harness({}, true);
  try {
    const command = "gh pr merge https://github.com/picoduck/wollipog/pull/1165 --squash " +
      "--match-head-commit 741a0563a21c25b59560e75ef846dc5c4f3dcc64";
    const commandDigest = createHash("sha256").update(command, "utf8").digest("hex");
    const arm = h.store.appendEvent("s_governance", {
      kind: "workflow_action_admission_armed",
      occurrenceId: "workflow-retained-1165",
      commandDigest,
      sessionTurnId: "session-turn-retained",
      providerTurnId: "app-server-request-retained",
    });
    assert.ok(arm);
    h.store.appendEvent("s_governance", {
      kind: "tool_call",
      toolCallId: "command-retained",
      title: "merge",
      toolKind: "execute",
      status: "in_progress",
    });
    const receipt = h.store.appendEvent("s_governance", {
      kind: "review_decision",
      reviewId: "review-retained",
      reviewer: { kind: "agent", id: "codex-guardian" },
      outcome: "allowed",
      approvalReviewReceipt: {
        transport: "codex-app-server",
        threadId: "thread-exact",
        turnId: "provider-turn-retained",
        itemId: "command-retained",
        toolName: "commandExecution",
        input: command,
        inputSha256: commandDigest,
      },
    });
    assert.ok(receipt);
    const completion = h.store.appendEvent("s_governance", {
      kind: "tool_call_update",
      toolCallId: "command-retained",
      status: "completed",
    });
    assert.ok(completion);
    (h.entry.client as any).reconcileCompletedCommand = async () => null;
    (h.sm as any).resolveWorktreePullRequestState = async () => ({
      state: "merged", headOid: "741a0563a21c25b59560e75ef846dc5c4f3dcc64",
    });

    const result = await h.sm.reconcileWorkflowAction("s_governance", {
      occurrenceId: "workflow-retained-1165",
      command,
      commandDigest,
      pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1165",
      expectedHeadSha: "741a0563a21c25b59560e75ef846dc5c4f3dcc64",
      armedAfterEventSeq: h.store.projectedEventSeq("s_governance", arm.seq, PROTOCOL_VERSION),
      runnerHistoryEpoch: h.store.projectedHistoryEpoch(0, PROTOCOL_VERSION),
      actionProviderThreadId: "thread-exact",
      actionProviderTurnId: "app-server-request-retained",
    }, PROTOCOL_VERSION);
    assert.equal(result.accepted, true);
    assert.equal(result.providerItemId, "command-retained");
    assert.equal(result.providerReviewEventSeq,
      h.store.projectedEventSeq("s_governance", receipt.seq, PROTOCOL_VERSION));
    assert.equal(result.providerCompletionEventSeq,
      h.store.projectedEventSeq("s_governance", completion.seq, PROTOCOL_VERSION));
  } finally {
    h.cleanup();
  }
});

test("durable command completion rejects missing starts and missing, failed, misordered, or replayed terminals", async () => {
  const command = `gh pr merge https://github.com/picoduck/wollipog/pull/1165 --squash --match-head-commit ${"c".repeat(40)}`;
  const commandDigest = createHash("sha256").update(command, "utf8").digest("hex");
  for (const mismatch of ["start", "missing", "failed", "order", "duplicate"] as const) {
    const h = harness({}, true);
    try {
      const arm = h.store.appendEvent("s_governance", {
        kind: "workflow_action_admission_armed",
        occurrenceId: "workflow-restarted",
        commandDigest: "d".repeat(64),
        sessionTurnId: "session-turn-cli",
        providerTurnId: "provider-turn-before-restart",
      });
      assert.ok(arm);
      const terminal = (status: "completed" | "failed") => h.store.appendEvent("s_governance", {
        kind: "tool_call_update" as const,
        toolCallId: "command-cli",
        status,
      });
      if (mismatch === "order") terminal("completed");
      if (mismatch !== "start") {
        h.store.appendEvent("s_governance", {
          kind: "tool_call",
          toolCallId: "command-cli",
          title: "merge",
          toolKind: "execute",
          status: "in_progress",
        });
      }
      h.store.appendEvent("s_governance", {
        kind: "review_decision",
        reviewId: "review-cli",
        reviewer: { kind: "agent", id: "codex-guardian" },
        outcome: "allowed",
        approvalReviewReceipt: {
          transport: "codex-app-server",
          threadId: "thread-exact",
          turnId: "provider-turn-cli",
          itemId: "command-cli",
          toolName: "commandExecution",
          input: command,
          inputSha256: commandDigest,
        },
      });
      if (mismatch === "failed") terminal("failed");
      if (mismatch === "start") terminal("completed");
      if (mismatch === "duplicate") {
        terminal("completed");
        terminal("completed");
      }
      (h.entry.client as any).reconcileCompletedCommand = async () => null;
      (h.sm as any).resolveWorktreePullRequestState = async () => ({
        state: "merged", headOid: "c".repeat(40),
      });
      const result = await h.sm.reconcileWorkflowAction("s_governance", {
        occurrenceId: "workflow-restarted",
        command,
        commandDigest: "d".repeat(64),
        pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1165",
        expectedHeadSha: "c".repeat(40),
        armedAfterEventSeq: h.store.projectedEventSeq("s_governance", arm.seq, PROTOCOL_VERSION),
        runnerHistoryEpoch: h.store.projectedHistoryEpoch(0, PROTOCOL_VERSION),
        actionProviderThreadId: "thread-exact",
        actionProviderTurnId: "provider-turn-before-restart",
      }, PROTOCOL_VERSION);
      assert.equal(result.accepted, false, mismatch);
      assert.equal(result.error, "provider history did not contain one exact successful command");
    } finally {
      h.cleanup();
    }
  }
});

test("durable reconciliation rejects missing, misordered, duplicated, and cross-epoch receipts", async () => {
  const command = `gh pr merge https://github.com/picoduck/wollipog/pull/1162 --squash --match-head-commit ${"c".repeat(40)}`;
  const commandDigest = createHash("sha256").update(command, "utf8").digest("hex");
  for (const mismatch of ["missing", "order", "duplicate", "intervening", "epoch"] as const) {
    const h = harness({}, true);
    try {
      const appendReceipt = () => h.store.appendEvent("s_governance", {
        kind: "review_decision" as const,
        reviewId: `review-cli-${mismatch}-${h.store.readEvents("s_governance").length}`,
        reviewer: { kind: "agent" as const, id: "codex-guardian" },
        outcome: "allowed" as const,
        approvalReviewReceipt: {
          transport: "codex-app-server" as const,
          threadId: "thread-exact",
          turnId: "provider-turn-cli",
          itemId: "command-cli",
          toolName: "commandExecution" as const,
          input: command,
          inputSha256: commandDigest,
        },
      });
      if (mismatch === "order") appendReceipt();
      const arm = h.store.appendEvent("s_governance", {
        kind: "workflow_action_admission_armed",
        occurrenceId: "workflow-cli",
        commandDigest: "d".repeat(64),
        sessionTurnId: "session-turn-cli",
        providerTurnId: "legacy-session-turn-stored-as-provider",
      });
      assert.ok(arm);
      if (mismatch === "intervening") {
        h.store.appendEvent("s_governance", {
          kind: "workflow_action_admission_armed",
          occurrenceId: "workflow-cli-newer",
          commandDigest: "d".repeat(64),
          sessionTurnId: "session-turn-cli",
          providerTurnId: "legacy-session-turn-stored-as-provider",
        });
      }
      if (mismatch !== "missing" && mismatch !== "order") appendReceipt();
      if (mismatch === "duplicate") appendReceipt();
      let receivedFence: unknown = "not-called";
      (h.entry.client as any).reconcileCompletedCommand = async (
        _occurrenceId: string,
        _candidate: string,
        fence: unknown,
      ) => {
        receivedFence = fence;
        return {
          commandDigest,
          providerThreadId: "thread-exact",
          providerTurnId: "provider-turn-cli",
          providerItemId: "command-cli",
        };
      };
      (h.sm as any).resolveWorktreePullRequestState = async () => ({
        state: "merged", headOid: "c".repeat(40),
      });
      const result = await h.sm.reconcileWorkflowAction("s_governance", {
        occurrenceId: "workflow-cli",
        command,
        commandDigest: "d".repeat(64),
        pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1162",
        expectedHeadSha: "c".repeat(40),
        armedAfterEventSeq: h.store.projectedEventSeq("s_governance", arm.seq, PROTOCOL_VERSION),
        runnerHistoryEpoch: mismatch === "epoch"
          ? h.store.projectedHistoryEpoch(0, PROTOCOL_VERSION) + 1
          : h.store.projectedHistoryEpoch(0, PROTOCOL_VERSION),
        actionProviderThreadId: "thread-exact",
        actionProviderTurnId: "legacy-session-turn-stored-as-provider",
      }, PROTOCOL_VERSION);
      assert.equal(result.accepted, false, `${mismatch} must fail closed`);
      if (mismatch === "epoch") {
        assert.equal(result.error, "reconciliation runner fence is stale or mismatched");
        assert.equal(receivedFence, "not-called", "a stale projected epoch cannot consult provider history");
      } else {
        assert.equal(receivedFence, undefined, `${mismatch} cannot mint a runner receipt fence`);
      }
    } finally {
      h.cleanup();
    }
  }
});

test("retroactive action reconciliation fails closed without each independent proof", async () => {
  const command = `gh pr merge https://github.com/picoduck/wollipog/pull/1146 --squash --match-head-commit ${"a".repeat(40)}`;
  for (const mismatch of ["provider", "forge"] as const) {
    const h = harness({}, true);
    try {
      (h.entry.client as any).reconcileCompletedCommand = async () => mismatch === "provider" ? null : {
        commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
        providerThreadId: "thread-exact",
        providerTurnId: "turn-history",
        providerAdmissionItemId: "admission-history",
        providerItemId: "command-history",
      };
      (h.sm as any).resolveWorktreePullRequestState = async () => mismatch === "forge"
        ? { state: "merged", headOid: "f".repeat(40) }
        : { state: "merged", headOid: "a".repeat(40) };
      const result = await h.sm.reconcileWorkflowAction("s_governance", {
        occurrenceId: `workflow-${mismatch}`,
        command,
        commandDigest: "b".repeat(64),
        pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1146",
        expectedHeadSha: "a".repeat(40),
      });
      assert.equal(result.accepted, false, `${mismatch} cannot reconcile`);
    } finally {
      h.cleanup();
    }
  }
});

test("Claude Code reconciliation proves the merge from the forge alone, even after the session ended", async () => {
  const h = harness({});
  try {
    (h.sm as any).active.delete("s_governance");
    const meta = h.store.readMeta("s_governance")!;
    (h.store as any).writeMeta({ ...meta, worktreePath: "/reclaimed-worktree" });
    const command = `gh pr merge https://github.com/picoduck/wollipog/pull/1351 --squash --match-head-commit ${"a".repeat(40)}`;
    const request = {
      occurrenceId: "workflow-claude",
      command,
      commandDigest: "b".repeat(64),
      pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1351",
      expectedHeadSha: "a".repeat(40),
    };
    const reads: string[] = [];
    let forge: { state: string; headOid: string } | null = { state: "merged", headOid: "A".repeat(40) };
    (h.sm as any).resolveWorktreePullRequestState = async (path: string, url: string) => {
      assert.equal(url, request.pullRequestUrl);
      reads.push(path);
      return path === "/reclaimed-worktree" ? null : forge;
    };
    assert.deepEqual(await h.sm.reconcileWorkflowAction("s_governance", request), {
      accepted: true,
      occurrenceId: "workflow-claude",
      commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
      forgeHeadSha: "a".repeat(40),
    });
    assert.deepEqual(reads, ["/reclaimed-worktree", "/repo"], "a reclaimed worktree falls back to the repository");

    for (const unproven of [
      { state: "open", headOid: "a".repeat(40) },
      { state: "merged", headOid: "f".repeat(40) },
      null,
    ]) {
      forge = unproven;
      assert.equal((await h.sm.reconcileWorkflowAction("s_governance", request)).accepted, false,
        `${JSON.stringify(unproven)} is not proof of the approved merge`);
    }
    forge = { state: "merged", headOid: "a".repeat(40) };
    const fenced = await h.sm.reconcileWorkflowAction("s_governance", {
      ...request,
      armedAfterEventSeq: 1,
      runnerHistoryEpoch: 0,
      actionProviderThreadId: "thread",
      actionProviderTurnId: "turn",
    });
    assert.equal(fenced.accepted, false, "an App Server fence never applies to a Claude Code session");
  } finally {
    h.cleanup();
  }
});

test("retroactive action reconciliation requires the original App Server thread after restart", async () => {
  const h = harness({}, true);
  try {
    (h.sm as any).active.delete("s_governance");
    const result = await h.sm.reconcileWorkflowAction("s_governance", {
      occurrenceId: "workflow-after-restart",
      command: `gh pr merge https://github.com/picoduck/wollipog/pull/1146 --squash --match-head-commit ${"a".repeat(40)}`,
      commandDigest: "b".repeat(64),
      pullRequestUrl: "https://github.com/picoduck/wollipog/pull/1146",
      expectedHeadSha: "a".repeat(40),
    });
    assert.equal(result.accepted, false);
    assert.match(result.error ?? "", /resume it before reconciliation/u);
  } finally {
    h.cleanup();
  }
});

test("policy-hook decisions wait for their exact buffered tool event and deduplicate by audit id", async () => {
  const h = harness({});
  try {
    const decision = {
      auditId: "audit-exact",
      requestId: "policy-hook:s_governance:exact",
      stage: "resolution",
      outcome: "allowed",
      actor: { kind: "human", id: "device-1" },
      governancePolicyId: "policy-1",
      toolCallId: "tool-exact",
    };
    const pending = h.sm.recordPolicyHookDecision("s_governance", decision);
    const joinedRetry = h.sm.recordPolicyHookDecision("s_governance", decision);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.store.readEvents("s_governance").length, 0, "the decision cannot race ahead of a buffered tool");

    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "tool-other", title: "Read", status: "pending",
    });
    assert.equal(h.store.readEvents("s_governance").length, 1, "an unrelated tool id cannot release the fence");
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: "tool-exact", title: "Write", status: "pending",
    });

    const recorded = await pending;
    assert.deepEqual(recorded, { accepted: true, auditId: "audit-exact", eventSeq: 3 });
    assert.deepEqual(await joinedRetry, recorded, "a concurrent retry joins the same causal append");
    assert.deepEqual(h.store.readEvents("s_governance").map((event) => event.payload.kind), [
      "tool_call", "tool_call", "policy_hook_decision",
    ]);
    const replay = await h.sm.recordPolicyHookDecision("s_governance", decision);
    assert.deepEqual(replay, recorded, "a lost acknowledgement cannot append the same audit twice");
    const conflict = await h.sm.recordPolicyHookDecision("s_governance", { ...decision, outcome: "denied" });
    assert.equal(conflict.accepted, false);
    assert.match(conflict.error ?? "", /conflicts/);
  } finally {
    h.cleanup();
  }
});

test("policy-hook causal and dedup indexes survive more than the bounded recovery scan in one turn", async () => {
  const h = harness({});
  try {
    const decision = {
      auditId: "audit-noisy-turn",
      requestId: "policy-hook:s_governance:noisy-turn",
      stage: "resolution",
      outcome: "allowed",
      actor: { kind: "policy", id: "allow-noisy" },
      toolCallId: "tool-noisy-turn",
    };
    (h.sm as any).onDriverEvent("s_governance", {
      kind: "tool_call", toolCallId: decision.toolCallId, title: "Read", status: "pending",
    });
    for (let index = 0; index < 501; index += 1) {
      (h.sm as any).onDriverEvent("s_governance", { kind: "agent_message", text: `before-${index}` });
    }
    const readEvents = h.store.readEvents.bind(h.store);
    let fullHistoryReads = 0;
    (h.store as any).readEvents = (...args: Parameters<SessionStore["readEvents"]>) => {
      fullHistoryReads += 1;
      return readEvents(...args);
    };
    const recorded = await h.sm.recordPolicyHookDecision("s_governance", decision);
    assert.equal(recorded.accepted, true, "the exact turn index retains an old matching tool call");
    for (let index = 0; index < 501; index += 1) {
      (h.sm as any).onDriverEvent("s_governance", { kind: "agent_message", text: `after-${index}` });
    }
    assert.deepEqual(
      await h.sm.recordPolicyHookDecision("s_governance", decision),
      recorded,
      "the exact turn index deduplicates an acknowledgement after its event leaves the recovery scan",
    );
    assert.equal(fullHistoryReads, 0, "the governed hot path never parses the whole durable history");
    assert.equal(readEvents("s_governance")
      .filter((event) => event.payload.kind === "policy_hook_decision").length, 1);
  } finally {
    h.cleanup();
  }
});

test("policy-hook restart recovery uses the indexed bounded page instead of a full-history scan", async () => {
  const h = harness({});
  try {
    h.store.appendEvent("s_governance", {
      kind: "tool_call", toolCallId: "tool-recovered", title: "Read", status: "pending",
    });
    h.store.flushAll();
    h.entry.policyHookToolCallIds = undefined;
    h.entry.policyHookDecisionEvents = undefined;
    (h.store as any).readEvents = () => { throw new Error("full history scan is forbidden"); };
    const recorded = await h.sm.recordPolicyHookDecision("s_governance", {
      auditId: "audit-recovered",
      requestId: "policy-hook:s_governance:recovered",
      stage: "resolution",
      outcome: "denied",
      actor: { kind: "policy", id: "deny-recovered" },
      toolCallId: "tool-recovered",
    });
    assert.deepEqual(recorded, { accepted: true, auditId: "audit-recovered", eventSeq: 2 });
  } finally {
    h.cleanup();
  }
});

test("a policy-hook decision times out when its matching tool event never arrives", async () => {
  const h = harness({});
  try {
    const recorded = await h.sm.recordPolicyHookDecision("s_governance", {
      auditId: "audit-aborted",
      requestId: "policy-hook:s_governance:aborted",
      stage: "resolution",
      outcome: "aborted",
      actor: { kind: "system", id: "policy-hook-abandoned" },
      toolCallId: "tool-never-observed",
    });
    assert.deepEqual(recorded, {
      accepted: false,
      auditId: "audit-aborted",
      error: "matching tool event was not observed",
    });
    assert.equal(h.store.readEvents("s_governance").length, 0);
  } finally {
    h.cleanup();
  }
});

test("policy-hook decision append rejects fields outside the content-safe protocol subset", async () => {
  const h = harness({});
  try {
    const rejected = await h.sm.recordPolicyHookDecision("s_governance", {
      auditId: "audit-unsafe",
      requestId: "request-unsafe",
      stage: "resolution",
      outcome: "denied",
      actor: { kind: "policy" },
      toolCallId: "tool-unsafe",
      toolInput: { secret: true },
    });
    assert.equal(rejected.accepted, false);
    assert.match(rejected.error ?? "", /unsafe fields/);
    assert.equal(h.store.readEvents("s_governance").length, 0);
  } finally {
    h.cleanup();
  }
});

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

test("idle threshold synchronization preserves a provider-owned approval status", () => {
  const h = harness({});
  try {
    h.entry.running = false;
    h.store.patchMeta("s_governance", {
      status: "input_required",
      pendingApproval: {
        requestId: "question-live",
        kind: "question",
        title: "Choose a target",
        options: [],
      },
    });

    h.sm.rearmGovernance("s_governance", { costBudgetUsd: 10 });

    const statuses = h.sent.filter((message) => message.type === "session_status");
    assert.equal(statuses.at(-1)?.status, "input_required");
    assert.equal(h.store.readMeta("s_governance")!.status, "input_required");
    assert.equal(h.store.readMeta("s_governance")!.pendingApproval?.requestId, "question-live");
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
