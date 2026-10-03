/**
 * Campaign Status harness (#2417): the real right panel over a fixture campaign ledger.
 *
 * `scenario` picks the session the panel belongs to:
 * - `campaign` (default): the root Orchestrator with a recorded plan, recursive follow-ups, a
 *   blocked item waiting on a Request, partial pricing, and finished work behind the filter;
 * - `member`: a child of that campaign, whose current assignment is highlighted;
 * - `planless`: a campaign whose Orchestrator never recorded a plan, with untracked children;
 * - `legacy`: a campaign on a server without the ledger (no `work` on its projection);
 * - `unrelated`: a session outside any campaign.
 * `theme=light` switches the palette; `open=launcher` starts on the launcher instead of the mode.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type CampaignWorkItemDetail,
  type CampaignWorkItemSummary,
  type ControlPlaneToUi,
  type DescendantRequestView,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { RightPanel, type RightPanelState } from "../components/RightPanel.js";
import { useCampaignStatusAvailability } from "../components/useCampaignStatus.js";
import { applyCampaignWorkFilters, type CampaignWorkFilters } from "../campaign-status.js";
import type { RightPanelMode } from "../right-panel.js";
import { StoreProvider } from "../store.js";
import type { ViewNavigation } from "../navigation.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { MINUTE, campaignProjection, forgeObservation, itemDetail, itemSummary, knownCost, workSummary } from "./campaign-status-fixtures.js";
import "../styles.css";

declare global {
  interface Window {
    __WOLLIPOG_CAMPAIGN_STATUS_E2E__: {
      /** Every work-list query the panel sent, in order. */
      queries(): string[];
      /** The session a panel link opened, if any. */
      openedSession(): string | null;
      /** The request Requests was asked to select, if any. */
      selectedRequestKey(): string | null;
      /** Moves the ledger forward one revision, as a ledger write re-sending the root would. */
      bumpRevision(): void;
      /** Navigates the harness to another session, as the app does. */
      navigate(sessionId: string): void;
      /** Every on-demand GitHub read the details asked for, as `session/item`. */
      forgeRefreshes(): string[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "campaign";
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";

const NOW = Date.now();
const HOUR = 60 * MINUTE;

const items: CampaignWorkItemSummary[] = [
  itemSummary("cwi_1", NOW, {
    title: "Campaign Work Ledger Contract", queuePosition: 1, primaryState: "delivered", dispatchState: "queued",
    elapsed: { startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR }, cost: knownCost(4.12), activityAt: NOW - 2 * HOUR,
    stage: { stage: "merged", note: null, pullRequests: [{ repository: "picoduck/wollipog", number: 2430 }], sourceSessionId: "s_root", reportedAt: NOW - 2 * HOUR },
  }),
  itemSummary("cwi_2", NOW, {
    title: "Campaign Status Panel", queuePosition: 2, primaryState: "running",
    currentAttempt: { id: "catt_2", sessionId: "s_child", sessionTitle: "#2417 Slice 7: Campaign Status Panel" },
    elapsed: { startedAt: NOW - 95 * MINUTE, endedAt: null }, cost: knownCost(6.4, "modelPriced", 3), activityAt: NOW - MINUTE,
    stage: {
      stage: "merge_queued",
      note: "Binding to the merged contract.",
      pullRequests: [2440, 2436, 2441].map((number) => ({ repository: "picoduck/wollipog", number })),
      sourceSessionId: "s_root",
      reportedAt: NOW - 20 * MINUTE,
    },
  }),
  itemSummary("cwi_3", NOW, {
    title: "Ledger Read API", queuePosition: 3, primaryState: "blocked", stateCauses: ["recorded_blocker"],
    currentAttempt: { id: "catt_3", sessionId: "s_child_3", sessionTitle: "#2417 Slice 5: Read API" },
    elapsed: { startedAt: NOW - 70 * MINUTE, endedAt: null }, cost: knownCost(2.05), activityAt: NOW - 8 * MINUTE,
    blocker: { reason: "Waiting for a merge decision on the storage pull request.", responsibleActor: "human", requestOccurrenceId: "occ_1", recordedAt: NOW - 8 * MINUTE, recordedBySessionId: "s_root" },
  }),
  itemSummary("cwi_4", NOW, {
    title: "Time and Cost Attribution", queuePosition: 4, primaryState: "waiting", stateCauses: ["attempt_awaiting_verification"],
    currentAttempt: { id: "catt_4", sessionId: "s_child_4", sessionTitle: "#2417 Slice 6: Time and Cost" },
    elapsed: { startedAt: NOW - 50 * MINUTE, endedAt: null }, cost: { availability: "unavailable", reason: "not_authorized" }, activityAt: NOW - 3 * MINUTE,
  }),
  itemSummary("cwi_5", NOW, {
    title: "Observed GitHub Status", queuePosition: 5, primaryState: "queued", stateCauses: ["dependency_unfinished"],
    currentAttempt: null, attemptCount: 0, elapsed: { startedAt: null, endedAt: null }, createdAt: NOW - 3 * HOUR, activityAt: NOW - 3 * HOUR,
  }),
  itemSummary("cwi_6", NOW, {
    title: "Integration Coverage", issue: null, key: "plan:integration", queuePosition: 6, primaryState: "planned", dispatchState: "planned",
    currentAttempt: null, attemptCount: 0, elapsed: { startedAt: null, endedAt: null }, createdAt: NOW - 3 * HOUR, activityAt: NOW - 3 * HOUR,
  }),
  itemSummary("cwi_7", NOW, {
    title: "Retain Ledger History on Child Deletion", issue: { repository: "picoduck/wollipog", number: 2431 }, origin: "follow_up", generation: 1,
    queuePosition: 7, primaryState: "planned", dispatchState: "planned", currentAttempt: null, attemptCount: 0,
    elapsed: { startedAt: null, endedAt: null }, createdAt: NOW - 40 * MINUTE, activityAt: NOW - 40 * MINUTE,
  }),
  itemSummary("cwi_8", NOW, {
    title: "Nested Orchestrator Overhead Label", issue: null, key: "follow-up:nested-overhead", origin: "follow_up", generation: 2,
    queuePosition: 8, primaryState: "planned", dispatchState: "planned", currentAttempt: null, attemptCount: 0,
    elapsed: { startedAt: null, endedAt: null }, createdAt: NOW - 15 * MINUTE, activityAt: NOW - 15 * MINUTE,
  }),
  itemSummary("cwi_9", NOW, {
    title: "Standalone Campaign Dashboard", issue: null, key: "plan:dashboard", queuePosition: null, primaryState: "removed",
    commitment: "scope_removed", currentAttempt: null, attemptCount: 0, elapsed: { startedAt: null, endedAt: null },
    createdAt: NOW - 3 * HOUR, activityAt: NOW - HOUR,
  }),
];

const details: Record<string, CampaignWorkItemDetail> = Object.fromEntries(items.map((item) => [item.id, itemDetail(item)]));
details.cwi_2 = itemDetail(items[1]!, {
  dependsOn: [{ id: "cwi_1", key: "picoduck/wollipog#1", title: "Campaign Work Ledger Contract", primaryState: "delivered" }],
  nextAction: "Open the pull request once the read API lands.",
  attempts: [
    {
      ...itemDetail(items[1]!).attempts[0]!, id: "catt_2a", ordinal: 1, sessionId: null,
      session: { title: "#2417 Slice 7 (First Attempt)", harness: null, agentName: "Codex App Server", model: "gpt-5.5", effort: "high" },
      startedAt: NOW - 3 * HOUR, endedAt: NOW - 95 * MINUTE, endReason: "superseded",
    },
    {
      ...itemDetail(items[1]!).attempts[0]!, id: "catt_2", ordinal: 2,
      session: { title: "#2417 Slice 7: Campaign Status Panel", harness: { agentId: "claude-native", driver: "claude-code", context: { kind: "native" } }, agentName: "Claude Code (native)", model: "claude-opus-5-5", effort: "high" },
      startedAt: NOW - 95 * MINUTE,
    },
  ],
  currentAttempt: { id: "catt_2", sessionId: "s_child", sessionTitle: "#2417 Slice 7: Campaign Status Panel" },
  attemptCosts: [
    { attemptId: "catt_2a", cost: knownCost(1.1, "modelPriced") },
    { attemptId: "catt_2", cost: knownCost(5.3, "modelPriced", 3) },
  ],
  times: {
    elapsed: items[1]!.elapsed,
    queue: { availability: "known", value: 12 * MINUTE },
    waiting: { availability: "partial", value: 9 * MINUTE, reason: "history_unavailable" },
    active: { availability: "unavailable", reason: "not_collected" },
    asOf: NOW,
  },
  observed: {
    session: { availability: "fresh", value: { sessionId: "s_child", status: "running", archived: false, held: false, pendingRequests: 0 }, observedAt: NOW - MINUTE },
    // Slice 8: a merge-queue wait observed a minute ago, an older observation now stale, and one
    // the runner could not read.
    pullRequests: [
      { ref: { repository: "picoduck/wollipog", number: 2440 }, fact: { availability: "fresh", value: forgeObservation(), observedAt: NOW - MINUTE } },
      {
        ref: { repository: "picoduck/wollipog", number: 2436 },
        fact: {
          availability: "stale",
          value: forgeObservation({ state: "merged", reviewDecision: "approved", mergeQueue: null, mergeCommitSha: "dd08b41b6a0e2c4f1f0b7d4e5b9a3c2d1e0f9a8b",
            checks: { state: "passing", passing: 9, failing: 0, pending: 0 } }),
          observedAt: NOW - 25 * MINUTE,
        },
      },
      { ref: { repository: "picoduck/wollipog", number: 2441 }, fact: { availability: "unavailable", reason: "forge_unauthenticated" } },
    ],
  },
});
details.cwi_3 = itemDetail(items[2]!, {
  nextAction: "Answer the merge decision in Requests.",
  stage: { stage: "in_review", note: null, pullRequests: [{ repository: "picoduck/wollipog", number: 2436 }], sourceSessionId: "s_root", reportedAt: NOW - 30 * MINUTE },
  observed: {
    // A reader who can open the campaign but not the runner whose GitHub CLI reads it.
    pullRequests: [{ ref: { repository: "picoduck/wollipog", number: 2436 }, fact: { availability: "unavailable", reason: "not_authorized" } }],
    session: { availability: "stale", value: { sessionId: "s_child_3", status: "idle", archived: false, held: true, pendingRequests: 1 }, observedAt: NOW - 6 * MINUTE },
    cleanup: { availability: "fresh", value: { sessionId: "s_child_3", worktrees: [{ path: "/w/3", status: "pending", reason: null }] }, observedAt: NOW - 6 * MINUTE },
  },
});

const ROOT_TITLE = "#2417 Campaign Orchestrator";
const recordedWork = (revision: number) => workSummary(NOW, {
  revision,
  coverage: { untrackedChildren: 0, predatesLedger: false },
  counts: {
    committed: 8, delivered: 1, original: 6, followUp: 2, cancelled: 0, removed: 1,
    byState: { planned: 3, queued: 1, running: 1, waiting: 1, blocked: 1, delivered: 1, cancelled: 0, removed: 1 },
  },
  recommendations: { awaiting_adjudication: 1, accepted: 2, rejected: 1, deferred: 1, duplicate: 3 },
  obligations: { verification: 1, adjudication: 1, publication: 1, cleanup: 1 },
  elapsed: { startedAt: NOW - 3 * HOUR - 12 * MINUTE, endedAt: null },
  cost: {
    total: { availability: "partial", value: { usd: 14.82, source: "modelPriced", unpricedRecords: 3 }, reason: "unpriced_usage" },
    workItems: { availability: "partial", value: { usd: 12.57, source: "modelPriced", unpricedRecords: 3 }, reason: "unpriced_usage" },
    coordination: knownCost(2.25),
    unattributed: knownCost(0),
    attributedSince: NOW - 3 * HOUR,
  },
});

function baseSession(overrides: Partial<SessionView>): SessionView {
  return {
    id: "s_root", runnerId: "runner-1", workspaceId: null, agentId: "claude-native", driver: "claude-code",
    title: ROOT_TITLE, status: "running", adopted: false, eventEpoch: 1, archived: false, runId: null,
    parentSessionId: null, pendingApproval: null, createdAt: NOW - 3 * HOUR, updatedAt: NOW, lastEventAt: NOW,
    messageCount: 40, tokensIn: 0, tokensOut: 0, costUsd: 0, costBudgetUsd: null, maxToolCalls: null,
    ...overrides,
  } as SessionView;
}

let revision = 1;
const projectionFor = (rev: number) => campaignProjection(
  scenario === "legacy" ? null
    : scenario === "planless" ? workSummary(NOW, {
      revision: rev,
      planState: "not_recorded",
      coverage: { untrackedChildren: 2, predatesLedger: true },
      counts: {
        committed: 2, delivered: 0, original: 2, followUp: 0, cancelled: 0, removed: 0,
        byState: { planned: 0, queued: 0, running: 2, waiting: 0, blocked: 0, delivered: 0, cancelled: 0, removed: 0 },
      },
      recommendations: { awaiting_adjudication: 0, accepted: 0, rejected: 0, deferred: 0, duplicate: 0 },
      obligations: { verification: 0, adjudication: 0, publication: 0, cleanup: 0 },
      cost: undefined,
    })
      : recordedWork(rev),
  {
    limits: { maximumConcurrentChildren: 4, occupied: 3, remaining: 1, costBudgetUsd: 40, maxToolCalls: null },
    heldChildren: [{
      sessionId: "s_child_3",
      holds: [{
        kind: "provider_account_switch", holdId: "hold_1", since: NOW - 6 * MINUTE,
        reason: "The next turn waits while the provider account switches.",
        recoveryAction: "Restart the session once the account is ready.",
      }],
    }],
  },
);

function sessionsFor(rev: number): SessionView[] {
  const root = baseSession({ orchestratorCampaign: projectionFor(rev) });
  const child = baseSession({
    id: "s_child", title: "#2417 Slice 7: Campaign Status Panel", parentSessionId: "s_root",
    ...(scenario === "legacy" ? {} : { campaignMembership: { campaignSessionId: "s_root", currentWorkItemId: "cwi_2", currentAttemptId: "catt_2" } }),
  });
  const unrelated = baseSession({ id: "s_other", title: "Unrelated Bug Fix" });
  return [root, child, unrelated];
}

/** The request the blocked item's recorded blocker names, pending on its child. */
const descendantRequests: DescendantRequestView[] = scenario === "campaign" ? [{
  sessionId: "s_child_3",
  sessionTitle: "#2417 Slice 5: Read API",
  runnerId: "runner-1",
  runnerOnline: true,
  eventEpoch: 1,
  createdAt: NOW - 8 * MINUTE,
  responseOwner: "human",
  occurrenceId: "occ_1",
  request: {
    requestId: "req_1",
    occurrenceId: "occ_1",
    title: "Run gh pr merge for the storage pull request",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  },
}] : [];

const queries: string[] = [];
const forgeRefreshes: string[] = [];
let openedSession: string | null = null;
let selectedRequestKey: string | null = null;

const visibleItems = scenario === "planless" ? items.filter((item) => item.id === "cwi_2" || item.id === "cwi_3") : items;

const client = {
  ...api,
  childSessions: () => Promise.reject(new ApiError("No registry in this fixture.", 404)),
  campaignWorkItems: async (_id: string, query: string) => {
    queries.push(query);
    const search = new URLSearchParams(query);
    const filters: CampaignWorkFilters = {
      origin: (search.get("origin") ?? "all") as CampaignWorkFilters["origin"],
      state: (search.get("state") ?? "unfinished") as CampaignWorkFilters["state"],
      sort: (search.get("sort") ?? "queue") as CampaignWorkFilters["sort"],
    };
    const matching = applyCampaignWorkFilters(visibleItems, filters, Date.now());
    const offset = Number(search.get("cursor") ?? 0);
    const limit = Number(search.get("limit") ?? 50);
    const page = matching.slice(offset, offset + limit);
    return {
      revision,
      items: page,
      total: matching.length,
      nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
    };
  },
  campaignWorkItem: async (_id: string, itemId: string) => {
    const item = details[itemId];
    if (!item) throw new ApiError("work item not found", 404);
    return { revision, item };
  },
  campaignForgeRefresh: async (id: string, itemId: string) => {
    forgeRefreshes.push(`${id}/${itemId}`);
    const item = details[itemId];
    if (!item) throw new ApiError("work item not found", 404);
    return { revision, pullRequests: item.observed.pullRequests ?? [] };
  },
} as ApiClient;

/** Feeds the store a snapshot, then lets the harness push later root updates. */
let pushToStore: ((message: ControlPlaneToUi) => void) | null = null;
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    pushToStore = (message) => this.onmessage?.({ data: JSON.stringify(message) });
    window.setTimeout(() => {
      this.onopen?.();
      pushToStore?.({
        type: "snapshot",
        capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
        runners: [], boxes: [], projects: [], sessions: sessionsFor(revision), runs: [], pods: [],
      });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "campaign-status-e2e",
  runtimeKey: "campaign-status-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const initialSessionId = scenario === "member" ? "s_child" : scenario === "unrelated" ? "s_other" : "s_root";
const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: initialSessionId }),
  push() {},
  listen: () => () => {},
};

let navigateTo: ((sessionId: string) => void) | null = null;
let setRevision: ((value: number) => void) | null = null;

function Fixture() {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [rev, setRev] = useState(revision);
  navigateTo = setSessionId;
  setRevision = setRev;
  const session = sessionsFor(rev).find((candidate) => candidate.id === sessionId)!;
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<RightPanelMode>(params.get("open") === "launcher" ? "launcher" : "campaign");
  const [width, setWidth] = useState(420);
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
          <PanelForSession state={state} session={session} onOpenSession={(id) => { openedSession = id; setSessionId(id); }} />
        </div>
      </section>
      {/* On a phone the app's tab bar fills the band below the panel sheet (--bottom-bar-h); this
          stand-in shows that band for what it is in the captures. */}
      {window.innerWidth <= 760 && (
        <nav aria-label="App Navigation" style={{
          position: "fixed", left: 0, right: 0, bottom: 0, height: "var(--bottom-bar-h)",
          display: "flex", alignItems: "center", justifyContent: "center",
          borderTop: "1px solid var(--border)", background: "var(--bg-elev)", color: "var(--text-dim)",
          font: "var(--type-small)",
        }}>
          App Tab Bar
        </nav>
      )}
    </main>
  );
}

function PanelForSession({ state, session, onOpenSession }: { state: RightPanelState; session: SessionView; onOpenSession: (id: string) => void }) {
  const availability = useCampaignStatusAvailability(session);
  return (
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
      campaignAvailability={availability}
      onOpenSession={onOpenSession}
      descendantRequests={session.orchestratorCampaign ? descendantRequests : []}
      selectedRequestKey={selectedRequestKey}
      onSelectedRequestKeyChange={(key) => { selectedRequestKey = key; }}
      onSessionUpdate={() => {}}
    />
  );
}

window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__ = {
  queries: () => [...queries],
  openedSession: () => openedSession,
  selectedRequestKey: () => selectedRequestKey,
  bumpRevision: () => {
    revision += 1;
    for (const session of sessionsFor(revision)) pushToStore?.({ type: "session_upsert", session });
    setRevision?.(revision);
  },
  navigate: (sessionId) => navigateTo?.(sessionId),
  forgeRefreshes: () => [...forgeRefreshes],
};

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <Fixture />
    </StoreProvider>
  </ApiProvider>,
);
