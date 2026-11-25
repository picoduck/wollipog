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
    const sessionId = `acp-session-${launchIndex}`;
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
