import assert from "node:assert/strict";
import test from "node:test";
import type { AgentQuestion } from "@wollipog/protocol";
import {
  clearQuestionDrafts,
  questionAnswers,
  resolveQuestionResponse,
  storedQuestionDrafts,
  storeQuestionDrafts,
  toggleQuestionChoice,
} from "./question-response.js";

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
  storeQuestionDrafts("session", "request-a", { secret: "temporary" });
  assert.deepEqual(storedQuestionDrafts("session", "request-a"), { secret: "temporary" });
  assert.deepEqual(storedQuestionDrafts("session", "request-b"), {});
  clearQuestionDrafts("session", "request-a");
  assert.deepEqual(storedQuestionDrafts("session", "request-a"), {});
});

test("opaque prototype-chain question ids remain own answer keys", () => {
  const question = { ...single, id: "__proto__" };
  const result = questionAnswers([question], { [question.id]: "1" });
  assert.equal(Object.hasOwn(result.answers, "__proto__"), true);
  assert.equal(result.answers.__proto__, "TypeScript");
  assert.deepEqual(result.errors, {});
});
