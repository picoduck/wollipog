import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentQuestion, SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { deriveTimeline, type TimelineItem } from "../timeline.js";
import { QuestionHistoryRow, questionAnswerLine, questionOutcome } from "./QuestionHistoryRow.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

type QuestionItem = Extract<TimelineItem, { kind: "question" }>;

const ASKED = Date.UTC(2026, 9, 3, 0, 30, 0);
const ANSWERED = Date.UTC(2026, 9, 3, 0, 31, 0);

const destination: AgentQuestion = {
  id: "destination",
  header: "Destination",
  question: "Where should this deploy?",
  options: [{ label: "Destination 1 (Production)" }, { label: "Destination 2 (Staging)" }],
};
const checks: AgentQuestion = {
  id: "checks",
  question: "Which checks should run first?\n\nPick every one you need.",
  multiSelect: true,
  options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
};
const note: AgentQuestion = { id: "note", header: "Note", question: "Anything else?", options: [], allowOther: true };
const token: AgentQuestion = { id: "token", header: "Token", question: "Paste the token.", options: [], allowOther: true, secret: true };

let seq = 0;
function event(payload: SessionEventPayload, ts: number): SessionEvent {
  seq += 1;
  return { id: seq, sessionId: "session", seq, ts, payload };
}

/** The rows the transcript builds from these stored events, as a reload would. */
function questionFrom(events: SessionEvent[]): QuestionItem {
  const item = deriveTimeline(events).find((candidate) => candidate.kind === "question");
  assert.ok(item?.kind === "question");
  return item;
}

function ask(questions: AgentQuestion[], requestId = "ask"): SessionEvent {
  return event({ kind: "question_request", requestId, questions }, ASKED);
}

function render(item: QuestionItem, open = false): string {
  return renderToStaticMarkup(React.createElement(QuestionHistoryRow, { item, open }));
}

const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a single-choice answer reads on line 2 from the stored event (#2188)", () => {
  const request = ask([destination]);
  const item = questionFrom([
    request,
    event({
      kind: "question_answered", requestId: "ask", questionEventSeq: request.seq,
      answers: [{ questionId: "destination", selected: ["Destination 1 (Production)"] }], answeredBy: { kind: "person" },
    }, ANSWERED),
    event({ kind: "question_resolved", requestId: "ask", answered: true }, ANSWERED + 500),
  ]);
  assert.equal(item.resolvedAt, ANSWERED, "the stored answer's time, not the runner's later resolution");
  assert.equal(questionOutcome(item), "answered");
  const html = render(item);
  assert.match(html, /<span class="tl-step-title">Destination<\/span><span class="tl-step-detail">Answer: Destination 1 \(Production\)<\/span>/);
  assert.match(html, /<span class="status sm t-success inline tl-step-status">Answered<\/span>/);
  assert.match(html, /aria-label="Destination · Answer: Destination 1 \(Production\) · Answered"/);
  assert.match(html, /<time dateTime="2026-10-03T00:31:00.000Z">/);
  assert.match(html, /Asked [^,]+, answered /);
  assert.match(visibleText(render(item, true)), /Answered by you at /);
  assert.doesNotMatch(html, /❓|→|tl-perm/);
});

test("a multi-select answer lists every chosen label, and its body checks them under the question shown once", () => {
  const request = ask([checks]);
  const item = questionFrom([
    request,
    event({
      kind: "question_answered", requestId: "ask", questionEventSeq: request.seq,
      answers: [{ questionId: "checks", selected: ["Unit Tests", "Smoke Test"] }], answeredBy: { kind: "person" },
    }, ANSWERED),
  ]);
  const html = render(item, true);
  assert.match(html, /<span class="tl-step-detail">Answer: Unit Tests, Smoke Test<\/span>/);
  assert.equal((visibleText(html).match(/Pick every one you need\./g) ?? []).length, 1, "the question text appears once");
  const chosen = [...html.matchAll(/<li class="chosen">.*?<span>([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(chosen, ["Unit Tests", "Smoke Test"]);
  assert.equal((html.match(/lucide-check /g) ?? []).length, 2);
  assert.match(html, /<li><span class="tl-question-check" aria-hidden="true"><\/span><span>Browser Tests<\/span><\/li>/);
});

test("several questions in one request are one row listing every answer, free text in quotes and a secret not shown", () => {
  const request = ask([destination, note, token]);
  const item = questionFrom([
    request,
    event({
      kind: "question_answered", requestId: "ask", questionEventSeq: request.seq,
      answers: [
        { questionId: "destination", selected: ["Destination 2 (Staging)"] },
        { questionId: "note", text: "Ship after the freeze" },
        { questionId: "token", withheld: true },
      ],
      answeredBy: { kind: "person" },
    }, ANSWERED),
  ]);
  const html = render(item, true);
  assert.match(html, /<span class="tl-step-title">Destination, Note, Token<\/span>/);
  assert.match(html, /<span class="tl-step-detail">Answers: Destination 2 \(Staging\) · “Ship after the freeze” · \(not shown\)<\/span>/);
  assert.match(html, /<p class="tl-question-free-text">“Ship after the freeze”<\/p>/);
  assert.match(html, /<p class="tl-question-withheld">Answer not shown<\/p>/);
  assert.equal((html.match(/class="tl-question-item"/g) ?? []).length, 3);
});

test("a secret answer reads Answer not shown and never shows its content", () => {
  const request = ask([token]);
  const item = questionFrom([
    request,
    event({
      kind: "question_answered", requestId: "ask", questionEventSeq: request.seq,
      answers: [{ questionId: "token", withheld: true }], answeredBy: { kind: "person" },
    }, ANSWERED),
  ]);
  assert.equal(questionAnswerLine(item), "Answer not shown");
  assert.match(render(item), /<span class="tl-step-detail">Answer not shown<\/span>/);
});

test("a dismissed question reads Dismissed in the neutral tone with no answer line", () => {
  const item = questionFrom([ask([destination]), event({ kind: "question_resolved", requestId: "ask", answered: false }, ANSWERED)]);
  const html = render(item, true);
  assert.match(html, /<span class="status sm t-neutral inline tl-step-status">Dismissed<\/span>/);
  assert.doesNotMatch(html, /tl-step-detail|lucide-check /);
  assert.match(visibleText(html), /Dismissed at /);
});

test("a later dismissal drops an answer summary, and a summary never revives a dismissed question", () => {
  const request = ask([destination]);
  const answer: SessionEventPayload = {
    kind: "question_answered", requestId: "ask", questionEventSeq: request.seq,
    answers: [{ questionId: "destination", selected: ["Destination 1 (Production)"] }], answeredBy: { kind: "person" },
  };
  const dismissedAfter = questionFrom([request, event(answer, ANSWERED), event({ kind: "question_resolved", requestId: "ask", answered: false }, ANSWERED)]);
  assert.equal(dismissedAfter.answers, undefined);
  assert.equal(questionAnswerLine(dismissedAfter), null);
  const second = ask([destination]);
  const dismissedBefore = questionFrom([second, event({ kind: "question_resolved", requestId: "ask", answered: false }, ANSWERED),
    event({ ...answer, questionEventSeq: second.seq }, ANSWERED + 1)]);
  assert.equal(dismissedBefore.answered, false);
  assert.equal(dismissedBefore.answers, undefined);
});

test("a policy answer reads Answered by Policy with the policy's name and its answer", () => {
  const request = ask([destination]);
  const item = questionFrom([
    request,
    event({
      kind: "question_policy_answered", requestId: "ask", questionEventSeq: request.seq,
      policies: [{ policyId: "routine", name: "Routine Deploys" }],
      answers: [{ questionId: "destination", selected: ["Destination 2 (Staging)"] }],
    }, ANSWERED),
    event({ kind: "question_resolved", requestId: "ask", answered: true }, ANSWERED),
  ]);
  const html = render(item, true);
  assert.match(html, /<span class="tl-step-detail">Answer: Destination 2 \(Staging\) · Policy: Routine Deploys<\/span>/);
  assert.match(html, /t-success inline tl-step-status">Answered by Policy<\/span>/);
  assert.match(visibleText(html), /Answered by policy Routine Deploys at /);
});

test("a Parent Control answer reads Answered by Parent", () => {
  const request = ask([destination]);
  const item = questionFrom([
    request,
    event({
      kind: "question_answered", requestId: "ask", questionEventSeq: request.seq,
      answers: [{ questionId: "destination", selected: ["Destination 1 (Production)"] }],
      answeredBy: { kind: "parent", sessionId: "parent-session-1" },
    }, ANSWERED),
  ]);
  assert.equal(item.resolvedByParentSessionId, "parent-session-1");
  assert.equal(questionOutcome(item), "answered_by_parent");
  assert.match(visibleText(render(item, true)), /Answered by parent session parent-sessi… at /);
});

test("an older runner's answer without a summary reads Answered with no answer line and no error", () => {
  const item = questionFrom([ask([destination]), event({ kind: "question_resolved", requestId: "ask", answered: true }, ANSWERED)]);
  assert.equal(item.answers, undefined);
  const html = render(item, true);
  assert.match(html, /t-success inline tl-step-status">Answered<\/span>/);
  assert.doesNotMatch(html, /tl-step-detail|lucide-check /);
  assert.match(visibleText(html), /Answered at /);
  assert.doesNotMatch(visibleText(html), /Answered by you/, "who answered is unknown without the summary");
});

test("an unanswered question keeps the Awaiting Answer warning status", () => {
  const item = questionFrom([ask([destination])]);
  assert.equal(questionOutcome(item), "awaiting_answer");
  const html = render(item);
  assert.match(html, /<span class="status sm t-warning inline tl-step-status">Awaiting Answer<\/span>/);
  assert.doesNotMatch(html, /tl-step-detail|tl-question-resolution/);
});

test("a summary restored after the runner's resolution still attaches to its own question", () => {
  const first = ask([destination]);
  const second = ask([destination]);
  const items = deriveTimeline([
    first,
    event({ kind: "question_resolved", requestId: "ask", answered: true }, ANSWERED),
    second,
    event({
      kind: "question_answered", requestId: "ask", questionEventSeq: first.seq,
      answers: [{ questionId: "destination", selected: ["Destination 2 (Staging)"] }], answeredBy: { kind: "person" },
    }, ANSWERED),
  ]).filter((item): item is QuestionItem => item.kind === "question");
  assert.deepEqual(items.map((item) => item.answers?.[0]?.selected), [["Destination 2 (Staging)"], undefined]);
  assert.equal(items[1]!.answered, undefined, "an identical later request stays pending");
});

test("replaced, expired and provider-resolved questions keep their outcome words", () => {
  for (const [reason, label] of [["replaced", "Replaced"], ["expired", "Expired"], ["provider_resolved", "Resolved by Provider"]] as const) {
    const item = questionFrom([ask([destination]), event({
      kind: "question_resolved", requestId: "ask", answered: false, resolutionReason: reason,
    }, ANSWERED)]);
    assert.match(render(item), new RegExp(`t-neutral inline tl-step-status">${label}</span>`));
  }
});
