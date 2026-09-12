import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { useInboxKeys, type InboxKeyActions } from "./useInboxKeys.js";

const domWindow = new Window({ url: "http://localhost/inbox" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function Harness({ actions }: { actions: InboxKeyActions }) {
  useInboxKeys(true, actions);
  return (
    <div>
      <div className="inbox-list" data-focus-zone="list" role="grid" tabIndex={0}>List</div>
      <textarea aria-label="Composer" />
      <details><summary>Requests</summary><button type="button">Open Request</button></details>
      <div className="xterm"><textarea aria-label="Terminal" /></div>
      <div data-focus-zone="detail">
        <div className="detail-scroll" tabIndex={0}>Preview</div>
        <button type="button" aria-label="Allow Once">Allow Once</button>
      </div>
    </div>
  );
}

test("the central Inbox layer handles bare keys but never steals typing or terminal input", async () => {
  const calls: Array<keyof InboxKeyActions> = [];
  let previewAvailable = true;
  const action = (name: keyof InboxKeyActions) => () => calls.push(name);
  const actions: InboxKeyActions = {
    next: action("next"), previous: action("previous"), first: action("first"), last: action("last"), expand: action("expand"),
    openTopRequest: action("openTopRequest"), toggleThread: action("toggleThread"),
    toggleAllThreads: action("toggleAllThreads"), goToParent: action("goToParent"),
    expandThread: action("expandThread"), collapseThread: action("collapseThread"),
    fork: action("fork"),
    nextSplit: action("nextSplit"), previousSplit: action("previousSplit"),
    approve: action("approve"), deny: action("deny"), archive: action("archive"),
    snooze: action("snooze"),
    pin: action("pin"), unread: action("unread"), reply: action("reply"),
    pageDown: action("pageDown"), pageUp: action("pageUp"), resumeFollow: () => {
      if (!previewAvailable) return false;
      calls.push("resumeFollow");
      return true;
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<Harness actions={actions} />); });

  const list = container.querySelector<HTMLElement>(".inbox-list")!;
  list.focus();
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "j", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "G", shiftKey: true, bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "f", bubbles: true }));
  assert.deepEqual(calls, ["next", "nextSplit", "pageUp", "resumeFollow", "last", "first", "next", "previous", "fork"]);
  // Threads (#896): t, Shift+T, p, and the arrow pair, plus F2 for the top request.
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "t", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "T", shiftKey: true, bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "p", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  assert.deepEqual(calls.slice(9), ["toggleThread", "toggleAllThreads", "goToParent", "expandThread", "collapseThread", "openTopRequest"]);
  calls.length = 9;

  const composer = container.querySelector<HTMLTextAreaElement>('[aria-label="Composer"]')!;
  composer.focus();
  for (const key of ["j", "j", "j", "e", " ", "f"]) {
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }));
  }
  const terminal = container.querySelector<HTMLTextAreaElement>('[aria-label="Terminal"]')!;
  terminal.focus();
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "k", bubbles: true }));
  const approval = container.querySelector<HTMLButtonElement>('[aria-label="Allow Once"]')!;
  approval.focus();
  for (const key of ["Enter", " ", "Tab", "a", "d"]) {
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }));
  }
  assert.deepEqual(calls, ["next", "nextSplit", "pageUp", "resumeFollow", "last", "first", "next", "previous", "fork"],
    "typing contexts and native controls own their keys before the Inbox layer");

  container.querySelector<HTMLElement>("summary")!.focus();
  for (const key of ["Enter", " ", "Tab", "a", "d", "j"]) {
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }));
  }
  assert.deepEqual(calls, ["next", "nextSplit", "pageUp", "resumeFollow", "last", "first", "next", "previous", "fork"],
    "request disclosure summaries own their keys without running any row actions");

  const detail = container.querySelector<HTMLElement>(".detail-scroll")!;
  detail.focus();
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.equal(calls.at(-1), "resumeFollow", "End keeps its preview-follow behavior in the detail zone");

  previewAvailable = false;
  detail.focus();
  const unownedEnd = new domWindow.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
  domWindow.dispatchEvent(unownedEnd);
  assert.equal(unownedEnd.defaultPrevented, false,
    "End retains its native detail behavior when no preview navigation surface is registered");
  assert.equal(calls.at(-1), "resumeFollow");

  domWindow.document.body.focus();
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "f", bubbles: true }));
  assert.equal(calls.filter((call) => call === "fork").length, 1,
    "Fork is scoped to the Inbox list and detail zones");

  await act(async () => { root.unmount(); });
  container.remove();
});
