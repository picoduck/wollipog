import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { SessionView } from "@wollipog/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import {
  approvalFocusDestination,
  SessionApprovalRegion,
  SessionQuestionBanner,
  questionSelectionForRequest,
} from "./SessionApproval.js";

test("the standalone approval slot does not render structured questions", () => {
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
    questionInTimeline: true,
  }));

  assert.doesNotMatch(html, /aria-label="Agent Questions"/);
  assert.doesNotMatch(html, /Which language\?/);
});

test("the standalone approval slot keeps a pending question reachable until its timeline row loads", () => {
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
    questionInTimeline: false,
  }));

  assert.match(html, /aria-label="Agent Questions"/);
  assert.match(html, /Which language\?/);
  assert.equal((html.match(/Agent Questions/g) ?? []).length, 1);
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

  assert.match(html, /Agent Question Recovery Required/);
  assert.match(html, /original answer channel is no longer available/);
  assert.match(html, /No prior tool calls will be replayed/);
  assert.match(html, /Which target should receive the deployment\?/);
  assert.match(html, /Production/);
  assert.match(html, /Staging/);
  assert.match(html, /Dismiss and Continue/);
  assert.doesNotMatch(html, />Submit</);
  assert.equal((html.match(/role="radio"[^>]*aria-disabled="true"/g) ?? []).length, 2);
});

test("question choices expose labelled radio and checkbox semantics with one radio tab stop", () => {
  const html = renderToStaticMarkup(React.createElement(SessionQuestionBanner, {
    sessionId: "s1",
    requestId: "ask-1",
    runnerOnline: true,
    questions: [
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
    ],
  }));
  assert.match(html, /role="radiogroup" aria-labelledby=/);
  assert.match(html, /role="radiogroup"[^>]*aria-describedby="[^"]+-requirement-0"[^>]*aria-required="true"/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 2);
  assert.equal((html.match(/role="checkbox"/g) ?? []).length, 2);
  assert.equal((html.match(/role="radio"[^>]*aria-checked="false"[^>]*tabindex="0"/g) ?? []).length, 1);
  assert.equal((html.match(/role="radio"[^>]*aria-checked="false"[^>]*tabindex="-1"/g) ?? []).length, 1);
});

test("multi-select questions offer custom input and require a response before Submit", () => {
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

  assert.match(html, /class="input question-input"/);
  assert.doesNotMatch(html, /This question format is unsupported/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Submit<\/button>/);
  assert.match(html, /role="checkbox"/);
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

test("provider form questions render context and constrained free-text controls", () => {
  const html = renderToStaticMarkup(React.createElement(SessionQuestionBanner, {
    sessionId: "s-form",
    requestId: "ask-form",
    runnerOnline: true,
    questions: [
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
        inputFormat: "integer",
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
    ],
  }));
  assert.match(html, /Deploy MCP: Choose deployment settings/);
  assert.match(html, /Retry policy for the deployment/);
  assert.match(html, /This note is stored with the deployment/);
  assert.equal((html.match(/class="question-context"/g) ?? []).length, 3);
  assert.match(html, /<span[^>]*>Response<\/span>/);
  assert.match(html, /type="password"[^>]*maxLength="120"/);
  assert.match(html, /type="number"[^>]*inputMode="numeric"[^>]*step="1"[^>]*min="1"[^>]*max="5"/);
  assert.match(html, /<span class="muted sm"> \(optional\)<\/span>/);
  assert.match(html, /aria-labelledby="[^"]+-question-0 [^"]+-response-0"/);
  assert.match(html, /aria-labelledby="[^"]+-question-1 [^"]+-response-1"/);
  assert.match(html, /aria-labelledby="[^"]+-question-2 [^"]+-response-2"/);
  assert.equal((html.match(/aria-required="true" required=""/g) ?? []).length, 2);
  assert.equal((html.match(/aria-required="false"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-describedby="[^"]+-context-[0-2] [^"]+-requirement-[0-2]"/g) ?? []).length, 3);
});
