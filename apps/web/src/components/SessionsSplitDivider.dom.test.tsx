import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { INBOX_SPLIT_RATIO_DEFAULT } from "../inbox.js";
import { sessionsListRowsForRatio, type SessionsSplitGeometry } from "../sessions-split.js";
import { SessionsSplitDivider } from "./SessionsSplitDivider.js";

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

/** 1440×900: 800px under the page header, 56px rows and an 8px pad, so 3 to 9 rows. */
const GEOMETRY: SessionsSplitGeometry = { area: 800, rowHeight: 56, pad: 8 };

test("the divider names itself, reports percent, and moves by whole rows from the keyboard (#2217)", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const grid = createRef<HTMLDivElement>();
  const stored: number[] = [];
  const render = (rows: number) => root.render(
    <div ref={grid}>
      <SessionsSplitDivider grid={grid} geometry={GEOMETRY} rows={rows} onRatioChange={(ratio) => stored.push(ratio)} />
    </div>,
  );
  await act(async () => { render(6); });

  const divider = container.querySelector<HTMLElement>('[role="separator"]')!;
  assert.equal(divider.getAttribute("aria-label"), "Resize List and Preview");
  assert.equal(divider.getAttribute("aria-orientation"), "horizontal");
  assert.equal(divider.tabIndex, 0, "a Tab stop between the list and the preview bar");
  // Six rows are 344px of 800: 43%; three are 22% and nine 64%.
  assert.deepEqual(["aria-valuenow", "aria-valuemin", "aria-valuemax"].map((name) => divider.getAttribute(name)), ["43", "22", "64"]);

  const press = (key: string, init: { shiftKey?: boolean } = {}) => {
    const event = new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    act(() => { divider.dispatchEvent(event as never); });
    return event.defaultPrevented;
  };
  const rowsStored = () => stored.map((ratio) => sessionsListRowsForRatio(ratio, GEOMETRY));
  assert.equal(press("ArrowUp"), true);
  assert.equal(press("ArrowDown"), true);
  assert.equal(press("Home"), true);
  assert.equal(press("End"), true);
  assert.deepEqual(rowsStored(), [5, 7, 3, 9]);
  assert.equal(press("Enter"), true);
  assert.equal(stored.at(-1), INBOX_SPLIT_RATIO_DEFAULT);
  stored.length = 0;
  assert.equal(press("ArrowUp", { shiftKey: true }), false, "a modified arrow is not a resize");
  assert.equal(press("j"), false, "other keys belong to the list");
  assert.deepEqual(stored, []);

  // At either end of the range a key keeps the list where it is.
  await act(async () => { render(3); });
  press("ArrowUp");
  await act(async () => { render(9); });
  press("ArrowDown");
  assert.deepEqual(rowsStored(), [3, 9]);

  act(() => { divider.dispatchEvent(new domWindow.MouseEvent("dblclick", { bubbles: true }) as never); });
  assert.equal(stored.at(-1), INBOX_SPLIT_RATIO_DEFAULT, "a double-click restores the default");
  await act(async () => root.unmount());
});

test("a drag the divider does not finish leaves no unsnapped height on the grid (#2710 review)", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const grid = createRef<HTMLDivElement>();
  const stored: number[] = [];
  const render = (stacked: boolean) => root.render(
    <div ref={grid}>
      {stacked && <SessionsSplitDivider grid={grid} geometry={GEOMETRY} rows={6} onRatioChange={(ratio) => stored.push(ratio)} />}
    </div>,
  );
  await act(async () => { render(true); });
  const divider = container.querySelector<HTMLElement>('[role="separator"]')!;
  const pointer = (type: string, clientY: number) => new domWindow.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, button: 0, clientY,
  });
  act(() => { divider.dispatchEvent(pointer("pointerdown", 344) as never); });
  act(() => { divider.dispatchEvent(pointer("pointermove", 370) as never); });
  assert.equal(grid.current!.style.getPropertyValue("--sessions-list-h"), "370px", "the list follows the pointer");

  // B opens the board mid-drag: the divider unmounts before any release.
  await act(async () => { render(false); });
  assert.equal(grid.current!.style.getPropertyValue("--sessions-list-h"), "", "the stacked grid returns to whole rows");
  assert.deepEqual(stored, [], "an unfinished drag stores nothing");
  await act(async () => root.unmount());
});
