import assert from "node:assert/strict";
import test from "node:test";
import React, { act, memo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { useStableCallbacks } from "./stable-callbacks.js";

/**
 * A memoized child handed `useStableCallbacks` props renders only for a change to a value, not for
 * the parent's new closures, and its callbacks still reach the latest ones (#2872).
 */

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

interface ChildProps {
  label: string;
  onPick: (value: string) => string;
  onExtra?: () => string;
}

let childRenders = 0;
let lastChild: ChildProps | null = null;
const Child = memo(function Child(props: ChildProps) {
  childRenders += 1;
  lastChild = props;
  return <output>{props.label}</output>;
});

let rerender: (next: { label: string; tick: number; extra: boolean }) => void = () => {};
/** Runs inside the parent's render, before that render commits. */
let duringRender: (() => void) | null = null;

function Parent() {
  const [state, setState] = useState({ label: "One", tick: 0, extra: false });
  rerender = setState;
  const props = useStableCallbacks<ChildProps>({
    label: state.label,
    // A new closure on every render, reading this render's tick.
    onPick: (value) => `${value}:${state.tick}`,
    ...(state.extra ? { onExtra: () => `extra:${state.tick}` } : {}),
  });
  // After this render made its callbacks, before it commits.
  duringRender?.();
  return <Child {...props} />;
}

test("new closures alone do not render the memoized child, and its callbacks call the latest", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Parent />));
    const firstPick = lastChild!.onPick;
    const before = childRenders;

    await act(async () => rerender({ label: "One", tick: 1, extra: false }));
    assert.equal(childRenders, before, "the parent's new closure does not render the child");
    assert.equal(lastChild!.onPick("a"), "a:1", "the child's callback calls the parent's latest one");
    assert.equal(lastChild!.onPick, firstPick, "and keeps its identity");

    await act(async () => rerender({ label: "Two", tick: 2, extra: false }));
    assert.equal(childRenders, before + 1, "a changed value renders the child");
    assert.equal(container.querySelector("output")?.textContent, "Two");
    assert.equal(lastChild!.onPick, firstPick);
    assert.equal(lastChild!.onExtra, undefined, "an absent callback stays absent");

    await act(async () => rerender({ label: "Two", tick: 3, extra: true }));
    assert.equal(childRenders, before + 2, "a callback that appears renders the child");
    assert.equal(typeof lastChild!.onExtra, "function");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a render that has not committed does not reach the child's callbacks, and a dropped one keeps its last", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Parent />));
    await act(async () => rerender({ label: "One", tick: 1, extra: true }));
    const held = lastChild!;
    const seenDuringRender: string[] = [];
    duringRender = () => { seenDuringRender.push(held.onPick("a")); };
    await act(async () => rerender({ label: "One", tick: 2, extra: true }));
    duringRender = null;
    assert.equal(seenDuringRender[0], "a:1", "while the next render is under way, the committed callback answers");
    assert.equal(held.onPick("a"), "a:2", "once it commits, the new one does");

    await act(async () => rerender({ label: "Three", tick: 3, extra: false }));
    assert.equal(lastChild!.onExtra, undefined);
    assert.equal(held.onExtra!(), "extra:2", "a callback the parent dropped still calls the last one it stood for");
  } finally {
    duringRender = null;
    await act(async () => root.unmount());
    container.remove();
  }
});
