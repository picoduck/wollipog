import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionEvent, SessionView, SideChatView } from "@wollipog/protocol";
import { api } from "../api.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import type { View, ViewNavigation } from "../navigation.js";
import { SideChatPanel, sideChatComposerUnavailable } from "./SideChatPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  ResizeObserver: domWindow.ResizeObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// `SideChatPanel` starts a repeating timer that only its effect teardown clears. Without this, an
// assertion throwing before the trailing `root.unmount()` left the timer rescheduling and the
// process could not exit — a plain failure reading as a hung suite (#899).
installDomTestCleanup(domWindow);

const parent = {
  id: "primary-session",
  runnerId: "runner-1",
  agentId: "claude",
  status: "idle",
  title: "Primary",
} as SessionView;

const child = {
  ...parent,
  id: "side-session",
  title: "Side chat: Primary",
  archived: true,
  useWorktree: true,
  eventEpoch: 0,
} as SessionView;

const relation: SideChatView = { parentSessionId: parent.id, session: child, createdAt: 1 };

const connection: UiConnectionRuntime = {
  instanceId: "side-chat-test", runtimeKey: "side-chat-test",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

/** The panel navigates through the store, so every render needs one mounted above it. */
function mount(node: React.ReactElement, pushed: View[]) {
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: parent.id }),
    push: (view) => { pushed.push(view); },
    listen: () => () => {},
  };
  return <StoreProvider connection={connection} navigation={navigation}>{node}</StoreProvider>;
}
const responseEvent: SessionEvent = {
  id: 1,
  sessionId: child.id,
  seq: 1,
  ts: 2,
  payload: { kind: "agent_message", text: "Selected side-chat answer", final: true },
};

test("side chat starts separately, prompts only the child, and inserts output explicitly", async () => {
  const originals = {
    sideChat: api.sideChat,
    createSideChat: api.createSideChat,
    session: api.session,
    getSessionEventPage: api.getSessionEventPage,
    prompt: api.prompt,
  };
  const prompted: Array<{ id: string; text: string }> = [];
  const inserted: string[] = [];
  let eventServed = false;
  api.sideChat = async () => ({ sideChat: null });
  api.createSideChat = async () => relation;
  api.session = async () => ({ session: child });
  api.getSessionEventPage = async () => {
    if (eventServed) return { events: [], eventEpoch: 0, nextAfter: 1, cacheComplete: true };
    eventServed = true;
    return { events: [responseEvent], eventEpoch: 0, nextAfter: 1, cacheComplete: true };
  };
  api.prompt = async (id: string, text: string) => {
    prompted.push({ id, text });
    return child;
  };

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(mount(<SideChatPanel session={parent} runnerOnline
        onInsertDraft={(text) => inserted.push(text)} />, []));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(container.textContent ?? "", /No prompt, transcript, attachments, artifacts, or budget are copied/);

    const start = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Start Side Chat")!;
    await act(async () => {
      (start as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.equal(prompted.length, 0, "creating the auxiliary session does not send a prompt");
    assert.match(container.textContent ?? "", /separate worktree and transcript/);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.value = "independent question";
      fireDomEvent.change(textarea);
    });
    const send = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Send")!;
    await act(async () => {
      (send as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(prompted, [{ id: child.id, text: "independent question" }]);

    const insert = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Insert Latest Response into Primary Draft")!;
    await act(async () => { (insert as HTMLButtonElement).click(); });
    assert.deepEqual(inserted, ["Selected side-chat answer"]);
    assert.deepEqual(prompted, [{ id: child.id, text: "independent question" }], "insertion never auto-submits primary text");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, originals);
    container.remove();
  }
});

test("the two composer closures never share a message", () => {
  assert.match(sideChatComposerUnavailable("stopped", true)!, /session was stopped/);
  assert.match(sideChatComposerUnavailable("failed", true)!, /session failed/);
  assert.match(sideChatComposerUnavailable("completed", true)!, /session has finished/);
  assert.match(sideChatComposerUnavailable("idle", false)!, /runner is offline/);
  assert.doesNotMatch(sideChatComposerUnavailable("idle", false)!, /side chat's session/,
    "an offline runner is not reported as an ended child");
  assert.doesNotMatch(sideChatComposerUnavailable("stopped", true)!, /runner/,
    "an ended child is not reported as an offline runner");
  assert.equal(sideChatComposerUnavailable("running", true), null);
});

/**
 * #1206: a side chat whose child reached a terminal state used to be a dead end — a disabled
 * composer with no action, because `create` was reachable only when no side chat existed at all.
 */
test("a terminal side chat offers a working replacement and a link to the ended child", async () => {
  const originals = {
    sideChat: api.sideChat,
    createSideChat: api.createSideChat,
    session: api.session,
    getSessionEventPage: api.getSessionEventPage,
    prompt: api.prompt,
  };
  const ended = { ...child, status: "stopped" } as SessionView;
  const replacement = { ...child, id: "side-session-2", status: "idle" } as SessionView;
  const createCalls: Array<{ id: string; replaceEnded: boolean }> = [];
  const pushed: View[] = [];
  const sessions = new Map([[ended.id, ended], [replacement.id, replacement]]);
  api.sideChat = async () => ({ sideChat: { ...relation, session: ended } });
  api.createSideChat = async (id: string, replaceEnded = false) => {
    createCalls.push({ id, replaceEnded });
    return { parentSessionId: parent.id, session: replacement, createdAt: 2 };
  };
  api.session = async (id: string) => ({ session: sessions.get(id)! });
  api.getSessionEventPage = async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true });
  api.prompt = async () => { throw new Error("a terminal side chat must never be prompted"); };

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const button = (label: string) => Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === label) as HTMLButtonElement | undefined;
  try {
    await act(async () => {
      root.render(mount(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, pushed));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    assert.equal((container.querySelector("textarea") as HTMLTextAreaElement).disabled, true);
    assert.match(container.textContent ?? "", /This side chat's session was stopped/,
      "the disabled composer explains that the child ended, not that the runner is offline");

    await act(async () => { button("Open Side Chat Session")!.click(); });
    assert.deepEqual(pushed, [{ name: "session", id: ended.id }],
      "the ended child's own session view stays reachable");

    const restart = button("Start a New Side Chat")!;
    assert.equal(restart.disabled, false, "the recovery action is enabled, not merely present");
    await act(async () => {
      restart.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    assert.deepEqual(createCalls, [{ id: parent.id, replaceEnded: true }]);
    assert.equal((container.querySelector("textarea") as HTMLTextAreaElement).disabled, false,
      "the replacement is usable without leaving the parent session");
    assert.equal(button("Start a New Side Chat"), undefined, "a live child offers no replacement action");
    assert.doesNotMatch(container.textContent ?? "", /can no longer receive/);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, originals);
    container.remove();
  }
});

test("a terminal side chat cannot be replaced while the runner is offline", async () => {
  const originals = { sideChat: api.sideChat, session: api.session, getSessionEventPage: api.getSessionEventPage };
  const ended = { ...child, status: "failed" } as SessionView;
  api.sideChat = async () => ({ sideChat: { ...relation, session: ended } });
  api.session = async () => ({ session: ended });
  api.getSessionEventPage = async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true });

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(mount(<SideChatPanel session={parent} runnerOnline={false} onInsertDraft={() => {}} />, []));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const restart = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === "Start a New Side Chat") as HTMLButtonElement;
    assert.equal(restart.disabled, true);
    assert.match(container.textContent ?? "", /runner must be online to start a new side chat/);
    assert.match(container.textContent ?? "", /This side chat's session failed/,
      "both closures are reported, because they have different remedies");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, originals);
    container.remove();
  }
});
