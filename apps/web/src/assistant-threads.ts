/**
 * The Wollipog Assistant's Thread API, as the web client sees it (#4664).
 *
 * Every thread request the dashboard makes goes through `assistantThreadRoutes`, and every thread
 * shape it reads is declared here. The types mirror the provisional contract shared with #4663,
 * which builds the control-plane routes; when those routes and their protocol types land, swapping
 * them in touches this module alone.
 *
 * A control plane without the routes answers 404. That is not an error the person can act on, so
 * `assistantThreadsUnavailable` names it and the Assistants section shows its empty, unavailable
 * state instead of a failure. Nothing here invents a thread: the only threads the dashboard shows
 * are ones the control plane returned.
 */
import { ApiError } from "./api.js";

/** The harnesses a thread can run on. */
export type AssistantThreadHarness = "claude-code" | "codex";

/** Where a thread stands. `needs_you` means a confirmation or approval in it is waiting for you. */
export type AssistantThreadStatus = "working" | "needs_you" | "done" | "archived";

/** What the assistant may do in a thread. No credential is ever part of it. */
export interface AssistantThreadAccess {
  level: "full_access";
  destructive: "ask";
}

export interface AssistantThread {
  /** `thr_…` */
  id: string;
  assistant: "wollipog";
  title: string;
  harness: AssistantThreadHarness;
  /** The backing session (role "assistant"): its transcript and composer are the thread's. */
  sessionId: string;
  status: AssistantThreadStatus;
  access: AssistantThreadAccess;
  /** The thread-scoped assistant connection, by id only; its credential is never sent here. */
  connectionId: string | null;
  /** Sessions the assistant launched from this thread, shown as work cards. */
  launchedSessionIds: string[];
  lastActivityAt: number;
  createdAt: number;
  archivedAt: number | null;
}

export interface AssistantThreadHarnessOption {
  id: AssistantThreadHarness;
  label: string;
  available: boolean;
  /** Why the harness can't be chosen, in the person's words. */
  reason?: string;
}

export interface AssistantThreadDefaults {
  /** The saved Orchestrator harness, which New Thread preselects. */
  harness: AssistantThreadHarness;
  harnesses: AssistantThreadHarnessOption[];
}

export interface CreateAssistantThreadRequest {
  harness?: AssistantThreadHarness;
  title?: string;
  runnerId?: string;
  workspaceId?: string;
}

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
      req<{ threads: AssistantThread[] }>(
        options.includeArchived ? `${ASSISTANT_THREADS_PATH}?includeArchived=true` : ASSISTANT_THREADS_PATH,
      ),
    assistantThreadDefaults: () => req<AssistantThreadDefaults>(`${ASSISTANT_THREADS_PATH}/defaults`),
    /** An unsupported runner or harness is refused with 409 and the server's guidance. */
    createAssistantThread: (body: CreateAssistantThreadRequest) =>
      req<{ thread: AssistantThread }>(ASSISTANT_THREADS_PATH, { method: "POST", body: JSON.stringify(body) }),
    renameAssistantThread: (threadId: string, title: string) =>
      req<{ thread: AssistantThread }>(threadPath(threadId), { method: "PATCH", body: JSON.stringify({ title }) }),
    archiveAssistantThread: (threadId: string) =>
      req<{ thread: AssistantThread }>(`${threadPath(threadId)}/archive`, { method: "POST", body: "{}" }),
  };
}

/** Whether a Thread API failure means this control plane has no threads at all (it predates them). */
export function assistantThreadsUnavailable(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.status === 405 || cause.status === 501);
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
