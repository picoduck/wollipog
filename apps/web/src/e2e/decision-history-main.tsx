/**
 * Decision History harness (#2213): the real right panel and the real audit hook over a fixture
 * governance audit.
 *
 * `scenario` picks what the audit endpoint does:
 * - `decisions` (default): a person's permissions, question, workflow decision and guardrail and
 *   sign-in cards beside policy and fail-closed outcomes, over today, yesterday and earlier, with an
 *   older page behind Load Older Decisions;
 * - `empty`: a session with no decisions;
 * - `loading`: a first page that never arrives;
 * - `error`: a first page that fails until Retry.
 * `theme=light` switches the palette; `open=launcher` starts on the launcher instead of the mode.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type GovernanceAuditEntry, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { RightPanel, type RightPanelState } from "../components/RightPanel.js";
import { useGovernanceAudit } from "../components/useGovernanceAudit.js";
import { GovernancePolicyNamesContext } from "../decision-record.js";
import type { GovernanceDecision } from "../governance.js";
import { ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";
import type { RightPanelMode } from "../right-panel.js";
import "../styles.css";

declare global {
  interface Window {
    __WOLLIPOG_DECISION_HISTORY_E2E__: {
      /** Every transcript row Show in Transcript asked to reveal, in order. */
      revealed(): number[];
      /** Audit requests the panel sent, as `newest` or the older cursor. */
      requests(): string[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "decisions";
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Decisions are placed relative to now, but never earlier than 2 AM today, so a run just after
// midnight still finds today's decisions under Today.
const NOW = Math.max(Date.now(), new Date().setHours(2, 0, 0, 0));
const SESSION_ID = "s_decisions";
const person = { kind: "human" as const, id: "user-ada" };

function entry(auditId: string, at: number, overrides: Partial<GovernanceAuditEntry>): GovernanceAuditEntry {
  return {
    auditId,
    requestId: `request-${auditId}`,
    approvalKind: "permission",
    stage: "resolution",
    outcome: "allowed",
    actor: person,
    scope: { sessionId: SESSION_ID, runnerId: "runner-1" },
    timestamp: at,
    ...overrides,
  };
}

const scope = (toolName: string, path?: string) => ({ sessionId: SESSION_ID, runnerId: "runner-1", toolName, ...(path ? { path } : {}) });

/** The newest page, oldest first as the endpoint returns it. */
const newestPage: GovernanceAuditEntry[] = [
  entry("yesterday-continue", NOW - DAY - 2 * HOUR, { approvalKind: "cost_checkpoint", outcome: "allowed" }),
  entry("yesterday-signin", NOW - DAY - HOUR, { approvalKind: "authentication", outcome: "dismissed" }),
  entry("policy-permission", NOW - 110 * MINUTE, {
    actor: { kind: "policy", id: "allow-reads" }, governancePolicyId: "allow-reads", scope: scope("Grep"),
  }),
  entry("allow-read", NOW - 95 * MINUTE, {
    approvalKind: "policy_hook", actor: { kind: "policy", id: "allow-reads" }, governancePolicyId: "allow-reads",
    scope: scope("Read", "apps/web/src/governance.ts"),
  }),
  entry("allow-bash", NOW - 80 * MINUTE, { scope: scope("Bash"), requestId: "perm-bash" }),
  entry("reject-write", NOW - 65 * MINUTE, {
    outcome: "denied", scope: scope("mcp__github__create_pull_request_review_comment"), requestId: "perm-write",
  }),
  entry("answer", NOW - 50 * MINUTE, { approvalKind: "question", outcome: "answered", requestId: "question-1" }),
  entry("approve-merge", NOW - 35 * MINUTE, { approvalKind: "workflow_decision", outcome: "allowed" }),
  entry("fail-closed", NOW - 20 * MINUTE, {
    approvalKind: "policy_hook", stage: "policy_decision", outcome: "denied",
    actor: { kind: "system", id: "decision-history-unavailable" }, scope: scope("WebFetch"),
  }),
  entry("block-shell", NOW - 6 * MINUTE, {
    approvalKind: "policy_hook", stage: "policy_decision", outcome: "denied",
    actor: { kind: "policy", id: "deny-shell" }, governancePolicyId: "deny-shell", scope: scope("Bash"),
  }),
];

const olderPage: GovernanceAuditEntry[] = [
  entry("older-allow", NOW - 3 * DAY, { scope: scope("Edit", "README.md") }),
  entry("older-block", NOW - 3 * DAY + HOUR, {
    approvalKind: "policy_hook", stage: "policy_decision", outcome: "denied",
    actor: { kind: "policy", id: "deny-shell" }, governancePolicyId: "deny-shell", scope: scope("Bash"),
  }),
];

/** The rows the fixture transcript has loaded: Show in Transcript is available for these only. */
const transcriptRows = new Map([["perm-bash", 41], ["question-1", 57], ["request-block-shell", 73]]);

const requests: string[] = [];
const revealed: number[] = [];
let failuresLeft = scenario === "error" ? Number.POSITIVE_INFINITY : 0;
let retried = false;

const client: ApiClient = {
  ...api,
  governanceAudit: async (_id: string, _limit?: number, before?: string) => {
    requests.push(before ?? "newest");
    if (scenario === "loading") return new Promise(() => {});
    if (failuresLeft > 0 && !retried) throw new Error("The audit could not be read.");
    if (scenario === "empty") return { entries: [], hasMore: false };
    if (before) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { entries: olderPage, hasMore: false };
    }
    return { entries: newestPage, nextBefore: "older", hasMore: true };
  },
};

const viewer: ViewerIdentity = { userId: "user-ada", shared: false, names: new Map() };
const policyNames = {
  names: new Map([["deny-shell", "Deny Shell Commands"], ["allow-reads", "Allow Reads"]]),
  load: () => {},
  invalidate: () => {},
};

const session = {
  id: SESSION_ID, runnerId: "runner-1", workspaceId: null, agentId: "claude-native", driver: "claude-code",
  title: "Refactor the Governance Audit Reader", status: "idle", adopted: false, eventEpoch: 1, archived: false,
  runId: null, parentSessionId: null, pendingApproval: null, createdAt: NOW - 2 * DAY, updatedAt: NOW,
  lastEventAt: NOW, messageCount: 40, tokensIn: 0, tokensOut: 0, costUsd: 0, costBudgetUsd: null, maxToolCalls: null,
} as SessionView;

function Fixture() {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<RightPanelMode>(params.get("open") === "launcher" ? "launcher" : "decisions");
  const [width, setWidth] = useState(420);
  const audit = useGovernanceAudit(SESSION_ID, "revision-1", true);
  const state: RightPanelState = {
    open, mode, width, dragging: false, subagentTarget: null,
    toggle: () => setOpen((value) => !value),
    openMode: (next) => { setMode(next); setOpen((value) => !(value && mode === next)); },
    show: (next) => { setMode(next); setOpen(true); },
    setMode,
    setWidth: (update) => setWidth(update),
    setDragging: () => {},
    close: () => setOpen(false),
    selectSubagent: () => {},
    showSubagent: () => {},
    consumeSubagentFocusRequest: () => {},
  };
  return (
    <main className="app" style={{ display: "block", height: "100dvh" }}>
      <section className="session-detail expanded" style={{ height: "100%" }}>
        <header className="detail-bar session-bar">
          <h1 className="detail-bar-title session-bar-title">{session.title}</h1>
        </header>
        <div className="detail-columns">
          <div className="detail-chat">
            <div className="detail-main">
              <div className="detail-reader">
                <div className="detail-scroll" role="region" aria-label="Session Activity">
                  {Array.from({ length: 12 }, (_, index) => (
                    <div className={`tl-row ${index % 2 ? "agent" : "user"}`} key={index}>
                      <div className="tl-bubble">Transcript message {index + 1}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <RightPanel
            state={state}
            session={session}
            runnerOnline
            runnerProtocolVersion={PROTOCOL_VERSION}
            onOpenSourceLocation={() => {}}
            onClearSourceLocation={() => {}}
            git={{
              status: null, observation: 0, observedAt: null, settled: true, busy: false, error: null, errorCode: null,
              refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
            }}
            onOpenTerminal={() => {}}
            onInsertSideChatDraft={() => {}}
            items={[]}
            decisionHistory={audit.history}
            decisionHistoryStatus={audit.status}
            onRetryDecisionHistory={() => {
              retried = true;
              audit.retry();
            }}
            decisionHistoryHasMore={audit.hasMore}
            decisionHistoryLoadingOlder={audit.loadingOlder}
            onLoadOlderDecisions={audit.loadOlder}
            transcriptItemForDecision={(decision: GovernanceDecision) => transcriptRows.get(decision.requestId)}
            onShowDecisionInTranscript={(itemId) => { revealed.push(itemId); }}
          />
        </div>
      </section>
    </main>
  );
}

window.__WOLLIPOG_DECISION_HISTORY_E2E__ = {
  revealed: () => [...revealed],
  requests: () => [...requests],
};

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <ViewerIdentityContext.Provider value={viewer}>
      <GovernancePolicyNamesContext.Provider value={policyNames}>
        <Fixture />
      </GovernancePolicyNamesContext.Provider>
    </ViewerIdentityContext.Provider>
  </ApiProvider>,
);
