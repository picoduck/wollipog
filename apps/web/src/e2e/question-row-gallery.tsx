import type { AgentQuestion, QuestionAnswerSummaryEntry, SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { EventTimeline } from "../components/EventTimeline.js";
import { ViewerIdentityContext, viewerIdentity } from "../resolver-identity.js";
import { deriveTimeline } from "../timeline.js";

/**
 * Every question row the transcript draws (#2188), built from stored events through the real
 * projection: answered single, multi-select, free-text and secret answers, several questions in one
 * request, a dismissal, a policy answer and an unanswered question.
 */
const destination: AgentQuestion = {
  id: "destination",
  header: "Destination",
  question: "Where should this release deploy first?",
  options: [
    { label: "Destination 1 (Production)", description: "Customers see it immediately." },
    { label: "Destination 2 (Staging)", description: "Verify it before promoting." },
  ],
};
const checks: AgentQuestion = {
  id: "checks",
  header: "Checks",
  question: "Which checks should run before the release is promoted?",
  multiSelect: true,
  options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
};
const note: AgentQuestion = {
  id: "note",
  header: "Note",
  question: "Anything the reviewer should know?",
  options: [],
  allowOther: true,
};
const token: AgentQuestion = {
  id: "token",
  header: "Token",
  question: "Paste the temporary deploy token.",
  options: [],
  allowOther: true,
  secret: true,
};
const proceed: AgentQuestion = {
  id: "review",
  header: "Review",
  question: "May I send this diff for review?",
  options: [{ label: "Proceed" }, { label: "Wait" }],
};

const base = Date.UTC(2026, 9, 3, 7, 30, 0);
const events: SessionEvent[] = [];
function add(payload: SessionEventPayload, minute: number): SessionEvent {
  const event = { id: events.length + 1, sessionId: "gallery", seq: events.length + 1, ts: base + minute * 60_000, payload };
  events.push(event);
  return event;
}
function answered(
  requestId: string,
  questions: AgentQuestion[],
  answers: QuestionAnswerSummaryEntry[],
  minute: number,
): void {
  add({ kind: "question_request", requestId, questions }, minute);
  add({ kind: "question_resolved", requestId, answered: true, resolutionReason: "submitted", answers }, minute + 1);
}

answered("single", [destination], [{ questionId: "destination", selected: ["Destination 1 (Production)"] }], 0);
answered("multi", [checks], [{ questionId: "checks", selected: ["Unit Tests", "Smoke Test"] }], 2);
answered("free-text", [note], [{ questionId: "note", text: "Ship after the Friday freeze, and page the on-call reviewer first." }], 4);
answered("secret", [token], [{ questionId: "token", withheld: true }], 6);
answered("several", [destination, checks, note], [
  { questionId: "destination", selected: ["Destination 2 (Staging)"] },
  { questionId: "checks", selected: ["Browser Tests"] },
  { questionId: "note", text: "Hold production until QA signs off." },
], 8);
add({ kind: "question_request", requestId: "dismissed", questions: [destination] }, 10);
add({ kind: "question_resolved", requestId: "dismissed", answered: false, resolutionReason: "dismissed" }, 11);
const policy = add({ kind: "question_request", requestId: "policy", questions: [proceed] }, 12);
add({
  kind: "question_policy_answered", requestId: "policy", questionEventSeq: policy.seq,
  policies: [{ policyId: "routine", name: "Review Sharing and Retries" }],
}, 12);
add({ kind: "question_resolved", requestId: "policy", answered: true, resolutionReason: "submitted",
  answers: [{ questionId: "review", selected: ["Proceed"] }] }, 12);
add({ kind: "question_request", requestId: "awaiting", questions: [checks] }, 14);

/** The only member of a personal installation reads every answer as their own. */
const soloViewer = viewerIdentity({
  context: {
    userId: "user-local", userName: "Local owner", organizationId: "org", organizationName: "Personal organization",
    role: "owner", deviceId: null, localBootstrap: true,
  },
  organizations: [],
  memberships: [],
  teams: [],
});

export function QuestionRowGallery() {
  return (
    <ViewerIdentityContext.Provider value={soloViewer}>
      <EventTimeline ariaLabel="Question Rows" items={deriveTimeline(events)} />
    </ViewerIdentityContext.Provider>
  );
}
