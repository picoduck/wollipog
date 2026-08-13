import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  usePreviewNavigationRegistration,
  type PreviewNavigationControls,
} from "./usePreviewNavigationRegistration.js";

const domWindow = new Window({ url: "http://localhost/inbox" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("preview navigation registration follows mode and session lifecycle", async () => {
  const registrations: Array<PreviewNavigationControls | null> = [];
  const previews: string[] = [];
  const follows: string[] = [];
  const register = (controls: PreviewNavigationControls | null) => registrations.push(controls);
  function Harness({ mode, sessionId }: { mode: "preview" | "expanded"; sessionId: string }) {
    const preview = useCallback((direction: "next" | "previous") => previews.push(`${sessionId}:${direction}`), [sessionId]);
    const follow = useCallback(() => follows.push(sessionId), [sessionId]);
    const controls = React.useMemo(() => ({ beginProgrammaticScroll: preview, follow }), [follow, preview]);
    usePreviewNavigationRegistration(mode, register, controls);
    return <div data-mode={mode} data-session-id={sessionId} />;
  }

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<Harness mode="preview" sessionId="alpha" />); });
  const alpha = registrations.at(-1);
  assert.equal(typeof alpha?.beginProgrammaticScroll, "function");
  assert.equal(typeof alpha?.follow, "function");

  await act(async () => { root.render(<Harness mode="expanded" sessionId="alpha" />); });
  assert.equal(registrations.at(-1), null, "expanding unregisters Inbox preview paging");

  await act(async () => { root.render(<Harness mode="preview" sessionId="alpha" />); });
  assert.equal(Object.is(registrations.at(-1), alpha), true, "collapsing re-registers the same session preview");

  await act(async () => { root.render(<Harness mode="preview" sessionId="beta" />); });
  assert.equal(registrations.at(-2), null, "a session swap clears the departing registration first");
  const beta = registrations.at(-1);
  assert.equal(typeof beta?.beginProgrammaticScroll, "function");
  assert.notEqual(beta, alpha);
  alpha?.beginProgrammaticScroll("previous");
  beta?.beginProgrammaticScroll("next");
  alpha?.follow();
  beta?.follow();
  assert.deepEqual(previews, ["alpha:previous", "beta:next"]);
  assert.deepEqual(follows, ["alpha", "beta"]);

  await act(async () => { root.unmount(); });
  assert.equal(registrations.at(-1), null, "unmount clears the active preview callback");
  container.remove();
});
