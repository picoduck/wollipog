/** Wollipog Assistant threads (#4663). A thread is the owner's conversation with the built-in
 * assistant; its transcript and composer are the backing `assistant`-role session's own routes.
 * These views never carry a credential value or hash. */

/** The harnesses a thread can run on. `codex` selects a runner's Codex agent (App Server when
 * installed, otherwise the Codex CLI driver). */
export type AssistantThreadHarness = "claude-code" | "codex";
export const ASSISTANT_THREAD_HARNESSES: readonly AssistantThreadHarness[] = ["claude-code", "codex"];

/** `needs_you` while the backing session (or, later, a pending owner request bound to the thread)
 * awaits the owner; `working` while it runs; `done` when idle; `archived` after archive. */
export type AssistantThreadStatus = "working" | "needs_you" | "done" | "archived";

/** The only assistant today. Outside assistants arrive later as Activity, not threads. */
export type AssistantThreadAssistant = "wollipog";

export interface AssistantThreadAccess {
  level: "full_access";
  /** Destructive Assistant operations require a confirmation the assistant cannot give itself. */
  destructive: "ask";
}

/** What one thread may spend and launch (#4663). They stop a runaway or recursive assistant: the
 * backing session is capped at the cost budget, a launch is refused once the thread has launched
 * `launchedSessions` sessions or spent its budget, and each launched session is capped at what
 * remains. The owner can always start a new thread. */
export const ASSISTANT_THREAD_LIMITS = { launchedSessions: 10, costUsd: 25 } as const;

export interface AssistantThreadUsage {
  launchedSessions: { used: number; limit: number };
  /** The backing session's cost plus every launched session's. */
  costUsd: { used: number; limit: number };
}

export interface AssistantThread {
  /** `thr_…` */
  id: string;
  assistant: AssistantThreadAssistant;
  title: string;
  harness: AssistantThreadHarness;
  /** Backing session, role `assistant`. */
  sessionId: string;
  status: AssistantThreadStatus;
  access: AssistantThreadAccess;
  /** The thread-scoped Assistant connection, once minted. Null until the runner proxy holds one. */
  connectionId: string | null;
  /** Sessions this thread's assistant launched, oldest first. */
  launchedSessionIds: string[];
  /** Additive: the thread's limits and what it has used of them. */
  usage?: AssistantThreadUsage;
  /** Additive (#4665): destructive commands of this thread's assistant waiting for the owner, oldest
   * first. While any is listed the thread's status is `needs_you`. */
  confirmations?: AssistantOwnerConfirmation[];
  lastActivityAt: number;
  createdAt: number;
  archivedAt: number | null;
}

export interface AssistantThreadListResponse { threads: AssistantThread[] }
export interface AssistantThreadResponse { thread: AssistantThread }

export interface CreateAssistantThreadRequest {
  /** Defaults to the owner's saved Orchestrator Child Harness, else Claude Code. */
  harness?: AssistantThreadHarness;
  title?: string;
  /** Defaults to an online Machine the owner can use that supports the role and harness. */
  runnerId?: string;
  /** A Location on `runnerId`; defaults to the Machine's first one the owner can use. */
  workspaceId?: string;
}

export interface UpdateAssistantThreadRequest { title: string }

export interface AssistantThreadHarnessOption {
  id: AssistantThreadHarness;
  label: string;
  available: boolean;
  /** Present when unavailable: what the owner can do about it. */
  reason?: string;
}

export interface AssistantThreadDefaultsResponse {
  harness: AssistantThreadHarness;
  harnesses: AssistantThreadHarnessOption[];
}

/** A thread credential authenticates for this long after the runner registers it. The runner
 * proxy registers a fresh one at each launch and before half of this has passed (#4663). */
export const ASSISTANT_THREAD_CREDENTIAL_TTL_MS = 60 * 60 * 1000;

/** The stable MCP server name under which an Assistant thread's session sees its tools. */
export const ASSISTANT_MCP_SERVER_NAME = "wollipog_assistant";

/** Runner launch marker for an `assistant`-role session. The runner launches it without the
 * general Wollipog agent-control server and CLI, and refuses the marker on a harness it cannot
 * launch that way. */
export interface AssistantLaunchPolicy {
  threadId: string;
  /** The shared `wollipog` assistant skill, given to the session with its role instructions.
   * Older runners ignore it and launch with the instructions alone. */
  guide?: string;
}

/** How long the owner has to answer an Assistant thread's owner confirmation (#4665). An
 * unanswered request then expires and the command does not run. */
export const ASSISTANT_OWNER_CONFIRMATION_TTL_MS = 60 * 60 * 1000;

/** `pending` until the owner answers. `approved` while the approved command runs, `executed` once
 * it ran (its receipt holds the result). `denied`, `expired` and `refused` (the bound command,
 * target or grant changed, or the thread ended) mean it never ran. */
export type AssistantOwnerConfirmationStatus = "pending" | "approved" | "executed" | "denied" | "expired" | "refused";

/** One line of what an owner confirmation would do, derived by the control plane for display. */
export interface AssistantOwnerConfirmationDetail { label: string; value: string }

/** A destructive command a Wollipog Assistant thread's assistant asked to run (#4665). Only its
 * owner can answer it, from the thread or the Inbox. It is bound to the exact connection,
 * operation, target, arguments and grant revision; approving runs that command once, and its id
 * is never given to the assistant. */
export interface AssistantOwnerConfirmation {
  /** `aoc_…`, owner-facing only. */
  id: string;
  threadId: string;
  /** The Assistant operation, e.g. `session_archive`. */
  operation: string;
  /** Title Case action label, e.g. "Archive Session". */
  title: string;
  target: { kind: string; id: string; label: string };
  /** What the command affects, as the operation previewed it. */
  impact: AssistantOwnerConfirmationDetail[];
  /** The command's exact arguments, without its command ID. */
  arguments: AssistantOwnerConfirmationDetail[];
  status: AssistantOwnerConfirmationStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  /** Present once resolved: the command receipt's status after it ran, or why it did not run. */
  outcome?: { receiptStatus?: "accepted" | "running" | "succeeded" | "failed" | "uncertain"; reason?: string };
}

export interface AssistantOwnerConfirmationResponse { confirmation: AssistantOwnerConfirmation; thread: AssistantThread }
