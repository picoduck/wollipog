import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApprovalSelectorContext,
  approvalFocusDestination,
  approvalKeyHintForOption,
  SessionQuestionBanner,
  questionSelectionForRequest,
} from "./SessionApproval.js";

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
  assert.equal((html.match(/role="radio"/g) ?? []).length, 2);
  assert.equal((html.match(/role="checkbox"/g) ?? []).length, 2);
  assert.equal((html.match(/role="radio" aria-checked="false" tabindex="0"/g) ?? []).length, 1);
  assert.equal((html.match(/role="radio" aria-checked="false" tabindex="-1"/g) ?? []).length, 1);
});

test("approval key hints appear only for one unambiguous one-time option", () => {
  assert.equal(approvalKeyHintForOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "deny", kind: "reject_once" },
  ], "allow"), "A");
  assert.equal(approvalKeyHintForOption([
    { optionId: "allow-a", kind: "allow_once" },
    { optionId: "allow-b", kind: "allow_once" },
  ], "allow-a"), null);
  assert.equal(approvalKeyHintForOption([{ optionId: "always", kind: "allow_always" }], "always"), null);
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

test("policy hook selector context renders the bounded tool card", () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalSelectorContext, {
    context: { toolName: "WebFetch" },
  }));
  assert.match(html, /data-selector="tool"/);
  assert.match(html, /<dt>Tool<\/dt><dd>WebFetch<\/dd>/);
});

for (const selector of [
  { key: "path", label: "Path", context: { path: "/repos/demo/src/index.ts" }, value: "/repos/demo/src/index.ts" },
  { key: "network", label: "Network", context: { network: "api.example.com" }, value: "api.example.com" },
  { key: "branch", label: "Branch", context: { branch: "feature/governance" }, value: "feature/governance" },
] as const) {
  test(`policy hook selector context renders the ${selector.key} card`, () => {
    const html = renderToStaticMarkup(React.createElement(ApprovalSelectorContext, {
      context: selector.context,
    }));
    assert.match(html, new RegExp(`data-selector="${selector.key}"`));
    assert.match(html, new RegExp(`<dt>${selector.label}</dt><dd>${selector.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</dd>`));
  });
}

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
        options: [],
        allowOther: true,
        required: false,
      },
    ],
  }));
  assert.match(html, /Deploy MCP: Choose deployment settings/);
  assert.match(html, /<span[^>]*>Response<\/span>/);
  assert.match(html, /type="password"[^>]*maxLength="120"/);
  assert.match(html, /type="number"[^>]*inputMode="numeric"[^>]*step="1"[^>]*min="1"[^>]*max="5"/);
  assert.match(html, /<span class="muted sm"> \(optional\)<\/span>/);
  assert.match(html, /aria-labelledby="[^"]+-question-0 [^"]+-response-0"/);
  assert.match(html, /aria-labelledby="[^"]+-question-1 [^"]+-response-1"/);
  assert.match(html, /aria-labelledby="[^"]+-question-2 [^"]+-response-2"/);
});
