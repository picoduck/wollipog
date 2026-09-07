import type { AgentContext, ShellOpenMessage, ShellOpenResultMessage } from "@wollipog/protocol";
import type { SessionMeta } from "./session-store.js";
import type { ShellProcessLaunch } from "./shell-manager.js";

export type ShellOpenTarget =
  | { root: string; context: AgentContext; meta: SessionMeta }
  | "pending"
  | null;

export interface ShellOpenCommandDependencies {
  waitForSessionStart(sessionId: string): Promise<boolean | null>;
  registerPending(shellId: string): void;
  unregisterPending(shellId: string): void;
  consumeCancellation(shellId: string): boolean;
  sessionCanOpen(sessionId: string): boolean;
  resolveTarget(sessionId: string): ShellOpenTarget;
  launchEpoch(sessionId: string): number;
  resolveAgentTuiLaunch(meta: SessionMeta): ShellProcessLaunch | null | Promise<ShellProcessLaunch | null>;
  open(
    message: ShellOpenMessage,
    target: Exclude<ShellOpenTarget, "pending" | null>,
    launch: ShellProcessLaunch | undefined,
  ): { pty: boolean };
  send(result: ShellOpenResultMessage): void;
  errorText(error: unknown): string;
}

/** Coordinate a shell open without letting an initial Agent TUI outrun its session start.
 * Ordinary interactive shells intentionally bypass the start fence so manual attachment keeps
 * the legacy v58 behavior. Cancellation is checked on both sides of asynchronous preparation and at
 * the synchronous spawn boundary. */
export async function handleShellOpenCommand(
  message: ShellOpenMessage,
  dependencies: ShellOpenCommandDependencies,
): Promise<void> {
  const fail = (error: string) => dependencies.send({
    type: "shell_open_result",
    requestId: message.requestId,
    ok: false,
    error,
  });

  const registered = message.kind === "agent_tui";
  if (registered) dependencies.registerPending(message.shellId);
  try {
    if (dependencies.consumeCancellation(message.shellId)) {
      fail("shell open was cancelled");
      return;
    }

    if (message.kind === "agent_tui") {
      if (!dependencies.sessionCanOpen(message.sessionId)) {
        fail("session is being deleted");
        return;
      }
      if (message.fenceStart === true) {
        const started = await dependencies.waitForSessionStart(message.sessionId);
        if (started !== true) {
          fail("session launch failed or was cancelled");
          return;
        }
      }
      if (!dependencies.sessionCanOpen(message.sessionId)) {
        fail("session is being deleted");
        return;
      }
      if (dependencies.consumeCancellation(message.shellId)) {
        fail("shell open was cancelled");
        return;
      }
    }

    const target = dependencies.resolveTarget(message.sessionId);
    if (!target || target === "pending") {
      fail(target === "pending"
        ? "the session's worktree is still being prepared — try again in a moment"
        : "unknown session");
      return;
    }

    try {
      // Only launch-relevant fields participate: transcript ticks must not continually
      // invalidate a slow MCP probe, but a replacement launch or workspace change must.
      const launchIdentity = (value: Exclude<ShellOpenTarget, "pending" | null>) => JSON.stringify([
        value.root, value.context, value.meta.command, value.meta.args, value.meta.config,
        value.meta.executionTarget, value.meta.providerCredentialScopeId, value.meta.status,
      ]);
      const identity = launchIdentity(target);
      const epoch = dependencies.launchEpoch(message.sessionId);
      const launch = message.kind === "agent_tui"
        ? (await dependencies.resolveAgentTuiLaunch(target.meta)) ?? undefined
        : undefined;
      if (message.kind === "agent_tui" && !launch) {
        throw new Error("this session's agent does not expose a standalone TUI");
      }
      if (message.kind === "agent_tui" && !dependencies.sessionCanOpen(message.sessionId)) {
        throw new Error("session is being deleted");
      }
      if (dependencies.consumeCancellation(message.shellId)) {
        throw new Error("shell open was cancelled");
      }
      if (message.kind === "agent_tui") {
        const current = dependencies.resolveTarget(message.sessionId);
        if (!current || current === "pending" || launchIdentity(current) !== identity ||
            dependencies.launchEpoch(message.sessionId) !== epoch) {
          throw new Error("session launch or workspace changed while preparing Agent TUI; try again");
        }
      }
      const { pty } = dependencies.open(message, target, launch);
      dependencies.send({ type: "shell_open_result", requestId: message.requestId, ok: true, pty });
    } catch (error) {
      fail(dependencies.errorText(error));
    }
  } finally {
    if (registered) dependencies.unregisterPending(message.shellId);
  }
}
