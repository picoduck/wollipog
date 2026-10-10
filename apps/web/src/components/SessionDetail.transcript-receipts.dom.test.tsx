import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  ControlPlaneToUi,
  RunnerView,
  SessionEvent,
  SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "./SessionDetail.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/**
 * Receipts for messages already sent are rows of the transcript, under their message (#2171): the
 * composer column keeps only the notice slot above the composer, whatever is pending, rejected,
 * completed or failed.
 */

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
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
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
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 99,
} as RunnerView;

const RAW_RENAME_ERROR = "rename_session: provider_rejected (code 409)";

function session(id: string): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: null,
    workspaceName: null,
    projectId: null,
    agentId: "codex",
    agentName: "Codex",
    title: "Transcript Receipts Fixture",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: 1,
    eventEpoch: 0,
    preview: null,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    pendingPrompts: [{
      commandId: "prompt-pending",
      text: "Please also update the changelog.",
      state: "sent",
      revision: 1,
      attemptCount: 287,
      createdAt: 5,
      updatedAt: 5,
    }],
    steeringAttempts: [{
      submissionId: "steer-rejected",
      turnId: "turn-previous",
      source: "direct",
      text: "Use the smaller fixture instead.",
      state: "rejected",
      reason: "stale_turn",
      createdAt: 3,
      updatedAt: 4,
    }],
    commandInvocations: [{
      invocationId: "invocation-completed",
      submissionId: "submission-completed",
      sessionId: id,
      providerCommandId: "provider-compact",
      catalogRevision: "catalog-1",
      commandName: "compact",
      argumentText: "",
      executionMode: "passthrough",
      state: "completed",
      revision: 3,
      createdAt: 2,
      updatedAt: 3,
    }],
  };
}

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

function EventSeeder({ sessionId, payloads }: { sessionId: string; payloads: SessionEvent["payload"][] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload, index) => {
      dispatch({
        type: "msg",
        msg: {
          type: "session_event",
          event: { id: index + 1, sessionId, seq: index + 1, ts: index + 1, payload },
        },
      });
    });
  }, [dispatch, payloads, ready, sessionId]);
  return null;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  retitles: string[];
  renderMode: (mode: "preview" | "expanded") => Promise<void>;
}

async function flushAsyncWork() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function mountFixture(options: {
  draft?: string;
  steeringAttempts?: SessionView["steeringAttempts"];
} = {}): Promise<Fixture> {
  const currentSession = session("transcript-receipts");
  if (options.steeringAttempts) currentSession.steeringAttempts = options.steeringAttempts;
  const retitles: string[] = [];
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "transcript-receipts",
    runtimeKey: "transcript-receipts:1",
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: currentSession.id }),
    push() {},
    listen: () => () => {},
  };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    retitleSession: async (sessionId: string) => {
      retitles.push(sessionId);
      throw new Error(RAW_RENAME_ERROR);
    },
  } as unknown as ApiClient;
  const rightPanel = {
    open: false,
    mode: "launcher" as const,
    width: 360,
    dragging: false,
    subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {},
    expanded: false, setExpanded() {}, setDragging() {}, close() {}, selectSubagent() {}, showSubagent() {},
    consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const renderMode = async (mode: "preview" | "expanded") => act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <EventSeeder sessionId={currentSession.id} payloads={[
            { kind: "user_message", text: "Start the release checklist.", images: [] },
            { kind: "agent_message", text: "Started.", messageId: "agent-1" },
          ] as SessionEvent["payload"][]} />
          <SessionDetail
            sessionId={currentSession.id}
            mode={mode}
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            composerDraftLoader={async () => options.draft === undefined
              ? null
              : { text: options.draft, images: [], updatedAt: 1 }}
          />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await renderMode("expanded");
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false,
        boundedDelivery: false,
        paginatedSessionHistory: false,
        projects: true,
      },
      runners: [runner],
      boxes: [],
      projects: [],
      sessions: [currentSession],
      runs: [],
      pods: [],
    });
  });
  await flushAsyncWork();
  return { container, root, retitles, renderMode };
}

async function unmountFixture(fixture: Fixture) {
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
}

test("pending, steering, command and rename receipts are transcript rows; only the notice slot sits above the composer", async () => {
  const fixture = await mountFixture({ draft: "/rename-session" });
  try {
    const send = fixture.container.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null;
    assert.ok(send, "the composer can send the loaded /rename-session draft");
    await act(async () => { send.click(); });
    await flushAsyncWork();
    assert.deepEqual(fixture.retitles, ["transcript-receipts"], "the rename ran and failed");

    const scroller = fixture.container.querySelector(".detail-scroll") as HTMLElement;
    const composer = fixture.container.querySelector(".composer") as HTMLElement;
    assert.ok(scroller && composer);
    const rows = {
      pending: scroller.querySelector('[data-testid="pending-prompt-prompt-pending"]'),
      steering: scroller.querySelector('[data-testid="steering-attempt-steer-rejected"]'),
      command: scroller.querySelector('[data-testid="provider-command-submission-completed"]'),
      rename: scroller.querySelector('[role="region"][aria-label="Rename Session Status"]'),
    };
    for (const [kind, row] of Object.entries(rows)) {
      assert.ok(row, `the ${kind} receipt is in the transcript`);
      assert.equal(row.classList.contains("tl-row"), true, `${kind} is a right-aligned user row`);
      assert.equal(row.classList.contains("user"), true, `${kind} is a right-aligned user row`);
      assert.ok(row.querySelector(".tl-receipt"), `${kind} has one receipt line`);
    }
    // Each receipt sits after the last canonical item, under its own message.
    const timeline = scroller.querySelector(".timeline") as HTMLElement;
    for (const row of Object.values(rows)) {
      assert.equal(Boolean(timeline.compareDocumentPosition(row as never) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING),
        true);
    }

    // Between the transcript and the composer box: only the notice slot.
    assertNoDomNode(composer.querySelector(".tl-receipt, .tl-receipt-row, [data-testid^='steering-attempt-'], "
      + "[data-testid^='provider-command-'], [data-testid^='pending-prompt-']"), "no receipt renders in the composer");
    const visibleBeforeBox: string[] = [];
    for (const child of composer.children) {
      if (child.classList.contains("composer-box")) break;
      if (child.classList.contains("sr-only")) continue;
      visibleBeforeBox.push(child.className);
    }
    assert.deepEqual(visibleBeforeBox.filter((className) => !className.includes("notice")), [],
      `nothing but the notice slot precedes the composer box: ${visibleBeforeBox.join(", ")}`);

    // The words are for people (§11.2, §17.2).
    const receiptText = Object.values(rows).map((row) => row?.textContent ?? "").join("\n");
    for (const retired of ["Direct Steering", "Provider Command", "Delivery Attempts", "/rename-session",
      "Stale turn", "stale_turn", RAW_RENAME_ERROR]) {
      assert.equal(receiptText.includes(retired), false, `no receipt says "${retired}"`);
    }
    assert.match(rows.pending?.querySelector(".tl-receipt")?.textContent ?? "", /^Sending/u);
    assert.match(rows.steering?.querySelector(".tl-receipt")?.textContent ?? "",
      /^Not Accepted·The turn ended before this could steer it\.·Dismiss$/u);
    assert.match(rows.command?.querySelector(".tl-receipt")?.textContent ?? "", /^Delivered·Ran in Codex App Server\.$/u);
    assert.match(rows.rename?.querySelector(".tl-receipt")?.textContent ?? "",
      /^Rename Failed·Couldn't rename this session\.·Retry RenameShow Details$/u);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a steer the agent did not accept, scrolled off-screen, raises 1 Message Not Sent and leads to its Dismiss", async () => {
  const observed: Array<{ element: Element; callback: IntersectionObserverCallback }> = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) { observed.push({ element, callback: this.callback }); }
      unobserve() {}
      disconnect() {}
    },
  });
  const fixture = await mountFixture();
  try {
    const target = observed.find(({ element }) => element.getAttribute("data-receipt-id") === "steering:steer-rejected");
    assert.ok(target, "the rejected steer's row is watched for visibility");
    assert.equal(observed.some(({ element }) => element.getAttribute("data-receipt-id") === "prompt:prompt-pending"),
      false, "a message still on its way is not a failure");
    await act(async () => {
      target.callback([{ target: target.element, isIntersecting: false } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver);
    });
    const control = fixture.container.querySelector(".transcript-tail-control") as HTMLButtonElement | null;
    assert.equal(control?.textContent, "1 Message Not Sent");
    let scrolledTo: Element | null = null;
    (target.element as HTMLElement).scrollIntoView = function (this: Element) { scrolledTo = this; };
    await flushAsyncWork();
    await act(async () => { control!.click(); });
    assert.equal(scrolledTo, target.element, "the control scrolls to the receipt");
    assert.equal(domWindow.document.activeElement?.textContent, "Dismiss", "focus lands on the receipt's action");
  } finally {
    await unmountFixture(fixture);
    if (original) Object.defineProperty(globalThis, "IntersectionObserver", original);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  }
});

/** An IntersectionObserver stand-in that records what it watches, so a test can report rows off-screen. */
function recordIntersections() {
  const observed: Array<{ element: Element; callback: IntersectionObserverCallback }> = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) { observed.push({ element, callback: this.callback }); }
      unobserve() {}
      disconnect() {}
    },
  });
  return {
    observed,
    restore() {
      if (original) Object.defineProperty(globalThis, "IntersectionObserver", original);
      else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    },
  };
}

test("folded rejected steers still raise Message Not Sent when their group is off-screen", async () => {
  const intersections = recordIntersections();
  const rejected = (submissionId: string, updatedAt: number) => ({
    submissionId, turnId: "turn-previous", source: "direct" as const, text: `Steer ${submissionId}`,
    state: "rejected" as const, reason: "provider_rejected" as const, createdAt: updatedAt, updatedAt,
  });
  const fixture = await mountFixture({ steeringAttempts: [rejected("fold-a", 3), rejected("fold-b", 4)] });
  try {
    const group = fixture.container.querySelector('[data-terminal-status="rejected"]');
    assert.ok(group, "two rejections fold into one group");
    const target = intersections.observed.find(({ element }) =>
      element.getAttribute("data-receipt-id") === "steering:fold-a steering:fold-b");
    assert.ok(target, "the group row is watched for both of its messages");
    await act(async () => {
      target.callback([{ target: target.element, isIntersecting: false } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver);
    });
    const control = fixture.container.querySelector(".transcript-tail-control") as HTMLButtonElement | null;
    assert.equal(control?.textContent, "2 Messages Not Sent");
    (target.element as HTMLElement).scrollIntoView = () => {};
    await act(async () => { control!.click(); });
    assert.equal(domWindow.document.activeElement?.textContent, "Show All", "focus lands on the group's first action");

    // Expanding the group does not add a second watched row for the same messages.
    await act(async () => { (domWindow.document.activeElement as unknown as HTMLButtonElement).click(); });
    assert.equal(fixture.container.querySelectorAll('[data-receipt-id~="steering:fold-a"]').length, 1);
  } finally {
    await unmountFixture(fixture);
    intersections.restore();
  }
});

test("a failed rename stays with the full session view and does not follow the session into the Inbox preview", async () => {
  const fixture = await mountFixture({ draft: "/rename-session" });
  try {
    const send = fixture.container.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null;
    assert.ok(send);
    await act(async () => { send.click(); });
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector('[aria-label="Rename Session Status"]'), "the failed rename shows expanded");
    await fixture.renderMode("preview");
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector('[aria-label="Rename Session Status"]'),
      "the preview has no composer, so it offers no Retry Rename");
    assertNoDomNode(fixture.container.querySelector('[data-testid="steering-attempt-steer-rejected"]'),
      "steering receipts stay with the full session view too");
    await fixture.renderMode("expanded");
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector('[aria-label="Rename Session Status"]'), "and return with it");
  } finally {
    await unmountFixture(fixture);
  }
});
