import assert from "node:assert/strict";
import test from "node:test";
import type { AgentQuestion } from "@wollipog/protocol";
import {
  clearQuestionDrafts,
  claimQuestionResponseOperation,
  isAnswerableAgentQuestion,
  offeredQuestionChoices,
  questionAnswers,
  questionDraftAnswers,
  resolveQuestionResponse,
  storedQuestionDrafts,
  storeQuestionDrafts,
  toggleQuestionChoice,
} from "./question-response.js";

test("question operations are exclusive per request and release for retry", () => {
  const release = claimQuestionResponseOperation("session-lock", "request-lock");
  assert.ok(release);
  assert.equal(claimQuestionResponseOperation("session-lock", "request-lock"), null);
  const otherRelease = claimQuestionResponseOperation("session-lock", "other-request");
  assert.ok(otherRelease);
  otherRelease();
  release();
  const retryRelease = claimQuestionResponseOperation("session-lock", "request-lock");
  assert.ok(retryRelease);
  retryRelease();
});

const single: AgentQuestion = {
  id: "language",
  question: "Language?",
  options: [{ label: "TypeScript" }, { label: "Python" }],
};

test("text responses resolve displayed numbers and case-insensitive exact labels", () => {
  assert.deepEqual(resolveQuestionResponse(single, "2"), { answer: "Python" });
  assert.deepEqual(resolveQuestionResponse(single, "typescript"), { answer: "TypeScript" });
  assert.match(resolveQuestionResponse(single, "py").error ?? "", /unambiguous option label/);
  assert.match(resolveQuestionResponse(single, "rust").error ?? "", /displayed number/);
});

test("multi-select text responses deterministically resolve comma-separated choices", () => {
  const question: AgentQuestion = {
    ...single,
    id: "checks",
    multiSelect: true,
    minSelections: 2,
    maxSelections: 2,
    options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
  };
  assert.deepEqual(resolveQuestionResponse(question, "1, browser tests"), { answer: ["Unit Tests", "Browser Tests"] });
  assert.match(resolveQuestionResponse(question, "1").error ?? "", /at least 2/);
  assert.match(resolveQuestionResponse(question, "1, Unit Tests").error ?? "", /more than once/);
  assert.deepEqual(offeredQuestionChoices(question, "1"), ["Unit Tests"],
    "incomplete exact choices remain available to Interactive Form toggles");
  assert.equal(toggleQuestionChoice(question, "1, 2", "Unit Tests"), "Browser Tests");
});

test("quoted multi-select labels preserve commas and quotes without changing provider values", () => {
  const question: AgentQuestion = {
    ...single,
    multiSelect: true,
    options: [{ label: "North, America" }, { label: 'Say "Hello"' }],
  };
  const raw = toggleQuestionChoice(question, "", "North, America");
  const both = toggleQuestionChoice(question, raw, 'Say "Hello"');
  assert.equal(both, '"North, America", "Say ""Hello"""');
  assert.deepEqual(resolveQuestionResponse(question, both), { answer: ["North, America", 'Say "Hello"'] });
});

test("free text is accepted only when declared and retains provider validation", () => {
  const form: AgentQuestion = {
    id: "count",
    question: "Count?",
    options: [],
    allowOther: true,
    inputFormat: "integer",
    minimum: 1,
    maximum: 3,
  };
  assert.deepEqual(resolveQuestionResponse(form, "2"), { answer: "2" });
  assert.match(resolveQuestionResponse(form, "4").error ?? "", /above its maximum/);
  assert.match(resolveQuestionResponse(single, "arbitrary prose").error ?? "", /displayed number/);
});

test("answer maps omit blank optional fields and report every invalid response", () => {
  const result = questionAnswers([
    single,
    { ...single, id: "optional", required: false },
    { ...single, id: "required" },
  ], { language: "1", optional: "", required: "unknown" });
  assert.deepEqual(result.answers, { language: "TypeScript" });
  assert.deepEqual(Object.keys(result.errors), ["required"]);
});

test("page-lifetime draft storage is request-correlated and explicitly clearable", () => {
  storeQuestionDrafts("session", "request-a", { note: { kind: "entry", value: "temporary" } });
  assert.deepEqual(storedQuestionDrafts("session", "request-a"), { note: { kind: "entry", value: "temporary" } });
  assert.deepEqual(storedQuestionDrafts("session", "request-b"), {});
  clearQuestionDrafts("session", "request-a");
  assert.deepEqual(storedQuestionDrafts("session", "request-a"), {});
});

test("choice and Other draft intents validate to provider values without becoming interchangeable", () => {
  const question: AgentQuestion = { ...single, allowOther: true };
  assert.deepEqual(questionDraftAnswers([question], {
    language: { kind: "choice", labels: ["Python"] },
  }).answers, { language: "Python" });
  assert.deepEqual(questionDraftAnswers([question], {
    language: { kind: "other", value: "Production west region" },
  }).answers, { language: "Production west region" });

  const numericOther: AgentQuestion = {
    id: "workers",
    question: "Choose a worker count",
    options: [{ label: "Auto" }, { label: "Two Workers" }],
    allowOther: true,
    inputFormat: "integer",
    minimum: 1,
    maximum: 10,
  };
  assert.deepEqual(questionDraftAnswers([numericOther], {
    workers: { kind: "other", value: "2" },
  }).answers, { workers: "2" }, "Interactive Other does not apply Composer Response's ordinal syntax");
  assert.deepEqual(questionDraftAnswers([numericOther], {
    workers: { kind: "choice", labels: ["Two Workers"] },
  }).answers, { workers: "Two Workers" }, "fixed choices still retain exact provider labels");
});

test("Interactive choices retain exact provider labels without reparsing them as text syntax", () => {
  const numeric: AgentQuestion = {
    ...single,
    options: [{ label: "2" }, { label: "Second Option" }],
  };
  assert.deepEqual(resolveQuestionResponse(numeric, "2"), { answer: "Second Option" },
    "Composer Response keeps displayed-number syntax");
  assert.deepEqual(questionDraftAnswers([numeric], {
    language: { kind: "choice", labels: ["2"] },
  }).answers, { language: "2" }, "Interactive Form keeps the clicked label");

  const comma: AgentQuestion = {
    ...single,
    id: "regions",
    multiSelect: true,
    options: [{ label: "North, America" }, { label: "Europe" }],
  };
  assert.deepEqual(questionDraftAnswers([comma], {
    regions: { kind: "choice", labels: ["North, America", "Europe"] },
  }).answers, { regions: ["North, America", "Europe"] });
});

test("questions with neither choices nor free text fail as unsupported with truthful copy", () => {
  const question: AgentQuestion = { id: "empty", question: "Impossible", options: [] };
  assert.equal(isAnswerableAgentQuestion(question), false);
  assert.deepEqual(resolveQuestionResponse(question, "anything"), { error: "This question format is unsupported." });
});

test("opaque prototype-chain question ids remain own answer keys", () => {
  const question = { ...single, id: "__proto__" };
  const result = questionAnswers([question], { [question.id]: "1" });
  assert.equal(Object.hasOwn(result.answers, "__proto__"), true);
  assert.equal(result.answers.__proto__, "TypeScript");
  assert.deepEqual(result.errors, {});
});
