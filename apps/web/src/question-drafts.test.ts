import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AgentQuestion, PendingApproval, SessionView } from "@wollipog/protocol";
import { Store } from "./store.js";
import { questionDraftIdentity, reconcileQuestionDrafts, storedQuestionDrafts, storedQuestionStep,
  storeQuestionDrafts, storeQuestionStep } from "./question-drafts.js";

const data = new Map<string, string>();
const browserStorage = { getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) };
Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: browserStorage } });
afterEach(() => data.clear());
const questions: AgentQuestion[] = [
  { id: "target", question: "Choose a target.", options: [{ label: "Staging" }, { label: "Production" }] },
  { id: "note", question: "Add a note.", options: [], allowOther: true },
];
const request: PendingApproval = { requestId: "draft", occurrenceId: "epoch-1", kind: "question", title: "", options: [], questions };

test("only non-sensitive known fields and offered choices enter durable drafts", () => {
  const fields: AgentQuestion[] = [...questions,
    { id: "private", question: "Enter a value.", options: [], allowOther: true, secret: true },
    { id: "credential", question: "Enter an API key.", options: [], allowOther: true },
    { id: "email", question: "Contact address.", options: [], allowOther: true, inputFormat: "email" },
  ];
  const key = questionDraftIdentity("sensitive", fields, "sensitive-epoch");
  storeQuestionDrafts("sensitive", key, {
    target: { kind: "choice", labels: ["Not Offered"] }, note: { kind: "entry", value: "Synthetic note" },
    private: { kind: "entry", value: "SECRET-A" }, credential: { kind: "entry", value: "SECRET-B" },
    email: { kind: "entry", value: "PRIVATE-C" }, unknown: { kind: "entry", value: "UNKNOWN-D" },
  });
  assert.deepEqual(storedQuestionDrafts("sensitive", key), { note: { kind: "entry", value: "Synthetic note" },
    credential: { kind: "entry", value: "SECRET-B" }, email: { kind: "entry", value: "PRIVATE-C" } });
  assert.doesNotMatch([...data.values()].join(""), /SECRET|PRIVATE-C|UNKNOWN-D|Not Offered/);
});

test("authoritative projected occurrences retain drafts; full schema replacements and resolution retire them", () => {
  const key = questionDraftIdentity(request.requestId, questions, request.occurrenceId);
  storeQuestionDrafts("projection", key, { target: { kind: "choice", labels: ["Staging"] } });
  storeQuestionStep("projection", key, 1);
  reconcileQuestionDrafts("projection", [{ ...request, questions: undefined }]);
  assert.equal(storedQuestionStep("projection", key), 1);
  assert.match([...data.values()].join(""), /Staging/);
  reconcileQuestionDrafts("projection", [{ ...request, questions: [{ ...questions[0]!, question: "A new question." }] }]);
  assert.deepEqual(storedQuestionDrafts("projection", key), {});
  assert.equal(data.size, 0);
  storeQuestionDrafts("projection", key, { target: { kind: "choice", labels: ["Staging"] } });
  reconcileQuestionDrafts("projection", []);
  assert.deepEqual(storedQuestionDrafts("projection", key), {});
  assert.equal(data.size, 0);
});

test("legacy requests without an occurrence epoch stay page-only; instances isolate answers", () => {
  const key = questionDraftIdentity("legacy", questions);
  storeQuestionDrafts("legacy", key, { target: { kind: "choice", labels: ["Staging"] } });
  assert.equal(data.size, 0);
  assert.equal(storedQuestionDrafts("legacy", key).target?.kind, "choice");
  const local = questionDraftIdentity("bound", questions, "epoch", undefined, "local");
  storeQuestionDrafts("instance", local, { target: { kind: "choice", labels: ["Staging"] } });
  const remote = questionDraftIdentity("bound", questions, "epoch", undefined, "remote");
  assert.deepEqual(storedQuestionDrafts("instance", remote), {});
});

test("corrupted field shapes and secret values are filtered when durable storage is read", () => {
  const fields = [...questions, { id: "secret", question: "Value.", options: [], allowOther: true, secret: true }];
  const key = questionDraftIdentity("injected", fields, "epoch");
  data.set("wollipog:question-drafts:v1:local", JSON.stringify([
    { sessionId: "injected", key, savedAt: Date.now(), step: 99,
      values: { secret: { kind: "entry", value: "NEVER RESTORE" }, target: { kind: "choice", labels: ["Staging"] } } },
  ]));
  assert.deepEqual(storedQuestionDrafts("injected", key), { target: { kind: "choice", labels: ["Staging"] } });
  assert.equal(storedQuestionStep("injected", key), 2);
  data.set("wollipog:question-drafts:v1:local", JSON.stringify([
    { sessionId: "injected", key, savedAt: Date.now(), step: 1, values: { note: { kind: "other", value: 42 } } },
  ]));
  assert.deepEqual(storedQuestionDrafts("injected", key), {});
});

test("storage denial retains page drafts and retention is bounded", () => {
  Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("denied"); } });
  const key = questionDraftIdentity("denied", questions, "epoch");
  storeQuestionDrafts("denied", key, { note: { kind: "entry", value: "Still editable" } });
  storeQuestionStep("denied", key, 1);
  assert.equal(storedQuestionStep("denied", key), 1);
  assert.deepEqual(storedQuestionDrafts("denied", key), { note: { kind: "entry", value: "Still editable" } });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: browserStorage });
  for (let index = 0; index < 60; index++) {
    storeQuestionStep("bounded", questionDraftIdentity(`request-${index}`, questions, `epoch-${index}`), 1);
  }
  assert.equal(JSON.parse([...data.values()][0]!).length, 50);
});

test("store updates retire resolved and replaced questions even without a mounted card", () => {
  const store = new Store({ name: "session", id: "unrelated" });
  const session = { id: "inactive", status: "input_required", title: "Synthetic", pendingApproval: request } as SessionView;
  store.loadSession(session);
  const key = questionDraftIdentity(request.requestId, questions, request.occurrenceId);
  storeQuestionDrafts("inactive", key, { target: { kind: "choice", labels: ["Staging"] } });
  store.dispatch({ type: "msg", msg: { type: "snapshot", sessionsComplete: false,
    runners: [], boxes: [], sessions: [], runs: [] } });
  store.dispatch({ type: "msg", msg: { type: "session_snapshot_page", complete: true,
    sessions: [{ ...session, projection: "summary", pendingApproval: { ...request, questions: undefined } }] } });
  assert.equal(storedQuestionDrafts("inactive", key).target?.kind, "choice");
  store.loadSession({ ...session, pendingApproval: { ...request, occurrenceId: "epoch-2" } });
  assert.deepEqual(storedQuestionDrafts("inactive", key), {});
  storeQuestionDrafts("inactive", key, { target: { kind: "choice", labels: ["Staging"] } });
  store.loadSession({ ...session, pendingApproval: null });
  assert.deepEqual(storedQuestionDrafts("inactive", key), {});
  // Deletion is authoritative even when this browser never loaded the session row.
  storeQuestionDrafts("missing", key, { target: { kind: "choice", labels: ["Staging"] } });
  store.dispatch({ type: "msg", msg: { type: "session_removed", sessionId: "missing" } });
  assert.deepEqual(storedQuestionDrafts("missing", key), {});
});

test("the same question occurrence retains its answers when provider recovery metadata arrives", () => {
  const key = questionDraftIdentity("recover", questions, "same-occurrence");
  storeQuestionDrafts("recover", key, { target: { kind: "choice", labels: ["Staging"] } });
  storeQuestionStep("recover", key, 1);
  reconcileQuestionDrafts("recover", [{ ...request, requestId: "recover", occurrenceId: "same-occurrence",
    recoveryId: "provider-restart", recoveryReason: "provider_restart", recoveryAction: "resume_answer" }]);
  assert.equal(storedQuestionStep("recover", key), 1);
  assert.deepEqual(storedQuestionDrafts("recover", key), { target: { kind: "choice", labels: ["Staging"] } });
});

test("ordinary account choices stay shared in this page while conservative browser persistence excludes them", () => {
  const fields: AgentQuestion[] = [{ id: "account", question: "Which AWS account should I deploy to?",
    options: [{ label: "Staging" }] }];
  const key = questionDraftIdentity("account", fields, "account-occurrence");
  storeQuestionDrafts("account", key, { account: { kind: "choice", labels: ["Staging"] } });
  assert.deepEqual(storedQuestionDrafts("account", key), { account: { kind: "choice", labels: ["Staging"] } });
  assert.doesNotMatch([...data.values()].join(""), /Staging/);
});

test("a failed storage update removes the earlier browser answer instead of restoring it after reload", () => {
  const key = questionDraftIdentity("quota", questions, "quota-occurrence");
  storeQuestionDrafts("quota", key, { target: { kind: "choice", labels: ["Staging"] } });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: { ...browserStorage,
    setItem() { throw new Error("quota"); } } });
  try {
    storeQuestionDrafts("quota", key, { target: { kind: "choice", labels: ["Production"] } });
    assert.deepEqual(storedQuestionDrafts("quota", key), { target: { kind: "choice", labels: ["Production"] } });
    assert.equal(data.size, 0);
  } finally {
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: browserStorage });
  }
});

test("valid text honors a larger provider bound in shared memory and browser recovery", () => {
  const fields: AgentQuestion[] = [{ id: "note", question: "Add a note.", options: [], allowOther: true, maxLength: 8000 }];
  const key = questionDraftIdentity("long-answer", fields, "long-occurrence");
  const value = "x".repeat(5000);
  storeQuestionDrafts("long-answer", key, { note: { kind: "entry", value } });
  assert.deepEqual(storedQuestionDrafts("long-answer", key), { note: { kind: "entry", value } });
  const entries = JSON.parse(data.get("wollipog:question-drafts:v1:local")!);
  entries[0].sessionId = "long-reloaded";
  data.set("wollipog:question-drafts:v1:local", JSON.stringify(entries));
  assert.deepEqual(storedQuestionDrafts("long-reloaded", key), { note: { kind: "entry", value } });
});

test("invalid over-length edits remain correctable in this page but never enter browser recovery", () => {
  const key = questionDraftIdentity("over-length", questions, "over-length-occurrence");
  const value = "x".repeat(4001);
  storeQuestionDrafts("over-length", key, { note: { kind: "entry", value } });
  assert.deepEqual(storedQuestionDrafts("over-length", key), { note: { kind: "entry", value } });
  assert.doesNotMatch([...data.values()].join(""), /x{4001}/);
});
