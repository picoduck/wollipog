import { removePendingRequest, type ControlPlaneToUi, type SessionView } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";

export function installInboxTriageFixture(
  client: ApiClient,
  sessions: SessionView[],
  push: (message: ControlPlaneToUi) => void,
) {
  const actions: Array<{ sessionId: string; requestId: string; optionId: string | null }> = [];
  const questionActions: Array<{ sessionId: string; body: Parameters<ApiClient["answerQuestion"]>[1] }> = [];
  for (const session of sessions) {
    session.status = "input_required";
    session.pendingApproval = {
      requestId: `ask-${session.id}`, kind: "policy_hook", title: `Review ${session.title}`,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    };
  }
  const detail = (id: string) => structuredClone(sessions.find((session) => session.id === id)!);
  client.session = async (id) => {
    // A synthetic HTTP seam gives Playwright control of individual responses and real request counts.
    const response = await fetch(`/__inbox-triage-detail/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("Synthetic detail read failed");
    return response.json();
  };
  client.approve = async (id, body) => {
    actions.push({ sessionId: id, ...body });
    const session = sessions.find((candidate) => candidate.id === id)!;
    session.pendingApproval = removePendingRequest(session.pendingApproval, body.requestId);
    session.updatedAt += 1;
    push({ type: "session_upsert", session: detail(id) });
    return detail(id);
  };
  client.answerQuestion = async (id, body) => {
    questionActions.push({ sessionId: id, body: structuredClone(body) });
    const session = sessions.find((candidate) => candidate.id === id)!;
    session.pendingApproval = removePendingRequest(session.pendingApproval, body.requestId);
    return detail(id);
  };
  window.__WOLLIPOG_INBOX_TRIAGE_E2E__ = {
    detail,
    actions: () => structuredClone(actions),
    questionActions: () => structuredClone(questionActions),
    summary(id, patch = {}) {
      const session = sessions.find((candidate) => candidate.id === id)!;
      Object.assign(session, structuredClone(patch));
      push({ type: "session_upsert", session: { ...detail(id), projection: "summary", agentCapabilities: undefined } });
    },
  };
}

declare global {
  interface Window {
    __WOLLIPOG_INBOX_TRIAGE_E2E__: {
      detail(id: string): SessionView;
      actions(): Array<{ sessionId: string; requestId: string; optionId: string | null }>;
      questionActions(): Array<{ sessionId: string; body: Parameters<ApiClient["answerQuestion"]>[1] }>;
      summary(id: string, patch?: Partial<SessionView>): void;
    };
  }
}
