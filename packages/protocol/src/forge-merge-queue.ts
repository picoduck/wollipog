/**
 * Merge-queue state of a forge change request (#604, protocol v381).
 *
 * A repository that protects its base branch with a GitHub merge queue merges asynchronously:
 * enqueueing adds the pull request to the queue, GitHub tests it on top of the current base in a
 * merge group, and lands it later or removes it. The runner reads that state through its own `gh`
 * login and reports it here; every surface (the Review panel's request summary, Inbox rows, and the
 * Pull Request view) maps it through `mergeQueueStatus`, so they agree on wording and attention.
 *
 * GitLab merge trains are not read into the session summary yet: a merge request carries no queue
 * state, and surfaces show none.
 */

/** GitHub's `MergeQueueEntryState`, lowercased. */
export type ForgeMergeQueueEntryState = "queued" | "awaiting_checks" | "mergeable" | "unmergeable" | "locked";

export const FORGE_MERGE_QUEUE_ENTRY_STATES: readonly ForgeMergeQueueEntryState[] =
  ["queued", "awaiting_checks", "mergeable", "unmergeable", "locked"];

/** A check rollup reduced to one word. */
export type ForgeCheckRollupState = "passing" | "failing" | "pending";

/** The pull request's entry in its base branch's merge queue. */
export interface ForgeMergeQueueEntry {
  state: ForgeMergeQueueEntryState;
  /** 1-based position, when GitHub reports one. */
  position: number | null;
  /** Epoch milliseconds, when GitHub reports it. */
  enqueuedAt: number | null;
  /** The merge group's own checks, or null before GitHub has built a group or reported any. */
  groupChecks: ForgeCheckRollupState | null;
}

/** GitHub's latest removal of the pull request's current head from the queue, when no entry has
 * replaced it. `reason` is GitHub's own token (for example `failed_checks` or `merge_conflict`). */
export interface ForgeMergeQueueRemoval {
  reason: string | null;
  /** Epoch milliseconds. */
  removedAt: number;
}

/**
 * Merge-queue facts for one open pull request. Absent on the wire means unknown (an older runner,
 * a GitLab merge request, a closed or merged pull request, or a failed read), never "no queue".
 */
export interface ForgeMergeQueueFacts {
  /** The base branch has a merge queue; null when GitHub did not say. */
  enabled: boolean | null;
  entry: ForgeMergeQueueEntry | null;
  removal: ForgeMergeQueueRemoval | null;
}

export type MergeQueueStatusKind = "queued" | "merging" | "unmergeable" | "removed";

/** How every surface presents merge-queue facts. */
export interface MergeQueueStatus {
  kind: MergeQueueStatusKind;
  /** Title Case label for a compact badge or fact. */
  label: string;
  /** One sentence for a tooltip, description or screen reader. */
  detail: string;
  tone: "info" | "success" | "danger";
  /** A person should look: GitHub gave up on the entry or removed it. Comparable to failing checks. */
  attention: boolean;
}

const REMOVAL_REASONS: Record<string, string> = {
  failed_checks: "a merge-group check failed",
  ci_failure: "a merge-group check failed",
  checks_timed_out: "merge-group checks timed out",
  ci_timeout: "merge-group checks timed out",
  merge_conflict: "it conflicts with the base branch or a pull request ahead of it",
  manual: "someone removed it",
  queue_cleared: "the queue was cleared",
  branch_protections: "it no longer meets the branch's protection rules",
  roll_back: "the queue rolled back",
};

/** Sentence-case reason GitHub gave for a removal, without a trailing period. */
export function mergeQueueRemovalReason(reason: string | null | undefined): string {
  const token = (reason ?? "").trim().toLowerCase();
  if (!token) return "GitHub gave no reason";
  return REMOVAL_REASONS[token] ?? token.replace(/[_-]+/gu, " ").slice(0, 120);
}

/** Short Title Case reason for a compact label, such as an Inbox row's "Dequeued: Check Failed".
 * Kept short so it fits a phone row; the full sentence is `mergeQueueRemovalReason`. */
export function mergeQueueRemovalReasonLabel(reason: string | null | undefined): string {
  const token = (reason ?? "").trim().toLowerCase();
  const labels: Record<string, string> = {
    failed_checks: "Check Failed", ci_failure: "Check Failed",
    checks_timed_out: "Timed Out", ci_timeout: "Timed Out",
    merge_conflict: "Merge Conflict", manual: "By Hand",
    queue_cleared: "Queue Cleared", branch_protections: "Branch Rules", roll_back: "Rolled Back",
  };
  if (labels[token]) return labels[token];
  if (!token) return "No Reason Given";
  return token.replace(/[_-]+/gu, " ").slice(0, 60).replace(/\b\p{Ll}/gu, (letter) => letter.toUpperCase());
}

/**
 * The merge-queue status to show for a change request, or null when there is none to show: a
 * repository without a queue, a pull request never enqueued, one that merged or closed, or facts
 * an older runner did not report. `state` is the forge state word (`OPEN`, `open`, ...); anything
 * but open shows no queue state, since Merged or Closed already says what happened.
 */
export function mergeQueueStatus(
  facts: ForgeMergeQueueFacts | null | undefined,
  state?: string | null,
): MergeQueueStatus | null {
  if (!facts || (state != null && state.toLowerCase() !== "open")) return null;
  const entry = facts.entry;
  if (entry) {
    const position = entry.position !== null && entry.position > 0 ? ` at position ${entry.position}` : "";
    switch (entry.state) {
      case "unmergeable":
        return {
          kind: "unmergeable", label: "Unmergeable in Merge Queue", tone: "danger", attention: true,
          detail: "GitHub marked the queued pull request unmergeable; it stays queued until the conflict ahead of it is resolved.",
        };
      case "locked":
        return { kind: "merging", label: "Merging", tone: "success", attention: false, detail: "GitHub is merging this pull request now." };
      case "mergeable":
        return {
          kind: "queued", label: "In Merge Queue", tone: "info", attention: false,
          detail: `In the merge queue${position}; its merge group passed and it is waiting to land.`,
        };
      case "awaiting_checks":
        return {
          kind: "queued", label: "In Merge Queue", tone: "info", attention: false,
          detail: entry.groupChecks === "failing"
            ? `In the merge queue${position}; a merge-group check failed, and GitHub may rebuild the group or remove it.`
            : `In the merge queue${position}; its merge-group checks are running.`,
        };
      default:
        return { kind: "queued", label: "In Merge Queue", tone: "info", attention: false, detail: `In the merge queue${position}, waiting for its turn.` };
    }
  }
  const removal = facts.removal;
  // A base whose queue is now off (disabled, or the pull request was retargeted) makes an earlier
  // removal history, not a state to act on. Unknown (null) keeps the removal.
  if (!removal || facts.enabled === false) return null;
  // GitHub records a removal when the entry lands; the pull request reads MERGED a moment later.
  if ((removal.reason ?? "").toLowerCase() === "merged") {
    return { kind: "merging", label: "Merging", tone: "success", attention: false, detail: "GitHub merged this pull request from the merge queue." };
  }
  return {
    kind: "removed",
    label: "Removed from Merge Queue",
    tone: "danger",
    attention: true,
    detail: `GitHub removed this pull request from the merge queue because ${mergeQueueRemovalReason(removal.reason)}.`,
  };
}

function finiteTime(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Validate merge-queue facts from a peer, or null when they are malformed. Strings are bounded. */
export function validForgeMergeQueueFacts(value: unknown): ForgeMergeQueueFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const enabled = raw.enabled === true || raw.enabled === false ? raw.enabled : null;
  let entry: ForgeMergeQueueEntry | null = null;
  if (raw.entry !== null && raw.entry !== undefined) {
    const e = raw.entry as Record<string, unknown>;
    if (typeof e !== "object" || !FORGE_MERGE_QUEUE_ENTRY_STATES.includes(e.state as ForgeMergeQueueEntryState)) return null;
    const groupChecks = e.groupChecks === "passing" || e.groupChecks === "failing" || e.groupChecks === "pending" ? e.groupChecks : null;
    entry = {
      state: e.state as ForgeMergeQueueEntryState,
      position: typeof e.position === "number" && Number.isSafeInteger(e.position) && e.position > 0 ? e.position : null,
      enqueuedAt: finiteTime(e.enqueuedAt),
      groupChecks,
    };
  }
  let removal: ForgeMergeQueueRemoval | null = null;
  if (raw.removal !== null && raw.removal !== undefined) {
    const r = raw.removal as Record<string, unknown>;
    const removedAt = typeof r === "object" ? finiteTime(r.removedAt) : null;
    if (removedAt === null) return null;
    removal = { reason: typeof r.reason === "string" && r.reason ? r.reason.slice(0, 64) : null, removedAt };
  }
  return { enabled, entry, removal: entry ? null : removal };
}

/** Two facts describe the same queue state (used to avoid persisting an unchanged observation). */
export function sameForgeMergeQueueFacts(a: ForgeMergeQueueFacts | null | undefined, b: ForgeMergeQueueFacts | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
