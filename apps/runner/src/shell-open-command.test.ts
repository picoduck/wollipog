import assert from "node:assert/strict";
import test from "node:test";
import type { ShellOpenMessage, ShellOpenResultMessage } from "@wollipog/protocol";
import type { SessionMeta } from "./session-store.js";
import { handleShellOpenCommand, type ShellOpenCommandDependencies } from "./shell-open-command.js";
import { PendingShellOpenCancellations } from "./pending-shell-open-cancellations.js";

const meta = {
  sessionId: "session-1",
  repoPath: "/repo",
  context: { kind: "native" },
} as SessionMeta;

function command(kind: "shell" | "agent_tui", fenceStart = false): ShellOpenMessage {
  return {
    type: "shell_open",
    requestId: `request-${kind}`,
    sessionId: "session-1",
    shellId: `shell-${kind}`,
    kind,
    ...(fenceStart ? { fenceStart: true as const } : {}),
  };
}

function harness(overrides: Partial<ShellOpenCommandDependencies> = {}) {
  const replies: ShellOpenResultMessage[] = [];
  let opens = 0;
  let waits = 0;
  const dependencies: ShellOpenCommandDependencies = {
    waitForSessionStart: async () => {
      waits++;
      return true;
    },
    registerPending: () => {},
    unregisterPending: () => {},
    consumeCancellation: () => false,
    sessionCanOpen: () => true,
    resolveTarget: () => ({ root: "/repo", context: { kind: "native" }, meta }),
    resolveAgentTuiLaunch: () => ({ command: "codex", args: [] }),
    open: () => {
      opens++;
      return { pty: true };
    },
    send: (reply) => replies.push(reply),
    errorText: (error) => error instanceof Error ? error.message : String(error),
    ...overrides,
  };
  return {
    dependencies,
    replies,
    get opens() { return opens; },
    get waits() { return waits; },
  };
}

test("ordinary shells bypass the initial-session fence", async () => {
  const state = harness({
    waitForSessionStart: async () => {
      throw new Error("ordinary shell must not wait");
    },
  });
  await handleShellOpenCommand(command("shell"), state.dependencies);
  assert.equal(state.opens, 1);
  assert.equal(state.replies[0]?.ok, true);
});

test("initial Agent TUI waits for materialization and a settled failure prevents spawn", async () => {
  const order: string[] = [];
  const state = harness({
    waitForSessionStart: async () => {
      order.push("wait");
      return false;
    },
    resolveTarget: () => {
      order.push("target");
      return ({ root: "/repo", context: { kind: "native" }, meta });
    },
  });
  await handleShellOpenCommand(command("agent_tui", true), state.dependencies);
  assert.deepEqual(order, ["wait"]);
  assert.equal(state.opens, 0);
  assert.match(state.replies[0]?.error ?? "", /launch failed/);
});

test("manual Agent TUI attachment bypasses even a retained failed start fence", async () => {
  const state = harness({
    waitForSessionStart: async () => {
      throw new Error("manual attachment must not consume the initial-start fence");
    },
  });
  await handleShellOpenCommand(command("agent_tui"), state.dependencies);
  assert.equal(state.opens, 1);
  assert.equal(state.waits, 0);
  assert.equal(state.replies[0]?.ok, true);
});

test("Agent TUI launch-resolution failures return a failed shell result", async () => {
  const state = harness({
    resolveAgentTuiLaunch: () => { throw new Error("provider HOME lease is unavailable"); },
  });
  await handleShellOpenCommand(command("agent_tui"), state.dependencies);
  assert.equal(state.opens, 0);
  assert.equal(state.replies[0]?.ok, false);
  assert.match(state.replies[0]?.error ?? "", /provider HOME lease is unavailable/);
});

test("a close arriving while Agent TUI waits prevents the delayed spawn", async () => {
  let releaseStart!: (started: boolean) => void;
  const start = new Promise<boolean>((resolve) => { releaseStart = resolve; });
  let cancelled = false;
  const state = harness({
    waitForSessionStart: () => start,
    consumeCancellation: () => {
      if (!cancelled) return false;
      cancelled = false;
      return true;
    },
  });
  const opening = handleShellOpenCommand(command("agent_tui", true), state.dependencies);
  await Promise.resolve();
  cancelled = true;
  releaseStart(true);
  await opening;
  assert.equal(state.opens, 0);
  assert.match(state.replies[0]?.error ?? "", /cancelled/);
});

test("a slow Agent TUI start remains cancellable after the unknown-close TTL", async () => {
  const cancellations = new PendingShellOpenCancellations(5);
  let releaseStart!: (started: boolean) => void;
  const start = new Promise<boolean>((resolve) => { releaseStart = resolve; });
  const state = harness({
    waitForSessionStart: () => start,
    registerPending: (shellId) => cancellations.register(shellId),
    unregisterPending: (shellId) => cancellations.unregister(shellId),
    consumeCancellation: (shellId) => cancellations.consume(shellId),
  });
  const opening = handleShellOpenCommand(command("agent_tui", true), state.dependencies);
  await Promise.resolve();
  cancellations.cancel("shell-agent_tui");
  await new Promise((resolve) => setTimeout(resolve, 15));
  releaseStart(true);
  await opening;
  assert.equal(state.opens, 0);
  assert.match(state.replies[0]?.error ?? "", /cancelled/);
});

test("delete after the fence settles is rechecked before Agent TUI spawn", async () => {
  let checks = 0;
  const state = harness({
    sessionCanOpen: () => ++checks < 3,
  });
  await handleShellOpenCommand(command("agent_tui", true), state.dependencies);
  assert.equal(state.opens, 0);
  assert.match(state.replies[0]?.error ?? "", /being deleted/);
});
