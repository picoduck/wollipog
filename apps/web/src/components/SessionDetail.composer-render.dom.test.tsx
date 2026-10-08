import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { loadComposerDraft } from "../composer-drafts.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { observeRenderProbe, SESSION_VIEW_PROBE, TRANSCRIPT_PROBE } from "./render-probe.js";

/**
 * Typing in the composer renders the composer, not the session view around it (#2764).
 *
 * The draft lives in a store only the composer's textarea subscribes to; the session view reads
 * facts derived from it and renders when one of those changes. Two render probes count what a
 * keystroke renders: the session view, and the transcript inside it. The rest of this file covers
 * what the move must not change: composition, the caret, paste, undo, the draft surviving a switch
 * to another session, and a failed send's Retry.
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
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  File: domWindow.File,
  FileReader: domWindow.FileReader,
  MutationObserver: domWindow.MutationObserver,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
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
  protocolVersion: 106,
} as RunnerView;

function sessionView(id: string): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: null,
    workspaceName: null,
    projectId: null,
    agentId: "codex",
    agentName: "Codex",
    title: "Composer Render Fixture",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: 0,
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

const transcript: SessionEvent["payload"][] = [
  { kind: "user_message", text: "Summarize the repository", images: [] },
  { kind: "agent_message", text: "It is a control plane, a runner and a web client." },
  { kind: "user_message", text: "Which one owns sessions?", images: [] },
  { kind: "agent_message", text: "The control plane." },
];

let appendEvent: (sessionId: string, payload: SessionEvent["payload"]) => void = () => {};

function EventSeeder({ sessionId, payloads }: { sessionId: string; payloads: SessionEvent["payload"][] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  const seq = React.useRef(0);
  appendEvent = (target, payload) => {
    seq.current += 1;
    const id = seq.current;
    dispatch({ type: "msg", msg: { type: "session_event", event: { id, sessionId: target, seq: id, ts: id, payload } } });
  };
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload) => appendEvent(sessionId, payload));
  }, [payloads, ready, sessionId]);
  return null;
}

let fixtureSequence = 0;

async function mount(client: Partial<ApiClient> = {}) {
  fixtureSequence += 1;
  const first = sessionView(`composer-render-${fixtureSequence}`);
  const second = sessionView(`composer-render-${fixtureSequence}-other`);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: `composer-render-${fixtureSequence}`,
    runtimeKey: `composer-render-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: first.id }),
    push() {},
    listen: () => () => {},
  };
  const apiClient = {
    ...api,
    session: () => new Promise<never>(() => {}),
    searchWorkspaceReferences: async () => ({ results: [], truncated: false }),
    ...client,
  } as unknown as ApiClient;
  const rightPanel = {
    open: false,
    mode: "launcher",
    width: 360,
    dragging: false,
    subagentTarget: null,
    toggle() {},
    openMode() {},
    show() {},
    setMode() {},
    setWidth() {},
    setDragging() {},
    close() {},
    selectSubagent() {},
    showSubagent() {},
    consumeSubagentFocusRequest() {},
  };
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const render = (sessionId: string) => root.render(
    <ApiProvider client={apiClient}>
      <StoreProvider connection={connection} navigation={navigation}>
        <FeedbackProvider>
          <EventSeeder sessionId={first.id} payloads={transcript} />
          <SessionDetail
            key={sessionId}
            sessionId={sessionId}
            mode="expanded"
            rightPanel={rightPanel as never}
            onOpenTerminal={() => {}}
          />
        </FeedbackProvider>
      </StoreProvider>
    </ApiProvider>,
  );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  await act(async () => render(first.id));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner],
    boxes: [],
    projects: [],
    sessions: [first, second],
    runs: [],
    pods: [],
  }));
  await settle();
  const composer = () => {
    const element = mountPoint.querySelector(".composer-input") as HTMLTextAreaElement | null;
    assert.ok(element, "the composer is mounted");
    return element;
  };
  assert.ok(mountPoint.textContent?.includes("Which one owns sessions?"), "the transcript is rendered");
  const change = (value: string, caret = value.length) => act(async () => {
    fireDomEvent.change(composer(), { target: { value, selectionStart: caret, selectionEnd: caret } });
  });
  return {
    first,
    second,
    composer,
    container: mountPoint,
    settle,
    change,
    async type(text: string) {
      for (const character of text) await change(composer().value + character);
    },
    async append(payload: SessionEvent["payload"]) {
      await act(async () => appendEvent(first.id, payload));
    },
    async show(sessionId: string) {
      await act(async () => render(sessionId));
      await settle();
    },
    button(label: string) {
      return mountPoint.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    },
    async unmount() {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

function countRenders() {
  const counts = { view: 0, transcript: 0 };
  const stops = [
    observeRenderProbe(SESSION_VIEW_PROBE, () => { counts.view += 1; }),
    observeRenderProbe(TRANSCRIPT_PROBE, () => { counts.transcript += 1; }),
  ];
  return { counts, stop: () => stops.forEach((stop) => stop()) };
}

test("typing in the composer renders neither the session view nor the transcript per keystroke", async () => {
  const view = await mount();
  const { counts, stop } = countRenders();
  try {
    const message = "Hello, could you explain how drafts are saved?\nThanks again";
    await view.type(message);
    assert.equal(view.composer().value, message);
    // The first character turns Send on and the first line break stops a phone composer collapsing,
    // so the session view renders for each of those once. Nothing else it shows follows the text.
    assert.ok(counts.view <= 2, `${message.length} keystrokes rendered the session view ${counts.view} times`);
    assert.equal(counts.transcript, 0, "and never the transcript");
    assert.equal(view.button("Send")?.disabled, false, "Send follows the draft");

    // Both probes are live: a transcript change is exactly what they count.
    await view.append({ kind: "agent_message", text: "Drafts are saved after a short pause." });
    assert.ok(counts.transcript > 0, "a new transcript event renders the transcript");
    assert.ok(counts.view > 2, "and the session view around it");
  } finally {
    stop();
    await view.unmount();
  }
});

test("emptying the composer still updates what depends on the draft being blank", async () => {
  const view = await mount();
  try {
    await view.type("Draft");
    assert.equal(view.button("Send")?.disabled, false);
    await view.change("");
    assert.equal(view.composer().value, "");
    assert.equal(view.button("Send")?.disabled, true, "a blank draft disables Send again");
  } finally {
    await view.unmount();
  }
});

test("a slash or @ token renders the session view for its menu, but never the transcript", async () => {
  const view = await mount();
  const { counts, stop } = countRenders();
  try {
    await view.type("/rev");
    assert.ok(view.container.ownerDocument.querySelector('[role="listbox"]'), "the command menu is open");
    assert.equal(view.composer().getAttribute("aria-expanded"), "true");
    assert.ok(counts.view >= 1, "the menu filters on each keystroke, which renders the session view");

    await view.change("");
    await view.type("see @src");
    assert.equal(view.composer().getAttribute("aria-expanded"), "true", "the @ picker is open");
    assert.equal(counts.transcript, 0, "the transcript's props never change, so it does not render");
  } finally {
    stop();
    await view.unmount();
  }
});

test("text composed through an input method lands whole, without rendering the transcript", async () => {
  const view = await mount();
  const { counts, stop } = countRenders();
  try {
    const composer = view.composer();
    await act(async () => { fireDomEvent.compositionStart(composer); });
    for (const partial of ["ni", "nih", "你", "你好"]) await view.change(partial);
    await act(async () => { fireDomEvent.compositionEnd(composer); });
    await view.type("!");
    assert.equal(composer.value, "你好!");
    assert.equal(view.button("Send")?.disabled, false);
    assert.equal(counts.transcript, 0);
  } finally {
    stop();
    await view.unmount();
  }
});

test("an edit in the middle of the draft keeps the caret where it was typed", async () => {
  const view = await mount();
  try {
    await view.type("Hello world");
    const composer = view.composer();
    await view.change("Hello, world", "Hello,".length);
    assert.equal(composer.value, "Hello, world");
    assert.equal(composer.selectionStart, "Hello,".length, "the textarea is not rewritten under the caret");
    assert.equal(composer.selectionEnd, "Hello,".length);
  } finally {
    await view.unmount();
  }
});

test("pasted text is left to the browser and lands in the draft", async () => {
  const view = await mount();
  try {
    await view.type("Look at ");
    const composer = view.composer();
    const paste = new domWindow.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], files: [] },
    });
    await act(async () => { composer.dispatchEvent(paste as never); });
    assert.equal(paste.defaultPrevented, false, "plain text is not taken over as an attachment");
    // The browser inserts the pasted text and reports it as input.
    await view.change("Look at this stack trace");
    assert.equal(composer.value, "Look at this stack trace");
  } finally {
    await view.unmount();
  }
});

test("a keystroke clears an attachment refusal queued just before it", async () => {
  // The refusal of a pasted image is queued as the paste is handled; a keystroke that lands before
  // the session view renders it still makes a new message, so the notice goes with the old one.
  const view = await mount();
  try {
    await view.type("draft");
    const composer = view.composer();
    const file = new domWindow.File(["<svg/>"], "drawing.svg", { type: "image/svg+xml" });
    const paste = new domWindow.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/svg+xml", getAsFile: () => file }], files: [file] },
    });
    await act(async () => {
      composer.dispatchEvent(paste as never);
      await Promise.resolve();
      fireDomEvent.change(composer, { target: { value: "draft edited", selectionStart: 12, selectionEnd: 12 } });
    });
    await view.settle();
    assert.equal(view.composer().value, "draft edited");
    const alerts = [...view.container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent ?? "");
    assert.equal(alerts.some((text) => text.includes("Not Supported")), false,
      `the refusal belonged to the draft before the edit: ${alerts.join(" | ")}`);
  } finally {
    await view.unmount();
  }
});

test("a native undo is followed like any other edit", async () => {
  const view = await mount();
  try {
    await view.type("A message");
    // The browser's undo restores the textarea's earlier value and reports it as input; the draft,
    // and everything that follows whether it is blank, follow it.
    await view.change("");
    assert.equal(view.composer().value, "");
    assert.equal(view.button("Send")?.disabled, true);
    await view.change("A message");
    assert.equal(view.button("Send")?.disabled, false, "and a redo brings Send back");
  } finally {
    await view.unmount();
  }
});

test("a draft survives switching to another session and back", async () => {
  const view = await mount();
  try {
    await view.type("Half a thought");
    await view.show(view.second.id);
    assert.equal(view.composer().value, "", "the other session has its own, empty draft");
    const saved = await loadComposerDraft(view.first.id);
    assert.equal(saved?.text, "Half a thought", "leaving the session saved the draft that was typed");

    await view.show(view.first.id);
    assert.equal(view.composer().value, "Half a thought", "coming back restores it");
    assert.equal(view.button("Send")?.disabled, false, "with Send following the restored draft");
  } finally {
    await view.unmount();
  }
});

test("a failed send keeps the draft and offers Retry until the draft changes", async () => {
  let attempts = 0;
  const view = await mount({
    prompt: async () => {
      attempts += 1;
      throw new Error("transport rejected");
    },
  });
  try {
    await view.type("Please retry this");
    await act(async () => { view.button("Send")!.click(); });
    await view.settle();
    assert.equal(view.composer().value, "Please retry this", "the failed draft stays in the composer");
    const notSent = () => [...view.container.querySelectorAll<HTMLElement>('[role="alert"]')]
      .find((alert) => alert.textContent?.includes("Message Not Sent"));
    const retry = [...notSent()?.querySelectorAll<HTMLButtonElement>("button") ?? []]
      .find((button) => button.textContent === "Retry");
    assert.ok(retry, "the failure offers Retry for the draft it was about");
    await act(async () => { retry.click(); });
    await view.settle();
    assert.equal(attempts, 2, "Retry sends the same draft again");
    assert.equal(view.composer().value, "Please retry this");

    await view.type(", please");
    assert.equal(notSent(), undefined,
      "once the draft changes, the failure and its Retry are about a message that is gone");
  } finally {
    await view.unmount();
  }
});
