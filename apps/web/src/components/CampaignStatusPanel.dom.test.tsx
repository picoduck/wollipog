import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
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
import { useCampaignStatusAvailability } from "./useCampaignStatus.js";
import { CAMPAIGN_STATUS_UNSUPPORTED_REASON } from "../campaign-status.js";
import {
  campaignProjection,
  itemDetail,
  itemSummary,
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

interface Calls { list: string[]; detail: string[] }

type FixturePage = Omit<CampaignWorkItemsPage, "total"> & { total?: number };

function fakeClient(pages: (query: string) => FixturePage | Error, details: Record<string, CampaignWorkItemDetail> = {}) {
  const calls: Calls = { list: [], detail: [] };
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
