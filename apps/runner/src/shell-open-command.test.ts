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

test("a cancellation already queued before the start fence prevents Agent TUI spawn", async () => {
  let cancellationChecks = 0;
  const state = harness({
    consumeCancellation: () => ++cancellationChecks === 1,
    waitForSessionStart: async () => {
      throw new Error("a pre-fence cancellation must not wait");
    },
  });
  await handleShellOpenCommand(command("agent_tui", true), state.dependencies);
  assert.equal(state.opens, 0);
  assert.equal(cancellationChecks, 1);
  assert.match(state.replies[0]?.error ?? "", /cancelled/);
});

test("Agent TUI deletion is checked before and immediately after the start fence", async () => {
  const before = harness({ sessionCanOpen: () => false });
  await handleShellOpenCommand(command("agent_tui", true), before.dependencies);
  assert.equal(before.waits, 0, "a deleting session never enters its start fence");
  assert.equal(before.opens, 0);
  assert.match(before.replies[0]?.error ?? "", /being deleted/);

  let checks = 0;
  const after = harness({
    sessionCanOpen: () => ++checks === 1,
    resolveTarget: () => {
      throw new Error("post-fence deletion must be rejected before target resolution");
    },
  });
  await handleShellOpenCommand(command("agent_tui", true), after.dependencies);
  assert.equal(after.waits, 1);
  assert.equal(after.opens, 0);
  assert.equal(checks, 2, "deletion is rechecked as soon as the fence settles");
  assert.match(after.replies[0]?.error ?? "", /being deleted/);
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

test("missing and pending shell targets fail with distinct messages without spawning", async () => {
  const missing = harness({ resolveTarget: () => null });
  await handleShellOpenCommand(command("shell"), missing.dependencies);
  assert.equal(missing.opens, 0);
  assert.match(missing.replies[0]?.error ?? "", /unknown session/);

  const pending = harness({ resolveTarget: () => "pending" });
  await handleShellOpenCommand(command("shell"), pending.dependencies);
  assert.equal(pending.opens, 0);
  assert.match(pending.replies[0]?.error ?? "", /worktree is still being prepared/);
});

test("a cancellation at the synchronous Agent TUI spawn boundary prevents open", async () => {
  let cancellationChecks = 0;
  const state = harness({
    consumeCancellation: () => ++cancellationChecks === 3,
  });
  await handleShellOpenCommand(command("agent_tui"), state.dependencies);
  assert.equal(cancellationChecks, 3);
  assert.equal(state.opens, 0);
  assert.match(state.replies[0]?.error ?? "", /cancelled/);
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
    resolveTarget: () => {
      throw new Error("post-fence cancellation must be rejected before target resolution");
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
