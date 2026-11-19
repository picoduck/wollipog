/**
 * The Wollipog Assistant's Thread API, as the web client sees it (#4664).
 *
 * Every thread request the dashboard makes goes through `assistantThreadRoutes`. The shapes are the
 * control plane's own (#4663, `packages/protocol/src/assistant-threads.ts`), re-exported here so the
 * dashboard names them in one place.
 *
 * A control plane without the routes answers 404. That is not an error the person can act on, so
 * `assistantThreadsUnavailable` names it and the Assistants section shows its empty, unavailable
 * state instead of a failure. Nothing here invents a thread: the only threads the dashboard shows
 * are ones the control plane returned.
 */
import type {
  AssistantThread,
  AssistantThreadAccess,
  AssistantThreadAccountChoices,
  AssistantThreadDefaultsResponse,
  AssistantThreadHarness,
  AssistantThreadHarnessOption,
  AssistantThreadListResponse,
  AssistantThreadResponse,
  ChangeAssistantThreadAccountRequest,
  CreateAssistantThreadRequest,
  UpdateAssistantThreadRequest,
} from "@wollipog/protocol";
import { ApiError } from "./api.js";

export type {
  AssistantThread,
  AssistantThreadAccess,
  AssistantThreadHarness,
  AssistantThreadHarnessOption,
  AssistantThreadStatus,
  CreateAssistantThreadRequest,
} from "@wollipog/protocol";
/** What New Thread reads: the saved Orchestrator harness it preselects, and each harness's state. */
export type AssistantThreadDefaults = AssistantThreadDefaultsResponse;

export const ASSISTANT_THREADS_PATH = "/api/assistant-threads";

function threadPath(threadId: string): string {
  return `${ASSISTANT_THREADS_PATH}/${encodeURIComponent(threadId)}`;
}

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

/** The Thread API's requests, spread into the API client (`api.ts`). */
export function assistantThreadRoutes(req: JsonRequest) {
  return {
    /** Newest activity first. Archived threads come back only when asked for. */
    assistantThreads: (options: { includeArchived?: boolean } = {}) =>
      req<AssistantThreadListResponse>(
        options.includeArchived ? `${ASSISTANT_THREADS_PATH}?includeArchived=true` : ASSISTANT_THREADS_PATH,
      ),
    /** One thread, archived ones included: what a link to a thread the list leaves out opens. */
    assistantThread: (threadId: string) => req<AssistantThreadResponse>(threadPath(threadId)),
    assistantThreadDefaults: () => req<AssistantThreadDefaults>(`${ASSISTANT_THREADS_PATH}/defaults`),
    /** An unsupported runner or harness is refused with 409 and the server's guidance. */
    createAssistantThread: (body: CreateAssistantThreadRequest) =>
      req<AssistantThreadResponse>(ASSISTANT_THREADS_PATH, { method: "POST", body: JSON.stringify(body) }),
    renameAssistantThread: (threadId: string, title: string) =>
      req<AssistantThreadResponse>(threadPath(threadId), {
        method: "PATCH",
        body: JSON.stringify({ title } satisfies UpdateAssistantThreadRequest),
      }),
    archiveAssistantThread: (threadId: string) =>
      req<AssistantThreadResponse>(`${threadPath(threadId)}/archive`, { method: "POST", body: "{}" }),
    assistantThreadAccountChoices: (threadId: string) =>
      req<AssistantThreadAccountChoices>(`${threadPath(threadId)}/account`),
    changeAssistantThreadAccount: (threadId: string, body: ChangeAssistantThreadAccountRequest) =>
      req<AssistantThreadResponse>(`${threadPath(threadId)}/account`, { method: "POST", body: JSON.stringify(body) }),
  };
}

/** The longest title the control plane accepts (#4663); the title fields stop there. */
export const ASSISTANT_THREAD_TITLE_MAX = 120;

/** The body a control plane sends for a route it does not have (its not-found handler). */
const MISSING_ROUTE_ERROR = "not found";

/**
 * Whether a Thread API failure means this control plane has no threads at all (it predates them).
 * A 404 counts only when it is the server's answer for a route it lacks, or carries no body: a
 * refusal names what was not found ("Machine not found.") and is the person's to read.
 */
export function assistantThreadsUnavailable(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return false;
  if (cause.status === 405 || cause.status === 501) return true;
  if (cause.status !== 404) return false;
  const error = cause.details?.error;
  return error === undefined || error === MISSING_ROUTE_ERROR;
}

/** Whether the person is refused because only an organization owner can use threads (403), with
 * the control plane's own words for it. */
export function assistantThreadsOwnerOnly(cause: unknown): string | null {
  if (!(cause instanceof ApiError) || cause.status !== 403) return null;
  return cause.message.trim() || "Only an organization owner can use Wollipog Assistant threads.";
}

/** One thread change the control plane published, numbered in arrival order (the store's log). */
export interface NumberedAssistantThread {
  seq: number;
  thread: AssistantThread;
}

/**
 * The list with every event after `afterSeq` applied, in order: a changed thread replaces its row,
 * a new one joins, and an archived one leaves. Applying the events newer than a read's start to
 * what the read returned keeps a change that landed while the read was in flight.
 */
export function applyAssistantThreadEvents(
  threads: readonly AssistantThread[],
  events: readonly NumberedAssistantThread[],
  afterSeq: number,
): AssistantThread[] {
  let next = [...threads];
  for (const { seq, thread } of events) {
    if (seq <= afterSeq) continue;
    next = next.filter((candidate) => candidate.id !== thread.id);
    if (thread.status !== "archived") next.push(thread);
  }
  return sortAssistantThreads(next);
}

/** The words the person sees for each harness, whatever the server's defaults call them. */
export const ASSISTANT_THREAD_HARNESS_LABELS: Readonly<Record<AssistantThreadHarness, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** A thread's harness by name; a harness the server's options label is shown by that label. */
export function assistantThreadHarnessLabel(
  harness: AssistantThreadHarness,
  options?: readonly AssistantThreadHarnessOption[],
): string {
  return options?.find((option) => option.id === harness)?.label || ASSISTANT_THREAD_HARNESS_LABELS[harness] || harness;
}

/** "Full Access · Ask Before Destructive": the thread's access level as its header shows it. */
export function assistantThreadAccessLabel(access: AssistantThreadAccess): string {
  const level = access.level === "full_access" ? "Full Access" : "Limited Access";
  const destructive = access.destructive === "ask" ? "Ask Before Destructive" : "Destructive Allowed";
  return `${level} · ${destructive}`;
}

/** The thread list's order: newest activity first, as the server sends it, and stable on ties. */
export function sortAssistantThreads(threads: readonly AssistantThread[]): AssistantThread[] {
  return [...threads].sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** A title the person can read: an untitled thread is "New Thread". */
export function assistantThreadTitle(thread: Pick<AssistantThread, "title">): string {
  return thread.title.trim() || "New Thread";
}
