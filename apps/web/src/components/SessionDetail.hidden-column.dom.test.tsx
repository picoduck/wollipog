/**
 * #2894: conditions that arrive while the side panel hides the chat column (desktop Expanded, #2845;
 * the phone sheet, #2843). A failure brings the column back; a request shows its indicator; both
 * are announced from outside the hidden column (docs/design-system.md §4.9).
 */

import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, PendingApproval, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import type { RightPanelState } from "./RightPanel.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { setQuestionResponseStyle } from "../question-response-style.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 72, width: 800, height: 72, toJSON: () => ({}) };
  },
});
for (const [name, value] of [["clientHeight", 1_200], ["offsetHeight", 72]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
const desktopMatchMedia = domWindow.matchMedia;
const phoneMatchMedia = ((query: string) => ({
  matches: query.includes("max-width: 760px"), media: query, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  dispatchEvent: () => false,
})) as never;
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-1", hostname: "runner-host", displayName: "Build Box", os: "linux", version: "1",
  status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 192,
} as RunnerView;

let fixtureSequence = 0;
function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  fixtureSequence += 1;
  return {
    id: `hidden-column-${fixtureSequence}`, runnerId: runner.runnerId, workspaceId: null, workspaceName: null,
    projectId: null, agentId: "codex", agentName: "Codex", title: "Hidden Column Fixture", status: "running",
    column: "review", runId: null, useWorktree: true, worktreePath: "/repos/demo/wt",
    archived: false, createdAt: 1, updatedAt: 1, lastEventAt: null, messageCount: 0,
    eventEpoch: 0, preview: null, pendingApproval: null, driver: "codex-app-server",
    model: "gpt-5.6-sol", effort: "high", permissionMode: null, tokensIn: 0, tokensOut: 0,
    costUsd: 0, adopted: false,
    ...overrides,
  };
}

const failedDelivery = (state: "failed" | "uncertain" | "pending" = "failed"): SessionView["queued"] => [{
  id: "queued-1", text: "ship the fix", steerable: false,
  durableDeliveryState: state, durableDeliveryError: "The runner restarted.",
}];

const request = (requestId: string, title = "Run pnpm deploy?"): PendingApproval => ({
  requestId, occurrenceId: `${requestId}-occurrence`, kind: "permission", title,
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
} as PendingApproval);

const twoRequests = (): PendingApproval => ({ ...request("ask-1"), additionalRequests: [request("ask-2", "Run pnpm test?")] });

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

async function flush(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

/** Mounts the opened session with its side panel open: expanded on desktop, the sheet on a phone. */
async function mount(initial: SessionView, { phone = false, open = true }: { phone?: boolean; open?: boolean } = {}) {
  domWindow.matchMedia = phone ? phoneMatchMedia : desktopMatchMedia;
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: initial.id, runtimeKey: `${initial.id}:1`, createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: initial.id }), push() {}, listen: () => () => {},
  };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
  } as unknown as ApiClient;
  /** What the panel was asked to do, in order. */
  const calls: string[] = [];
  let setPanel: (next: { open: boolean; expanded: boolean }) => void = () => {};
  function Harness() {
    const [panel, update] = React.useState({ open, expanded: !phone });
    setPanel = update;
    const rightPanel = {
      open: panel.open, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
      toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
      expanded: panel.expanded,
      setExpanded(value: boolean) {
        calls.push(value ? "expand" : "restore");
        update((current) => ({ ...current, expanded: value }));
      },
      close() {
        calls.push("close");
        update((current) => ({ ...current, open: false }));
      },
      selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
    } as unknown as RightPanelState;
    return (
      <SessionDetail sessionId={initial.id} mode="expanded" rightPanel={rightPanel}
        onOpenTerminal={() => {}} composerDraftLoader={async () => null} />
    );
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={{
        confirm: async () => true, showToast: () => 0, showUndo: () => 0, dismissToast: () => {},
      } as never}>
        <StoreProvider connection={connection} navigation={navigation}>
          <Harness />
        </StoreProvider>
      </FeedbackContext.Provider>
    </ApiProvider>
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner], boxes: [], projects: [], sessions: [initial], runs: [], pods: [],
  }));
  await flush();
  let current = initial;
  return {
    container,
    calls,
    /** Delivers a session update, as a heartbeat or event would. */
    update: async (overrides: Partial<SessionView>) => {
      current = { ...current, ...overrides, updatedAt: current.updatedAt + 1 };
      await act(async () => socket.push({ type: "session_upsert", session: current }));
      await flush();
      await flush();
    },
    /** Opens or expands the panel again, as the person would. */
    setPanel: async (next: { open: boolean; expanded: boolean }) => {
      await act(async () => setPanel(next));
      await flush();
    },
    announcement: () => container.querySelector("[data-hidden-column-announcement]")?.textContent ?? "",
    slotKey: () => container.querySelector<HTMLElement>(".session-notice-slot")?.dataset.noticeKey ?? null,
    unmount: async () => {
      await flush(1);
      await act(async () => root.unmount());
      container.remove();
      domWindow.matchMedia = desktopMatchMedia;
    },
  };
}

test("desktop Expanded: a queued message's delivery failure restores the panel once and is announced (#2894)", async () => {
  const fixture = await mount(sessionView());
  try {
    const switcher = fixture.container.querySelector<HTMLElement>(".rpanel-switcher");
    switcher?.focus();
    await fixture.update({ queued: failedDelivery("failed") });
    assert.deepEqual(fixture.calls, ["restore"], "the failure restores the expanded panel");
    assert.equal(fixture.slotKey(), "queued-delivery:queued-1", "the slot shows the failure");
    assert.match(fixture.announcement(), /Message Not Delivered\./u);
    assert.ok(document.activeElement === switcher, "focus stays in the panel, which is still in view");

    // The person expands the panel again; the failure stays, clears and comes back.
    await fixture.setPanel({ open: true, expanded: true });
    await fixture.update({ queued: [] });
    await fixture.update({ queued: failedDelivery("failed") });
    assert.deepEqual(fixture.calls, ["restore"], "the same failure never restores twice");
  } finally {
    await fixture.unmount();
  }
});

test("desktop Expanded: an uncertain delivery restores the panel too (#2894)", async () => {
  const fixture = await mount(sessionView());
  try {
    await fixture.update({ queued: failedDelivery("uncertain") });
    assert.deepEqual(fixture.calls, ["restore"]);
    assert.match(fixture.announcement(), /Delivery Uncertain\./u);
  } finally {
    await fixture.unmount();
  }
});

test("desktop Expanded: a failure the session already had when it was shown changes nothing (#2894)", async () => {
  const fixture = await mount(sessionView({ queued: failedDelivery("failed") }));
  try {
    await fixture.update({ title: "Renamed" });
    assert.deepEqual(fixture.calls, []);
    assert.equal(fixture.announcement(), "");
  } finally {
    await fixture.unmount();
  }
});

test("desktop Expanded: a passive notice neither moves the layout nor is announced (#2894)", async () => {
  const fixture = await mount(sessionView());
  try {
    await fixture.update({ queued: failedDelivery("pending") });
    assert.deepEqual(fixture.calls, [], "a delivery still being retried is not a failure");
    assert.equal(fixture.announcement(), "");
  } finally {
    await fixture.unmount();
  }
});

test("desktop Expanded: a new request keeps the layout and is announced; the session bar is its indicator (#2894)", async () => {
  const fixture = await mount(sessionView());
  try {
    await fixture.update({ status: "input_required", pendingApproval: request("ask-1") });
    assert.deepEqual(fixture.calls, [], "a request does not restore the panel");
    assert.equal(fixture.announcement(), "New request waiting.");
    assert.ok(fixture.container.querySelector(".session-bar .session-status-button"),
      "the session bar's status control stays in view as the request's indicator");
    assertNoDomNode(fixture.container.querySelector(".rpanel-request"), "desktop has no panel-bar indicator");
  } finally {
    await fixture.unmount();
  }
});

test("desktop Expanded: a campaign continuation whose retries stopped restores the panel (#2894)", async () => {
  const campaign = (state: "running" | "failed") => ({
    orchestratorCampaign: {
      continuation: { state, pendingEvents: 1, attemptCount: 3, updatedAt: 2, commandId: "continue-1", canRetry: true },
    },
  } as unknown as Partial<SessionView>);
  const fixture = await mount(sessionView(campaign("running")));
  try {
    await fixture.update(campaign("failed"));
    assert.deepEqual(fixture.calls, ["restore"]);
    assert.match(fixture.announcement(), /Couldn't Resume the Orchestrator\./u);
  } finally {
    await fixture.unmount();
  }
});

test("desktop Expanded: a failure waits for a modal dialog over the panel to close (#2894)", async () => {
  const fixture = await mount(sessionView());
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  try {
    await fixture.update({ queued: failedDelivery("failed") });
    assert.deepEqual(fixture.calls, [], "nothing moves under the dialog");
    assert.match(fixture.announcement(), /Message Not Delivered\./u, "the failure is announced at once");
    await act(async () => { dialog.remove(); });
    await flush();
    await flush();
    assert.deepEqual(fixture.calls, ["restore"], "the panel restores once the dialog closes");
  } finally {
    dialog.remove();
    await fixture.unmount();
  }
});

test("a session that has been left never restores the panel (#2894)", async () => {
  const fixture = await mount(sessionView());
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  await fixture.update({ queued: failedDelivery("failed") });
  await fixture.unmount();
  await act(async () => { dialog.remove(); });
  await flush();
  assert.deepEqual(fixture.calls, [], "the waiting restore went with the session");
});

test("phone sheet: a delivery failure closes the sheet and focuses its notice (#2894)", async () => {
  const fixture = await mount(sessionView(), { phone: true, open: false });
  try {
    // Opened from a control in the session bar, to which closing the panel would return focus.
    const opener = fixture.container.querySelector<HTMLElement>(".session-bar button");
    assert.ok(opener, "the session bar has a control to open the panel from");
    opener.focus();
    await fixture.setPanel({ open: true, expanded: false });
    assert.equal(fixture.container.querySelector(".detail-body")?.hasAttribute("inert"), true, "the sheet covers the session");
    await fixture.update({ queued: failedDelivery("failed") });
    assert.deepEqual(fixture.calls, ["close"]);
    assert.equal(fixture.container.querySelector(".detail-body")?.hasAttribute("inert"), false,
      "closing the sheet lifts the session's inert state (#2888)");
    const slot = fixture.container.querySelector<HTMLElement>(".session-notice-slot");
    assert.equal(slot?.dataset.noticeKey, "queued-delivery:queued-1");
    assert.ok(document.activeElement === slot, "focus moves to the failure");
    await flush(5);
    assert.ok(document.activeElement === slot, "closing the panel does not pull focus back to its opener");
  } finally {
    await fixture.unmount();
  }
});

test("phone sheet: a failure under a waiting request keeps the dock and its unsent secret answer (#2894)", async () => {
  setQuestionResponseStyle("interactive", domWindow as never);
  const question = {
    requestId: "ask-token", occurrenceId: "ask-token-1", kind: "question", title: "Enter the token", options: [],
    questions: [{ id: "token", question: "Enter the token", options: [], allowOther: true, secret: true }],
  } as unknown as PendingApproval;
  const fixture = await mount(sessionView({ status: "input_required", pendingApproval: question }), { phone: true, open: false });
  try {
    const secret = () => fixture.container.querySelector<HTMLInputElement>('.request-dock input[type="password"]');
    const input = secret();
    assert.ok(input, "the dock asks for the secret");
    await act(async () => {
      input.value = "s3cret";
      fireDomEvent.change(input, { target: { value: "s3cret" } } as never);
    });
    await fixture.setPanel({ open: true, expanded: false });
    await fixture.update({ queued: failedDelivery("failed") });
    assert.deepEqual(fixture.calls, ["close"], "the failure closes the sheet");
    assert.equal(fixture.slotKey(), "request-dock", "the request keeps its place in the slot");
    assert.equal(secret()?.value, "s3cret", "the unsent secret answer survives");
    const more = [...fixture.container.querySelectorAll<HTMLButtonElement>(".session-notice-slot button")]
      .find((button) => /^\+1 More$/u.test(button.textContent ?? ""));
    assert.ok(more, "the failure waits behind the dock's +1 More");
    assert.ok(document.activeElement === fixture.container.querySelector(".session-notice-slot"), "focus moves to the slot");
    assert.match(fixture.announcement(), /Message Not Delivered\./u, "and the failure is announced");
  } finally {
    setQuestionResponseStyle("interactive", domWindow as never);
    await fixture.unmount();
  }
});

test("phone sheet: a request shows Answer Request in the sheet's bar, which closes it on the dock's card (#2894)", async () => {
  const fixture = await mount(sessionView(), { phone: true });
  try {
    assertNoDomNode(fixture.container.querySelector(".rpanel-request"), "no request, no indicator");
    await fixture.update({ status: "input_required", pendingApproval: request("ask-1") });
    assert.deepEqual(fixture.calls, [], "a request does not close the sheet");
    assert.equal(fixture.announcement(), "New request waiting.");
    const button = fixture.container.querySelector<HTMLButtonElement>(".rpanel-head .rpanel-request");
    assert.ok(button, "the sheet's bar shows the request");
    assert.equal(button.getAttribute("aria-label"), "Answer Request");
    assert.equal(button.querySelector(".count-badge")?.textContent, "1");

    await fixture.update({ pendingApproval: twoRequests() });
    assert.equal(button.getAttribute("aria-label"), "Review 2 Requests");
    assert.equal(button.querySelector(".count-badge")?.textContent, "2");

    await act(async () => { fireDomEvent.click(button); });
    await flush();
    await flush(5);
    assert.deepEqual(fixture.calls, ["close"]);
    const focused = document.activeElement as HTMLElement | null;
    assert.ok(focused?.closest('[data-session-request-id="ask-1"]'), "focus is on the lead request's card");
  } finally {
    await fixture.unmount();
  }
});

test("phone sheet: a campaign continuation whose retries stopped closes the sheet and focuses its notice (#2894)", async () => {
  const campaign = (state: "running" | "failed") => ({
    orchestratorCampaign: {
      continuation: { state, pendingEvents: 1, attemptCount: 3, updatedAt: 2, commandId: "continue-1", canRetry: true },
    },
  } as unknown as Partial<SessionView>);
  const fixture = await mount(sessionView(campaign("running")), { phone: true });
  try {
    await fixture.update(campaign("failed"));
    assert.deepEqual(fixture.calls, ["close"]);
    const notice = fixture.container.querySelector<HTMLElement>('.campaign-notices .notice[data-state="failed"]');
    assert.ok(notice, "the failed continuation is shown");
    assert.ok(document.activeElement === notice, "focus moves to it");
    await flush(5);
    assert.ok(document.activeElement === notice, "and stays there");
  } finally {
    await fixture.unmount();
  }
});
