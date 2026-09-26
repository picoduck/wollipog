import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DescendantRequestView, SessionView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { CampaignContinuationNotice } from "../components/SessionDetail.js";
import { CampaignHeldChildren } from "../components/CampaignHeldChildren.js";
import { RightPanel, type RightPanelState } from "../components/RightPanel.js";
import { SessionApprovalRegion } from "../components/SessionApproval.js";
import { EventTimeline } from "../components/EventTimeline.js";
import {
  sessionRequestPanelKey,
  type DescendantRequestStatus,
} from "../components/SessionRequestPanel.js";
import { SessionStatusIndicators } from "../components/common.js";
import type { RightPanelMode } from "../right-panel.js";
import type { TimelineItem } from "../timeline.js";
import "../styles.css";

declare global {
  interface Window {
    __WOLLIPOG_REQUEST_SURFACES_E2E__: {
      openedChild(): DescendantRequestView | null;
      submissions(): unknown[];
      workerReviewOpened(): boolean;
      artifactRequests(): string[];
      openedHeldChild(): string | null;
      clearHold(sessionId: string): void;
    };
  }
}

const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "evidence";
const evidenceCount = Number(new URLSearchParams(window.location.search).get("items")) || 8;
const includeDescendants = scenario === "descendants" || scenario === "held" ||
  new URLSearchParams(window.location.search).get("children") === "1";
const requestedPollStatus = new URLSearchParams(window.location.search).get("pollStatus");
const descendantRequestStatus: DescendantRequestStatus = requestedPollStatus === "loading" ||
  requestedPollStatus === "unavailable" ? requestedPollStatus : "ready";
// `artifacts` makes the evidence artifact-backed: `ready` (every item), `mixed` (artifact, URI-only,
// and video items together), `mismatch` (item 2's bytes do not match its digest), `unavailable`
// (item 2 is gone), or `undecodable` (item 2 has a PNG signature, a correct digest, and a body no
// browser can draw, which is exactly what the artifact validator's signature check admits). The captures are drawn here so the fixture needs no binary files.
const artifactMode = new URLSearchParams(window.location.search).get("artifacts");
const artifactBytes = new Map<string, ArrayBuffer>();
const artifactDigests = new Map<string, string>();
const artifactRequests: string[] = [];

async function drawCapture(index: number): Promise<ArrayBuffer> {
  const wide = index % 2 === 0;
  const canvas = document.createElement("canvas");
  canvas.width = wide ? 960 : 390;
  canvas.height = wide ? 600 : 760;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#0f1720";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1c2b3a";
  context.fillRect(0, 0, canvas.width, 56);
  context.fillStyle = ["#2f8f83", "#c9772e", "#5b7fd6", "#a65bb5"][index % 4]!;
  context.fillRect(24, 88, canvas.width - 48, 140);
  context.fillStyle = "#223446";
  for (let row = 0; row < 5; row += 1) context.fillRect(24, 260 + row * 56, canvas.width - 48 - row * 40, 36);
  context.fillStyle = "#e6edf3";
  context.font = "600 22px system-ui, sans-serif";
  context.fillText(`Capture ${index + 1} — ${wide ? "Desktop" : "Mobile"} After`, 24, 36);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
  return blob.arrayBuffer();
}

// A page opened over plain HTTP at a network address has no SubtleCrypto. The card refuses such
// evidence before hashing it, so the recorded digest is never compared there; a placeholder keeps
// the fixture loadable, and a card that did show the bytes would read them as a mismatch.
async function fixtureDigest(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return "e".repeat(64);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function prepareArtifacts(): Promise<void> {
  if (!artifactMode) return;
  if (artifactMode === "video" || artifactMode === "mixed") {
    const bytes = await fetch(new URL("../../e2e/fixtures/session-artifact-review.webm", import.meta.url)).then((response) => response.arrayBuffer());
    artifactBytes.set("art_clip", bytes);
    artifactDigests.set("art_clip", await fixtureDigest(bytes));
  }
  for (let index = 0; index < evidenceCount; index += 1) {
    const bytes = artifactMode === "undecodable" && index === 1
      ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("not an image")]).buffer
      : await drawCapture(index);
    artifactBytes.set(`art_${index + 1}`, bytes);
    artifactDigests.set(`art_${index + 1}`, await fixtureDigest(bytes));
  }
}

let openedChild: DescendantRequestView | null = null;
let openedHeldChild: string | null = null;
let clearHold: (sessionId: string) => void = () => {};
const submissions: unknown[] = [];
let workerReviewOpened = false;

function evidenceSession(): SessionView {
  const evidence = Array.from({ length: evidenceCount }, (_, index) => {
    const base = {
      evidenceId: `viewport-${index + 1}`,
      uri: `https://evidence.example/item-${index + 1}.png?signature=hidden-${index + 1}`,
      sha256: String(index).padStart(64, "0"),
    };
    if (!artifactMode) return base;
    if (artifactMode === "video") return {
      evidenceId: "interaction-clip",
      artifactId: "art_clip",
      mediaType: "video/webm",
      sha256: artifactDigests.get("art_clip")!,
    };
    if (artifactMode === "mixed" && index === 1) return base;
    if (artifactMode === "mixed" && index === 2) {
      return { ...base, evidenceId: "interaction-clip", artifactId: "art_clip", mediaType: "video/webm",
        sha256: artifactDigests.get("art_clip")! };
    }
    const artifact = {
      ...base,
      artifactId: `art_${index + 1}`,
      mediaType: "image/png",
      sha256: artifactMode === "mismatch" && index === 1 ? "f".repeat(64) : artifactDigests.get(`art_${index + 1}`)!,
    };
    if (artifactMode === "artifact-only") {
      const { uri: _externalCopy, ...withoutUri } = artifact;
      return withoutUri;
    }
    return artifact;
  });
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

function standaloneApprovalSession(): SessionView {
  return {
    ...evidenceSession(),
    id: "worktree-setup-session",
    title: "Worktree Setup",
    pendingApproval: {
      requestId: "worktree-setup:one:hash",
      occurrenceId: "worktree-setup-occurrence",
      kind: "permission",
      title: "Trust Worktree Setup Configuration?",
      context: {
        toolName: "wollipog.worktree_setup",
        path: "/workspace/project",
        branch: "fix/responsive-approval",
        input: [
          "Copies:",
          ...Array.from({ length: 12 }, (_, index) => `  config/example-${index + 1}.env -> .env-${index + 1}`),
          "Commands:",
          ...Array.from({ length: 12 }, (_, index) => `  pnpm setup:step-${index + 1}`),
          "Environment: API_BASE_URL, PORT, WOLLIPOG_PROJECT",
        ].join("\n"),
      },
      options: [
        { optionId: "trust", name: "Trust This Configuration", kind: "allow_always" },
        { optionId: "skip", name: "Create Without Setup", kind: "reject_once" },
      ],
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
      request: index === 0 ? {
        requestId: "child-evidence",
        occurrenceId: "occurrence-1",
        kind: "workflow_decision",
        title: "Child UI Evidence Approval",
        options: [
          { optionId: "approve", name: "Approve", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        workflowDecision: {
          requestId: "child-evidence-request",
          occurrenceId: "occurrence-1",
          sessionId: "child-1",
          controllingSessionId: "parent",
          category: "ui_evidence_approval",
          resourceKey: "pr-1107-child-ui",
          resourceSnapshot: {
            category: "ui_evidence_approval",
            evidence: [{
              evidenceId: "child-viewport",
              uri: "https://evidence.example/child.png?signature=hidden-child",
              sha256: "d".repeat(64),
            }],
          },
          resourceDigest: "e".repeat(64),
          policyRevision: 1,
          authority: "human",
          status: "pending",
          createdAt: Date.now() - 60_000,
        },
      } : orchestrator ? {
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

function continuationSession(): SessionView {
  return {
    ...evidenceSession(),
    id: "campaign-session",
    title: "Durable Campaign Recovery",
    status: "idle",
    pendingApproval: null,
    orchestratorCampaign: {
      status: "active",
      policyRevision: 7,
      decisionOwners: {
        implementation_question: "orchestrator",
        pr_merge: "human",
        merged_branch_deletion: "human",
        follow_up_issue_publication: "human",
        ui_evidence_approval: "human",
      },
      limits: { maximumConcurrentChildren: 4, occupied: 2, remaining: 2, costBudgetUsd: null, maxToolCalls: null },
      uiEvidenceReview: { status: "available", effectiveOwner: "orchestrator" },
      children: { total: 4, active: 1, waitingHuman: 0, blocked: 0, verified: 2, cleanupPending: 1 },
      pendingDecisions: { human: 0, orchestrator: 1 },
      followUps: { unique: 0, duplicates: 0 },
      continuation: {
        state: "missing_result",
        pendingEvents: 3,
        continuationId: "campaign_cont_evidence",
        commandId: "campaign_prompt_evidence",
        eventFromSeq: 8,
        eventThroughSeq: 10,
        attemptCount: 2,
        updatedAt: Date.now(),
        error: "Provider accepted the turn but no terminal result was persisted.",
        canAcknowledgeMissingResult: true,
      },
    },
  } as SessionView;
}

const HELD_CHILD_TITLES: Record<string, string> = {
  "held-child-1": "Fix #1650: Keep a Decision Resume Across Worktree Recovery",
  "held-child-2": "Fix #1651: Queue Prompts Behind a Handoff Barrier",
};

/** A campaign whose projection holds two children: one in worktree recovery with a held decision
 * resume, and one with a hold kind this client predates. A third blocked child failed (#1760). */
function heldCampaignSession(): SessionView {
  const base = continuationSession();
  return {
    ...base,
    title: "Issue Campaign With Held Children",
    status: "running",
    orchestratorCampaign: {
      ...base.orchestratorCampaign!,
      status: "blocked",
      continuation: undefined,
      children: { total: 5, active: 1, waitingHuman: 1, blocked: 3, verified: 0, cleanupPending: 0 },
      pendingRequests: { human: 8, orchestrator: 4 },
      heldChildren: [
        {
          sessionId: "held-child-1",
          holds: [{
            kind: "worktree_recovery",
            holdId: "recovery-held-child-1",
            since: Date.now() - 7 * 60_000,
            reason: "The selected worktree /home/dev/worktrees/issue-1650 is on branch main, not " +
              "fix/issue-1650-decision-resume.",
            recoveryAction: "Restore branch fix/issue-1650-decision-resume in /home/dev/worktrees/issue-1650 " +
              "(for example `git -C /home/dev/worktrees/issue-1650 switch fix/issue-1650-decision-resume`) and " +
              "select that worktree again with select_worktree, or select or create another worktree for this " +
              "session with select_worktree or create_worktree.",
            heldResumes: [{
              kind: "workflow_decision_resolution",
              occurrenceId: "wd_occ_merge_1752",
              since: Date.now() - 3 * 60_000,
            }],
          }],
        },
        {
          sessionId: "held-child-2",
          holds: [{
            // A runner-side hold kind this client predates renders from its own fields.
            kind: "handoff_barrier" as never,
            holdId: "barrier-held-child-2",
            since: Date.now() - 90_000,
            reason: "A prompt is queued behind a conversation handoff that has not finished.",
            recoveryAction: "Finish or cancel the handoff; the queued prompt is delivered once it clears.",
          }],
        },
      ],
    },
  } as SessionView;
}

function Fixture() {
  const [session, setSession] = useState(() => scenario === "continuation"
    ? continuationSession()
    : scenario === "held"
    ? heldCampaignSession()
    : scenario === "descendants" || scenario === "polling" ? {
        ...evidenceSession(),
        status: "running",
        pendingApproval: null,
        orchestratorCampaign: {
          pendingRequests: scenario === "descendants"
            ? { human: 8, orchestrator: 4 }
            : { human: 1, orchestrator: 0 },
        } as SessionView["orchestratorCampaign"],
      } as SessionView
    : scenario === "standalone" || scenario === "worker"
      ? {
          ...standaloneApprovalSession(),
          pendingApproval: scenario === "worker"
            ? { ...standaloneApprovalSession().pendingApproval!, ownerToolUseId: "worker-tool" }
            : standaloneApprovalSession().pendingApproval,
        } as SessionView
      : evidenceSession());
  const descendants = useMemo(() => includeDescendants ? descendantRequests() : [], []);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RightPanelMode>("requests");
  const [width, setWidth] = useState(420);
  clearHold = (sessionId: string) => setSession((current) => {
    const campaign = current.orchestratorCampaign!;
    const heldChildren = (campaign.heldChildren ?? []).filter((child) => child.sessionId !== sessionId);
    return {
      ...current,
      orchestratorCampaign: {
        ...campaign,
        children: { ...campaign.children, active: campaign.children.active + 1, blocked: campaign.children.blocked - 1 },
        ...(heldChildren.length ? { heldChildren } : { heldChildren: undefined }),
      },
    } as SessionView;
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(() => scenario === "descendants" || scenario === "held"
    ? sessionRequestPanelKey(descendants[0]!.sessionId, descendants[0]!.occurrenceId)
    : session.pendingApproval?.occurrenceId
      ? sessionRequestPanelKey(session.id, session.pendingApproval.occurrenceId)
      : null);
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
    artifactExport: async (artifactId: string) => {
      artifactRequests.push(artifactId);
      const bytes = artifactBytes.get(artifactId);
      if (!bytes || (artifactMode === "unavailable" && artifactId === "art_2")) {
        throw new ApiError("artifact not found", 404);
      }
      return new Blob([bytes], { type: artifactId === "art_clip" ? "video/webm" : "image/png" });
    },
    approve: async (_sessionId: string, body: unknown) => {
      submissions.push(structuredClone(body));
      const updated = { ...session, status: "running", pendingApproval: null } as SessionView;
      setSession(updated);
      setOpen(false);
      return updated;
    },
    resolvePendingPrompt: async (_sessionId: string, commandId: string, action: "cancel" | "dismiss" | "retry") => {
      submissions.push({ commandId, action });
      const updated = {
        ...session,
        orchestratorCampaign: session.orchestratorCampaign
          ? { ...session.orchestratorCampaign, continuation: undefined }
          : undefined,
      } as SessionView;
      setSession(updated);
      return updated;
    },
  } as ApiClient;
  const ownDecision = session.pendingApproval?.workflowDecision;
  const standaloneTemplate = scenario === "standalone" || scenario === "worker"
    ? standaloneApprovalSession().pendingApproval! : null;
  const standaloneTimelineItems: TimelineItem[] = standaloneTemplate ? [{
    kind: "permission",
    id: 25,
    requestId: standaloneTemplate.requestId,
    title: standaloneTemplate.title,
    options: standaloneTemplate.options,
    context: standaloneTemplate.context,
    ...(session.pendingApproval ? {} : { resolvedOptionId: "trust", resolutionReason: "submitted" as const }),
  }] : [];
  const artifactTimelineItems: TimelineItem[] = scenario === "artifact-timeline" ? [
    ...(artifactMode === "ready" ? Array.from({ length: 24 }, (_, index): TimelineItem =>
      ({ kind: "user_message", id: 100 + index, text: `Earlier transcript message ${index + 1}` })) : []),
    {
      kind: "artifact_attached", id: 26, createdAt: Date.now(), artifact: {
        artifactId: artifactMode === "ready" ? "art_1" : "art_clip", sessionId: session.id,
        kind: artifactMode === "ready" ? "screenshot" : "video",
        name: artifactMode === "ready" ? "Session Screenshot.png" : "Session Walkthrough.webm",
        mimeType: artifactMode === "ready" ? "image/png" : "video/webm", encoding: "base64",
        sizeBytes: artifactBytes.get(artifactMode === "ready" ? "art_1" : "art_clip")?.byteLength ?? 0,
        sha256: artifactDigests.get(artifactMode === "ready" ? "art_1" : "art_clip")!,
        createdBy: { kind: "agent", id: session.id }, createdAt: Date.now(),
      },
    },
    ...(artifactMode === "ready" ? Array.from({ length: 40 }, (_, index): TimelineItem =>
      ({ kind: "user_message", id: 200 + index, text: `Later transcript message ${index + 1}` })) : []),
  ] : [];
  const artifactTimelineScrollRef = useRef<HTMLDivElement>(null);

  return (
    <ApiProvider client={client}>
      <main className="app" style={{ display: "block", height: "100dvh" }}>
        <section className="session-detail expanded" style={{ height: "100%" }}>
          <header className="detail-head" style={{ justifyContent: "space-between" }}>
            <h1 className="detail-title">{session.title}</h1>
            {scenario === "descendants" || scenario === "polling" || scenario === "held" ? (
              <SessionStatusIndicators
                session={session}
                onOpenAttention={() => setOpen(true)}
                onOpenCampaignRequests={() => setOpen(true)}
              />
            ) : <span />}
          </header>
          {scenario === "continuation" && session.orchestratorCampaign?.continuation && (
            <CampaignContinuationNotice
              continuation={session.orchestratorCampaign.continuation}
              onAcknowledge={(commandId) => void client.resolvePendingPrompt(session.id, commandId, "dismiss")}
              onRetry={(commandId) => void client.resolvePendingPrompt(session.id, commandId, "retry")}
            />
          )}
          {scenario === "held" && session.orchestratorCampaign && (
            <CampaignHeldChildren
              heldChildren={session.orchestratorCampaign.heldChildren ?? []}
              blocked={session.orchestratorCampaign.children.blocked}
              childTitle={(id) => HELD_CHILD_TITLES[id]}
              onOpenChild={(id) => { openedHeldChild = id; }}
            />
          )}
          <div className="detail-columns">
            <div className="detail-chat">
              {(scenario === "legacy" || scenario === "standalone" || scenario === "worker") && (
                <SessionApprovalRegion
                  session={session}
                  runnerOnline
                  fallbackFocusRef={legacyFocusRef}
                  onSessionUpdate={setSession}
                  showKeyHints={false}
                  standaloneInReviewSurface={scenario === "standalone"}
                />
              )}
              <div className="detail-main">
                <div className="detail-reader">
                  <div className="detail-scroll measured-virtual-scroll" role="region" aria-label="Session Activity"
                    ref={artifactTimelineScrollRef}>
                    {Array.from({ length: scenario === "artifact-timeline" ? 0 : 24 }, (_, index) => (
                      <div className={`tl-row ${index % 2 ? "agent" : "user"}`} key={index}>
                        <div className={index % 2 ? "bubble agent-bubble" : "bubble user-bubble"}>
                          Transcript message {index + 1}
                        </div>
                      </div>
                    ))}
                    {(scenario === "standalone" || scenario === "worker" || scenario === "artifact-timeline") && (
                      <EventTimeline
                        items={scenario === "artifact-timeline" ? artifactTimelineItems : standaloneTimelineItems}
                        scrollRef={scenario === "artifact-timeline" ? artifactTimelineScrollRef : undefined}
                        historyKey={scenario === "artifact-timeline" ? `${session.id}:0` : undefined}
                        approvalContext={session.pendingApproval ? {
                          sessionId: session.id,
                          requestId: session.pendingApproval.requestId,
                          onOpenRequest: () => {
                            if (scenario === "worker") workerReviewOpened = true;
                            else setOpen(true);
                          },
                        } : undefined}
                      />
                    )}
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
              descendantRequestStatus={descendantRequestStatus}
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
  workerReviewOpened: () => workerReviewOpened,
  artifactRequests: () => [...artifactRequests],
  openedHeldChild: () => openedHeldChild,
  clearHold: (sessionId) => clearHold(sessionId),
};

void prepareArtifacts().then(() => createRoot(document.getElementById("root")!).render(<Fixture />));
