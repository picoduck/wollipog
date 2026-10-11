import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { LazySessionBoundary } from "./LazySessionBoundary.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node,
  Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, FocusEvent: domWindow.FocusEvent,
  React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const priorConsoleError = console.error;
afterEach(() => { console.error = priorConsoleError; });

function Reader({ broken }: { broken: boolean }) {
  if (broken) throw new Error("Synthetic reader download failure");
  return <button>Reader Control</button>;
}

function Surface({ broken, preview, mobile, onBack }: {
  broken: boolean; preview: boolean; mobile: boolean; onBack: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  return <>
    {(preview || mobile) && <h1 id="page-title" tabIndex={-1}>{preview ? "Sessions" : "Session"}</h1>}
    <button>List Control</button>
    <div ref={containerRef}>
      <LazySessionBoundary sessionId="synthetic-1" preview={preview} isMobile={mobile}
        onBack={onBack} containerRef={containerRef}>
        <Reader broken={broken} />
      </LazySessionBoundary>
    </div>
  </>;
}

for (const [label, preview, mobile] of [
  ["preview", true, false], ["desktop", false, false], ["phone", false, true],
] as const) {
  test(`a failed ${label} reader keeps its single heading and surrounding controls`, async () => {
    console.error = () => {};
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let backCalls = 0;
    try {
      await act(async () => root.render(<Surface broken preview={preview} mobile={mobile} onBack={() => backCalls++} />));
      assert.equal(container.querySelectorAll("#page-title").length, 1);
      assert.equal(container.querySelector("[role=alert]")?.textContent?.includes("This Session Couldn't Be Shown"), true);
      const buttons = [...container.querySelectorAll("button")];
      assert.ok(buttons.some((button) => button.textContent === "List Control"));
      assert.ok(buttons.some((button) => button.textContent === "Reload Page"));
      assert.ok(buttons.some((button) => button.textContent === "Copy Error Details"));
      const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back to Sessions"]');
      assert.equal(Boolean(back), !preview && !mobile);
      if (back) {
        await act(async () => back.click());
        assert.equal(backCalls, 1);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

for (const focusedControl of ["Reader Control", "List Control"] as const) {
  test(`reader containment rescues removed focus without taking focus from ${focusedControl}`, async () => {
    console.error = () => {};
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Surface broken={false} preview mobile={false} onBack={() => {}} />));
      const focused = [...container.querySelectorAll("button")].find((button) => button.textContent === focusedControl)!;
      focused.focus();
      await act(async () => root.render(<Surface broken preview mobile={false} onBack={() => {}} />));
      assert.equal(document.activeElement, focusedControl === "Reader Control" ? container.querySelector(".detail-scroll") : focused);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
