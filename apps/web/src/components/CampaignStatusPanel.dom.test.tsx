import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  CampaignForgeRefreshResponse,
  CampaignWorkItemDetail,
  CampaignWorkItemSummary,
  CampaignWorkItemsPage,
  CampaignWorkSummary,
  ControlPlaneToUi,
  DescendantRequestView,
  SessionView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { titleCaseLabel } from "../format.js";
import type { GitStatus } from "./useGitStatus.js";
import { RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import { forgetCampaignStatusMemory } from "./CampaignStatusPanel.js";
import { CAMPAIGN_COST_REFRESH_MS, useCampaignStatusAvailability } from "./useCampaignStatus.js";
import { CAMPAIGN_STATUS_UNSUPPORTED_REASON } from "../campaign-status.js";
import {
  campaignProjection,
  forgeObservation,
  itemDetail,
  itemSummary,
  knownCost,
  MINUTE,
  workSummary as sharedWorkSummary,
} from "../e2e/campaign-status-fixtures.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  ResizeObserver: domWindow.ResizeObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);
before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
beforeEach(() => {
  domWindow.localStorage.clear();
  forgetCampaignStatusMemory();
  harnessRequests.descendants = [];
  harnessRequests.selected = [];
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const NOW = Date.now();

const git: GitStatus = {
  status: null, observation: 0, observedAt: null, settled: false, busy: false, error: null, errorCode: null,
  refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
};

const workSummary = (overrides: Partial<CampaignWorkSummary> = {}) => sharedWorkSummary(NOW, overrides);
const campaign = (work: CampaignWorkSummary | null) => campaignProjection(work);

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "s_root", runnerId: "runner-1", driver: "claude-code", status: "running", adopted: false, eventEpoch: 1,
    title: "Campaign Orchestrator", parentSessionId: null, pendingApproval: null,
    ...overrides,
  } as SessionView;
}

const item = (id: string, overrides: Partial<CampaignWorkItemSummary> = {}) => itemSummary(id, NOW, overrides);

/** A detail whose queue time was never recorded, whose waiting time is a recorded zero, and whose
 * forge facts this server does not observe. */
function detailOf(base: CampaignWorkItemSummary, overrides: Partial<CampaignWorkItemDetail> = {}): CampaignWorkItemDetail {
  return itemDetail(base, {
    times: {
      elapsed: base.elapsed,
      queue: { availability: "unavailable", reason: "history_unavailable" },
      waiting: { availability: "known", value: 0 },
      active: { availability: "unavailable", reason: "not_collected" },
      asOf: NOW,
    },
    ...overrides,
  });
}

interface Calls { list: string[]; detail: string[]; forge: string[] }

type FixturePage = Omit<CampaignWorkItemsPage, "total"> & { total?: number };

function fakeClient(
  pages: (query: string) => FixturePage | Error,
  details: Record<string, CampaignWorkItemDetail> = {},
  forge: (itemId: string) => CampaignForgeRefreshResponse | Error = () => new ApiError("not found", 404),
) {
  const calls: Calls = { list: [], detail: [], forge: [] };
  const client = {
    ...api,
    childSessions: () => Promise.reject(new ApiError("No registry in this fixture.", 404)),
    campaignWorkItems: async (id: string, query: string) => {
      calls.list.push(`${id}?${query}`);
      const page = pages(query);
      if (page instanceof Error) throw page;
      return { total: page.items.length, ...page };
    },
    campaignWorkItem: async (id: string, itemId: string) => {
      calls.detail.push(`${id}/${itemId}`);
      const found = details[itemId];
      if (!found) throw new ApiError("not found", 404);
      return { revision: 1, item: found };
    },
    campaignForgeRefresh: async (id: string, itemId: string) => {
      calls.forge.push(`${id}/${itemId}`);
      const response = forge(itemId);
      if (response instanceof Error) throw response;
      return response;
    },
  } as ApiClient;
  return { client, calls };
}

function Harness({ initial, client, sessions, onState, onSession, socket }: {
  initial: SessionView;
  client: ApiClient;
  sessions: SessionView[];
  onState: (state: RightPanelState) => void;
  onSession: (set: (next: SessionView) => void) => void;
  socket: FakeSocket;
}) {
  const [current, setCurrent] = useState(initial);
  onSession(setCurrent);
  const connection: UiConnectionRuntime = {
    instanceId: "campaign-status", runtimeKey: "campaign-status", createSocket: () => socket, close() {},
  };
  void sessions;
  return (
    <ApiProvider client={client}>
      <StoreProvider connection={connection}>
        <PanelWithAvailability session={current} onState={onState} onOpen={(id) => {
          const next = sessions.find((candidate) => candidate.id === id);
          if (next) setCurrent(next);
        }} />
      </StoreProvider>
    </ApiProvider>
  );
}

/** Requests the panel lists, and every Requests selection it made; tests set these before mounting. */
const harnessRequests: { descendants: DescendantRequestView[]; selected: (string | null)[] } = { descendants: [], selected: [] };

function PanelWithAvailability({ session: current, onState, onOpen }: {
  session: SessionView;
  onState: (state: RightPanelState) => void;
  onOpen: (id: string) => void;
}) {
  const state = useRightPanelState();
  onState(state);
  const availability = useCampaignStatusAvailability(current);
  const [selectedRequestKey, setSelectedRequestKey] = useState<string | null>(null);
  return (
    <RightPanel
      state={state}
      session={current}
      runnerOnline
      runnerProtocolVersion={null}
      git={git}
      items={[]}
      onOpenSourceLocation={() => {}}
      onClearSourceLocation={() => {}}
      onOpenTerminal={() => {}}
      onInsertSideChatDraft={() => {}}
      campaignAvailability={availability}
      onOpenSession={onOpen}
      descendantRequests={harnessRequests.descendants}
      selectedRequestKey={selectedRequestKey}
      onSelectedRequestKeyChange={(key) => {
        harnessRequests.selected.push(key);
        setSelectedRequestKey(key);
      }}
      onSessionUpdate={() => {}}
    />
  );
}

async function mount({
  initial,
  sessions = [initial],
  client,
}: {
  initial: SessionView;
  sessions?: SessionView[];
  client: ApiClient;
}) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLDivElement;
  const root = createRoot(container);
  const socket = new FakeSocket();
  let state!: RightPanelState;
  let setSession!: (next: SessionView) => void;
  await act(async () => {
    root.render(<Harness initial={initial} client={client} sessions={sessions} socket={socket}
      onState={(next) => { state = next; }} onSession={(set) => { setSession = set; }} />);
    await Promise.resolve();
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
      runners: [], boxes: [], projects: [], sessions, runs: [], pods: [],
    } as unknown as UiSnapshotMessage);
    await Promise.resolve();
  });
  return {
    container,
    get state() { return state; },
    setSession: async (next: SessionView) => { await act(async () => { setSession(next); }); await settle(); },
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function launcherRow(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>(".rp-launcher .rp-row")]
    .find((row) => row.textContent?.startsWith(label)) ?? null;
}

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
}

async function chooseFilter(container: HTMLElement, label: string, option: string) {
  const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label")?.startsWith(`${label}:`));
  assert.ok(trigger, `the ${label} filter renders`);
  await click(trigger);
  const choice = [...domWindow.document.querySelectorAll('[role="option"]')]
    .find((node) => node.textContent?.trim() === option);
  assert.ok(choice, `the ${label} filter offers ${option}`);
  await click(choice as unknown as Element);
}

const rootSession = session({ orchestratorCampaign: campaign(workSummary()) });
const childSession = session({
  id: "s_child", title: "Child One", parentSessionId: "s_root",
  campaignMembership: { campaignSessionId: "s_root", currentWorkItemId: "cwi_2", currentAttemptId: "catt_2" },
});
const unrelated = session({ id: "s_other", title: "Unrelated" });

test("the launcher offers Campaign Status on a campaign and its members, and nowhere else", async () => {
  const { client } = fakeClient(() => ({ revision: 1, items: [], nextCursor: null }));
  for (const [current, expected] of [[rootSession, true], [childSession, true], [unrelated, false]] as const) {
    const panel = await mount({ initial: current, sessions: [rootSession, childSession, unrelated], client });
    try {
      await act(async () => panel.state.show("launcher"));
      const row = launcherRow(panel.container, "Campaign Status");
      if (expected) {
        assert.ok(row, `${current.id} offers Campaign Status`);
        assert.equal(row.getAttribute("aria-disabled"), null);
      } else {
        assertNoDomNode(row, "an unrelated session has no Campaign Status entry");
      }
    } finally {
      await panel.dispose();
    }
  }
});

test("a recognized campaign on a server without campaign work shows why, visibly and accessibly", async () => {
  const { client, calls } = fakeClient(() => ({ revision: 1, items: [], nextCursor: null }));
  // An older server sends the campaign projection without `work`.
  const panel = await mount({ initial: session({ orchestratorCampaign: campaign(null) }), client });
  try {
    await act(async () => panel.state.show("launcher"));
    const row = launcherRow(panel.container, "Campaign Status")!;
    assert.ok(row, "the entry stays visible");
    assert.equal(row.getAttribute("aria-disabled"), "true");
    assert.ok(row.textContent?.includes(CAMPAIGN_STATUS_UNSUPPORTED_REASON), "the reason is visible text");
    const describedBy = row.getAttribute("aria-describedby")!;
    assert.equal(panel.container.querySelector(`[id="${describedBy}"]`)?.textContent, CAMPAIGN_STATUS_UNSUPPORTED_REASON);
    assert.equal(row.tabIndex, 0, "the row stays reachable by keyboard");
    await click(row);
    assert.equal(panel.state.mode, "launcher", "an unavailable entry does not open");
    // Reaching the mode another way still explains instead of rendering an empty body.
    await act(async () => panel.state.show("campaign"));
    assert.match(panel.container.querySelector(".rp-body")?.textContent ?? "", /Campaign Status Unavailable/);
    assert.deepEqual(calls.list, [], "nothing is fetched from a server that cannot answer");
  } finally {
    await panel.dispose();
  }
});

test("navigating from a campaign to an unrelated session returns the open panel to the launcher", async () => {
  const { client } = fakeClient(() => ({ revision: 1, items: [item("cwi_1")], nextCursor: null }));
  const panel = await mount({ initial: rootSession, sessions: [rootSession, childSession, unrelated], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await panel.setSession(childSession);
    assert.equal(panel.state.mode, "campaign", "a member keeps Campaign Status open");
    await panel.setSession(unrelated);
    assert.equal(panel.state.open, true, "the panel stays open");
    assert.equal(panel.state.mode, "launcher");
    assert.ok(panel.container.querySelector(".rp-launcher"));
  } finally {
    await panel.dispose();
  }
});

test("the summary states progress, capacity, time and cost, and says when no plan was recorded", async () => {
  const { client } = fakeClient(() => ({ revision: 1, items: [], nextCursor: null }));
  const planless = session({ orchestratorCampaign: campaign(workSummary({
    planState: "not_recorded", coverage: { untrackedChildren: 2, predatesLedger: false }, cost: undefined,
  })) });
  const panel = await mount({ initial: planless, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    const text = panel.container.querySelector(".campaign-status-summary")?.textContent ?? "";
    assert.match(text, /Plan Not Recorded/);
    assert.match(text, /2 child sessions without a work item are not counted/);
    assert.match(text, /1 of 3 Delivered/);
    assert.match(text, /1 of 4 Occupied/);
    assert.match(text, /CostUnavailable/, "missing cost reads Unavailable, never $0.00");
    assert.doesNotMatch(text, /\$0\.00/);
  } finally {
    await panel.dispose();
  }
});

test("filters reload the list, and returning from details restores filters, position and focus", async () => {
  const items = Array.from({ length: 6 }, (_, index) => item(`cwi_${index + 1}`, { queuePosition: index + 1 }));
  const { client, calls } = fakeClient(() => ({ revision: 1, items, nextCursor: null }), {
    cwi_3: detailOf(items[2]!),
  });
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    assert.equal(calls.list[0], "s_root?limit=50&sort=queue&state=unfinished", "unfinished work in queue order by default");
    await chooseFilter(panel.container, "State", "All States");
    assert.equal(calls.list.at(-1), "s_root?limit=50&sort=queue&state=all");

    const scroller = panel.container.querySelector<HTMLElement>(".campaign-status")!;
    scroller.scrollTop = 120;
    const rows = [...panel.container.querySelectorAll<HTMLButtonElement>(".campaign-work-row")];
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map((row) => row.tabIndex), [0, -1, -1, -1, -1, -1], "one tab stop for the list");
    await act(async () => { rows[0]!.focus(); });
    await act(async () => { rows[0]!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event); });
    await act(async () => { rows[1]!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event); });
    assert.equal(domWindow.document.activeElement, rows[2], "arrow keys move along the rows");

    await click(rows[2]!);
    assertNoDomNode(panel.container.querySelector(".campaign-work-list"), "details replace the list");
    const heading = panel.container.querySelector("h3.campaign-detail-title")!;
    assert.equal(heading.textContent, "Work cwi_3");
    assert.equal(domWindow.document.activeElement, heading, "focus moves to the details");
    const facts = panel.container.textContent ?? "";
    assert.match(facts, /Queue TimeUnavailable/, "an unrecorded interval is Unavailable");
    assert.match(facts, /Waiting Time0s/, "a recorded zero is a real zero");
    assert.match(facts, /Review and ChecksUnavailableThis server does not observe it\./, "unobserved forge data never reads as passing");

    const back = [...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Back to Work Items")!;
    await click(back);
    const restored = [...panel.container.querySelectorAll<HTMLButtonElement>(".campaign-work-row")];
    assert.equal(restored.length, 6, "the list returns");
    assert.equal(domWindow.document.activeElement, restored[2], "focus returns to the row that was opened");
    assert.equal(panel.container.querySelector<HTMLElement>(".campaign-status")!.scrollTop, 120, "the scroll position is restored");
    const stateTrigger = [...panel.container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("State:"));
    assert.equal(stateTrigger?.getAttribute("aria-label"), "State: All States", "the filter is kept");
    assert.equal(calls.list.at(-1), "s_root?limit=50&sort=queue&state=all", "no filter reset on the way back");
  } finally {
    await panel.dispose();
  }
});

/** The facts of the details' Delivery section as `term: description` pairs, in order. */
function deliveryFacts(container: HTMLElement): string[] {
  const section = [...container.querySelectorAll("section.campaign-detail-section")]
    .find((candidate) => candidate.querySelector("h4")?.textContent === "Delivery")!;
  return [...section.querySelectorAll("dl > div")].map((row) =>
    `${row.querySelector("dt")?.textContent}: ${row.querySelector("dd")?.textContent}`);
}

/** The Delivery rows that belong to one pull request: its own row and the facts that follow it. */
function pullRequestGroup(facts: string[], number: number): string[] {
  const start = facts.findIndex((fact) => fact.startsWith(`PR #${number}:`));
  assert.ok(start >= 0, `PR #${number} is shown`);
  const end = facts.findIndex((fact, index) => index > start && /^(PR #|Verification:)/u.test(fact));
  return facts.slice(start, end);
}

test("observed GitHub facts stay apart from the reported stage, and stale or unavailable ones never read as passing", async () => {
  const PR = (number: number) => ({ repository: "picoduck/wollipog", number });
  const base = item("cwi_9", {
    stage: { stage: "merge_queued", note: null, pullRequests: [PR(2462), PR(2430), PR(7), PR(8)], sourceSessionId: "s_root", reportedAt: NOW - 5 * MINUTE },
  });
  const detail = detailOf(base, {
    observed: {
      pullRequests: [
        { ref: PR(2462), fact: { availability: "fresh", value: forgeObservation(), observedAt: NOW - MINUTE } },
        { ref: PR(2430), fact: { availability: "stale", value: forgeObservation({ state: "merged", reviewDecision: "approved", mergeQueue: null, mergeCommitSha: "dd08b41b0000000000000000000000000000beef" }), observedAt: NOW - 20 * MINUTE } },
        { ref: PR(7), fact: { availability: "unavailable", reason: "forge_rate_limited", lastValue: forgeObservation({ reviewDecision: "approved" }), lastObservedAt: NOW - 30 * MINUTE } },
        // Fresh when served, but older than the documented age by now: the client reads it as stale.
        { ref: PR(8), fact: { availability: "fresh", value: forgeObservation({ reviewDecision: "approved" }), observedAt: NOW - 11 * MINUTE } },
      ],
    },
  });
  let refreshed: CampaignForgeRefreshResponse | Error = new ApiError("not yet", 503);
  const details: Record<string, CampaignWorkItemDetail> = { cwi_9: detail };
  const { client, calls } = fakeClient(() => ({ revision: 1, items: [base], nextCursor: null }), details, () => refreshed);
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelector(".campaign-work-row")!);
    let facts = deliveryFacts(panel.container);

    assert.equal(facts[0], "Reported Stage: Merge QueuedReported by the Orchestrator 5m ago. Wollipog has not observed this stage.",
      "the reported stage names its source and time and says it is not an observation");
    assert.deepEqual(pullRequestGroup(facts, 2462), [
      "PR #2462: OpenObserved on GitHub 1m ago",
      "Review: No Review Decision",
      "Required Checks: Passing1 passing.",
      "All Checks: Pending1 pending, 8 passing.",
      "Merge Queue: Awaiting Checks, Position 2",
      "Head: 44579c6",
      "Base Branch: main",
    ], "a merge-queue wait reads as observed facts with their time");
    const stale = pullRequestGroup(facts, 2430);
    assert.equal(stale[0], "PR #2430: Last Seen MergedStale: observed on GitHub 20m ago. It may have changed since.");
    assert.ok(stale.includes("Review: Last Seen Approved"));
    assert.ok(stale.includes("Required Checks: Last Seen Passing1 passing."));
    const unavailable = pullRequestGroup(facts, 7);
    assert.deepEqual(unavailable, [
      "PR #7: UnavailableGitHub's rate limit for the runner's GitHub CLI is used up. It will be read again later. Last observed on GitHub 30m ago.",
    ], "an unavailable fact shows why and when, and none of its last values");
    assert.ok(pullRequestGroup(facts, 8).includes("Review: Last Seen Approved"), "an aged fresh fact reads as stale");
    for (const fact of facts) {
      if (/: (Passing|Approved|Merged)/u.test(fact)) {
        assert.ok(pullRequestGroup(facts, 2462).includes(fact), `only a current observation reads as passing: ${fact}`);
      }
    }
    assert.deepEqual(calls.forge, ["s_root/cwi_9"], "opening the details asks for a read once");

    // A completed read reloads the details, so what the store holds now is shown; the answer's own
    // facts are never applied, even one naming a pull request the details do not list.
    const merged = forgeObservation({ state: "merged", mergeQueue: null, reviewDecision: "approved" });
    details.cwi_9 = { ...detail, observed: { pullRequests: detail.observed.pullRequests!.map((entry) => entry.ref.number === 2462
      ? { ref: entry.ref, fact: { availability: "fresh" as const, value: merged, observedAt: Date.now() } }
      : entry) } };
    refreshed = {
      revision: 2,
      pullRequests: [{ ref: PR(9999), fact: { availability: "fresh", value: forgeObservation(), observedAt: Date.now() } }],
    };
    const loadsBefore = calls.detail.length;
    await click(panel.container.querySelector(".campaign-detail-back")!);
    await click(panel.container.querySelector(".campaign-work-row")!);
    assert.equal(calls.detail.length, loadsBefore + 2, "opening loads the details, and the completed read loads them again");
    facts = deliveryFacts(panel.container);
    assert.equal(pullRequestGroup(facts, 2462)[0], "PR #2462: MergedObserved on GitHub just now");
    assert.ok(pullRequestGroup(facts, 2462).includes("Merge Queue: Not Queued"));
    assert.ok(!facts.some((fact) => fact.startsWith("PR #9999")), "a refresh answer's own facts are never shown");
    assert.equal(calls.forge.length, 2);
  } finally {
    await panel.dispose();
  }
});

test("a late forge-refresh answer never puts back facts that have since changed, whatever its revision", async () => {
  const PR = { repository: "picoduck/wollipog", number: 2462 };
  const base = item("cwi_7", { stage: { stage: "in_review", note: null, pullRequests: [PR], sourceSessionId: "s_root", reportedAt: NOW - MINUTE } });
  const withRequired = (state: "passing" | "failing", revision: number) => ({
    revision,
    item: detailOf(base, { observed: { pullRequests: [{ ref: PR, fact: { availability: "fresh", value: forgeObservation({
      requiredChecks: { state, passing: state === "passing" ? 1 : 0, failing: state === "failing" ? 1 : 0, pending: 0 },
    }), observedAt: Date.now() } }] } }),
  });
  // The late answer: passing, at an older revision, then at the same revision as newer details
  // (the revision bump is coalesced after the store write, so equal revisions are not ordered).
  for (const answerRevision of [1, 2]) {
    forgetCampaignStatusMemory();
    let current: { revision: number; item: CampaignWorkItemDetail } | Error = withRequired("passing", 1);
    let releaseRefresh!: () => void;
    const { client: baseClient } = fakeClient(() => ({ revision: 2, items: [base], nextCursor: null }));
    const client = {
      ...baseClient,
      campaignWorkItem: async () => {
        if (current instanceof Error) throw current;
        return current;
      },
      campaignForgeRefresh: () => new Promise<CampaignForgeRefreshResponse>((resolve) => {
        releaseRefresh = () => resolve({ revision: answerRevision, pullRequests: withRequired("passing", 1).item.observed.pullRequests! });
      }),
    } as ApiClient;
    const panel = await mount({ initial: rootSession, client });
    try {
      await act(async () => panel.state.show("campaign"));
      await settle();
      await click(panel.container.querySelector(".campaign-work-row")!);
      assert.ok(deliveryFacts(panel.container).includes("Required Checks: Passing1 passing."));
      // The ledger moves: the details reload and now show a failing required check.
      current = withRequired("failing", 2);
      await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({ revision: 2 })) }));
      assert.ok(deliveryFacts(panel.container).includes("Required Checks: Failing1 failing."));
      // A later reload fails; the failing details stay shown, with the error.
      current = new ApiError("server unavailable", 503);
      await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({ revision: 3 })) }));
      assert.ok(deliveryFacts(panel.container).includes("Required Checks: Failing1 failing."));
      await act(async () => { releaseRefresh(); });
      await settle();
      assert.ok(deliveryFacts(panel.container).includes("Required Checks: Failing1 failing."),
        `a late passing answer at revision ${answerRevision} does not bring back Passing`);
    } finally {
      await panel.dispose();
    }
  }
});

test("details without pull requests say none was reported, and a reader without runner access is never refreshed", async () => {
  const none = item("cwi_1");
  const hidden = item("cwi_2", { stage: { stage: "in_review", note: null, pullRequests: [{ repository: "picoduck/wollipog", number: 5 }], sourceSessionId: null, reportedAt: NOW - MINUTE } });
  const { client, calls } = fakeClient(() => ({ revision: 1, items: [none, hidden], nextCursor: null }), {
    cwi_1: detailOf(none, { observed: { pullRequests: [] } }),
    cwi_2: detailOf(hidden, { observed: { pullRequests: [{ ref: { repository: "picoduck/wollipog", number: 5 }, fact: { availability: "unavailable", reason: "not_authorized" } }] } }),
  });
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelectorAll(".campaign-work-row")[0]!);
    assert.ok(deliveryFacts(panel.container).includes(
      "Review and Checks: No Pull Request ReportedGitHub status is observed for the pull requests the Orchestrator reports."));
    await click(panel.container.querySelector(".campaign-detail-back")!);
    await click(panel.container.querySelectorAll(".campaign-work-row")[1]!);
    const facts = deliveryFacts(panel.container);
    assert.equal(facts[0], "Reported Stage: In ReviewReported by a deleted Orchestrator session 1m ago. Wollipog has not observed this stage.");
    assert.equal(pullRequestGroup(facts, 5)[0],
      "PR #5: UnavailableGitHub status is read through the campaign runner's GitHub CLI, and you don't have access to that runner.");
    assert.deepEqual(calls.forge, [], "nothing to refresh for a reader who may not see the facts");
  } finally {
    await panel.dispose();
  }
});

test("a member sees its campaign and its current assignment highlighted", async () => {
  const { client, calls } = fakeClient(() => ({
    revision: 1,
    items: [item("cwi_1"), item("cwi_2", { title: "Assigned Work" })],
    nextCursor: null,
  }));
  const panel = await mount({ initial: childSession, sessions: [rootSession, childSession], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    assert.match(panel.container.querySelector(".campaign-status-context")?.textContent ?? "", /Campaign Orchestrator.*current assignment is highlighted/);
    const assigned = panel.container.querySelector<HTMLButtonElement>(".campaign-work-row.is-assignment")!;
    assert.match(assigned.textContent ?? "", /Assigned Work/);
    assert.match(assigned.textContent ?? "", /Current Assignment/);
    assert.equal(assigned.tabIndex, 0, "the assignment is the list's tab stop");
    assert.match(panel.container.querySelector(".campaign-status-summary")?.textContent ?? "", /1 of 3 Delivered/,
      "the root's live summary is read from the store");
    assert.equal(calls.list[0]?.startsWith("s_child?"), true, "the member asks about its own campaign");
  } finally {
    await panel.dispose();
  }
});

test("a new ledger revision reloads the list, and a stale cursor restarts from the first page", async () => {
  // A server that honours `limit` and binds each cursor to the revision it was minted at.
  const all = Array.from({ length: 60 }, (_, index) => item(`cwi_${index + 1}`, { queuePosition: index + 1 }));
  let revision = 1;
  const pages = (query: string): FixturePage | Error => {
    const search = new URLSearchParams(query);
    const [cursorRevision, offsetText] = (search.get("cursor") ?? `${revision}:0`).split(":");
    if (Number(cursorRevision) !== revision) return new ApiError("revision changed", 409, "revision_changed");
    const offset = Number(offsetText);
    const limit = Number(search.get("limit"));
    const next = offset + limit < all.length ? `${revision}:${offset + limit}` : null;
    return { revision, items: all.slice(offset, offset + limit), nextCursor: next, total: all.length };
  };
  const { client, calls } = fakeClient(pages);
  const panel = await mount({ initial: rootSession, sessions: [rootSession], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    assert.equal(calls.list.length, 1);
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 50);
    revision = 2;
    await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({ revision: 2 })) }));
    assert.equal(calls.list.length, 2, "a revision bump reloads the shown rows");
    // The ledger moves again before this browser hears of it, so the next page is refused.
    revision = 3;
    const more = [...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Show More")!;
    await click(more);
    assert.equal(calls.list.length, 4, "the refused page is followed by a reload from the first page");
    assert.match(calls.list[2]!, /cursor=2%3A50/);
    assert.doesNotMatch(calls.list.at(-1)!, /cursor=/);
    assert.match(calls.list.at(-1)!, /limit=100/, "the reload covers the shown rows and the page asked for");
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 60);
    assertNoDomNode(panel.container.querySelector('[role="alert"]'), "a revision change is not an error");
  } finally {
    await panel.dispose();
  }
});

test("Campaign Status controls carry Title Case accessible names", async () => {
  const items = [item("cwi_1")];
  const { client } = fakeClient(() => ({ revision: 1, items, nextCursor: "more" }), { cwi_1: detailOf(items[0]!) });
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    // Item titles are user-authored content; every label the panel itself writes is checked.
    const names = (scope: Element) => [...scope.querySelectorAll("button:not(.campaign-work-row), h3:not(.campaign-detail-title), h4, dt")]
      .map((node) => node.getAttribute("aria-label")?.split(":")[0] ?? node.textContent ?? "")
      .filter(Boolean);
    const body = panel.container.querySelector(".rp-body")!;
    for (const name of names(body)) assert.equal(titleCaseLabel(name), name, name);
    await click(body.querySelector(".campaign-work-row")!);
    for (const name of names(body)) assert.equal(titleCaseLabel(name), name, name);
  } finally {
    await panel.dispose();
  }
});

/** A promise the test settles by hand, to put responses in a chosen order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

test("a details response for an item already left behind never replaces the open item", async () => {
  const items = [item("cwi_1"), item("cwi_2")];
  const pending = new Map<string, ReturnType<typeof deferred<{ revision: number; item: CampaignWorkItemDetail }>>>();
  const client = {
    ...fakeClient(() => ({ revision: 1, items, nextCursor: null })).client,
    // Ignores the abort signal, as a body already arriving does.
    campaignWorkItem: (_id: string, itemId: string) => {
      const response = deferred<{ revision: number; item: CampaignWorkItemDetail }>();
      pending.set(itemId, response);
      return response.promise;
    },
  } as ApiClient;
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelectorAll(".campaign-work-row")[0]!);
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Back to Work Items")!);
    await click(panel.container.querySelectorAll(".campaign-work-row")[1]!);
    await act(async () => { pending.get("cwi_2")!.resolve({ revision: 1, item: detailOf(items[1]!) }); });
    await settle();
    await act(async () => { pending.get("cwi_1")!.resolve({ revision: 1, item: detailOf(items[0]!) }); });
    await settle();
    assert.equal(panel.container.querySelector("h3.campaign-detail-title")?.textContent, "Work cwi_2");
  } finally {
    await panel.dispose();
  }
});

test("Show More waits for a reload of the shown rows instead of racing it", async () => {
  let revision = 1;
  const reloads: ReturnType<typeof deferred<CampaignWorkItemsPage>>[] = [];
  const listCalls: string[] = [];
  const client = {
    ...fakeClient(() => ({ revision: 1, items: [], nextCursor: null })).client,
    campaignWorkItems: (_id: string, query: string) => {
      listCalls.push(query);
      if (revision === 1) {
        return Promise.resolve({ revision, items: [item("cwi_1"), item("cwi_2")], nextCursor: "next", total: 3 });
      }
      const reload = deferred<CampaignWorkItemsPage>();
      reloads.push(reload);
      return reload.promise;
    },
  } as ApiClient;
  const panel = await mount({ initial: rootSession, sessions: [rootSession], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    revision = 2;
    await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({ revision: 2 })) }));
    assert.equal(reloads.length, 1, "a new revision starts reloading the shown rows");
    const callsBeforeReload = listCalls.length;
    const more = [...panel.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Show More"))!;
    assert.equal(more.disabled, true, "paging is unavailable while the reload is pending");
    await click(more);
    assert.equal(listCalls.slice(callsBeforeReload).filter((query) => query.includes("cursor=")).length, 0, "no page is requested under a reload");
    await act(async () => { reloads[0]!.resolve({ revision: 2, items: [item("cwi_1"), item("cwi_2"), item("cwi_3")], nextCursor: null, total: 3 }); });
    await settle();
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 3);
  } finally {
    await panel.dispose();
  }
});

test("Show More still lands when a new revision arrives while its page is in flight", async () => {
  // The live order: the next page is requested, the ledger moves, the root view carrying the new
  // revision arrives first, and only then is the page refused (or answered) under the old revision.
  const all = Array.from({ length: 80 }, (_, index) => item(`cwi_${index + 1}`, { queuePosition: index + 1 }));
  let revision = 1;
  const nextPage = deferred<CampaignWorkItemsPage>();
  const listCalls: string[] = [];
  const client = {
    ...fakeClient(() => ({ revision: 1, items: [], nextCursor: null })).client,
    campaignWorkItems: (_id: string, query: string) => {
      listCalls.push(query);
      const search = new URLSearchParams(query);
      if (search.get("cursor")) return nextPage.promise;
      const limit = Number(search.get("limit"));
      return Promise.resolve({ revision, items: all.slice(0, limit), nextCursor: limit < all.length ? `${revision}:${limit}` : null,
        total: all.length });
    },
  } as ApiClient;
  const panel = await mount({ initial: rootSession, sessions: [rootSession], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 50);
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Show More")!);
    assert.match(listCalls.at(-1)!, /cursor=/, "the next page is requested");
    revision = 2;
    await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({ revision: 2 })) }));
    await act(async () => { nextPage.reject(new ApiError("revision changed", 409, "revision_changed")); });
    await settle();
    assert.match(listCalls.at(-1)!, /limit=100/, "the reload covers the shown rows and the page asked for");
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 80,
      "the rows Show More asked for are shown without a second click");
    assertNoDomNode(panel.container.querySelector('[role="alert"]'), "a revision change is not an error");
  } finally {
    await panel.dispose();
  }
});

test("Show More still lands when its refusal arrives before the new revision does", async () => {
  // The other order: the page is refused first, its reload (shown rows plus the page) is still in
  // flight when the root view with the new revision arrives and starts another reload.
  const all = Array.from({ length: 80 }, (_, index) => item(`cwi_${index + 1}`, { queuePosition: index + 1 }));
  const held: ReturnType<typeof deferred<void>>[] = [];
  const listCalls: string[] = [];
  let holdReloads = false;
  const client = {
    ...fakeClient(() => ({ revision: 1, items: [], nextCursor: null })).client,
    campaignWorkItems: (_id: string, query: string) => {
      listCalls.push(query);
      const search = new URLSearchParams(query);
      if (search.get("cursor")) return Promise.reject(new ApiError("revision changed", 409, "revision_changed"));
      const limit = Number(search.get("limit"));
      const page = { revision: 2, items: all.slice(0, limit), nextCursor: limit < all.length ? `2:${limit}` : null, total: all.length };
      if (!holdReloads) return Promise.resolve(page);
      const response = deferred<void>();
      held.push(response);
      return response.promise.then(() => page);
    },
  } as ApiClient;
  const panel = await mount({ initial: rootSession, sessions: [rootSession], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    holdReloads = true;
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Show More")!);
    assert.match(listCalls.at(-1)!, /limit=100/, "the refusal starts a reload of the shown rows and the page");
    await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({ revision: 2 })) }));
    assert.match(listCalls.at(-1)!, /limit=100/, "the revision's reload keeps the page the superseded reload was loading");
    holdReloads = false;
    await act(async () => { for (const response of held) response.resolve(); });
    await settle();
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 80);
    assertNoDomNode(panel.container.querySelector('[role="alert"]'), "a revision change is not an error");
  } finally {
    await panel.dispose();
  }
});

test("a new revision reloads every row already shown, past one request's page ceiling", async () => {
  const all = Array.from({ length: 160 }, (_, index) => item(`cwi_${index + 1}`, { queuePosition: index + 1 }));
  let revision = 1;
  const limits: number[] = [];
  const pages = (query: string): FixturePage => {
    const search = new URLSearchParams(query);
    const offset = Number(search.get("cursor") ?? 0);
    const limit = Number(search.get("limit"));
    limits.push(limit);
    const slice = all.slice(offset, offset + limit);
    return { revision, items: slice, nextCursor: offset + limit < all.length ? String(offset + limit) : null, total: all.length };
  };
  const { client } = fakeClient(pages);
  const panel = await mount({ initial: rootSession, sessions: [rootSession], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    for (let page = 0; page < 2; page += 1) {
      await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Show More"))!);
    }
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 150);
    limits.length = 0;
    revision = 2;
    await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({ revision: 2 })) }));
    assert.deepEqual(limits, [100, 50], "the reload walks pages until the shown count is restored");
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 150, "no shown row is dropped");
  } finally {
    await panel.dispose();
  }
});

test("a held child links to its session, and a blocker's request opens that request", async () => {
  const blocked = item("cwi_3", {
    primaryState: "blocked",
    stateCauses: ["recorded_blocker"],
    currentAttempt: { id: "catt_3", sessionId: "s_child", sessionTitle: "Child One" },
    blocker: { reason: "Waiting for a merge decision.", responsibleActor: "human", requestOccurrenceId: "occ_1", recordedAt: NOW, recordedBySessionId: "s_root" },
  });
  const held = item("cwi_4", { primaryState: "blocked", stateCauses: ["attempt_session_held"], currentAttempt: { id: "catt_4", sessionId: "s_held", sessionTitle: "Held Child" } });
  const { client } = fakeClient(() => ({ revision: 1, items: [blocked, held], nextCursor: null }), {
    cwi_3: detailOf(blocked),
    cwi_4: detailOf(held),
  });
  const heldRoot = session({
    orchestratorCampaign: campaignProjection(workSummary(), {
      heldChildren: [{ sessionId: "s_held", holds: [{ kind: "provider_account_switch", holdId: "h1", since: NOW, reason: "Switching accounts.", recoveryAction: "Restart it when ready." }] }],
    }),
  });
  const panel = await mount({ initial: heldRoot, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    const buttons = () => [...panel.container.querySelectorAll("button")].map((button) => button.textContent);

    await click(panel.container.querySelectorAll(".campaign-work-row")[1]!);
    assert.match(panel.container.textContent ?? "", /Switching accounts\./);
    assert.ok(buttons().includes("Open Child Session"));
    assert.ok(!buttons().includes("Open Requests"), "a hold has nothing to answer");
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Back to Work Items")!);

    // No request is reachable from this panel, so the child is the way to its request.
    await click(panel.container.querySelectorAll(".campaign-work-row")[0]!);
    assert.ok(!buttons().includes("Open Requests"));
    assert.ok(buttons().includes("Open Child Session"));
  } finally {
    await panel.dispose();
  }
});

function pendingRequest(sessionId: string, occurrenceId: string): DescendantRequestView {
  return {
    sessionId, sessionTitle: sessionId, runnerId: "runner-1", runnerOnline: true, eventEpoch: 1, createdAt: NOW,
    responseOwner: "human", occurrenceId,
    request: { requestId: occurrenceId, occurrenceId, title: "Approve the command", options: [] },
  };
}

test("an item waiting on a decision opens its own child's request, never another child's", async () => {
  harnessRequests.descendants = [pendingRequest("s_child_a", "occ_a"), pendingRequest("s_child_b", "occ_b")];
  const waiting = item("cwi_2", {
    primaryState: "waiting",
    stateCauses: ["attempt_session_pending_decision"],
    currentAttempt: { id: "catt_2", sessionId: "s_child_b", sessionTitle: "Child B" },
  });
  const elsewhere = item("cwi_3", {
    primaryState: "waiting",
    stateCauses: ["attempt_session_input_required"],
    currentAttempt: { id: "catt_3", sessionId: "s_child_c", sessionTitle: "Child C" },
  });
  const { client } = fakeClient(() => ({ revision: 1, items: [waiting, elsewhere], nextCursor: null }), {
    cwi_2: detailOf(waiting),
    cwi_3: detailOf(elsewhere),
  });
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelectorAll(".campaign-work-row")[0]!);
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Open Requests")!);
    assert.equal(harnessRequests.selected.at(-1), JSON.stringify(["s_child_b", "occ_b"]));
    assert.equal(panel.state.mode, "requests");

    // Child C's request is not listed here, so its item offers the child rather than Requests.
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Back to Work Items")!);
    await click(panel.container.querySelectorAll(".campaign-work-row")[1]!);
    const labels = [...panel.container.querySelectorAll("button")].map((button) => button.textContent);
    assert.ok(!labels.includes("Open Requests"));
    assert.ok(labels.includes("Open Child Session"));
  } finally {
    await panel.dispose();
  }
});

test("reopening the panel on an item's details still returns to that row in a long list", async () => {
  const all = Array.from({ length: 160 }, (_, index) => item(`cwi_${index + 1}`, { queuePosition: index + 1 }));
  const pages = (query: string): FixturePage => {
    const search = new URLSearchParams(query);
    const offset = Number(search.get("cursor") ?? 0);
    const limit = Number(search.get("limit"));
    return { revision: 1, items: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null, total: all.length };
  };
  const { client } = fakeClient(pages, { cwi_120: detailOf(all[119]!) });
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    for (let page = 0; page < 2; page += 1) {
      await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Show More"))!);
    }
    await click(panel.container.querySelectorAll(".campaign-work-row")[119]!);
    // Leave through the launcher, which unmounts the mode, and come back.
    await act(async () => panel.state.setMode("launcher"));
    await act(async () => panel.state.show("campaign"));
    await settle();
    assert.equal(panel.container.querySelector("h3.campaign-detail-title")?.textContent, "Work cwi_120");
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Back to Work Items")!);
    const rows = panel.container.querySelectorAll(".campaign-work-row");
    assert.equal(rows.length, 150, "the list reloads as deep as it was");
    assert.equal(domWindow.document.activeElement, rows[119], "focus returns to the opened row");
  } finally {
    await panel.dispose();
  }
});

test("a member's summary that fails to refresh says so instead of passing off old numbers", async () => {
  let rootReads = 0;
  const client = {
    ...fakeClient(() => ({ revision: 1, items: [item("cwi_1")], nextCursor: null })).client,
    session: async () => {
      rootReads += 1;
      if (rootReads > 1) throw new ApiError("control plane unavailable", 503);
      return { session: rootSession };
    },
    campaignWorkItem: async () => { throw new ApiError("details unavailable", 503); },
  } as ApiClient;
  // The member's browser does not hold the root session, so the summary is read through the API.
  const panel = await mount({ initial: childSession, sessions: [childSession], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    const summary = () => panel.container.querySelector(".campaign-status-summary")!;
    assert.match(summary().textContent ?? "", /1 of 3 Delivered/);
    assertNoDomNode(summary().querySelector('[role="alert"]'));
    // Retrying the failed details reads the root again, and that read fails.
    await click(panel.container.querySelector(".campaign-work-row")!);
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!);
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Back to Work Items")!);
    assert.equal(rootReads, 2);
    assert.match(summary().textContent ?? "", /Couldn't Refresh Campaign Summary/);
    assert.match(summary().textContent ?? "", /1 of 3 Delivered/, "the last summary stays, marked stale");
    assert.ok(summary().querySelector("[data-stale]"));
  } finally {
    await panel.dispose();
  }
});

test("a blocker naming the Orchestrator's own request opens that request, not the child's", async () => {
  harnessRequests.descendants = [pendingRequest("s_child", "occ_child")];
  const blocked = item("cwi_5", {
    primaryState: "blocked",
    stateCauses: ["recorded_blocker"],
    currentAttempt: { id: "catt_5", sessionId: "s_child", sessionTitle: "Child One" },
    blocker: { reason: "Waiting on the Orchestrator's approval.", responsibleActor: "human", requestOccurrenceId: "occ_root", recordedAt: NOW, recordedBySessionId: "s_root" },
  });
  const { client } = fakeClient(() => ({ revision: 1, items: [blocked], nextCursor: null }), { cwi_5: detailOf(blocked) });
  const awaiting = session({
    orchestratorCampaign: campaign(workSummary()),
    pendingApproval: { requestId: "occ_root", occurrenceId: "occ_root", title: "Run the merge command", options: [] },
  });
  const panel = await mount({ initial: awaiting, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelector(".campaign-work-row")!);
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Open Requests")!);
    assert.equal(harnessRequests.selected[0], JSON.stringify(["s_root", "occ_root"]));
  } finally {
    await panel.dispose();
  }
});

test("Back before the remembered rows arrive still lands on the opened row once they do", async () => {
  const all = Array.from({ length: 160 }, (_, index) => item(`cwi_${index + 1}`, { queuePosition: index + 1 }));
  let hold: ReturnType<typeof deferred<void>> | null = null;
  const client = {
    ...fakeClient(() => ({ revision: 1, items: [], nextCursor: null }), { cwi_120: detailOf(all[119]!) }).client,
    campaignWorkItems: async (_id: string, query: string) => {
      if (hold) await hold.promise;
      const search = new URLSearchParams(query);
      const offset = Number(search.get("cursor") ?? 0);
      const limit = Number(search.get("limit"));
      return { revision: 1, items: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null, total: all.length };
    },
  } as ApiClient;
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    for (let page = 0; page < 2; page += 1) {
      await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Show More"))!);
    }
    await click(panel.container.querySelectorAll(".campaign-work-row")[119]!);
    await act(async () => panel.state.setMode("launcher"));
    // The remounted list waits on the server while the person goes Back.
    hold = deferred<void>();
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Back to Work Items")!);
    assert.notEqual(domWindow.document.activeElement?.classList.contains("campaign-work-row"), true);
    await act(async () => { hold!.resolve(); });
    await settle();
    const rows = panel.container.querySelectorAll(".campaign-work-row");
    assert.equal(rows.length, 150);
    assert.equal(domWindow.document.activeElement, rows[119], "focus lands on the opened row once it renders");
  } finally {
    await panel.dispose();
  }
});

/** A server whose item costs move as usage arrives, without a new revision. */
function costServer(initialUsd: number, rows = 1) {
  const state = { usd: initialUsd, revision: 1 };
  const summaryOf = (id: string) => item(id, { cost: knownCost(state.usd) });
  const ids = Array.from({ length: rows }, (_, index) => `cwi_${index + 1}`);
  const details: Record<string, CampaignWorkItemDetail> = {};
  const refreshDetails = () => { for (const id of ids) details[id] = detailOf(summaryOf(id)); };
  refreshDetails();
  const base = fakeClient(() => ({ revision: state.revision, items: ids.map(summaryOf), nextCursor: null }), details);
  const calls = Object.assign(base.calls, { aborted: 0, rowsAborted: 0, rowsIssued: 0 });
  /**
   * While `hold` is set, detail reads wait for it, and row reads wait for `rows`, as a slow server
   * would. While `manual` is set, each detail read waits until the test settles it from `pending`,
   * in any order, with the details as they stand then or with an error.
   */
  const slow: {
    hold: Promise<void> | null;
    rows: Promise<void> | null;
    manual: boolean;
    /** Errors the next row reads fail with, in order, once any hold is released. */
    refuse: Error[];
    pending: Array<(outcome?: Error) => void>;
  } = { hold: null, rows: null, manual: false, pending: [], refuse: [] };
  const client = {
    ...base.client,
    campaignWorkItems: async (id: string, query: string, signal?: AbortSignal) => {
      calls.rowsIssued += 1;
      signal?.addEventListener("abort", () => { calls.rowsAborted += 1; });
      const held = slow.rows;
      if (held) await held;
      const refusal = slow.refuse.shift();
      if (refusal) throw refusal;
      return base.client.campaignWorkItems(id, query, signal);
    },
    campaignWorkItem: async (id: string, itemId: string, signal?: AbortSignal) => {
      base.calls.detail.push(`${id}/${itemId}`);
      signal?.addEventListener("abort", () => { calls.aborted += 1; });
      if (slow.manual) {
        const outcome = await new Promise<Error | undefined>((settle) => { slow.pending.push(settle); });
        if (outcome) throw outcome;
      } else if (slow.hold) {
        await slow.hold;
      }
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const found = details[itemId];
      if (!found) throw new ApiError("not found", 404);
      return { revision: state.revision, item: found };
    },
  } as ApiClient;
  return {
    client,
    calls,
    slow,
    /** Usage arrives: every item now costs `usd`, and the root summary says so at `revision`. Its
     * coordination share differs from the fixture's, so every call moves the summary cost. */
    use(usd: number, revision = state.revision) {
      state.usd = usd;
      state.revision = revision;
      refreshDetails();
      const base = workSummary();
      return session({ orchestratorCampaign: campaign(workSummary({
        revision, cost: { ...base.cost!, total: knownCost(usd * rows + 0.25), workItems: knownCost(usd * rows) },
      })) });
    },
  };
}

function detailCost(container: HTMLElement): string {
  const term = [...container.querySelectorAll("dt")].find((node) => node.textContent === "Cost");
  return term?.nextElementSibling?.textContent ?? "";
}

const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test("member usage re-sent on the root re-reads the open details and the shown rows, with no reload", async () => {
  const server = costServer(1);
  const panel = await mount({ initial: rootSession, client: server.client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    const summaryText = () => panel.container.querySelector(".campaign-status-summary")?.textContent ?? "";
    assert.match(summaryText(), /\$2\.50/);
    await click(panel.container.querySelector(".campaign-work-row")!);
    assert.match(detailCost(panel.container), /\$1\.00/);
    const [listed, detailed] = [server.calls.list.length, server.calls.detail.length];

    // The server re-sends the root after member usage arrives: the same revision, a higher cost.
    await panel.setSession(server.use(3.25));
    assert.equal(server.calls.detail.length, detailed + 1, "the open details are re-read once");
    assert.match(detailCost(panel.container), /\$3\.25/, "the open item's cost follows the summary");
    assert.equal(server.calls.list.length, listed + 1, "the shown rows are re-read once");
    assert.doesNotMatch(server.calls.list.at(-1)!, /cursor=/, "at the same revision, from the first page");

    await click(panel.container.querySelector(".campaign-detail-back")!);
    assert.match(summaryText(), /\$3\.50/, "the summary shows the new campaign cost");
    const row = panel.container.querySelector(".campaign-work-row")!;
    assert.match(row.textContent ?? "", /\$3\.25/, "the row shows the new cost too");
    assertNoDomNode(panel.container.querySelector('[role="alert"]'), "a cost refresh is not an error");
  } finally {
    await panel.dispose();
  }
});

test("a token stream re-reads at most once per window, and a revision change needs no extra re-read", async () => {
  const server = costServer(1);
  const panel = await mount({ initial: rootSession, client: server.client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelector(".campaign-work-row")!);
    const detailed = server.calls.detail.length;

    // A burst of re-sends inside one window: one re-read at once, one more when the window closes.
    for (const usd of [1.5, 2, 2.5, 3]) await panel.setSession(server.use(usd));
    assert.equal(server.calls.detail.length, detailed + 1, "the first change re-reads at once");
    await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    await settle();
    assert.equal(server.calls.detail.length, detailed + 2, "the rest of the burst costs one more re-read");
    assert.match(detailCost(panel.container), /\$3\.00/, "and it shows the latest cost");
    await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    await settle();
    assert.equal(server.calls.detail.length, detailed + 2, "a quiet window re-reads nothing");

    // A new revision with a new cost reloads once through the revision path, not twice.
    const beforeRevision = server.calls.detail.length;
    await panel.setSession(server.use(4, 2));
    await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    await settle();
    assert.equal(server.calls.detail.length, beforeRevision + 1, "the revision reload already carries the new cost");
    assert.match(detailCost(panel.container), /\$4\.00/);
  } finally {
    await panel.dispose();
  }
});

test("details slower than the window still land while usage streams, with no read cancelled", async () => {
  const server = costServer(1);
  const panel = await mount({ initial: rootSession, client: server.client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelector(".campaign-work-row")!);
    assert.match(detailCost(panel.container), /\$1\.00/);
    const detailed = server.calls.detail.length;
    // The server now answers detail reads only when released, while costs keep moving.
    let release!: () => void;
    server.slow.hold = new Promise<void>((done) => { release = done; });
    for (const usd of [2, 3, 4]) {
      await panel.setSession(server.use(usd));
      await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    }
    assert.equal(server.calls.detail.length, detailed + 1, "one cost re-read in flight; later changes wait for it");
    assert.equal(server.calls.aborted, 0, "no read is cancelled by a later cost change");
    server.slow.hold = null;
    await act(async () => { release(); });
    await settle();
    assert.equal(server.calls.detail.length, detailed + 2, "the gathered changes cost one more re-read once it lands");
    assert.match(detailCost(panel.container), /\$4\.00/, "and the details show the latest cost");
  } finally {
    await panel.dispose();
  }
});

test("rows slower than the window still land while usage streams, with no re-read cancelled", async () => {
  const server = costServer(1);
  const panel = await mount({ initial: rootSession, client: server.client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    const rowCost = () => /\$\d+\.\d{2}/u.exec(panel.container.querySelector(".campaign-work-row")?.textContent ?? "")?.[0];
    assert.equal(rowCost(), "$1.00");
    const listed = server.calls.rowsIssued;
    // The server now answers row reads only when released, while costs keep moving.
    let release!: () => void;
    server.slow.rows = new Promise<void>((done) => { release = done; });
    for (const usd of [2, 3, 4]) {
      await panel.setSession(server.use(usd));
      await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    }
    assert.equal(server.calls.rowsIssued, listed + 1, "one quiet re-read in flight; later changes wait for it");
    assert.equal(server.calls.rowsAborted, 0, "no row re-read is cancelled by a later cost change");
    server.slow.rows = null;
    await act(async () => { release(); });
    await settle();
    assert.equal(server.calls.rowsIssued, listed + 2, "the gathered changes cost one more re-read once it lands");
    assert.equal(rowCost(), "$4.00", "and the rows show the latest cost");
  } finally {
    await panel.dispose();
  }
});

test("a refused or failed quiet re-read still brings the rows to the latest cost", async () => {
  const server = costServer(1);
  const panel = await mount({ initial: rootSession, client: server.client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    const rowCost = () => /\$\d+\.\d{2}/u.exec(panel.container.querySelector(".campaign-work-row")?.textContent ?? "")?.[0];
    for (const [usd, refusal] of [
      // In the cost sort, usage can reorder the rows between pages, and the server refuses the cursor.
      [3, new ApiError("revision changed", 409, "revision_changed")],
      // Any other failure, with a change gathered behind the read, gets one more attempt.
      [5, new ApiError("unavailable", 503)],
    ] as const) {
      let release!: () => void;
      server.slow.rows = new Promise<void>((done) => { release = done; });
      await panel.setSession(server.use(usd - 1));
      await pause(CAMPAIGN_COST_REFRESH_MS + 100);
      // The last change of the stream arrives while that re-read is in flight, which then fails.
      await panel.setSession(server.use(usd));
      server.slow.refuse.push(refusal);
      server.slow.rows = null;
      await act(async () => { release(); });
      await settle();
      assert.equal(rowCost(), `$${usd}.00`, `rows follow the latest cost after a ${refusal.status}`);
      assertNoDomNode(panel.container.querySelector('[role="alert"]'), "a quiet re-read's failure is not shown");
      await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    }
  } finally {
    await panel.dispose();
  }
});

test("a cost re-read gathered behind a slow one never starts after the panel closes", async () => {
  const server = costServer(1);
  const panel = await mount({ initial: rootSession, client: server.client });
  let release!: () => void;
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelector(".campaign-work-row")!);
    server.slow.hold = new Promise<void>((done) => { release = done; });
    await panel.setSession(server.use(2));
    await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    await panel.setSession(server.use(3));
  } finally {
    await panel.dispose();
  }
  const issued = server.calls.detail.length;
  server.slow.hold = null;
  await act(async () => { release(); });
  await settle();
  assert.equal(server.calls.detail.length, issued, "the closed panel reads nothing more");
});

test("detail outcomes apply in the order their reads were issued, whichever path issued them", async () => {
  const server = costServer(1);
  const panel = await mount({ initial: rootSession, client: server.client });
  const text = () => panel.container.querySelector(".rp-body")?.textContent ?? panel.container.textContent ?? "";
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    await click(panel.container.querySelector(".campaign-work-row")!);
    assert.match(detailCost(panel.container), /\$1\.00/);
    server.slow.manual = true;

    // An older load's failure lands after a newer cost re-read: the newer details stay.
    await panel.setSession(server.use(2, 2));
    const olderLoad = server.slow.pending.length - 1;
    await panel.setSession(server.use(3, 2));
    const newerCostRead = server.slow.pending.length - 1;
    assert.ok(newerCostRead > olderLoad, "the cost re-read was issued after the revision's load");
    await act(async () => { server.slow.pending[newerCostRead]!(); });
    await settle();
    assert.match(detailCost(panel.container), /\$3\.00/);
    await act(async () => { server.slow.pending[olderLoad]!(new ApiError("unavailable", 503)); });
    await settle();
    assertNoDomNode(panel.container.querySelector('[role="alert"]'), "an older failure never replaces newer details");
    assert.match(detailCost(panel.container), /\$3\.00/);

    // An older cost re-read lands after a newer load found the item gone: it stays gone.
    await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    await panel.setSession(server.use(4, 2));
    const olderCostRead = server.slow.pending.length - 1;
    await panel.setSession(server.use(4, 3));
    const newerLoad = server.slow.pending.length - 1;
    assert.ok(newerLoad > olderCostRead);
    await act(async () => { server.slow.pending[newerLoad]!(new ApiError("not found", 404)); });
    await settle();
    assert.match(text(), /Work Item Not Found/u);
    await act(async () => { server.slow.pending[olderCostRead]!(); });
    await settle();
    assert.match(text(), /Work Item Not Found/u, "an older answer never brings back an item a newer read found gone");
  } finally {
    server.slow.manual = false;
    for (const settleRead of server.slow.pending) settleRead();
    await panel.dispose();
  }
});

test("a quiet row re-read never blocks Show More and never replaces rows a page added meanwhile", async () => {
  // A server that honours `limit`, whose item costs move with usage; Show More can be held.
  let usd = 1;
  const all = () => Array.from({ length: 60 }, (_, index) =>
    item(`cwi_${index + 1}`, { queuePosition: index + 1, cost: knownCost(usd) }));
  let hold: { promise: Promise<void>; resolve: () => void } | null = null;
  const pages = (query: string): FixturePage | Error => {
    const search = new URLSearchParams(query);
    const offset = Number(search.get("cursor") ?? 0);
    const limit = Number(search.get("limit"));
    const next = offset + limit < 60 ? String(offset + limit) : null;
    return { revision: 1, items: all().slice(offset, offset + limit), nextCursor: next, total: 60 };
  };
  const rowCosts = () => new Set([...panel.container.querySelectorAll(".campaign-work-row")]
    .map((row) => /\$\d+\.\d{2}/u.exec(row.textContent ?? "")?.[0]));
  const base = fakeClient(pages);
  const client = {
    ...base.client,
    campaignWorkItems: async (id: string, query: string, signal?: AbortSignal) => {
      if (hold && new URLSearchParams(query).get("cursor")) await hold.promise;
      return base.client.campaignWorkItems(id, query, signal);
    },
  } as ApiClient;
  const panel = await mount({ initial: rootSession, client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 50);
    // Show More is in flight when usage arrives.
    let resolve!: () => void;
    hold = { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
    const more = () => [...panel.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Show More");
    await click(more()!);
    usd = 3;
    const usage = workSummary();
    await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({
      cost: { ...usage.cost!, total: knownCost(180) },
    })) }));
    await act(async () => { hold!.resolve(); });
    hold = null;
    await settle();
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 60, "the page Show More asked for stays");
    assert.deepEqual([...rowCosts()], ["$3.00"],
      "the cost change that arrived during paging re-reads the rows above the new page once it lands");
    // With nothing in flight, a cost change re-reads quietly: Show More stays enabled throughout.
    await pause(CAMPAIGN_COST_REFRESH_MS + 100);
    usd = 4;
    await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({
      cost: { ...usage.cost!, total: knownCost(240) },
    })) }));
    assertNoDomNode(more() ?? null, "every row is shown, so there is no Show More");
    assert.equal(panel.container.querySelectorAll(".campaign-work-row").length, 60, "the quiet re-read keeps every shown row");
    assert.deepEqual([...rowCosts()], ["$4.00"]);
  } finally {
    await panel.dispose();
  }
});
