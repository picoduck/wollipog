import assert from "node:assert/strict";
import test from "node:test";
import type { AgentQuestion } from "@wollipog/protocol";
import {
  clearQuestionDrafts,
  claimQuestionResponseOperation,
  isAnswerableAgentQuestion,
  offeredQuestionChoices,
  questionDraftAnswers,
  questionDraftSelections,
  questionDraftText,
  resolveQuestionResponse,
  storedQuestionDrafts,
  storeQuestionDrafts,
  type QuestionResponseDraft,
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
  release();
  assert.equal(claimQuestionResponseOperation("session-lock", "request-lock"), null,
    "a stale duplicate release cannot clear a newer operation claim");
  retryRelease();
});

test("a hung question operation lease expires without letting its stale release clear a retry", () => {
  const firstRelease = claimQuestionResponseOperation("session-lease", "request-lease", 1_000);
  assert.ok(firstRelease);
  assert.equal(claimQuestionResponseOperation("session-lease", "request-lease", 60_999), null);
  const retryRelease = claimQuestionResponseOperation("session-lease", "request-lease", 61_000);
  assert.ok(retryRelease);
  firstRelease();
  assert.equal(claimQuestionResponseOperation("session-lease", "request-lease", 61_001), null,
    "the superseded operation cannot release the active retry's claim");
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

test("formatted single-choice labels with punctuation can return through typed-entry parsing", () => {
  const question: AgentQuestion = {
    ...single,
    options: [{ label: "Yes, do it" }, { label: 'Say "later"' }, { label: "8080" }],
  };
  assert.deepEqual(resolveQuestionResponse(question, '"Yes, do it"'), { answer: "Yes, do it" });
  assert.deepEqual(resolveQuestionResponse(question, '"Say ""later"""'), { answer: 'Say "later"' });
  assert.deepEqual(resolveQuestionResponse(question, '"8080"'), { answer: "8080" });
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
  assert.deepEqual(questionDraftSelections(question, { kind: "entry", value: "1, 2" }), ["Unit Tests", "Browser Tests"],
    "a typed entry shows its exact choices as the selection the Interactive Form toggles from");
});

test("quoted multi-select labels preserve commas and quotes without changing provider values", () => {
  const question: AgentQuestion = {
    ...single,
    multiSelect: true,
    options: [{ label: "North, America" }, { label: 'Say "Hello"' }],
  };
  const labels = ["North, America", 'Say "Hello"'];
  const text = questionDraftText({ kind: "choice", labels });
  assert.equal(text, '"North, America", "Say ""Hello"""');
  assert.deepEqual(resolveQuestionResponse(question, text), { answer: labels });
  // The choice draft's text returns through a typed entry as the same exact labels.
  assert.deepEqual(questionDraftSelections(question, { kind: "entry", value: text }), labels);
  assert.deepEqual(questionDraftAnswers([question], { language: { kind: "entry", value: text } }),
    { answers: { language: labels }, errors: {} });
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
  assert.match(resolveQuestionResponse(single, "arbitrary prose").error ?? "", /Something Else/);
});

test("answer maps omit blank optional fields and report every invalid response", () => {
  const result = questionDraftAnswers([
    single,
    { ...single, id: "optional", required: false },
    { ...single, id: "optionalChoice", required: false },
    { ...single, id: "optionalOther", required: false, allowOther: true },
    { ...single, id: "required" },
    { ...single, id: "requiredChoice" },
  ], {
    language: { kind: "entry", value: "1" },
    optional: { kind: "entry", value: "" },
    optionalChoice: { kind: "choice", labels: [] },
    optionalOther: { kind: "other", value: "  " },
    required: { kind: "entry", value: "" },
    requiredChoice: { kind: "choice", labels: [] },
  });
  assert.deepEqual(result.answers, { language: "TypeScript" });
  assert.deepEqual(Object.keys(result.errors), ["required", "requiredChoice"]);
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
  const drafts: QuestionResponseDraft[] = [{ kind: "entry", value: "1" }, { kind: "choice", labels: ["TypeScript"] }];
  for (const draft of drafts) {
    const result = questionDraftAnswers([question], { [question.id]: draft });
    assert.equal(Object.hasOwn(result.answers, "__proto__"), true, draft.kind);
    assert.equal(result.answers.__proto__, "TypeScript", draft.kind);
    assert.equal(Object.getPrototypeOf(result.answers), Object.prototype, "the answer map's prototype is untouched");
    assert.deepEqual(result.errors, {});
  }
  const invalid = questionDraftAnswers([question], { [question.id]: { kind: "entry", value: "" } });
  assert.equal(Object.hasOwn(invalid.errors, "__proto__"), true);
  assert.equal(invalid.errors.__proto__, "Enter a response.");
  assert.equal(Object.getPrototypeOf(invalid.errors), Object.prototype, "the error map's prototype is untouched");
});

test("Other intents are independent for every question and preserve numeric and label-like text (#1595)", () => {
  for (const allowOther of [undefined, false, true]) {
    const questions = [
      { ...single, allowOther },
      { ...single, id: "multi", multiSelect: true, minSelections: 2, allowOther },
    ];
    assert.deepEqual(questionDraftAnswers(questions, {
      language: { kind: "other", value: "2" },
      multi: { kind: "other", value: "TypeScript" },
    }), { answers: { language: "2", multi: "TypeScript" }, errors: {} });
    assert.match(resolveQuestionResponse(questions[1]!, "1, 4").error!, /not a displayed number/);
  }
});

test("typed choice mistakes retain validation while explicit Other preserves arbitrary punctuation", () => {
  const multi = { ...single, multiSelect: true };
  assert.match(resolveQuestionResponse(single, "4").error!, /Something Else/);
  assert.match(resolveQuestionResponse(multi, "1, 4").error!, /not a displayed number/);
  assert.match(resolveQuestionResponse(multi, "TypeScript, Pythno").error!, /not a displayed number/);
  assert.deepEqual(questionDraftAnswers([multi], { language: { kind: "other", value: "1, 4" } }),
    { answers: { language: "1, 4" }, errors: {} });
});


test("explicit Other accepts only exact single-choice labels on native typed forms", () => {
  const question: AgentQuestion = {
    id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }],
    customAnswerError: "cannot be delivered because the provider requires one of its typed choices",
  };
  assert.deepEqual(questionDraftAnswers([question], { confirm: { kind: "other", value: "Yes" } }),
    { answers: { confirm: "Yes" }, errors: {} });
  for (const value of ["yes", "1", "Maybe"]) {
    assert.match(questionDraftAnswers([question], { confirm: { kind: "other", value } }).errors.confirm!, /cannot be delivered/);
  }
  assert.match(questionDraftAnswers([{ ...question, multiSelect: true }], {
    confirm: { kind: "other", value: "Yes" },
  }).errors.confirm!, /cannot be delivered/, "a multi-select custom string is not a typed array");
});
