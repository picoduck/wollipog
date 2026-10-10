import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { useBodyWidth } from "./useBodyWidth.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const window = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({ window, document: window.document,
  navigator: window.navigator, HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const observers: Observer[] = [];
class Observer {
  target: Element | null = null;
  constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
  observe(target: Element) { this.target = target; }
  disconnect() { this.target = null; }
  deliver(width: number) {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true, value: () => ({ width: 980 }),
});

function Body({ report, replacement = false }: { report?: (width: number) => void; replacement?: boolean }) {
  const ref = useBodyWidth(report);
  return <div key={String(replacement)} ref={ref} data-body />;
}

test("body width reports in layout, follows the latest callback, and disconnects on replacement and StrictMode unmount", async () => {
  const container = window.document.createElement("div") as unknown as HTMLDivElement;
  window.document.body.append(container as never);
  const root = createRoot(container);
  const first: number[] = [];
  const next: number[] = [];
  const reportFirst = (width: number) => first.push(width);
  const reportNext = (width: number) => next.push(width);
  try {
    await act(async () => root.render(<React.StrictMode><Body report={reportFirst} /></React.StrictMode>));
    assert.equal(first.at(-1), 980, "initial positive width is available after layout");
    assert.equal(observers.filter(observer => observer.target).length, 1, "StrictMode leaves one active observer");
    const initial = observers.find(observer => observer.target)!;
    await act(async () => initial.deliver(1_040));
    assert.equal(first.at(-1), 1_040, "resize delivery drives the summary threshold");
    await act(async () => initial.deliver(0));
    assert.equal(first.at(-1), 1_040, "a hidden body does not replace its usable width");

    await act(async () => root.render(<React.StrictMode><Body report={reportNext} /></React.StrictMode>));
    assertNoDomNode(initial.target, "the old reporter's observer is disconnected");
    assert.equal(next.at(-1), 980, "a changed reporter immediately receives current layout");
    const second = observers.find(observer => observer.target)!;
    await act(async () => second.deliver(1_100));
    assert.equal(next.at(-1), 1_100);
    assert.equal(first.at(-1), 1_040, "the previous reporter receives no later delivery");

    const oldBody = second.target;
    await act(async () => root.render(<React.StrictMode><Body report={reportNext} replacement /></React.StrictMode>));
    assertNoDomNode(second.target, "a detached element is released synchronously");
    assert.equal(observers.filter(observer => observer.target).length, 1);
    assert.ok(observers.find(observer => observer.target)!.target !== oldBody);
    await act(async () => root.render(<React.StrictMode><Body replacement /></React.StrictMode>));
    assert.equal(observers.filter(observer => observer.target).length, 0, "no summary means no width observer");
    await act(async () => root.render(<React.StrictMode><Body report={reportNext} replacement /></React.StrictMode>));
    assert.equal(next.at(-1), 980, "enabling the summary reports the body already mounted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    assert.equal(observers.filter(observer => observer.target).length, 0, "unmount releases every observed body");
  }
});
