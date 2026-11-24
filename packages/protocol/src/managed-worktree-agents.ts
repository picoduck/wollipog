/** Which agents can run in a managed worktree on a runner (#4901).
 *
 * On Linux, a native host launch in a runner-created ("managed") worktree is always sandboxed with
 * bubblewrap, to protect the worktree's Git administration. On a runner configured for `provider`
 * isolation, that sandbox must keep the provider's own state directory writable, or the agent loses
 * its conversation, settings and sign-in. The runner knows that directory for Claude Code, Codex,
 * Pi (their own drivers) and Google Antigravity (its ACP profile, #4899). The generic ACP driver
 * serves every other agent and knows none, so their launch there is refused.
 *
 * This is the one rule, shared by the control plane (session creation), the runner (worktree
 * create/select, launch and the relaunch after a worktree switch) and the dashboard, so all of them
 * refuse before a worktree is created or a running provider is retired. A runner configured for
 * bwrap or Seatbelt runs every agent with its HOME read-only already and is unaffected. */

import { ANTIGRAVITY_AGENT_ID } from "./antigravity-setup.js";

export interface ManagedWorktreeAgentInput {
  /** The runner's operating system. */
  os: "windows" | "linux" | "macos" | undefined;
  /** The runner's configured execution isolation; unknown (an older runner) is never refused. */
  isolationMode: "provider" | "bwrap" | "seatbelt" | "windows-job" | undefined;
  driver: string;
  agentId: string | null | undefined;
  /** Where the agent's definition came from. An operator-configured agent that reuses Antigravity's
   * id (`config`) runs without Antigravity's profile, so its state directory is unknown too. */
  agentSource?: "config" | "discovered" | "registry";
  /** The agent's display name for the refusal; "This agent" when unknown (the runner has none). */
  agentName?: string;
  /** The launch context kind; only native launches are sandboxed this way. */
  contextKind: string | undefined;
  /** The execution target adapter; only host launches are sandboxed this way. */
  targetAdapter?: string;
}

/** Why this agent cannot run in a managed worktree on this runner, or null when it can. The reason
 * is a complete sentence for the person starting or switching the session. */
export function managedWorktreeUnsupportedReason(input: ManagedWorktreeAgentInput): string | null {
  if (input.os !== "linux" || input.isolationMode !== "provider") return null;
  if ((input.contextKind ?? "native") !== "native") return null;
  if (input.targetAdapter !== undefined && input.targetAdapter !== "host") return null;
  if (input.driver !== "acp") return null;
  if (input.agentId === ANTIGRAVITY_AGENT_ID && input.agentSource !== "config") return null;
  const name = input.agentName?.trim() || "This agent";
  return `${name} can't run in a managed worktree on this machine: its sandbox would make the agent's ` +
    "own settings and conversations read-only. Start the session In Place instead.";
}
