import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DescendantRequestView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { RightPanel, type RightPanelState } from "../components/RightPanel.js";
import { SessionApprovalRegion } from "../components/SessionApproval.js";
import { sessionRequestPanelKey } from "../components/SessionRequestPanel.js";
import { SessionStatusIndicators } from "../components/common.js";
import type { RightPanelMode } from "../right-panel.js";
import "../styles.css";

declare global {
  interface Window {
    __WOLLIPOG_REQUEST_SURFACES_E2E__: {
      openedChild(): DescendantRequestView | null;
      submissions(): unknown[];
    };
  }
}

const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "evidence";
const evidenceCount = Number(new URLSearchParams(window.location.search).get("items")) || 8;
const includeDescendants = scenario === "descendants" ||
  new URLSearchParams(window.location.search).get("children") === "1";
let openedChild: DescendantRequestView | null = null;
const submissions: unknown[] = [];

function evidenceSession(): SessionView {
  const evidence = Array.from({ length: evidenceCount }, (_, index) => ({
    evidenceId: `viewport-${index + 1}`,
    uri: `https://evidence.example/item-${index + 1}.png?signature=hidden-${index + 1}`,
    sha256: String(index).padStart(64, "0"),
  }));
  return {
    id: "evidence-session",
    runnerId: "runner",
    workspaceId: null,
    workspaceName: null,
    title: "Responsive Evidence Review",
    status: "input_required",
    eventEpoch: 3,
    updatedAt: Date.now(),
    pendingApproval: {
      requestId: "evidence-occurrence",
      occurrenceId: "evidence-occurrence",
      kind: "workflow_decision",
      title: "UI Evidence Approval Required",
      context: { input: JSON.stringify({ evidence }) },
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      workflowDecision: {
        requestId: "evidence-request",
        occurrenceId: "evidence-occurrence",
        sessionId: "evidence-session",
        controllingSessionId: "parent",
        category: "ui_evidence_approval",
        resourceKey: "pr-1107-ui",
        resourceSnapshot: { category: "ui_evidence_approval", evidence },
        resourceDigest: "a".repeat(64),
        policyRevision: 1,
        authority: "human",
        status: "pending",
        createdAt: Date.now() - 40_000,
      },
    },
  } as SessionView;
}

function descendantRequests(): DescendantRequestView[] {
  return Array.from({ length: 12 }, (_, index) => {
    const orchestrator = index % 3 === 2;
    return {
      sessionId: `child-${index + 1}`,
      sessionTitle: `Child Session ${index + 1}`,
      runnerId: "runner",
      runnerOnline: true,
      eventEpoch: index + 1,
      createdAt: Date.now() - ((index + 1) * 60_000),
      responseOwner: orchestrator ? "orchestrator" : "human",
      occurrenceId: `occurrence-${index + 1}`,
      request: orchestrator ? {
        requestId: `merge-${index + 1}`,
        occurrenceId: `occurrence-${index + 1}`,
        kind: "workflow_decision",
        title: "PR Merge Approval Required",
        options: [
          { optionId: "approve", name: "Approve", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        workflowDecision: {
          requestId: `merge-request-${index + 1}`,
          occurrenceId: `occurrence-${index + 1}`,
          sessionId: `child-${index + 1}`,
          controllingSessionId: "parent",
          category: "pr_merge",
          resourceKey: `pr-${100 + index}`,
          resourceSnapshot: {
            category: "pr_merge",
            repository: "picoduck/wollipog",
            pullRequest: 100 + index,
            headSha: "b".repeat(40),
            reviewResult: "merge",
            requiredChecks: { headSha: "b".repeat(40), status: "passed", checkedAt: 1, checks: [] },
          },
          resourceDigest: "c".repeat(64),
          policyRevision: 1,
          authority: "orchestrator",
          status: "pending",
          createdAt: Date.now() - ((index + 1) * 60_000),
        },
      } : {
        requestId: `question-${index + 1}`,
        occurrenceId: `occurrence-${index + 1}`,
        kind: "question",
        title: "Question",
        options: [],
        questions: [{
          id: "target",
          question: `Choose the deployment target for child ${index + 1}`,
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    } satisfies DescendantRequestView;
  });
}

function Fixture() {
  const [session, setSession] = useState(() => scenario === "descendants"
    ? {
        ...evidenceSession(),
        status: "running",
        pendingApproval: null,
        orchestratorCampaign: {
          pendingRequests: { human: 8, orchestrator: 4 },
        } as SessionView["orchestratorCampaign"],
      } as SessionView
    : evidenceSession());
  const descendants = useMemo(() => includeDescendants ? descendantRequests() : [], []);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RightPanelMode>("requests");
  const [width, setWidth] = useState(420);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => scenario !== "descendants"
    ? sessionRequestPanelKey(session.id, session.pendingApproval!.occurrenceId!)
    : sessionRequestPanelKey(descendants[0]!.sessionId, descendants[0]!.occurrenceId));
  const legacyFocusRef = useRef<HTMLTextAreaElement>(null);
  const state: RightPanelState = {
    open,
    mode,
    width,
    dragging: false,
    subagentTarget: null,
    toggle: () => setOpen((value) => !value),
    openMode: (next) => {
      setMode(next);
      setOpen((value) => !(value && mode === next));
    },
    show: (next) => { setMode(next); setOpen(true); },
    setMode,
    setWidth: (update) => setWidth(update),
    setDragging: () => {},
    close: () => setOpen(false),
    selectSubagent: () => {},
    showSubagent: () => {},
    consumeSubagentFocusRequest: () => {},
  };
  const client = {
    ...api,
    approve: async (_sessionId: string, body: unknown) => {
      submissions.push(structuredClone(body));
      const updated = { ...session, status: "running", pendingApproval: null } as SessionView;
      setSession(updated);
      setOpen(false);
      return updated;
    },
  } as ApiClient;
  const ownDecision = session.pendingApproval?.workflowDecision;

  return (
    <ApiProvider client={client}>
      <main className="app" style={{ display: "block", height: "100dvh" }}>
        <section className="session-detail expanded" style={{ height: "100%" }}>
          <header className="detail-head" style={{ justifyContent: "space-between" }}>
            <h1 className="detail-title">Request Review</h1>
            {scenario === "descendants" ? (
              <SessionStatusIndicators
                session={session}
                onOpenAttention={() => setOpen(true)}
                onOpenCampaignRequests={() => setOpen(true)}
              />
            ) : <span />}
          </header>
          <div className="detail-columns">
            <div className="detail-chat">
              {scenario === "legacy" && (
                <SessionApprovalRegion
                  session={session}
                  runnerOnline
                  fallbackFocusRef={legacyFocusRef}
                  onSessionUpdate={setSession}
                  showKeyHints={false}
                />
              )}
              <div className="detail-main">
                <div className="detail-reader">
                  <div className="detail-scroll measured-virtual-scroll" role="region" aria-label="Session Activity">
                    {Array.from({ length: 24 }, (_, index) => (
                      <div className={`tl-row ${index % 2 ? "agent" : "user"}`} key={index}>
                        <div className={index % 2 ? "bubble agent-bubble" : "bubble user-bubble"}>
                          Transcript message {index + 1}
                        </div>
                      </div>
                    ))}
                    {scenario === "evidence" && ownDecision?.resourceSnapshot.category === "ui_evidence_approval" && (
                      <section className="tl-request-card" aria-label="Pending UI Evidence Request">
                        <span className="tl-request-icon" aria-hidden="true">🖼️</span>
                        <span className="tl-request-copy">
                          <strong>UI Evidence Review Required</strong>
                          <span>{ownDecision.resourceSnapshot.evidence.length} Evidence Items</span>
                        </span>
                        <button
                          className="btn primary sm"
                          type="button"
                          aria-controls="right-panel"
                          onClick={() => setOpen(true)}
                        >
                          Review Evidence
                        </button>
                      </section>
                    )}
                  </div>
                </div>
                <div className="composer"><div className="composer-box"><textarea ref={legacyFocusRef} className="composer-input" aria-label="Composer" /></div></div>
              </div>
            </div>
            <RightPanel
              state={state}
              session={session}
              runnerOnline
              runnerProtocolVersion={999}
              onOpenSourceLocation={() => {}}
              onClearSourceLocation={() => {}}
              git={{
                status: null,
                observation: 0,
                observedAt: null,
                settled: true,
                busy: false,
                error: null,
                errorCode: null,
                refresh: async () => {},
                refreshStatusOnly: async () => {},
                install: () => {},
                mutationRevision: 0,
              }}
              onOpenTerminal={() => {}}
              onInsertSideChatDraft={() => {}}
              items={[]}
              descendantRequests={descendants}
              selectedRequestKey={selectedKey}
              onSelectedRequestKeyChange={setSelectedKey}
              onSessionUpdate={setSession}
              onDescendantsUpdate={() => {}}
              onOpenChildRequest={(request) => { openedChild = request; }}
            />
          </div>
        </section>
      </main>
    </ApiProvider>
  );
}

window.__WOLLIPOG_REQUEST_SURFACES_E2E__ = {
  openedChild: () => openedChild,
  submissions: () => submissions,
};

createRoot(document.getElementById("root")!).render(<Fixture />);
