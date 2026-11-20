/** Wollipog Assistant threads (#4663). A thread is the owner's conversation with the built-in
 * assistant; its transcript and composer are the backing `assistant`-role session's own routes.
 * These views never carry a credential value or hash. */
import type { ProviderAccountSkipReason } from "./provider-account-selection.js";
import type { OrchestratorCampaignBudgetDefault, WorkflowDecisionResourceSnapshot } from "./index.js";

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

/** Independent limits. A null limit is an explicit owner choice to remove it. */
export interface AssistantThreadLimits {
  costUsd: number | null;
  launchedSessions: number | null;
}

/** Saved on creation, so changing the owner's defaults never changes an existing thread. */
export const DEFAULT_ASSISTANT_THREAD_LIMITS = { launchedSessions: 10, costUsd: 25 } as const;

export const ASSISTANT_DECISION_CATEGORIES = {
  owner_question: "Owner Questions",
  pr_merge: "Pull Request Merge",
  merged_branch_deletion: "Merged Branch Deletion",
  follow_up_issue_publication: "Follow-Up Issue Publication",
  issue_closure: "Issue Closure",
  ui_evidence_approval: "UI Evidence Denial",
  review_round_extension: "Review Round Extension",
} as const;

export type AssistantDecisionCategory = keyof typeof ASSISTANT_DECISION_CATEGORIES;

export function assistantDecisionCategory(snapshot: WorkflowDecisionResourceSnapshot): AssistantDecisionCategory | null {
  if (snapshot.category === "owner_decision") return snapshot.kind === "question" ? "owner_question" : null;
  return Object.hasOwn(ASSISTANT_DECISION_CATEGORIES, snapshot.category) ? snapshot.category as AssistantDecisionCategory : null;
}

export interface AssistantDecisionGrant {
  categories: AssistantDecisionCategory[];
  projects: "all" | string[];
  campaigns: "all" | string[];
  expiresAt: number | null;
}

export interface AssistantDecisionDelegation {
  revision: number;
  grant: AssistantDecisionGrant | null;
}

/** Attribution is captured with the resolution, independent of the thread's current grant. */
export interface AssistantDecisionResolution {
  threadId: string;
  threadTitle?: string;
  ownerUserId: string;
  organizationId: string;
  grantRevision: number;
  campaignId: string;
  reason: string;
}

export interface RecordedAssistantDecisionResolution extends AssistantDecisionResolution {
  outcome: "approved" | "denied" | "answered";
  resolvedAt: number;
}

export interface AssistantDecisionHistoryEntry {
  occurrenceId: string;
  sessionId: string;
  category: AssistantDecisionCategory;
  resourceKey: string;
  delegation: RecordedAssistantDecisionResolution;
}

export interface AssistantDecisionHistoryPage {
  entries: AssistantDecisionHistoryEntry[];
  nextBefore?: string;
}

export interface AssistantThreadUsage {
  launchedSessions: { used: number; limit: number | null };
  /** The backing session's cost plus every launched session's. */
  costUsd: { used: number; limit: number | null };
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
  /** Owner-only label of the currently bound account. */
  providerAccountLabel?: string;
  /** An older control plane does not offer account changes. */
  accountChangeSupported?: true;
  /** Sessions this thread's assistant launched, oldest first. */
  launchedSessionIds: string[];
  /** Owner-approved independent roots. Their usage and descendants belong to their own campaign. */
  launchedCampaignIds?: string[];
  /** Additive: the thread's limits and what it has used of them. */
  usage?: AssistantThreadUsage;
  /** Advertises the dedicated owner limits write route. Absent on older control planes. */
  limitsEditable?: true;
  /** Absent on older control planes. A null grant gives the thread no decision authority. */
  decisionDelegation?: AssistantDecisionDelegation;
  /** An owner-facing refusal when the current thread cannot launch more work. */
  launchLimitRefusal?: string;
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
  /** Defaults to the owner's Assistant harness, else Claude Code. */
  harness?: AssistantThreadHarness;
  title?: string;
  /** Defaults to an online Machine the owner can use that supports the role and harness. */
  runnerId?: string;
  /** A Location on `runnerId`; defaults to the Machine's first one the owner can use. */
  workspaceId?: string;
  /** Opaque account reference, null for Machine Policy, or absent for the Assistant default. */
  providerAccountRef?: string | null;
}

export interface UpdateAssistantThreadRequest { title: string }

export interface AssistantThreadAccountChoices {
  accounts: { accountRef: string; label: string; reason?: ProviderAccountSkipReason }[];
  /** The Machine's policy will resolve again when a thread starts without a chosen account. */
  policyAccountRef?: string;
  policyRefusal?: string;
  currentAccountRef?: string;
  retryCurrentAccount?: boolean;
  unavailable?: string;
}

export interface ChangeAssistantThreadAccountRequest {
  providerAccountRef: string;
  expectedProviderAccountRef: string | null;
  freshConversation?: boolean;
}

export interface AssistantThreadHarnessOption {
  id: AssistantThreadHarness;
  label: string;
  available: boolean;
  /** Present when unavailable: what the owner can do about it. */
  reason?: string;
  /** The same Machine and Location creation selects for this harness. */
  accountSelection?: AssistantThreadAccountChoices & { runnerId: string; workspaceId: string };
}

export interface AssistantThreadDefaultsResponse {
  harness: AssistantThreadHarness;
  harnesses: AssistantThreadHarnessOption[];
  /** Absent on control planes that use the Orchestrator's harness and the Machine account policy. */
  launchDefaults?: AssistantThreadLaunchDefaults;
}

export interface AssistantThreadLaunchDefaults {
  harness: AssistantThreadHarness;
  providerAccount: { runnerId: string; accountRef: string } | null;
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
  /** What approving it does, as one plain sentence. */
  summary: string;
  target: { kind: string; id: string; label: string };
  /** What the command affects, as the operation previewed it. */
  impact: AssistantOwnerConfirmationDetail[];
  /** Every argument the approved run uses, without its command ID: `label` is the argument's exact
   * name and `value` its whole value (JSON for a non-string). Never truncated or relabeled. */
  arguments: AssistantOwnerConfirmationDetail[];
  /** Campaign-only fields. Approval sends the digest of the exact owner-visible launch. */
  campaign?: { digest: string; budget: OrchestratorCampaignBudgetDefault | null };
  status: AssistantOwnerConfirmationStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  /** Present once resolved: the command receipt's status after it ran, or why it did not run. */
  outcome?: { receiptStatus?: "accepted" | "running" | "succeeded" | "failed" | "uncertain"; reason?: string; sessionId?: string };
}

export interface AssistantOwnerConfirmationResponse { confirmation: AssistantOwnerConfirmation; thread: AssistantThread }
