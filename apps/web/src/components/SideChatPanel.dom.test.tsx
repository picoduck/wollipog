import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type { SessionEvent, SessionView, SideChatView } from "@wollipog/protocol";
import { api } from "../api.js";
import { SideChatPanel } from "./SideChatPanel.js";

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
      root.render(<SideChatPanel session={parent} runnerOnline onInsertDraft={(text) => inserted.push(text)} />);
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
      Simulate.change(textarea);
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
