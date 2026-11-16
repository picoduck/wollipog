/**
 * Merge-queue facts for a session's pull request (#604), read through this runner's `gh` login.
 * Read-only. The session summary and the worktree pull request reconciliation both use it, so the
 * Review panel and Inbox rows report the same queue state.
 */
import {
  FORGE_MERGE_QUEUE_ENTRY_STATES,
  validForgeMergeQueueFacts,
  type ForgeMergeQueueEntryState,
  type ForgeMergeQueueFacts,
} from "@wollipog/protocol";
import type { GhRunner } from "./campaign-forge-status.js";
import { readPullRequestQueue, type PullRequestQueueRead } from "./pull-request-wait.js";

/** `owner/name` and number of a github.com pull request URL, or null for anything else. */
export function githubPullRequestFromUrl(url: string): { repository: string; number: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return null;
  const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,9})\/?$/u.exec(parsed.pathname);
  if (!match || match[2] === "." || match[2] === "..") return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) ? { repository: `${match[1]}/${match[2]}`, number } : null;
}

function epoch(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** The protocol facts for one read. Unknown GitHub entry states are dropped rather than guessed. */
export function mergeQueueFactsFromRead(read: PullRequestQueueRead): ForgeMergeQueueFacts | undefined {
  if (read.state !== "open") return undefined;
  const state = read.entry?.state.toLowerCase() as ForgeMergeQueueEntryState | undefined;
  const entry = read.entry && state && FORGE_MERGE_QUEUE_ENTRY_STATES.includes(state)
    ? { state, position: read.entry.position, enqueuedAt: epoch(read.entry.enqueuedAt), groupChecks: read.entry.groupChecks }
    : null;
  const removedAt = read.removal ? epoch(read.removal.removedAt) : null;
  const removal = !entry && read.removal && removedAt !== null ? { reason: read.removal.reason, removedAt } : null;
  return validForgeMergeQueueFacts({ enabled: read.mergeQueueEnabled, entry, removal }) ?? undefined;
}

/** Merge-queue facts for an open github.com pull request, or undefined when they cannot be read. */
export async function githubMergeQueueFacts(pullRequestUrl: string, gh: GhRunner): Promise<ForgeMergeQueueFacts | undefined> {
  const ref = githubPullRequestFromUrl(pullRequestUrl);
  if (!ref) return undefined;
  try {
    const read = await readPullRequestQueue(ref.repository, ref.number, gh);
    return read.ok ? mergeQueueFactsFromRead(read.value) : undefined;
  } catch {
    return undefined;
  }
}
