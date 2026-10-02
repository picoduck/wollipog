import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { TranscriptTailControl, type TranscriptTailView } from "./TranscriptTailControl.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  FocusEvent: domWindow.FocusEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function mount() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const elsewhere = domWindow.document.createElement("button") as unknown as HTMLButtonElement;
  domWindow.document.body.append(container as never, elsewhere as never);
  const root = createRoot(container);
  let lost = 0;
  const render = (view: TranscriptTailView) => act(async () => root.render(
    <TranscriptTailControl
      view={view}
      shortcut="End"
      onJump={() => {}}
      onShowNotSent={() => {}}
      onFocusLost={() => { lost += 1; }}
    />,
  ));
  return {
    container,
    elsewhere,
    render,
    lost: () => lost,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      elsewhere.remove();
    },
  };
}

test("focus on the control is handed back when recovery replaces it or the tail takes it away", async () => {
  const fixture = mount();
  try {
    await fixture.render({ kind: "jump", newRows: 0 });
    const jump = fixture.container.querySelector("button")!;
    await act(async () => jump.focus());

    await fixture.render({ kind: "jump", newRows: 3 });
    assert.equal(fixture.lost(), 0, "a relabelled control keeps its focus");
    assert.equal(domWindow.document.activeElement, jump);

    await fixture.render({ kind: "recovering" });
    assert.equal(fixture.lost(), 1, "recovery replacing the focused control hands focus to the reader");

    await fixture.render({ kind: "jump", newRows: 0 });
    await act(async () => fixture.container.querySelector("button")!.focus());
    await fixture.render(null);
    assert.equal(fixture.lost(), 2, "jumping to the tail removes the focused control");
  } finally {
    await fixture.unmount();
  }
});

test("focus the person moved elsewhere is never taken back", async () => {
  const fixture = mount();
  try {
    await fixture.render({ kind: "jump", newRows: 0 });
    await act(async () => fixture.container.querySelector("button")!.focus());
    await act(async () => fixture.elsewhere.focus());
    await fixture.render(null);
    assert.equal(fixture.lost(), 0);
    assert.equal(domWindow.document.activeElement, fixture.elsewhere);

    await fixture.render({ kind: "jump", newRows: 0 });
    await act(async () => fixture.container.querySelector("button")!.focus());
    await act(async () => (domWindow.document.activeElement as unknown as HTMLElement).blur());
    await fixture.render({ kind: "recovering" });
    assert.equal(fixture.lost(), 0, "a click on the page leaves focus on the page");
  } finally {
    await fixture.unmount();
  }
});
