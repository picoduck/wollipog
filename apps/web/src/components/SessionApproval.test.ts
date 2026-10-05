import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { SessionView } from "@wollipog/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { clearQuestionDrafts, storeQuestionStep } from "../question-response.js";
import {
  approvalFocusDestination,
  SessionApprovalRegion,
  SessionQuestionBanner,
  questionSelectionForRequest,
} from "./SessionApproval.js";

test("the approval region only owns focus and announcements: a pending question is on the request dock (#2205)", () => {
  const session = {
    id: "session-1",
    runnerId: "runner-1",
    title: "Session",
    status: "input_required",
    pendingApproval: {
      kind: "question",
      requestId: "ask-1",
      title: "Agent Questions",
      options: [],
      questions: [{ id: "language", question: "Which language?", options: [{ label: "TypeScript" }] }],
    },
  } as SessionView;
  const html = renderToStaticMarkup(React.createElement(SessionApprovalRegion, {
    session,
    runnerOnline: true,
    fallbackFocusRef: React.createRef<HTMLElement>(),
  }));

  assert.doesNotMatch(html, /aria-label="Agent Questions"/);
  assert.doesNotMatch(html, /Which language\?/);
});

test("Interactive Form renders question and context Markdown with compact plain links", () => {
  const signed = "https://evidence.example/private/capture.png?signature=secret#full";
  const html = renderToStaticMarkup(React.createElement(SessionQuestionBanner, {
    sessionId: "s-markdown",
    requestId: "ask-markdown",
    runnerOnline: true,
    questions: [{
      id: "target",
      question: `Choose **one** target.\n\n- \`staging\`\n- production`,
      context: `Review ${signed}`,
      options: [{ label: "Staging" }, { label: "Production" }],
    }],
  }));

  assert.match(html, /Choose <strong>one<\/strong> target/);
  assert.match(html, /<li><code>staging<\/code><\/li>/);
  assert.match(html, />evidence\.example\/capture\.png<\/a>/);
  assert.match(html, /href="https:\/\/evidence\.example\/private\/capture\.png\?signature=secret#full"/);
  assert.equal((html.match(/signature=secret/g) ?? []).length, 1);
});

test("a question stranded by restart preserves context but offers only the explicit safe recovery", () => {
  const html = renderToStaticMarkup(React.createElement(SessionQuestionBanner, {
    sessionId: "s-recovered",
    requestId: "ask-recovered",
    runnerOnline: true,
    recoveryReason: "provider_restart",
    questions: [{
      id: "target",
      header: "Target",
      question: "Which target should receive the deployment?",
      options: [{ label: "Production" }, { label: "Staging" }],
    }],
  }));

  assert.match(html, /data-tone="danger"/);
  assert.match(html, /Recovery Required/);
  assert.match(html, /original answer channel is no longer available/);
  assert.match(html, /No prior tool calls will be replayed/);
  assert.match(html, /Which target should receive the deployment\?/);
  assert.match(html, /Production/);
  assert.match(html, /Staging/);
  assert.equal((html.match(/class="btn primary"/g) ?? []).length, 1, "one primary");
  assert.match(html, /class="btn primary"[^>]*>Dismiss and Continue/);
  assert.doesNotMatch(html, /Submit Answers/);
  // Every row, Something Else included, refuses a choice while it stays reachable.
  assert.equal((html.match(/type="radio"[^>]*aria-disabled="true"/g) ?? []).length, 3);
});

test("question choices are native radios and checkboxes in labelled ChoiceRows, one question per step", () => {
  const questions = [
    {
      id: "single",
      header: "Choice",
      question: "Pick one",
      multiSelect: false,
      options: [{ label: "A" }, { label: "B" }],
    },
    {
      id: "multi",
      question: "Pick any",
      multiSelect: true,
      options: [{ label: "X" }, { label: "Y" }],
    },
  ];
  const render = (requestId: string) => renderToStaticMarkup(React.createElement(SessionQuestionBanner, {
    sessionId: "s1",
    requestId,
    runnerOnline: true,
    questions,
  }));
  const first = render("ask-1");
  assert.match(first, /class="choice-rows" role="radiogroup" aria-labelledby="[^"]+-header-0 [^"]+-title"/);
  assert.match(first, /role="radiogroup"[^>]*aria-describedby="[^"]+-requirement-0"/);
  assert.equal((first.match(/type="radio"/g) ?? []).length, 3, "A, B and Something Else");
  assert.equal((first.match(/type="checkbox"/g) ?? []).length, 0, "the second question waits for its step");
  assert.doesNotMatch(first, /role="radio"|role="checkbox"|[☑☐●○]/);
  assert.match(first, />Something Else…</);
  assert.match(first, /Choice<\/span><span>Choose one/);
  assert.match(first, /Question 1 of 2/);
  assert.doesNotMatch(first, /select all that apply|question-chip/);

  storeQuestionStep("s1", "ask-step-2", 1);
  try {
    const second = render("ask-step-2");
    assert.match(second, /class="choice-rows" role="group" aria-labelledby="[^"]+-title"/);
    assert.equal((second.match(/type="checkbox"/g) ?? []).length, 3, "X, Y and Something Else");
    assert.match(second, /<p class="question-eyebrow"><span>Choose any<\/span><\/p>/);
    assert.match(second, /Question 2 of 2/);
  } finally {
    clearQuestionDrafts("s1", "ask-step-2");
  }
});

test("a choice question keeps its text field behind Something Else, and Submit Answers stays available", () => {
  const html = renderToStaticMarkup(React.createElement(SessionQuestionBanner, {
    sessionId: "s1",
    requestId: "ask-unsupported",
    runnerOnline: true,
    questions: [{
      id: "features",
      question: "Choose features or add another",
      multiSelect: true,
      allowOther: true,
      options: [{ label: "Audit" }],
    }],
  }));

  assert.doesNotMatch(html, /question-input/, "the field opens when Something Else is chosen");
  assert.match(html, />Something Else…</);
  assert.doesNotMatch(html, /This question format is unsupported/);
  // §8.5: a short form's primary stays enabled; pressing it reveals what is missing.
  assert.match(html, /<button[^>]*class="btn primary"[^>]*>Submit Answers<kbd aria-hidden="true">Enter<\/kbd><\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Submit Answers/);
  assert.doesNotMatch(html, /field-error|Complete all required responses/);
});

test("question selection is empty immediately when a new request replaces the old one", () => {
  const stale = { requestId: "ask-a", picked: { repeated: ["old answer"] } };
  assert.deepEqual(questionSelectionForRequest(stale, "ask-a"), stale.picked);
  assert.deepEqual(questionSelectionForRequest(stale, "ask-b"), {});
});

test("approval focus follows owned replacements and final resolution only", () => {
  assert.equal(approvalFocusDestination("ask-a", "ask-b", true), "request");
  assert.equal(approvalFocusDestination("ask-a", null, true), "fallback");
  assert.equal(approvalFocusDestination("ask-a", "ask-b", false), null);
  assert.equal(approvalFocusDestination("ask-a", "ask-a", true), null);
});

test("provider form questions render context and constrained free-text controls, one per step", () => {
  const questions = [
    {
      id: "token",
      header: "Token",
      question: "Enter the temporary token",
      context: "Deploy MCP: Choose deployment settings",
      options: [],
      allowOther: true,
      secret: true,
      maxLength: 120,
    },
    {
      id: "retries",
      header: "Retries",
      question: "How many retries?",
      context: "Retry policy for the deployment",
      options: [],
      allowOther: true,
      inputFormat: "integer" as const,
      minimum: 1,
      maximum: 5,
    },
    {
      id: "note",
      header: "Note",
      question: "Optional note",
      context: "This note is stored with the deployment",
      options: [],
      allowOther: true,
      required: false,
    },
  ];
  const render = (step: number) => {
    storeQuestionStep("s-form", "ask-form", step);
    try {
      return renderToStaticMarkup(React.createElement(SessionQuestionBanner, {
        sessionId: "s-form",
        requestId: "ask-form",
        runnerOnline: true,
        questions,
      }));
    } finally {
      clearQuestionDrafts("s-form", "ask-form");
    }
  };
  const [token, retries, note] = [render(0), render(1), render(2)];
  assert.match(token, /Deploy MCP: Choose deployment settings/);
  assert.match(retries, /Retry policy for the deployment/);
  assert.match(note, /This note is stored with the deployment/);
  for (const html of [token, retries, note]) {
    assert.equal((html.match(/class="question-context"/g) ?? []).length, 1);
    assert.match(html, /class="input question-input"[^>]*aria-labelledby="[^"]+-header-[0-2] [^"]+-title"/);
    assert.match(html, /aria-describedby="[^"]+-context-[0-2] [^"]+-requirement-[0-2]"/);
  }
  assert.match(token, /type="password"[^>]*maxLength="120"/);
  assert.match(retries, /type="number"[^>]*inputMode="numeric"[^>]*step="1"[^>]*min="1"[^>]*max="5"/);
  assert.match(note, /Note<\/span><span>Optional<\/span>/);
  assert.match(token, /aria-required="true"/);
  assert.match(retries, /aria-required="true"/);
  assert.match(note, /aria-required="false"/);
  assert.match(token, />Next</);
  assert.doesNotMatch(token, />Back</);
  assert.match(retries, />Back<[\s\S]*>Next</);
  assert.match(note, />Back<[\s\S]*>Submit Answers</);
});
