import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "./api.js";
import {
  assistantThreadAccessLabel,
  assistantThreadHarnessLabel,
  assistantThreadRoutes,
  assistantThreadsUnavailable,
  assistantThreadTitle,
  sortAssistantThreads,
  type AssistantThread,
} from "./assistant-threads.js";
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

test("every Thread API request goes to the provisional contract's routes", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const routes = assistantThreadRoutes(async <T,>(path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
    return {} as T;
  });
  await routes.assistantThreads();
  await routes.assistantThreads({ includeArchived: true });
  await routes.assistantThreadDefaults();
  await routes.createAssistantThread({ harness: "codex", title: "Ship It" });
  await routes.renameAssistantThread("thr_a/b", "Renamed");
  await routes.archiveAssistantThread("thr_a/b");
  assert.deepEqual(calls, [
    { path: "/api/assistant-threads", method: "GET" },
    { path: "/api/assistant-threads?includeArchived=true", method: "GET" },
    { path: "/api/assistant-threads/defaults", method: "GET" },
    { path: "/api/assistant-threads", method: "POST", body: { harness: "codex", title: "Ship It" } },
    // A thread id is one path segment whatever it contains.
    { path: "/api/assistant-threads/thr_a%2Fb", method: "PATCH", body: { title: "Renamed" } },
    { path: "/api/assistant-threads/thr_a%2Fb/archive", method: "POST", body: {} },
  ]);
});

test("a control plane without the Thread API is unavailable, not failing", () => {
  assert.equal(assistantThreadsUnavailable(new ApiError("Not Found", 404)), true);
  assert.equal(assistantThreadsUnavailable(new ApiError("Method Not Allowed", 405)), true);
  assert.equal(assistantThreadsUnavailable(new ApiError("Not Implemented", 501)), true);
  // A refusal or an outage is a real failure the person sees.
  assert.equal(assistantThreadsUnavailable(new ApiError("Unsupported harness", 409)), false);
  assert.equal(assistantThreadsUnavailable(new ApiError("Bad Gateway", 502)), false);
  assert.equal(assistantThreadsUnavailable(new Error("offline")), false);
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
  const base = { sessions: new Map(), runs: new Map(), pods: new Map(), assistantSessionId: "sess_backing" };
  assert.deepEqual(uiStreamSubscriptions({ ...base, view: { name: "assistants", threadId: "thr_1" } }).sessionIds, ["sess_backing"]);
  assert.deepEqual(uiStreamSubscriptions({ ...base, view: { name: "assistants" } }).sessionIds, []);
  assert.deepEqual(uiStreamSubscriptions({ ...base, view: { name: "automations" } }).sessionIds, []);
});
