import assert from "node:assert/strict";
import test from "node:test";
import type { ShellOpenResultMessage, StartSessionMessage } from "@wollipog/protocol";
import { SessionStartFence } from "./session-start-fence.js";
import { startSessionWithMaterializationFence } from "./session-start-command.js";
import { handleShellOpenCommand } from "./shell-open-command.js";
import type { SessionMeta } from "./session-store.js";

const command: StartSessionMessage = {
  type: "start_session",
  spec: {
    sessionId: "queued-session",
    agentId: "codex-native",
    workspaceId: "workspace",
    workspacePath: "/repo",
    command: "codex",
    args: [],
    env: {},
    useWorktree: false,
    driver: "codex-app-server",
  },
};

test("ordinary start_session exposes materialization before admission and provider completion", async () => {
  const fence = new SessionStartFence();
  let releaseAdmission!: () => void;
  const admission = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  let providerConstructed = false;
  let tuiOpened = false;

  startSessionWithMaterializationFence(command, undefined, {
    track: (sessionId, materialized) => {
      fence.track(sessionId, materialized);
    },
    start: async (_command, _lifecycle, onMaterialized) => {
      // Models SessionManager after worktreePending=false and its synchronous admit-or-queue
      // decision: materialization is published before the capacity promise is awaited.
      onMaterialized(true);
      await admission;
      providerConstructed = true;
      return true;
    },
    failed: (error) => {
      throw error;
    },
  });

  const replies: ShellOpenResultMessage[] = [];
  const opening = handleShellOpenCommand({
    type: "shell_open",
    requestId: "open-initial-tui",
    sessionId: "queued-session",
    shellId: "initial-tui",
    kind: "agent_tui",
    fenceStart: true,
  }, {
    waitForSessionStart: (sessionId) => fence.wait(sessionId),
    registerPending: () => {},
    unregisterPending: () => {},
    consumeCancellation: () => false,
    sessionCanOpen: () => true,
    resolveTarget: () => ({
      root: "/repo",
      context: { kind: "native" },
      meta: {
        sessionId: "queued-session",
        repoPath: "/repo",
        context: { kind: "native" },
      } as SessionMeta,
    }),
    resolveAgentTuiLaunch: () => ({ command: "codex", args: [] }),
    open: () => {
      tuiOpened = true;
      return { pty: true };
    },
    send: (reply) => replies.push(reply),
    errorText: (error) => error instanceof Error ? error.message : String(error),
  });
  await Promise.race([
    opening,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("ordinary start remained fenced on admission")), 250)),
  ]);
  assert.equal(tuiOpened, true);
  assert.equal(replies[0]?.ok, true);
  assert.equal(providerConstructed, false);

  releaseAdmission();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(providerConstructed, true);
});
