import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec } from "@wollipog/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AcpDriver } from "./drivers/acp-driver.js";
import type { DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { SessionManager, worktreeContinuationPrompt } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import type { AgentProcess } from "./spawn.js";

function haveGit(): boolean {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, message: string, attempts = 800): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

interface FakeAcpProcess {
  child: AgentProcess;
  cwd: string;
  prompts: string[];
  disposed: boolean;
  sendUpdate: (update: Record<string, unknown>) => void;
  respondPrompt: (stopReason?: string) => void;
  respondPromptError: (message: string, code?: number) => void;
  hasPendingPrompt: () => boolean;
}

function fakeAcpFactory(options: {
  autoRespond?: (launch: number, promptText: string) => boolean;
  providerTurnSettleMs?: number;
  providerTurnResponseSettleMs?: number;
} = {}) {
  const processes: FakeAcpProcess[] = [];
  const factory = (_driver: unknown, opts: DriverOptions, cb: DriverCallbacks) => {
    const launchIndex = processes.length + 1;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      pid: 10_000 + launchIndex,
      posixBoundary: { owner: undefined, terminate: async () => true },
    }) as unknown as AgentProcess;
    let sessionId = `acp-session-${launchIndex}`;
    let pendingPromptId: number | null = null;
    const proc: FakeAcpProcess = {
      child,
      cwd: opts.cwd,
      prompts: [],
      disposed: false,
      sendUpdate: (update) => {
        stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        }) + "\n");
      },
      respondPrompt: (stopReason = "end_turn") => {
        assert.notEqual(pendingPromptId, null, "no prompt is waiting for a response");
        const id = pendingPromptId!;
        pendingPromptId = null;
        stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason } }) + "\n");
      },
      respondPromptError: (message: string, code = -32000) => {
        assert.notEqual(pendingPromptId, null, "no prompt is waiting for a response");
        const id = pendingPromptId!;
        pendingPromptId = null;
        stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
      },
      hasPendingPrompt: () => pendingPromptId !== null,
    };
    processes.push(proc);

    let buffer = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        if (msg.method === "initialize" && msg.id !== undefined) {
          stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { sessionCapabilities: { resume: {} } },
              agentInfo: { name: "fake-acp", version: "1.0.0" },
            },
          }) + "\n");
        } else if ((msg.method === "session/new" || msg.method === "session/resume") && msg.id !== undefined) {
          if (msg.method === "session/resume" && typeof msg.params?.sessionId === "string") {
            sessionId = msg.params.sessionId;
          }
          stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId },
          }) + "\n");
        } else if (msg.method === "session/prompt" && msg.id !== undefined) {
          const blocks = (msg.params?.prompt as Array<{ text?: string }> | undefined) ?? [];
          const text = blocks.map((block) => block.text ?? "").join("\n");
          proc.prompts.push(text);
          pendingPromptId = msg.id;
          if (options.autoRespond?.(launchIndex, text) !== false) {
            proc.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok:${launchIndex}` } });
            proc.respondPrompt("end_turn");
          }
        }
      }
    });

    return new AcpDriver(opts, cb, {
      spawn: () => child,
      kill: () => {
        proc.disposed = true;
        child.emit("close", 0, null);
      },
      providerTurnSettleMs: options.providerTurnSettleMs ?? 90,
      providerTurnResponseSettleMs: options.providerTurnResponseSettleMs ?? 45,
    });
  };
  return { factory, processes };
}

function acpSpec(sessionId: string, repo: string): SessionLaunchSpec {
  return {
    sessionId,
    workspaceId: "repo",
    workspacePath: repo,
    agentId: "fake-acp",
    command: "fake-acp",
    args: [],
    env: {},
    useWorktree: false,
    driver: "acp",
    context: { kind: "native" },
  };
}

test("unsolicited post-end_turn ACP wakeup keeps session running, defers worktree rebind until wakeup settles, then relaunches cleanly (#4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-rebind-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    const fake = fakeAcpFactory({ providerTurnSettleMs: 90, providerTurnResponseSettleMs: 45 });
    manager = new SessionManager((msg) => { sent.push(msg); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_rebind";
    const externalWorktree = join(root, "wt-acp-wakeup");
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "fix/acp-wakeup", externalWorktree, "HEAD"]);
    await manager.start(acpSpec(sessionId, repo));
    const internals = manager as unknown as {
      active: Map<string, { managedGitBoundary?: true; providerInitiatedTurnActive?: boolean }>;
      configuredProjectPaths: string[];
    };
    internals.configuredProjectPaths = [repo];
    internals.active.get(sessionId)!.managedGitBoundary = true;

    // 1. Complete turn 1 normally so the session becomes idle.
    manager.prompt(sessionId, "start background command");
    await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.processes[0]!.prompts.length === 1,
      "turn 1 did not finish");

    // 2. ACP emits unsolicited post-end_turn background-task completion + open follow-up tool call.
    const first = fake.processes[0]!;
    first.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc_bg", status: "completed" });
    first.sendUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "processing background result" } });
    first.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "tc_follow", title: "inspect", status: "in_progress" });
    await waitFor(() => store.readMeta(sessionId)?.status === "running" &&
      internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
    "ACP wakeup did not transition session to running");

    // 3. While the wakeup turn is active, request a session-initiated worktree switch. Because the
    //    provider-initiated turn is active, the runner MUST NOT dispose the ACP process mid-wakeup.
    const switched = await manager.attachWorktree(
      sessionId,
      externalWorktree,
      { requestedBySession: true },
    );
    assert.deepEqual(switched.isolation, {
      writableNow: false,
      writableAtNextLaunch: true,
      continuesAfterRelaunch: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(first.disposed, false, "pending worktree rebind must not dispose ACP process mid-wakeup");
    assert.equal(fake.processes.length, 1);
    assert.equal(store.readMeta(sessionId)?.status, "running");

    // 4. Wakeup finishes its tool call and emits its response -> once settled, the deferred rebind
    //    relaunches in the new worktree and runs the automatic continuation turn cleanly.
    first.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc_follow", status: "completed" });
    first.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ending wakeup for rebind." } });

    await waitFor(() => fake.processes.length === 2 &&
      fake.processes[1]!.prompts.length === 1 &&
      store.readMeta(sessionId)?.status === "idle",
    "deferred worktree rebind and continuation did not run after ACP wakeup settled");
    assert.equal(first.disposed, true);
    assert.equal(fake.processes[1]!.cwd, switched.worktree.path);
    assert.ok(
      fake.processes[1]!.prompts[0]!.startsWith(worktreeContinuationPrompt({
        path: switched.worktree.path,
        branch: "fix/acp-wakeup",
      })),
      `unexpected continuation prompt: ${fake.processes[1]!.prompts[0]}`,
    );
    const events = store.readEvents(sessionId).map((event) => event.payload.kind);
    assert.ok(events.includes("agent_response_completed"), "wakeup response emits completion fence");

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interruptTurn cancels an active ACP post-end_turn wakeup cleanly and unblocks queued prompts (#4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-interrupt-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const fake = fakeAcpFactory({ providerTurnSettleMs: 5_000, providerTurnResponseSettleMs: 5_000 });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_interrupt";
    await manager.start(acpSpec(sessionId, repo));
    manager.prompt(sessionId, "turn 1");
    await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.processes[0]!.prompts.length === 1,
      "turn 1 did not finish");

    fake.processes[0]!.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc_stuck",
      title: "long wakeup tool",
      status: "in_progress",
    });
    await waitFor(() => store.readMeta(sessionId)?.status === "running", "wakeup did not transition to running");

    assert.equal(manager.interruptTurn(sessionId), "applied");
    await waitFor(() => store.readMeta(sessionId)?.status === "idle", "interrupted ACP wakeup did not settle idle");
    assert.ok(store.readEvents(sessionId).some((event) => event.payload.kind === "turn_interrupted"));

    manager.prompt(sessionId, "follow up after interrupt");
    await waitFor(() => fake.processes[0]!.prompts.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "next prompt did not run after interrupting ACP wakeup");

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACP wakeup starting during post-turn diff capture stays running until the wakeup settles (#4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-diff-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const fake = fakeAcpFactory({ providerTurnSettleMs: 80, providerTurnResponseSettleMs: 40 });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_diff";
    await manager.start(acpSpec(sessionId, repo));

    let enteredDiff!: () => void;
    let releaseDiff!: () => void;
    const diffEntered = new Promise<void>((resolve) => { enteredDiff = resolve; });
    const diffGate = new Promise<void>((resolve) => { releaseDiff = resolve; });
    const internals = manager as unknown as {
      captureDiff: (sid: string) => Promise<unknown>;
      active: Map<string, { running: boolean; providerInitiatedTurnActive?: boolean }>;
    };
    const origCaptureDiff = internals.captureDiff.bind(manager);
    let gatedOnce = false;
    internals.captureDiff = async (sid) => {
      if (!gatedOnce) {
        gatedOnce = true;
        enteredDiff();
        await diffGate;
      }
      return origCaptureDiff(sid);
    };

    manager.prompt(sessionId, "turn 1");
    await diffEntered;

    // Prompt returned end_turn, AcpClient cleared promptInFlight, and a wakeup opens a tool call
    // BEFORE SessionManager finishes captureDiff and exits runPrompt.
    const first = fake.processes[0]!;
    first.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "tc_post_diff", title: "wakeup tool", status: "in_progress" });
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
      "ACP wakeup did not activate during post-turn diff capture");

    releaseDiff();
    await waitFor(() => internals.active.get(sessionId)?.running === false, "runner prompt drain did not finish");
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(store.readMeta(sessionId)?.status, "running",
      "prompt cleanup must not mark an active ACP wakeup idle");

    first.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc_post_diff", status: "completed" });
    await waitFor(() => store.readMeta(sessionId)?.status === "idle",
      "session did not return to idle after wakeup settled");

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy cancel() during an ACP wakeup suppresses automatic continuation when a worktree switch activates after settlement (#4904, #4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-cancel-cont-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const externalWorktree = join(root, "wt-cancelled-wakeup");
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "fix/cancelled-wakeup", externalWorktree, "HEAD"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const fake = fakeAcpFactory({ providerTurnSettleMs: 5_000, providerTurnResponseSettleMs: 5_000 });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_cancel_cont";
    await manager.start(acpSpec(sessionId, repo));
    const internals = manager as unknown as {
      active: Map<string, { managedGitBoundary?: true; providerInitiatedTurnActive?: boolean }>;
      configuredProjectPaths: string[];
      worktreeIsolationNotice: (meta: unknown, path: string) => Promise<unknown>;
    };
    internals.configuredProjectPaths = [repo];
    internals.active.get(sessionId)!.managedGitBoundary = true;

    manager.prompt(sessionId, "turn 1");
    await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.processes[0]!.prompts.length === 1,
      "turn 1 did not finish");

    // Start an ACP wakeup with an open tool call.
    fake.processes[0]!.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc_cancel_wt",
      title: "create worktree",
      status: "in_progress",
    });
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
      "wakeup did not become active");

    // Hold activation of the wakeup's worktree switch while we issue legacy cancel().
    let activationReached!: () => void;
    let openActivation!: () => void;
    const arrived = new Promise<void>((resolve) => { activationReached = resolve; });
    const gate = new Promise<void>((resolve) => { openActivation = resolve; });
    const origNotice = internals.worktreeIsolationNotice.bind(manager);
    internals.worktreeIsolationNotice = async (meta, path) => {
      activationReached();
      await gate;
      return origNotice(meta, path);
    };

    const switched = manager.attachWorktree(sessionId, externalWorktree, { requestedBySession: true });
    await arrived;

    // Legacy cancel() cancels the provider wakeup; wait for it to settle idle before activation finishes.
    manager.cancel(sessionId);
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive !== true &&
      store.readMeta(sessionId)?.status === "idle",
    "cancelled ACP wakeup did not settle");

    openActivation();
    const result = await switched;
    assert.equal(result.isolation.continuesAfterRelaunch, undefined,
      "a cancelled provider wakeup must never regain automatic continuation eligibility");

    await waitFor(() => fake.processes.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "relaunch after cancelled wakeup did not settle");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fake.processes[1]!.prompts.length, 0, "no automatic continuation prompt may be queued");

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt cleanup failure or cancelled stopReason never publishes terminal status over a live ACP wakeup (#4905)", { skip: !haveGit() }, async () => {
  for (const variant of ["diff-throw", "cancelled-stop"] as const) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-acp-wakeup-${variant}-`));
    let manager: SessionManager | undefined;
    try {
      const repo = join(root, "repo");
      execFileSync("git", ["init", repo]);
      execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
      const dataDir = join(root, "data");
      const store = new SessionStore(join(dataDir, "sessions"));
      const sent: RunnerToControlPlane[] = [];
      const fake = fakeAcpFactory({
        autoRespond: variant === "cancelled-stop" ? () => false : undefined,
        providerTurnSettleMs: 80,
        providerTurnResponseSettleMs: 40,
      });
      manager = new SessionManager((msg) => { sent.push(msg); }, () => {}, store, "runner", undefined,
        fake.factory as never, dataDir, 1);

      const sessionId = `s_acp_wakeup_${variant.replaceAll("-", "_")}`;
      await manager.start(acpSpec(sessionId, repo));

      let enteredDiff!: () => void;
      let releaseDiff!: () => void;
      const diffEntered = new Promise<void>((resolve) => { enteredDiff = resolve; });
      const diffGate = new Promise<void>((resolve) => { releaseDiff = resolve; });
      const internals = manager as unknown as {
        captureDiff: (sid: string) => Promise<unknown>;
        active: Map<string, { running: boolean; providerInitiatedTurnActive?: boolean }>;
      };
      const origCaptureDiff = internals.captureDiff.bind(manager);
      let gatedOnce = false;
      internals.captureDiff = async (sid) => {
        if (!gatedOnce) {
          gatedOnce = true;
          enteredDiff();
          await diffGate;
          if (variant === "diff-throw") throw new Error("git diff exploded");
        }
        return origCaptureDiff(sid);
      };

      manager.prompt(sessionId, "turn 1");
      if (variant === "cancelled-stop") {
        await waitFor(() => fake.processes[0]!.hasPendingPrompt(), "prompt did not arrive");
        fake.processes[0]!.respondPrompt("cancelled");
      }
      await diffEntered;

      const first = fake.processes[0]!;
      first.sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: `tc_${variant}`,
        title: "wakeup tool",
        status: "in_progress",
      });
      await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
        `${variant}: wakeup did not activate during post-turn diff capture`);

      releaseDiff();
      await waitFor(() => internals.active.get(sessionId)?.running === false, `${variant}: prompt drain did not finish`);
      await new Promise((resolve) => setTimeout(resolve, 120));

      assert.equal(store.readMeta(sessionId)?.status, "running",
        `${variant}: prompt cleanup must keep session running while ACP wakeup is active`);
      const statuses = sent
        .filter((msg): msg is Extract<RunnerToControlPlane, { type: "session_status" }> =>
          msg.type === "session_status" && msg.sessionId === sessionId)
        .map((msg) => msg.status);
      assert.equal(statuses.includes("failed"), false, `${variant}: must never publish terminal failed`);
      assert.equal(statuses.includes("stopped"), false, `${variant}: must never publish terminal stopped`);
      if (variant === "diff-throw") {
        assert.ok(
          store.readEvents(sessionId).some((e) => e.payload.kind === "error" && e.payload.message.includes("git diff exploded")),
          "prompt failure event is still recorded",
        );
      }

      first.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: `tc_${variant}`, status: "completed" });
      await waitFor(() => store.readMeta(sessionId)?.status === "idle",
        `${variant}: session did not return idle after wakeup settled`);

      manager.stop(sessionId);
      await manager.delete(sessionId);
    } finally {
      manager?.shutdownAll();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("old prompt cleanup does not consume a wakeup interrupt or restore its worktree continuation (#4904, #4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-interrupt-race-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const externalWorktree = join(root, "wt-interrupted-wakeup");
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "fix/interrupted-wakeup", externalWorktree, "HEAD"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const fake = fakeAcpFactory({ providerTurnSettleMs: 5_000, providerTurnResponseSettleMs: 5_000 });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_interrupt_race";
    await manager.start(acpSpec(sessionId, repo));
    const internals = manager as unknown as {
      captureDiff: (sid: string) => Promise<unknown>;
      worktreeIsolationNotice: (meta: unknown, path: string) => Promise<unknown>;
      configuredProjectPaths: string[];
      active: Map<string, {
        running: boolean;
        managedGitBoundary?: true;
        providerInitiatedTurnActive?: boolean;
        providerInitiatedTurnId?: string;
      }>;
    };
    internals.configuredProjectPaths = [repo];
    internals.active.get(sessionId)!.managedGitBoundary = true;

    let enteredDiff!: () => void;
    let releaseDiff!: () => void;
    const diffEntered = new Promise<void>((resolve) => { enteredDiff = resolve; });
    const diffGate = new Promise<void>((resolve) => { releaseDiff = resolve; });
    const origCaptureDiff = internals.captureDiff.bind(manager);
    let gatedDiff = false;
    internals.captureDiff = async (sid) => {
      if (!gatedDiff) {
        gatedDiff = true;
        enteredDiff();
        await diffGate;
      }
      return origCaptureDiff(sid);
    };

    let activationReached!: () => void;
    let openActivation!: () => void;
    const activationArrived = new Promise<void>((resolve) => { activationReached = resolve; });
    const activationGate = new Promise<void>((resolve) => { openActivation = resolve; });
    const origNotice = internals.worktreeIsolationNotice.bind(manager);
    internals.worktreeIsolationNotice = async (meta, path) => {
      activationReached();
      await activationGate;
      return origNotice(meta, path);
    };

    manager.prompt(sessionId, "turn 1");
    await diffEntered;

    // Wakeup begins while turn 1 is still awaiting captureDiff, and initiates a worktree switch.
    fake.processes[0]!.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc_race_wt",
      title: "switch worktree",
      status: "in_progress",
    });
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
      "wakeup did not activate during diff capture");
    const providerTurnId = internals.active.get(sessionId)!.providerInitiatedTurnId!;
    const switched = manager.attachWorktree(sessionId, externalWorktree, { requestedBySession: true });
    await activationArrived;

    // Interrupt the wakeup by its exact providerTurnId AND immediately release diff capture before
    // yielding to setImmediate so turn 1's cleanup races ahead of ACP's deferred cancellation settle.
    assert.equal(manager.interruptTurn(sessionId, providerTurnId), "applied");
    releaseDiff();

    await waitFor(() => internals.active.get(sessionId)?.running === false &&
      internals.active.get(sessionId)?.providerInitiatedTurnActive !== true &&
      store.readMeta(sessionId)?.status === "idle",
    "old prompt and interrupted wakeup did not both settle");
    assert.ok(store.readEvents(sessionId).some((e) => e.payload.kind === "turn_interrupted"),
      "wakeup interrupt must still emit turn_interrupted rather than being consumed by old prompt cleanup");

    openActivation();
    const result = await switched;
    assert.equal(result.isolation.continuesAfterRelaunch, undefined,
      "interrupted wakeup must not advertise continuation");
    await waitFor(() => fake.processes.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "relaunch did not settle");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fake.processes[1]!.prompts.length, 0,
      "interrupted wakeup must never submit an automatic continuation prompt");

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wakeup settlement while old prompt is still in diff capture emits turn_interrupted and clears interrupt hold immediately (#4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-settle-first-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const fake = fakeAcpFactory({ providerTurnSettleMs: 5_000, providerTurnResponseSettleMs: 5_000 });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_settle_first";
    await manager.start(acpSpec(sessionId, repo));
    const internals = manager as unknown as {
      captureDiff: (sid: string) => Promise<unknown>;
      active: Map<string, {
        running: boolean;
        interruptRequested?: boolean;
        holdQueuedPromptsAfterInterrupt?: boolean;
        providerInitiatedTurnActive?: boolean;
        providerInitiatedTurnId?: string;
      }>;
    };

    let enteredDiff!: () => void;
    let releaseDiff!: () => void;
    const diffEntered = new Promise<void>((resolve) => { enteredDiff = resolve; });
    const diffGate = new Promise<void>((resolve) => { releaseDiff = resolve; });
    const origCaptureDiff = internals.captureDiff.bind(manager);
    let gatedDiff = false;
    internals.captureDiff = async (sid) => {
      if (!gatedDiff) {
        gatedDiff = true;
        enteredDiff();
        await diffGate;
      }
      return origCaptureDiff(sid);
    };

    manager.prompt(sessionId, "turn 1");
    await diffEntered;

    fake.processes[0]!.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc_settle_first",
      title: "wakeup work",
      status: "in_progress",
    });
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
      "wakeup did not become active");
    const providerTurnId = internals.active.get(sessionId)!.providerInitiatedTurnId!;

    // Keep captureDiff gated until ACP's deferred cancellation settles the wakeup first.
    assert.equal(manager.interruptTurn(sessionId, providerTurnId), "applied");
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive !== true,
      "wakeup did not settle while captureDiff remained gated");

    assert.equal(internals.active.get(sessionId)?.running, true, "old prompt is still gated in captureDiff");
    assert.equal(internals.active.get(sessionId)?.interruptRequested, false,
      "wakeup settlement must clear interruptRequested before old prompt resumes");
    assert.equal(internals.active.get(sessionId)?.holdQueuedPromptsAfterInterrupt, false,
      "wakeup settlement must clear the interrupt queue hold");
    assert.equal(store.readEvents(sessionId).filter((e) => e.payload.kind === "turn_interrupted").length, 1,
      "exactly one turn_interrupted event must be emitted for the interrupted wakeup");

    releaseDiff();
    await waitFor(() => internals.active.get(sessionId)?.running === false &&
      store.readMeta(sessionId)?.status === "idle",
    "original prompt did not finish cleanly after diff gate released");
    assert.equal(store.readEvents(sessionId).filter((e) => e.payload.kind === "turn_interrupted").length, 1);

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wakeup that starts and settles during diff capture does not restore the previous turn's continuation eligibility (#4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-no-restore-cont-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    const externalWorktree = join(root, "wt-external");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "acp-wakeup-superseded-wt", externalWorktree, "HEAD"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const fake = fakeAcpFactory({ providerTurnSettleMs: 5_000, providerTurnResponseSettleMs: 5_000 });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_no_restore_cont";
    await manager.start(acpSpec(sessionId, repo));
    const internals = manager as unknown as {
      captureDiff: (sid: string) => Promise<unknown>;
      worktreeIsolationNotice: (meta: unknown, path: string) => Promise<unknown>;
      configuredProjectPaths: string[];
      liveTurnId: (entry: unknown) => string | undefined;
      active: Map<string, {
        running: boolean;
        managedGitBoundary?: true;
        interruptRequested?: boolean;
        lastNormallyCompletedTurnId?: string;
        providerInitiatedTurnActive?: boolean;
        providerInitiatedTurnId?: string;
      }>;
    };
    internals.configuredProjectPaths = [repo];
    internals.active.get(sessionId)!.managedGitBoundary = true;

    let enteredDiff!: () => void;
    let releaseDiff!: () => void;
    const diffEntered = new Promise<void>((resolve) => { enteredDiff = resolve; });
    const diffGate = new Promise<void>((resolve) => { releaseDiff = resolve; });
    const origCaptureDiff = internals.captureDiff.bind(manager);
    let gatedDiff = false;
    internals.captureDiff = async (sid) => {
      if (!gatedDiff) {
        gatedDiff = true;
        enteredDiff();
        await diffGate;
      }
      return origCaptureDiff(sid);
    };

    let activationArrivedResolve!: () => void;
    let openActivation!: () => void;
    const activationArrived = new Promise<void>((resolve) => { activationArrivedResolve = resolve; });
    const activationGate = new Promise<void>((resolve) => { openActivation = resolve; });
    const origNotice = internals.worktreeIsolationNotice.bind(manager);
    internals.worktreeIsolationNotice = async (meta, path) => {
      activationArrivedResolve();
      await activationGate;
      return origNotice(meta, path);
    };

    manager.prompt(sessionId, "turn 1");
    await diffEntered;

    // The original turn initiates a worktree switch before the wakeup arrives; hold activation.
    const switched = manager.attachWorktree(sessionId, externalWorktree, { requestedBySession: true });
    await activationArrived;

    // A wakeup starts during turn 1's diff capture, is interrupted, and settles BEFORE diff capture finishes.
    fake.processes[0]!.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc_superseded_cont",
      title: "wakeup work",
      status: "in_progress",
    });
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
      "wakeup did not become active");
    const providerTurnId = internals.active.get(sessionId)!.providerInitiatedTurnId!;
    assert.equal(manager.interruptTurn(sessionId, providerTurnId), "applied");
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive !== true,
      "wakeup did not settle while captureDiff remained gated");

    assert.equal(internals.active.get(sessionId)?.running, true, "turn 1 is still in diff capture");
    assert.equal(internals.active.get(sessionId)?.interruptRequested, false);
    assert.equal(internals.liveTurnId(internals.active.get(sessionId)!), undefined,
      "turn 1 must no longer be treated as live after a wakeup superseded it");

    // Let turn 1 finish diff capture and cleanup: it must NOT restore lastNormallyCompletedTurnId.
    releaseDiff();
    await waitFor(() => internals.active.get(sessionId)?.running === false &&
      store.readMeta(sessionId)?.status === "idle",
    "turn 1 did not finish cleanly after diff gate released");
    assert.equal(internals.active.get(sessionId)?.lastNormallyCompletedTurnId, undefined,
      "superseded turn 1 must not restore lastNormallyCompletedTurnId");

    // Release worktree activation: neither notice nor relaunch may continue automatically.
    openActivation();
    const result = await switched;
    assert.equal(result.isolation.continuesAfterRelaunch, undefined,
      "superseded turn must not advertise continuation");
    await waitFor(() => fake.processes.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "relaunch did not settle");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fake.processes[1]!.prompts.length, 0,
      "superseded turn must never submit an automatic continuation prompt");

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACP wakeup during prompt preparation does not suppress the upcoming turn's worktree continuation (#4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-pre-submit-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    const initialWorktree = join(root, "wt-initial");
    const externalWorktree = join(root, "wt-pre-submit");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "acp-pre-submit-initial", initialWorktree, "HEAD"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "acp-pre-submit-wt", externalWorktree, "HEAD"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const fake = fakeAcpFactory({
      autoRespond: (launch, text) => !(launch === 2 && text.startsWith("turn 2")),
      providerTurnSettleMs: 50,
      providerTurnResponseSettleMs: 50,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_pre_submit";
    await manager.start(acpSpec(sessionId, repo));
    const internals = manager as unknown as {
      persistedWorktreeFailure: (meta: unknown, path: string, branch: string) => Promise<string | null>;
      configuredProjectPaths: string[];
      active: Map<string, {
        running: boolean;
        managedGitBoundary?: true;
        providerInitiatedTurnActive?: boolean;
      }>;
    };
    internals.configuredProjectPaths = [repo];
    // Attach an initial worktree so runPrompt runs pre-submission persistedWorktreeFailure checks.
    await manager.attachWorktree(sessionId, initialWorktree);
    await waitFor(() => fake.processes.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "initial worktree relaunch did not settle");
    internals.active.get(sessionId)!.managedGitBoundary = true;

    // Establish the ACP session with an ordinary first turn.
    manager.prompt(sessionId, "turn 1");
    await waitFor(() => fake.processes[1]!.prompts.length === 1 && store.readMeta(sessionId)?.status === "idle",
      "turn 1 did not finish");

    // Gate pre-submission worktree verification for turn 2 before it reaches ACP.
    let enteredProof!: () => void;
    let releaseProof!: () => void;
    const proofEntered = new Promise<void>((resolve) => { enteredProof = resolve; });
    const proofGate = new Promise<void>((resolve) => { releaseProof = resolve; });
    const origProof = internals.persistedWorktreeFailure.bind(manager);
    let gatedProof = false;
    internals.persistedWorktreeFailure = async (meta, path, branch) => {
      if (!gatedProof) {
        gatedProof = true;
        enteredProof();
        await proofGate;
      }
      return origProof(meta, path, branch);
    };

    manager.prompt(sessionId, "turn 2");
    await proofEntered;
    assert.equal(fake.processes[1]!.prompts.length, 1, "turn 2 must still be paused before ACP submission");

    // Start and settle an unsolicited ACP wakeup while turn 2 is waiting in pre-submission verification.
    fake.processes[1]!.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "background ping before turn 2" },
    });
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
      "unsolicited wakeup did not activate during prompt preparation");
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive !== true,
      "unsolicited wakeup did not settle before turn 2 submitted");

    // Release turn 2 so it reaches ACP, then let turn 2 request its own worktree switch.
    releaseProof();
    await waitFor(() => fake.processes[1]!.hasPendingPrompt() && fake.processes[1]!.prompts.length === 2,
      "turn 2 did not reach ACP");
    const switched = await manager.attachWorktree(sessionId, externalWorktree, { requestedBySession: true });
    assert.equal(switched.isolation.continuesAfterRelaunch, true,
      "turn 2 must advertise automatic continuation despite the earlier pre-submission wakeup");

    fake.processes[1]!.respondPrompt("end_turn");
    await waitFor(() => fake.processes.length === 3 &&
      fake.processes[2]!.prompts.length === 1 &&
      store.readMeta(sessionId)?.status === "idle",
    "relaunched ACP session did not receive automatic continuation for turn 2");
    assert.equal(fake.processes[2]!.prompts.length, 1);
    assert.ok(
      fake.processes[2]!.prompts[0]!.startsWith(
        worktreeContinuationPrompt({ path: switched.worktree.path, branch: "acp-pre-submit-wt" }),
      ),
      `expected continuation prompt, got: ${fake.processes[2]!.prompts[0]}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fake.processes[2]!.prompts.length, 1, "continuation must run exactly once");

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity retry after a backoff ACP wakeup does not restore a superseded turn's worktree continuation (#4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-capacity-retry-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    const externalWorktree = join(root, "wt-capacity-retry");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "acp-capacity-retry-wt", externalWorktree, "HEAD"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const fake = fakeAcpFactory({
      autoRespond: (launch, text) => launch === 1 && text.startsWith("turn 1"),
      providerTurnSettleMs: 50,
      providerTurnResponseSettleMs: 50,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_capacity_retry";
    await manager.start(acpSpec(sessionId, repo));
    const internals = manager as unknown as {
      worktreeIsolationNotice: (meta: unknown, path: string) => Promise<unknown>;
      configuredProjectPaths: string[];
      active: Map<string, {
        running: boolean;
        managedGitBoundary?: true;
        providerInitiatedTurnActive?: boolean;
      }>;
    };
    internals.configuredProjectPaths = [repo];
    internals.active.get(sessionId)!.managedGitBoundary = true;

    // Complete turn 1 so ACP enables post-end_turn wakeup detection.
    manager.prompt(sessionId, "turn 1");
    await waitFor(() => fake.processes[0]!.prompts.length === 1 && store.readMeta(sessionId)?.status === "idle",
      "turn 1 did not finish");

    let activationArrivedResolve!: () => void;
    let openActivation!: () => void;
    const activationArrived = new Promise<void>((resolve) => { activationArrivedResolve = resolve; });
    const activationGate = new Promise<void>((resolve) => { openActivation = resolve; });
    const origNotice = internals.worktreeIsolationNotice.bind(manager);
    internals.worktreeIsolationNotice = async (meta, path) => {
      activationArrivedResolve();
      await activationGate;
      return origNotice(meta, path);
    };

    // Start turn 2, capture its session-originated worktree request while activation is gated,
    // then fail attempt 0 with a capacity error so runPrompt enters retry backoff.
    manager.prompt(sessionId, "turn 2");
    await waitFor(() => fake.processes[0]!.prompts.length === 2 && fake.processes[0]!.hasPendingPrompt(),
      "turn 2 did not reach ACP");
    const switched = manager.attachWorktree(sessionId, externalWorktree, { requestedBySession: true });
    await activationArrived;

    fake.processes[0]!.respondPromptError("model_capacity_exceeded: model at capacity");
    await waitFor(() => !fake.processes[0]!.hasPendingPrompt(), "capacity error was not consumed");

    // Start and settle an unsolicited ACP wakeup during the capacity retry backoff window.
    fake.processes[0]!.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "wakeup during backoff" },
    });
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive === true,
      "wakeup did not activate during capacity retry backoff");
    await waitFor(() => internals.active.get(sessionId)?.providerInitiatedTurnActive !== true,
      "wakeup did not settle during capacity retry backoff");

    // Wait for the capacity retry (attempt 1) to reach ACP, then release worktree activation.
    await waitFor(() => fake.processes[0]!.prompts.length === 3 && fake.processes[0]!.hasPendingPrompt(),
      "capacity retry did not reach ACP");
    openActivation();
    const result = await switched;
    assert.equal(result.isolation.continuesAfterRelaunch, undefined,
      "capacity retry must not restore continuation eligibility after a backoff wakeup superseded the turn");

    // Finish the retried turn normally; relaunch must happen without any automatic continuation.
    fake.processes[0]!.respondPrompt("end_turn");
    await waitFor(() => fake.processes.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "relaunched ACP session did not settle");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fake.processes[1]!.prompts.length, 0,
      "superseded turn must never submit an automatic continuation prompt after capacity retry");

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("governance-tripped ACP prompt cancels a post-prompt permission wakeup cleanly instead of stranding its RPC (#4905)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-wakeup-governance-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));

    const responses: Array<{ id?: number; result?: unknown }> = [];
    let procStdout!: PassThrough;
    let promptReqId: number | null = null;
    const factory = (_driver: unknown, opts: DriverOptions, cb: DriverCallbacks) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      procStdout = stdout;
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr: new PassThrough(),
        pid: 12_345,
        posixBoundary: { owner: undefined, terminate: async () => true },
      }) as unknown as AgentProcess;
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        buf += chunk;
        while (buf.includes("\n")) {
          const line = buf.slice(0, buf.indexOf("\n")).trim();
          buf = buf.slice(buf.indexOf("\n") + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown };
          if (msg.id !== undefined && msg.result !== undefined) {
            responses.push({ id: msg.id, result: msg.result });
          } else if (msg.method === "initialize" && msg.id !== undefined) {
            stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake-acp", version: "1.0.0" } },
            }) + "\n");
          } else if (msg.method === "session/new" && msg.id !== undefined) {
            stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-gov-1" } }) + "\n");
          } else if (msg.method === "session/prompt" && msg.id !== undefined) {
            promptReqId = msg.id;
            // Emit 2 tool calls to trip maxToolCalls: 1.
            stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: "acp-gov-1", update: { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "t1", status: "completed" } },
            }) + "\n");
            stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: "acp-gov-1", update: { sessionUpdate: "tool_call", toolCallId: "tc_2", title: "t2", status: "completed" } },
            }) + "\n");
          } else if (msg.method === "session/cancel" && promptReqId !== null) {
            const id = promptReqId;
            promptReqId = null;
            stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } }) + "\n");
          }
        }
      });
      return new AcpDriver(opts, cb, {
        spawn: () => child,
        kill: () => child.emit("close", 0, null),
        providerTurnSettleMs: 60,
        providerTurnResponseSettleMs: 30,
      });
    };

    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      factory as never, dataDir, 1);

    const sessionId = "s_acp_wakeup_governance";
    await manager.start({
      ...acpSpec(sessionId, repo),
      config: { maxToolCalls: 1 },
    });
    const internals = manager as unknown as {
      captureDiff: (sid: string) => Promise<unknown>;
      active: Map<string, { running: boolean; governanceTripped?: string; providerInitiatedTurnActive?: boolean }>;
    };

    let enteredDiff!: () => void;
    let releaseDiff!: () => void;
    const diffEntered = new Promise<void>((resolve) => { enteredDiff = resolve; });
    const diffGate = new Promise<void>((resolve) => { releaseDiff = resolve; });
    const origCaptureDiff = internals.captureDiff.bind(manager);
    let gatedDiff = false;
    internals.captureDiff = async (sid) => {
      if (!gatedDiff) {
        gatedDiff = true;
        enteredDiff();
        await diffGate;
      }
      return origCaptureDiff(sid);
    };

    manager.prompt(sessionId, "trip maxToolCalls");
    await diffEntered;
    assert.equal(internals.active.get(sessionId)?.governanceTripped, "max_tool_calls");

    // While diff capture is gated on the governance-tripped turn, ACP sends an unsolicited permission RPC.
    procStdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 505,
      method: "session/request_permission",
      params: {
        sessionId: "acp-gov-1",
        toolCall: { toolCallId: "tc_gov_perm", title: "late command" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    }) + "\n");

    await waitFor(() => responses.some((r) => r.id === 505), "permission RPC did not receive cancellation");
    assert.deepEqual(
      responses.find((r) => r.id === 505)!.result,
      { outcome: { outcome: "cancelled" } },
      "governance-tripped session must immediately cancel an unsolicited wakeup permission RPC",
    );

    releaseDiff();
    await waitFor(() => internals.active.get(sessionId)?.running === false &&
      internals.active.get(sessionId)?.providerInitiatedTurnActive !== true &&
      store.readMeta(sessionId)?.status === "idle",
    "governance-tripped session did not settle cleanly to idle");
    assert.equal(store.readMeta(sessionId)?.pendingApproval ?? null, null);

    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
