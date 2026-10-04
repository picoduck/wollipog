import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentQuestion, QuestionAnswerSummaryEntry, SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { deriveTimeline, type TimelineItem } from "../timeline.js";
import { ViewerIdentityContext, viewerIdentity, type ViewerIdentity } from "../resolver-identity.js";
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

function render(item: QuestionItem, open = false, viewing: ViewerIdentity | null = null): string {
  return renderToStaticMarkup(React.createElement(
    ViewerIdentityContext.Provider,
    { value: viewing },
    React.createElement(QuestionHistoryRow, { item, open }),
  ));
}

function viewer(userId: string, members: Array<[string, string]>): ViewerIdentity {
  return viewerIdentity({
    context: {
      userId, userName: "", organizationId: "org-1", organizationName: "Org", role: "operator",
      deviceId: null, localBootstrap: false,
    },
    organizations: [],
    memberships: members.map(([memberId, userName]) => ({
      organizationId: "org-1", organizationName: "Org", userId: memberId, userName,
      userStatus: "active", role: "operator", createdAt: 1,
    })),
    teams: [],
  });
}

const SOLO = viewer("user-local", [["user-local", "Local owner"]]);
const MEMBERS: Array<[string, string]> = [["user-ada", "Ada Lovelace"], ["user-grace", "Grace Hopper"]];

const resolutionOf = (html: string) => /<p class="tl-question-resolution">([^<]*)<\/p>/.exec(html)?.[1];

const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The runner's resolution of a submitted answer, carrying the control plane's summary. */
function answered(answers: QuestionAnswerSummaryEntry[] | undefined, extra: Partial<Extract<SessionEventPayload, { kind: "question_resolved" }>> = {}, requestId = "ask"): SessionEvent {
  return event({
    kind: "question_resolved", requestId, answered: true, resolutionReason: "submitted",
    ...(answers ? { answers } : {}), ...extra,
  }, ANSWERED);
}

test("a single-choice answer reads on line 2 from the stored event (#2188)", () => {
  const item = questionFrom([ask([destination]), answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }])]);
  assert.equal(item.resolvedAt, ANSWERED);
  assert.equal(questionOutcome(item), "answered");
  const html = render(item);
  assert.match(html, /<span class="tl-step-title"><span class="tl-step-verb">Destination<\/span><\/span><span class="tl-step-detail">Answer: Destination 1 \(Production\)<\/span>/);
  assert.match(html, /<span class="status sm t-success inline tl-step-status">Answered<\/span>/);
  assert.match(html, /aria-label="Destination · Answer: Destination 1 \(Production\) · Answered"/);
  assert.match(html, /<time dateTime="2026-10-03T00:31:00.000Z">/);
  assert.match(html, /Asked [^,]+, answered /);
  assert.match(visibleText(render(item, true, SOLO)), /Answered by you at /);
  assert.doesNotMatch(html, /❓|→|tl-perm/);
});

test("a multi-select answer lists every chosen label, and its body checks them under the question shown once", () => {
  const item = questionFrom([ask([checks]), answered([{ questionId: "checks", selected: ["Unit Tests", "Smoke Test"] }])]);
  const html = render(item, true);
  assert.match(html, /<span class="tl-step-detail">Answer: Unit Tests, Smoke Test<\/span>/);
  assert.equal((visibleText(html).match(/Pick every one you need\./g) ?? []).length, 1, "the question text appears once");
  const chosen = [...html.matchAll(/<li class="chosen">.*?<span>([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(chosen, ["Unit Tests", "Smoke Test"]);
  assert.equal((html.match(/lucide-check /g) ?? []).length, 2);
  assert.match(html, /<li><span class="tl-question-check" aria-hidden="true"><\/span><span>Browser Tests<\/span><\/li>/);
});

test("several questions in one request are one row listing every answer, free text in quotes and a secret not shown", () => {
  const item = questionFrom([ask([destination, note, token]), answered([
    { questionId: "destination", selected: ["Destination 2 (Staging)"] },
    { questionId: "note", text: "Ship after the freeze" },
    { questionId: "token", withheld: true },
  ])]);
  const html = render(item, true);
  assert.match(html, /<span class="tl-step-title"><span class="tl-step-verb">Destination, Note, Token<\/span><\/span>/);
  assert.match(html, /<span class="tl-step-detail">Answers: Destination 2 \(Staging\) · “Ship after the freeze” · \(not shown\)<\/span>/);
  assert.match(html, /<p class="tl-question-free-text">“Ship after the freeze”<\/p>/);
  assert.match(html, /<p class="tl-question-withheld">Answer not shown<\/p>/);
  assert.equal((html.match(/class="tl-question-item"/g) ?? []).length, 3);
});

test("a secret answer reads Answer not shown and never shows its content", () => {
  const item = questionFrom([ask([token]), answered([{ questionId: "token", withheld: true }])]);
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

test("a later dismissal drops an earlier answer", () => {
  const item = questionFrom([ask([destination]), answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }]),
    event({ kind: "question_resolved", requestId: "ask", answered: false, resolutionReason: "replaced" }, ANSWERED + 1)]);
  assert.equal(item.answers, undefined);
  assert.equal(questionAnswerLine(item), null);
});

test("a policy answer reads Answered by Policy with the policy's name and its answer", () => {
  const request = ask([destination]);
  const item = questionFrom([
    request,
    event({
      kind: "question_policy_answered", requestId: "ask", questionEventSeq: request.seq,
      policies: [{ policyId: "routine", name: "Routine Deploys" }],
    }, ANSWERED),
    answered([{ questionId: "destination", selected: ["Destination 2 (Staging)"] }]),
  ]);
  const html = render(item, true);
  assert.match(html, /<span class="tl-step-detail">Answer: Destination 2 \(Staging\) · Policy: Routine Deploys<\/span>/);
  assert.match(html, /t-success inline tl-step-status">Answered by Policy<\/span>/);
  assert.match(visibleText(html), /Answered by policy Routine Deploys at /);
});

test("a Parent Control answer reads Answered by Parent", () => {
  const item = questionFrom([ask([destination]), answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }],
    { resolvedByParentSessionId: "parent-session-1" })]);
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

test("a shared session names who answered relative to the viewer, never by raw user id (#2527)", () => {
  const byAda = questionFrom([ask([destination]), answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }],
    { answeredByUserId: "user-ada" })]);
  assert.equal(byAda.answeredByUserId, "user-ada");
  const ada = viewer("user-ada", MEMBERS);
  const grace = viewer("user-grace", MEMBERS);

  assert.match(resolutionOf(render(byAda, true, ada))!, /^Answered by you at /);
  assert.match(resolutionOf(render(byAda, true, grace))!, /^Answered by Ada Lovelace at /);

  // A resolver missing from the directory, or without a display name, is "another member".
  const unnamed = viewer("user-grace", [...MEMBERS, ["user-anon", "  "]]);
  for (const answeredByUserId of ["user-gone", "user-anon"]) {
    const item = questionFrom([ask([destination]), answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }],
      { answeredByUserId })]);
    const html = render(item, true, unnamed);
    assert.match(resolutionOf(html)!, /^Answered by another member at /);
    assert.doesNotMatch(html, /user-(gone|anon|ada|grace)/, "no raw user id is rendered");
  }

  // Until the viewer is known, nobody is named.
  assert.match(resolutionOf(render(byAda, true, null))!, /^Answered at /);
  // A single-member installation keeps "you", whatever id the record carries.
  assert.match(resolutionOf(render(byAda, true, SOLO))!, /^Answered by you at /);
});

test("an answer an older runner or control plane recorded without its member stays neutral in a shared session", () => {
  // Answers from before protocol 205, or through an older runner, carry no member.
  const withSummary = questionFrom([ask([destination]),
    answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }])]);
  assert.equal(withSummary.answeredByUserId, undefined);
  assert.match(resolutionOf(render(withSummary, true, viewer("user-grace", MEMBERS)))!, /^Answered at /);
  assert.match(resolutionOf(render(withSummary, true, SOLO))!, /^Answered by you at /,
    "a single-member installation still reads its summarized answers as its own");

  const bare = questionFrom([ask([destination]), event({ kind: "question_resolved", requestId: "ask", answered: true }, ANSWERED)]);
  assert.match(resolutionOf(render(bare, true, SOLO))!, /^Answered at /,
    "with neither a summary nor a member, the row cannot tell a person answered");
});

test("each resolution says who settled it, so a reused request id never keeps another occurrence's member", () => {
  // The member rides on the exact resolution the runner recorded, so each occurrence of a reused
  // request id names its own member, and a later resolution never inherits an earlier one.
  const grace = viewer("user-grace", MEMBERS);
  const items = deriveTimeline([
    event({ kind: "question_request", requestId: "reused", occurrenceId: "first", questions: [destination] }, ASKED),
    answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }],
      { occurrenceId: "first", answeredByUserId: "user-ada" }, "reused"),
    event({ kind: "question_request", requestId: "reused", occurrenceId: "second", questions: [destination] }, ASKED),
    answered([{ questionId: "destination", selected: ["Destination 2 (Staging)"] }],
      { occurrenceId: "second", answeredByUserId: "user-grace" }, "reused"),
  ]).filter((item): item is QuestionItem => item.kind === "question");
  assert.deepEqual(items.map((item) => resolutionOf(render(item, true, grace))!.replace(/ at .*/, "")),
    ["Answered by Ada Lovelace", "Answered by you"]);

  const reanswered = questionFrom([ask([destination]),
    answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }], { answeredByUserId: "user-ada" }),
    event({ kind: "question_resolved", requestId: "ask", answered: true, resolutionReason: "submitted" }, ANSWERED + 1)]);
  assert.equal(reanswered.answeredByUserId, undefined);
  const dismissed = questionFrom([ask([destination]),
    answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }], { answeredByUserId: "user-ada" }),
    event({ kind: "question_resolved", requestId: "ask", answered: false, resolutionReason: "replaced" }, ANSWERED + 1)]);
  assert.equal(dismissed.answeredByUserId, undefined);
});

test("an unanswered question keeps the Awaiting Answer warning status", () => {
  const item = questionFrom([ask([destination])]);
  assert.equal(questionOutcome(item), "awaiting_answer");
  const html = render(item);
  assert.match(html, /<span class="status sm t-warning inline tl-step-status">Awaiting Answer<\/span>/);
  assert.doesNotMatch(html, /tl-step-detail|tl-question-resolution/);
});

test("a resolution names its occurrence, so a reused request id never moves an answer to another row", () => {
  const first = event({ kind: "question_request", requestId: "reused", occurrenceId: "request_first", questions: [destination] }, ASKED);
  const second = event({ kind: "question_request", requestId: "reused", occurrenceId: "request_second", questions: [destination] }, ASKED + 1);
  const items = deriveTimeline([
    first, second,
    answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }], { occurrenceId: "request_first" }, "reused"),
  ]).filter((item): item is QuestionItem => item.kind === "question");
  assert.deepEqual(items.map((item) => [item.answered, item.answers?.[0]?.selected]),
    [[true, ["Destination 1 (Production)"]], [undefined, undefined]]);

  // Its own question outside the loaded history, the resolution leaves the other occurrence alone.
  const windowed = deriveTimeline([
    event({ kind: "question_request", requestId: "reused", occurrenceId: "request_new", questions: [destination] }, ASKED),
    answered([{ questionId: "destination", selected: ["Destination 1 (Production)"] }], { occurrenceId: "request_old" }, "reused"),
  ]).filter((item): item is QuestionItem => item.kind === "question");
  assert.deepEqual(windowed.map((item) => [item.answered, item.answers]), [[undefined, undefined]]);
});

test("replaced, expired and provider-resolved questions keep their outcome words", () => {
  for (const [reason, label] of [["replaced", "Replaced"], ["expired", "Expired"], ["provider_resolved", "Resolved by Provider"]] as const) {
    const item = questionFrom([ask([destination]), event({
      kind: "question_resolved", requestId: "ask", answered: false, resolutionReason: reason,
    }, ANSWERED)]);
    assert.match(render(item), new RegExp(`t-neutral inline tl-step-status">${label}</span>`));
  }
});
