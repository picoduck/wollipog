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
  /** Per-thread only. Omission leaves the existing pause state alone. */
  launchPaused?: boolean;
}

/** Saved on creation, so changing the owner's defaults never changes an existing thread. */
export const DEFAULT_ASSISTANT_THREAD_LIMITS = { launchedSessions: 10, costUsd: 25 } as const;

export const ASSISTANT_EVIDENCE_INSPECT = "assistant_evidence_inspect";
export const ASSISTANT_EVIDENCE_PREPARE = "assistant_evidence_prepare";
export const ASSISTANT_EVIDENCE_GET = "assistant_evidence_get";
/** Private to the authenticated runner proxy. The stdio adapter may only call the public tool. */
export const ASSISTANT_EVIDENCE_RELAY_DELIVER = "wollipog/evidence-deliver";
export const ASSISTANT_EVIDENCE_RELAY_ACK = "wollipog/evidence-acknowledge";
export const ASSISTANT_EVIDENCE_RETENTION_DISCLOSURE =
  "Wollipog sends screenshots to the provider and model shown here. The provider may retain them under the selected account’s terms. Wollipog records evidence references, digests, and receipts in its decision audit.";

export type AssistantEvidenceReviewAvailability =
  | { available: true; provider: string; model: string; disclosureDigest: string }
  | { available: false; reason: string };

export const ASSISTANT_DECISION_CATEGORIES = {
  owner_question: "Answer Owner Questions",
  pr_merge: "Merge Pull Requests",
  ci_rerun: "Rerun CI",
  release_tag: "Tag Releases",
  release_publish: "Publish Releases",
  merged_branch_deletion: "Delete Merged Branches",
  follow_up_issue_publication: "Publish Follow-Up Issues",
  issue_closure: "Close Issues",
  ui_evidence_approval: "Send Back UI Evidence",
  ui_evidence_review: "Approve UI Evidence",
  review_round_extension: "Extend Review Rounds",
} as const;

export type AssistantDecisionCategory = keyof typeof ASSISTANT_DECISION_CATEGORIES;

export function assistantDecisionCategory(snapshot: WorkflowDecisionResourceSnapshot): AssistantDecisionCategory | null {
  if (snapshot.category === "owner_decision") return snapshot.kind === "question" ? "owner_question" : null;
  return Object.hasOwn(ASSISTANT_DECISION_CATEGORIES, snapshot.category) ? snapshot.category as AssistantDecisionCategory : null;
}

export interface AssistantDecisionGrant {
  categories: AssistantDecisionCategory[];
  /** How the owner picked the explicit categories. This is presentation metadata only. */
  selectionMode?: "all" | "choose";
  projects: "all" | string[];
  campaigns: "all" | string[];
  expiresAt: number | null;
  /** Owner-confirmed disclosure for the backing session's current provider, model and account. */
  evidenceDisclosureDigest?: string;
}

export const ASSISTANT_DECISION_DEFAULT_DURATIONS = {
  hour: 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
  never: null,
} as const;

/** Owner preference for future threads. A duration starts when each thread is created. */
export interface AssistantDecisionDefault extends Omit<AssistantDecisionGrant, "expiresAt" | "evidenceDisclosureDigest"> {
  expiresAfterMs: number | null;
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
  /** Display text derived from the approved snapshot, separate from its internal key. */
  subject?: string;
  delegation: RecordedAssistantDecisionResolution;
}

export interface AssistantDecisionHistoryPage {
  /** Total for the whole filter, on the first page of a thread history. */
  total?: number;
  entries: AssistantDecisionHistoryEntry[];
  nextBefore?: string;
}

export interface AssistantThreadUsage {
  launchedSessions: { used: number; limit: number | null };
  /** The backing session's cost plus every launched session's. */
  costUsd: { used: number; limit: number | null };
}

export interface AssistantThreadHistoryEntry {
  sessionId: string;
  harness: AssistantThreadHarness;
  nextHarness: AssistantThreadHarness;
  switchedAt: number;
}

export interface ChangeAssistantThreadHarnessRequest {
  expectedSessionId: string;
  harness: AssistantThreadHarness;
  providerAccountRef: string;
}

export interface AssistantThread {
  /** Absent on control planes that support denial only. */
  evidenceReview?: AssistantEvidenceReviewAvailability;
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
  harnessChangeSupported?: boolean;
  earlierConversations?: AssistantThreadHistoryEntry[];
  accountChangeSupported?: true;
  /** Sessions this thread's assistant launched, oldest first. */
  launchedSessionIds: string[];
  /** Owner-approved independent roots. Their usage and descendants belong to their own campaign. */
  launchedCampaignIds?: string[];
  /** Additive: the thread's limits and what it has used of them. */
  usage?: AssistantThreadUsage;
  /** Advertises the dedicated owner limits write route. Absent on older control planes. */
  limitsEditable?: true;
  /** An explicit boolean advertises support for pausing without changing the launch limit. */
  launchPaused?: boolean;
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
  accounts: {
    accountRef: string;
    label: string;
    reason?: ProviderAccountSkipReason;
    /** When the current usage limit is expected to reset, if known. */
    retryAt?: number;
  }[];
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
  /** Absent on older control planes. Null means Ask Me. */
  decisionDefault?: AssistantDecisionDefault | null;
}

export interface AssistantThreadLaunchDefaults {
  harness: AssistantThreadHarness;
  providerAccount: { runnerId: string; accountRef: string } | null;
}

export type AssistantThreadLaunchDefaultsPatch =
  | Pick<AssistantThreadLaunchDefaults, "harness">
  | (Pick<AssistantThreadLaunchDefaults, "providerAccount"> & { expectedHarness: AssistantThreadHarness });

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
