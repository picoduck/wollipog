/**
 * Owner confirmations of Wollipog Assistant threads (#4665), as the web client reads them.
 *
 * A thread's destructive command waits for its owner instead of being confirmed by its assistant.
 * Each thread lists its pending requests in `confirmations`; the Inbox sums them up by thread, and
 * the thread view draws its own to be answered. `assistant_thread_upsert` web events carry each change, which
 * the store announces here so a mounted list knows when to read the Thread API again.
 */
import type { AssistantOwnerConfirmation, AssistantThread } from "@wollipog/protocol";

const THREAD_UPSERT_EVENT = "wollipog:assistant-thread-upsert";

/** Called by the store for every `assistant_thread_upsert` it receives. */
export function announceAssistantThread(thread: AssistantThread): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AssistantThread>(THREAD_UPSERT_EVENT, { detail: thread }));
}

/** Follows announced thread changes until the returned function is called. */
export function onAssistantThreadUpsert(listener: (thread: AssistantThread) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<AssistantThread>).detail);
  window.addEventListener(THREAD_UPSERT_EVENT, handle);
  return () => window.removeEventListener(THREAD_UPSERT_EVENT, handle);
}

export interface PendingAssistantConfirmation {
  confirmation: AssistantOwnerConfirmation;
  threadId: string;
  threadTitle: string;
}

/** Every thread's pending owner confirmations, oldest request first. */
export function pendingAssistantConfirmations(threads: Iterable<AssistantThread>, now = Date.now()): PendingAssistantConfirmation[] {
  const pending: PendingAssistantConfirmation[] = [];
  for (const thread of threads) {
    if (thread.status === "archived") continue;
    for (const confirmation of thread.confirmations ?? []) {
      if (confirmation.status === "pending" && confirmation.expiresAt > now) pending.push({ confirmation, threadId: thread.id, threadTitle: thread.title });
    }
  }
  return pending.sort((left, right) => left.confirmation.createdAt - right.confirmation.createdAt ||
    (left.confirmation.id < right.confirmation.id ? -1 : 1));
}

export interface AssistantThreadConfirmations {
  threadId: string;
  threadTitle: string;
  /** The thread's pending requests, oldest first; never empty. */
  confirmations: AssistantOwnerConfirmation[];
  /** When the first of them expires. */
  expiresAt: number;
}

/** Every thread's pending owner confirmations, one entry per thread that has any: the thread whose
 * oldest request is oldest first, as `pendingAssistantConfirmations` orders the requests. */
export function pendingAssistantConfirmationsByThread(threads: Iterable<AssistantThread>, now = Date.now()): AssistantThreadConfirmations[] {
  const byThread = new Map<string, AssistantThreadConfirmations>();
  for (const { confirmation, threadId, threadTitle } of pendingAssistantConfirmations(threads, now)) {
    const group = byThread.get(threadId);
    if (group) {
      group.confirmations.push(confirmation);
      group.expiresAt = Math.min(group.expiresAt, confirmation.expiresAt);
    } else {
      byThread.set(threadId, { threadId, threadTitle, confirmations: [confirmation], expiresAt: confirmation.expiresAt });
    }
  }
  return [...byThread.values()];
}

/** Which requests a thread has waiting, as one comparable value. */
export function assistantThreadPendingKey(thread: AssistantThread): string {
  if (thread.status === "archived") return "";
  return (thread.confirmations ?? []).filter((confirmation) => confirmation.status === "pending")
    .map((confirmation) => confirmation.campaign ? `${confirmation.id}:${confirmation.campaign.digest}` : confirmation.id).sort().join("\n");
}

/** What the card says once the owner answered, for its toast. */
export function assistantConfirmationOutcome(confirmation: AssistantOwnerConfirmation): { tone: "success" | "error" | "info"; message: string } {
  switch (confirmation.status) {
    case "executed":
      return confirmation.outcome?.receiptStatus === "succeeded"
        ? { tone: "success", message: `${confirmation.title} ran once.` }
        : { tone: "info", message: `${confirmation.title} ran once; its result is ${confirmation.outcome?.receiptStatus ?? "unknown"}.` };
    case "denied": return { tone: "info", message: `${confirmation.title} was denied. Nothing ran.` };
    case "expired": return { tone: "info", message: `${confirmation.title} expired before you answered. Nothing ran.` };
    case "refused": return { tone: "error", message: `${confirmation.title} did not run: ${confirmation.outcome?.reason ?? "it no longer matched."}` };
    default: return { tone: "info", message: `${confirmation.title} is running.` };
  }
}
