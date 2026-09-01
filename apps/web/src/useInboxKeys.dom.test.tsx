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
      <div className="xterm"><textarea aria-label="Terminal" /></div>
      <div data-focus-zone="detail"><button type="button" aria-label="Allow Once">Allow Once</button></div>
    </div>
  );
}

test("the central Inbox layer handles bare keys but never steals typing or terminal input", async () => {
  const calls: Array<keyof InboxKeyActions> = [];
  let previewAvailable = true;
  const action = (name: keyof InboxKeyActions) => () => calls.push(name);
  const actions: InboxKeyActions = {
    next: action("next"), previous: action("previous"), expand: action("expand"),
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
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "f", bubbles: true }));
  assert.deepEqual(calls, ["next", "nextSplit", "pageUp", "resumeFollow", "resumeFollow", "fork"]);

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
  assert.deepEqual(calls, ["next", "nextSplit", "pageUp", "resumeFollow", "resumeFollow", "fork"],
    "typing contexts and native controls own their keys before the Inbox layer");

  previewAvailable = false;
  list.focus();
  const unownedEnd = new domWindow.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
  domWindow.dispatchEvent(unownedEnd);
  assert.equal(unownedEnd.defaultPrevented, false,
    "End retains its native list behavior when no preview navigation surface is registered");
  assert.deepEqual(calls, ["next", "nextSplit", "pageUp", "resumeFollow", "resumeFollow", "fork"]);

  domWindow.document.body.focus();
  domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "f", bubbles: true }));
  assert.equal(calls.filter((call) => call === "fork").length, 1,
    "Fork is scoped to the Inbox list and detail zones");

  await act(async () => { root.unmount(); });
  container.remove();
});
