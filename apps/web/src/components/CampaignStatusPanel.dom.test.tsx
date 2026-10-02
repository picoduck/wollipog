import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, OrchestratorCampaignProjection, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
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
import { useCampaignStatusAvailability } from "./useCampaignStatus.js";
import { CAMPAIGN_STATUS_UNSUPPORTED_REASON } from "../campaign-status.js";
import type {
  CampaignWorkItem,
  CampaignWorkItemDetail,
  CampaignWorkItemPage,
  CampaignWorkSummary,
} from "../campaign-work-contract.js";

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
const MINUTE = 60_000;

const git: GitStatus = {
  status: null, observation: 0, observedAt: null, settled: false, busy: false, error: null, errorCode: null,
  refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
};

function workSummary(overrides: Partial<CampaignWorkSummary> = {}): CampaignWorkSummary {
  return {
    revision: 1,
    planState: "recorded",
    coverage: { untrackedChildren: 0 },
    counts: {
      committed: 3, delivered: 1, original: 2, followUp: 1,
      byState: { planned: 1, queued: 0, running: 1, waiting: 0, blocked: 0, delivered: 1, cancelled: 0, removed: 0 },
    },
    recommendations: { awaiting_adjudication: 0, accepted: 1, rejected: 1, deferred: 0, duplicate: 2 },
    obligations: { verification: 1, adjudication: 0, cleanup: 0 },
    elapsed: { startedAt: NOW - 10 * MINUTE, completedAt: null },
    cost: { totalUsd: 2.5, workItemsUsd: 2, coordinationUsd: 0.5, unattributedUsd: 0, source: "providerReported", unpricedRecords: 0, coverage: "complete" },
    ...overrides,
  };
}

function campaign(work: CampaignWorkSummary | null): OrchestratorCampaignProjection {
  return {
    status: "active",
    policyRevision: 1,
    limits: { maximumConcurrentChildren: 4, occupied: 1, remaining: 3, costBudgetUsd: null, maxToolCalls: null },
    children: { total: 2, active: 1, waitingHuman: 0, blocked: 0, verified: 1, cleanupPending: 0 },
    followUps: { unique: 1, duplicates: 2 },
    ...(work ? { work } : {}),
  } as unknown as OrchestratorCampaignProjection;
}

function session(overrides: Partial<SessionView> & Record<string, unknown> = {}): SessionView {
  return {
    id: "s_root", runnerId: "runner-1", driver: "claude-code", status: "running", adopted: false, eventEpoch: 1,
    title: "Campaign Orchestrator", parentSessionId: null, pendingApproval: null,
    ...overrides,
  } as SessionView;
}

function item(id: string, overrides: Partial<CampaignWorkItem> = {}): CampaignWorkItem {
  return {
    id, key: `picoduck/wollipog#${id}`, issue: { repository: "picoduck/wollipog", number: Number(id.replace(/\D/g, "")) || 1 },
    title: `Work ${id}`, origin: "original", generation: 0, state: "running", queuePosition: 1,
    lastActivityAt: NOW, startedAt: NOW - 5 * MINUTE, endedAt: null, recordedAt: NOW - 20 * MINUTE,
    cost: null, currentSessionId: "s_child", ...overrides,
  };
}

function detailOf(base: CampaignWorkItem, overrides: Partial<CampaignWorkItemDetail> = {}): CampaignWorkItemDetail {
  return {
    ...base,
    commitment: { state: "committed", reason: null },
    dependsOn: [], originWorkItems: [], pullRequests: [], blocker: null, responsibleActor: "Orchestrator",
    nextAction: null, reportedStage: null,
    observed: [{ kind: "checks", value: "", observedAt: null, freshness: { state: "unavailable", reason: "GitHub is not connected." } }],
    attempts: [{ id: "catt_1", sessionId: "s_child", sessionTitle: "Child One", harness: "Claude Code", model: null, effort: null,
      startedAt: NOW - 5 * MINUTE, endedAt: null, endReason: null, cost: null }],
    verification: null,
    time: { queueMs: null, waitingMs: 0, activeMs: null },
    ...overrides,
  };
}

interface Calls { list: string[]; detail: string[]; summary: string[] }

function fakeClient(pages: (query: string) => CampaignWorkItemPage | Error, details: Record<string, CampaignWorkItemDetail> = {}) {
  const calls: Calls = { list: [], detail: [], summary: [] };
  const client = {
    ...api,
    childSessions: () => Promise.reject(new ApiError("No registry in this fixture.", 404)),
    campaignWorkItems: async (id: string, query: string) => {
      calls.list.push(`${id}?${query}`);
      const page = pages(query);
      if (page instanceof Error) throw page;
      return page;
    },
    campaignWorkItem: async (id: string, itemId: string) => {
      calls.detail.push(`${id}/${itemId}`);
      const found = details[itemId];
      if (!found) throw new ApiError("not found", 404);
      return found;
    },
    campaignSummary: async (id: string) => {
      calls.summary.push(id);
      return { campaignSessionId: "s_root", campaignTitle: "Campaign Orchestrator", status: "active", limits: null, work: workSummary() };
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

function PanelWithAvailability({ session: current, onState, onOpen }: {
  session: SessionView;
  onState: (state: RightPanelState) => void;
  onOpen: (id: string) => void;
}) {
  const state = useRightPanelState();
  onState(state);
  const availability = useCampaignStatusAvailability(current);
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
    />
  );
}

async function mount({
  initial,
  sessions = [initial],
  client,
  campaignWork = true,
}: {
  initial: SessionView;
  sessions?: SessionView[];
  client: ApiClient;
  campaignWork?: boolean;
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
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, ...(campaignWork ? { campaignWork: true } : {}) },
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
  campaignMembership: { campaignSessionId: "s_root", currentWorkItemId: "cwi_2" },
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
  const panel = await mount({ initial: rootSession, client, campaignWork: false });
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
    planState: "not_recorded", coverage: { untrackedChildren: 2 }, cost: null,
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
    assert.match(facts, /ChecksUnavailableGitHub is not connected\./, "unavailable forge data never reads as passing");

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
    assert.equal(calls.summary.length, 0, "the root's live summary is read from the store, not fetched");
    assert.equal(calls.list[0]?.startsWith("s_child?"), true, "the member asks about its own campaign");
  } finally {
    await panel.dispose();
  }
});

test("a new ledger revision reloads the list, and a stale cursor restarts from the first page", async () => {
  let revision = 1;
  const pages = (query: string): CampaignWorkItemPage | Error => {
    if (query.includes("cursor=")) {
      return revision === 2 ? new ApiError("revision changed", 409, "revision_changed") : { revision, items: [item("cwi_9")], nextCursor: null };
    }
    return { revision, items: [item("cwi_1"), item("cwi_2")], nextCursor: "next" };
  };
  const { client, calls } = fakeClient(pages);
  const panel = await mount({ initial: rootSession, sessions: [rootSession], client });
  try {
    await act(async () => panel.state.show("campaign"));
    await settle();
    assert.equal(calls.list.length, 1);
    await panel.setSession(session({ orchestratorCampaign: campaign(workSummary({ revision: 2 })) }));
    revision = 2;
    assert.equal(calls.list.length, 2, "a revision bump reloads the shown rows");
    const more = [...panel.container.querySelectorAll("button")].find((button) => button.textContent === "Show More")!;
    await click(more);
    assert.equal(calls.list.length, 4, "the refused page is followed by a first-page reload");
    assert.doesNotMatch(calls.list.at(-1)!, /cursor=/);
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
