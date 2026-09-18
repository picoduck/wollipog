import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
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
import {
  clearPanelScratch,
  dropPanelScratchMemory,
  panelScratchScopeKey,
  readPanelScratch,
} from "../right-panel-scratch.js";

/**
 * Panel scratch survives unmount on purpose (#1202), and these cases share one session id — so
 * without this each test would start holding whatever the previous one typed or chose.
 */
beforeEach(() => clearPanelScratch());

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
  let related: SideChatView | null = null;
  api.sideChat = async () => ({ sideChat: related });
  api.createSideChat = async () => { related = relation; return relation; };
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
  let related: SideChatView = { ...relation, session: ended };
  api.sideChat = async () => ({ sideChat: related });
  api.createSideChat = async (id: string, replaceEnded = false) => {
    createCalls.push({ id, replaceEnded });
    if (replaceEnded) related = { parentSessionId: parent.id, session: replacement, createdAt: 2 };
    return related;
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

/**
 * Cross-model review CR-1.1. Two panels can show the same ended child. When one replaces it, the
 * other used to keep polling its own retired child forever: its recovery action then failed with
 * "the current side chat is still active" every time, because the parent had already moved on.
 * Polling the relationship rather than the child is what lets the second panel catch up.
 */
test("a side chat replaced by another client is picked up by the polling panel", async () => {
  const originals = { sideChat: api.sideChat, session: api.session, getSessionEventPage: api.getSessionEventPage };
  const ended = { ...child, status: "stopped" } as SessionView;
  const replacement = { ...child, id: "side-session-elsewhere", status: "idle" } as SessionView;
  let related: SideChatView = { ...relation, session: ended };
  api.sideChat = async () => ({ sideChat: related });
  api.session = async () => ({ session: ended });
  api.getSessionEventPage = async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true });

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(mount(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, []));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.match(container.textContent ?? "", /can no longer receive messages/);

    // Somebody else replaces it. Only the control plane's answer changes.
    related = { parentSessionId: parent.id, session: replacement, createdAt: 3 };
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_800)); });

    assert.equal((container.querySelector("textarea") as HTMLTextAreaElement).disabled, false,
      "the panel follows the parent's current side chat instead of arguing about a retired one");
    assert.doesNotMatch(container.textContent ?? "", /can no longer receive messages/);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, originals);
    container.remove();
  }
});

/**
 * Cross-model review CR-1.2. `src/e2e/request-surfaces-main.tsx` renders `RightPanel` — and so this
 * panel — under an `ApiProvider` with no store. An unconditional `useStoreActions()` crashed that
 * tracked fixture the moment the Side Chat destination was opened.
 */
test("the panel still renders where no store is mounted, minus the store-backed link", async () => {
  const originals = { sideChat: api.sideChat, session: api.session, getSessionEventPage: api.getSessionEventPage };
  const ended = { ...child, status: "stopped" } as SessionView;
  api.sideChat = async () => ({ sideChat: { ...relation, session: ended } });
  api.session = async () => ({ session: ended });
  api.getSessionEventPage = async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true });

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      // Deliberately no StoreProvider.
      root.render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.match(container.textContent ?? "", /separate worktree and transcript/);
    assert.equal(Array.from(container.querySelectorAll("button"))
      .some((button) => button.textContent === "Open Side Chat Session"), false);
    assert.equal(Array.from(container.querySelectorAll("button"))
      .some((button) => button.textContent === "Start a New Side Chat"), true,
      "the recovery action needs no store and stays available");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, originals);
    container.remove();
  }
});

/**
 * Cross-model review CR-2.1. Switching children used to commit the new child while `events` still
 * held the old one's, so for one render the retired transcript sat under the new child's header —
 * and its "Insert Latest Response into Primary Draft" was live, which is the one action that crosses
 * back into the primary composer. The fix resets the transcript in the same commit as the switch;
 * that sub-frame window is not observable from happy-dom (a MutationObserver batches its records and
 * reports only the settled text), so this test pins the settled outcome and the insert boundary,
 * and the same-commit guarantee rests on `resetTranscript` being called beside every `setSideChat`
 * that changes the child.
 */
test("a replaced child carries neither the retired transcript nor its insert action", async () => {
  const originals = {
    sideChat: api.sideChat, createSideChat: api.createSideChat,
    session: api.session, getSessionEventPage: api.getSessionEventPage,
  };
  const ended = { ...child, status: "stopped" } as SessionView;
  const replacement = { ...child, id: "side-session-fresh", status: "idle" } as SessionView;
  const inserted: string[] = [];
  let related: SideChatView = { ...relation, session: ended };
  api.sideChat = async () => ({ sideChat: related });
  api.createSideChat = async (_id: string, replaceEnded = false) => {
    if (replaceEnded) related = { parentSessionId: parent.id, session: replacement, createdAt: 3 };
    return related;
  };
  api.session = async () => ({ session: related.session });
  api.getSessionEventPage = async (id: string) => ({
    events: id === ended.id ? [responseEvent] : [], eventEpoch: 0, nextAfter: 1, cacheComplete: true,
  });

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const button = (label: string) => Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === label) as HTMLButtonElement | undefined;
  try {
    await act(async () => {
      root.render(mount(<SideChatPanel session={parent} runnerOnline
        onInsertDraft={(text) => inserted.push(text)} />, []));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.match(container.textContent ?? "", /Selected side-chat answer/, "the retired transcript is loaded");
    assert.ok(button("Insert Latest Response into Primary Draft"));

    await act(async () => {
      button("Start a New Side Chat")!.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    assert.match(container.textContent ?? "", /idle · separate worktree and transcript/);
    assert.doesNotMatch(container.textContent ?? "", /Selected side-chat answer/,
      "the fresh child does not inherit the retired child's transcript");
    assert.equal(button("Insert Latest Response into Primary Draft"), undefined,
      "nor its route back into the primary composer");
    assert.deepEqual(inserted, []);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, originals);
    container.remove();
  }
});

/**
 * Shared set-up for the late-send cases (#1284): a live side chat whose prompt stays pending until
 * the test releases it, and a way to mount the panel again in a fresh root — which is what a right
 * panel mode switch there and back does to it.
 */
function lateSendHarness() {
  const originals = {
    sideChat: api.sideChat,
    session: api.session,
    getSessionEventPage: api.getSessionEventPage,
    prompt: api.prompt,
  };
  const prompted: string[] = [];
  let release: (() => void) | undefined;
  api.sideChat = async () => ({ sideChat: relation });
  api.session = async () => ({ session: child });
  api.getSessionEventPage = async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true });
  api.prompt = (_id: string, text: string) => {
    prompted.push(text);
    return new Promise<SessionView>((resolve) => { release = () => resolve(child); });
  };
  const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];
  const open = async () => {
    const happyContainer = domWindow.document.createElement("div");
    domWindow.document.body.append(happyContainer);
    const container = happyContainer as unknown as HTMLDivElement;
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
      root.render(mount(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, []));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement;
    const sendButton = () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Send" || button.textContent === "Sending…") as HTMLButtonElement;
    const close = async () => { await act(async () => { root.unmount(); }); container.remove(); };
    return { textarea, sendButton, close };
  };
  const resolveSend = async () => {
    await act(async () => {
      release!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const restore = async () => {
    for (const { root, container } of mounted) {
      await act(async () => { root.unmount(); });
      container.remove();
    }
    Object.assign(api, originals);
  };
  return { open, resolveSend, restore, prompted };
}

test("a send that lands after the panel was switched away and back empties the remounted composer", async () => {
  const harness = lateSendHarness();
  try {
    const first = await harness.open();
    await act(async () => {
      first.textarea().value = "sent while switching away";
      fireDomEvent.change(first.textarea());
    });
    await act(async () => { first.sendButton().click(); });
    assert.deepEqual(harness.prompted, ["sent while switching away"]);

    // The user switches right panel mode, and back, before the control plane answers.
    await first.close();
    const second = await harness.open();
    assert.equal(second.textarea().value, "sent while switching away",
      "the draft is still preserved while its send has not landed");
    assert.equal(second.sendButton().disabled, true, "the remounted panel does not offer a duplicate send");
    assert.equal(second.sendButton().textContent, "Sending…");

    await harness.resolveSend();
    assert.equal(second.textarea().value, "", "sent text is not left in the remounted composer");
    assert.equal(harness.prompted.length, 1);

    // A reload after that send must not bring the text back from the persisted record either.
    await second.close();
    dropPanelScratchMemory();
    assert.equal(readPanelScratch(panelScratchScopeKey(parent.id), "sidechat.draft"), undefined);
    const reloaded = await harness.open();
    assert.equal(reloaded.textarea().value, "", "a reload does not restore text that was sent");
  } finally {
    await harness.restore();
  }
});

test("a late send never clears what the user typed into the remounted composer", async () => {
  const harness = lateSendHarness();
  try {
    const first = await harness.open();
    await act(async () => {
      first.textarea().value = "first message";
      fireDomEvent.change(first.textarea());
    });
    await act(async () => { first.sendButton().click(); });
    await first.close();

    const second = await harness.open();
    await act(async () => {
      second.textarea().value = "a follow-up written while it was sending";
      fireDomEvent.change(second.textarea());
    });
    await harness.resolveSend();
    assert.equal(second.textarea().value, "a follow-up written while it was sending");
    assert.equal(second.sendButton().disabled, false, "the send settled, so the new draft can go");

    await second.close();
    dropPanelScratchMemory();
    const reloaded = await harness.open();
    assert.equal(reloaded.textarea().value, "a follow-up written while it was sending",
      "the unsent follow-up still survives a reload");
  } finally {
    await harness.restore();
  }
});
