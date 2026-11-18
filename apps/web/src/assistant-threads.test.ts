import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "./api.js";
import {
  applyAssistantThreadEvents,
  ASSISTANT_THREAD_TITLE_MAX,
  assistantThreadAccessLabel,
  assistantThreadHarnessLabel,
  assistantThreadRoutes,
  assistantThreadsOwnerOnly,
  assistantThreadsUnavailable,
  assistantThreadTitle,
  sortAssistantThreads,
  type AssistantThread,
} from "./assistant-threads.js";
import { ASSISTANT_THREAD_EVENTS_KEPT, Store } from "./store.js";
import { uiStreamSubscriptions } from "./ui-subscriptions.js";
import { viewFromPath, viewPath, viewTitle, type View } from "./navigation.js";

function thread(overrides: Partial<AssistantThread> = {}): AssistantThread {
  return {
    id: "thr_1",
    assistant: "wollipog",
    title: "Triage Open Issues",
    harness: "claude-code",
    sessionId: "sess_backing",
    status: "working",
    access: { level: "full_access", destructive: "ask" },
    connectionId: null,
    launchedSessionIds: [],
    lastActivityAt: 2_000,
    createdAt: 1_000,
    archivedAt: null,
    ...overrides,
  };
}

test("every Thread API request goes to the control plane's thread routes", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const routes = assistantThreadRoutes(async <T,>(path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
    return {} as T;
  });
  await routes.assistantThreads();
  await routes.assistantThreads({ includeArchived: true });
  await routes.assistantThread("thr_a/b");
  await routes.assistantThreadDefaults();
  await routes.createAssistantThread({ harness: "codex", title: "Ship It" });
  await routes.renameAssistantThread("thr_a/b", "Renamed");
  await routes.archiveAssistantThread("thr_a/b");
  assert.deepEqual(calls, [
    { path: "/api/assistant-threads", method: "GET" },
    { path: "/api/assistant-threads?includeArchived=true", method: "GET" },
    { path: "/api/assistant-threads/thr_a%2Fb", method: "GET" },
    { path: "/api/assistant-threads/defaults", method: "GET" },
    { path: "/api/assistant-threads", method: "POST", body: { harness: "codex", title: "Ship It" } },
    // A thread id is one path segment whatever it contains.
    { path: "/api/assistant-threads/thr_a%2Fb", method: "PATCH", body: { title: "Renamed" } },
    { path: "/api/assistant-threads/thr_a%2Fb/archive", method: "POST", body: {} },
  ]);
});

test("a control plane without the Thread API is unavailable, not failing", () => {
  // The control plane's answer for a route it lacks, and a 404 with no body at all.
  assert.equal(assistantThreadsUnavailable(new ApiError("not found", 404, undefined, { error: "not found" })), true);
  assert.equal(assistantThreadsUnavailable(new ApiError("Not Found", 404)), true);
  // A refusal names what wasn't found: the person reads it, the section stays available.
  assert.equal(assistantThreadsUnavailable(new ApiError("Machine not found.", 404, undefined, { error: "Machine not found." })), false);
  assert.equal(assistantThreadsUnavailable(new ApiError("Assistant thread not found for this owner.", 404, undefined,
    { error: "Assistant thread not found for this owner." })), false);
  assert.equal(assistantThreadsUnavailable(new ApiError("Method Not Allowed", 405)), true);
  assert.equal(assistantThreadsUnavailable(new ApiError("Not Implemented", 501)), true);
  // A refusal or an outage is a real failure the person sees.
  assert.equal(assistantThreadsUnavailable(new ApiError("Unsupported harness", 409)), false);
  assert.equal(assistantThreadsUnavailable(new ApiError("Bad Gateway", 502)), false);
  assert.equal(assistantThreadsUnavailable(new Error("offline")), false);
});

test("only an organization owner has threads, in the control plane's own words", () => {
  const refusal = "Only an organization owner can use Wollipog Assistant threads.";
  assert.equal(assistantThreadsOwnerOnly(new ApiError(refusal, 403, undefined, { error: refusal })), refusal);
  assert.equal(assistantThreadsOwnerOnly(new ApiError("Not Found", 404)), null);
  assert.equal(assistantThreadsOwnerOnly(new Error("offline")), null);
  assert.equal(ASSISTANT_THREAD_TITLE_MAX, 120, "the control plane's title limit");
});

test("thread events apply in order: a change replaces its row, a new thread joins, an archive leaves", () => {
  const list = [thread({ id: "thr_a", lastActivityAt: 10 }), thread({ id: "thr_b", lastActivityAt: 20 })];
  const events = [
    { seq: 1, thread: thread({ id: "thr_a", title: "Already Applied", lastActivityAt: 15 }) },
    { seq: 2, thread: thread({ id: "thr_a", title: "Renamed", lastActivityAt: 30 }) },
    { seq: 3, thread: thread({ id: "thr_c", lastActivityAt: 25 }) },
    { seq: 4, thread: thread({ id: "thr_b", status: "archived", archivedAt: 40 }) },
  ];
  const next = applyAssistantThreadEvents(list, events, 1);
  assert.deepEqual(next.map((item) => [item.id, item.title]), [["thr_a", "Renamed"], ["thr_c", "Triage Open Issues"]]);
  // Nothing newer than the read: the read stands as it was.
  assert.deepEqual(applyAssistantThreadEvents(list, events, 4).map((item) => item.id), ["thr_b", "thr_a"]);
});

test("the store numbers each thread event and keeps only the newest", () => {
  const store = new Store();
  for (let index = 0; index < ASSISTANT_THREAD_EVENTS_KEPT + 5; index += 1) {
    store.dispatch({ type: "msg", msg: { type: "assistant_thread_upsert", userId: "usr_1", thread: thread({ id: `thr_${index}` }) } });
  }
  const kept = store.getState().assistantThreadEvents!;
  assert.equal(kept.length, ASSISTANT_THREAD_EVENTS_KEPT);
  assert.equal(kept.at(-1)!.seq, ASSISTANT_THREAD_EVENTS_KEPT + 5);
  assert.equal(kept[0]!.seq, 6);
  assert.equal(kept.at(-1)!.thread.id, `thr_${ASSISTANT_THREAD_EVENTS_KEPT + 4}`);
});

test("threads read in Title Case labels, newest activity first", () => {
  assert.equal(assistantThreadAccessLabel({ level: "full_access", destructive: "ask" }), "Full Access · Ask Before Destructive");
  assert.equal(assistantThreadHarnessLabel("claude-code"), "Claude Code");
  assert.equal(assistantThreadHarnessLabel("codex"), "Codex");
  assert.equal(assistantThreadHarnessLabel("codex", [{ id: "codex", label: "Codex CLI", available: true }]), "Codex CLI");
  assert.equal(assistantThreadTitle(thread({ title: "  " })), "New Thread");
  const sorted = sortAssistantThreads([
    thread({ id: "thr_old", lastActivityAt: 10 }),
    thread({ id: "thr_new", lastActivityAt: 30 }),
    thread({ id: "thr_mid", lastActivityAt: 20 }),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["thr_new", "thr_mid", "thr_old"]);
});

test("the Assistants section and an open thread have their own addresses", () => {
  const list: View = { name: "assistants" };
  const open: View = { name: "assistants", threadId: "thr_42" };
  assert.equal(viewPath(list), "/assistants");
  assert.deepEqual(viewFromPath(viewPath(open)), open);
  assert.deepEqual(viewFromPath("/assistants"), list);
  assert.equal(viewFromPath("/assistants/thr_42"), null, "an id is always encoded behind ~");
  assert.equal(viewTitle(list), "Assistants");
  assert.equal(viewTitle(open), "Thread", "an open thread is titled by its title once it loads");
  assert.equal(viewTitle(open, "Triage Open Issues"), "Triage Open Issues");
});

test("an open thread streams its backing session, and only while it is open", () => {
  const base = { sessions: new Map(), assistantSessionId: "sess_backing" };
  assert.deepEqual(uiStreamSubscriptions({ ...base, view: { name: "assistants", threadId: "thr_1" } }).sessionIds, ["sess_backing"]);
  assert.deepEqual(uiStreamSubscriptions({ ...base, view: { name: "assistants" } }).sessionIds, []);
  assert.deepEqual(uiStreamSubscriptions({ ...base, view: { name: "automations" } }).sessionIds, []);
});
