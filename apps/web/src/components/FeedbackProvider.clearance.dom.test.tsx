import assert from "node:assert/strict";
import test from "node:test";
import React, { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackProvider, useFeedback } from "./FeedbackProvider.js";
import { toastChromeElements, useToastChrome } from "./useToastChrome.js";

const dom = new Window({ url: "http://localhost/", width: 390, height: 900 });
let mutationObservers = 0;
const resizes: FakeResizeObserver[] = [];
class FakeResizeObserver {
  readonly elements = new Set<Element>();
  constructor(readonly callback: () => void) { resizes.push(this); }
  observe(element: Element) { this.elements.add(element); }
  disconnect() { this.elements.clear(); }
}
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement, Node: dom.Node, Event: dom.Event,
  ResizeObserver: FakeResizeObserver,
  MutationObserver: class extends dom.MutationObserver { constructor(callback: MutationCallback) { super(callback as never); mutationObservers++; } },
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const { cleanup } = installDomTestCleanup(dom);
const doc = dom.document as unknown as Document;
let measurements = 0;
let composerHeight = 100;
const rect = (top: number, bottom: number, left = 0, right = 390) => ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
dom.HTMLElement.prototype.getBoundingClientRect = function () {
  measurements++;
  if (this.id === "root") return rect(0, 900) as never;
  if (this.classList.contains("app-rail")) return rect(850, 900) as never;
  if (this.classList.contains("composer")) return rect(850 - composerHeight, 850) as never;
  if (this.classList.contains("modal-foot")) return rect(600, 650) as never;
  return rect(0, 0) as never;
};
function Chrome({ kind }: { kind: string }) {
  const ref = useToastChrome<HTMLDivElement>();
  return <div ref={ref} className={kind} />;
}
let controls: { toast(): void; chrome(show: boolean): void; footer(show: boolean): void };
function Harness() {
  const { showToast } = useFeedback();
  const [chrome, setChrome] = useState(true);
  const [footer, setFooter] = useState(false);
  controls = { toast: () => { showToast("Saved.", { durationMs: 0 }); }, chrome: setChrome, footer: setFooter };
  return <>{chrome && <><Chrome kind="app-rail" /><Chrome kind="composer" /></>}{footer && <Chrome kind="modal-foot" />}<div id="transcript" /></>;
}
const settle = async () => { await act(async () => { await new Promise<void>((resolve) => dom.requestAnimationFrame(() => resolve())); }); };

test("toast clearance follows explicit chrome mounts, removal and resize, ignoring 100 transcript mutations (#2779)", async () => {
  const host = doc.createElement("div");
  host.id = "root";
  doc.body.append(host);
  const root = createRoot(host);
  cleanup(async () => { await act(async () => { root.unmount(); }); host.remove(); });
  await act(async () => { root.render(<StrictMode><FeedbackProvider><Harness /></FeedbackProvider></StrictMode>); });
  await act(async () => { controls.toast(); });
  await settle();
  const clearance = () => doc.documentElement.style.getPropertyValue("--toast-clear");
  assert.equal(clearance(), "150px", "composer stacks on the phone rail");
  const before = measurements;
  for (let index = 0; index < 100; index++) doc.getElementById("transcript")!.append(doc.createElement("p"));
  await settle();
  assert.equal(measurements - before, 0, "streaming rows cause zero clearance measurements");
  assert.equal(mutationObservers, 0, "no body-wide observer exists");
  assert.ok(resizes.at(-1)!.elements.has(doc.querySelector(".composer")!));

  composerHeight = 180;
  resizes.at(-1)!.callback();
  await settle();
  assert.equal(clearance(), "230px", "growing composer stays clear");
  await act(async () => { controls.footer(true); });
  await settle();
  assert.equal(clearance(), "300px", "floating dialog footer is clear too");
  await act(async () => { controls.footer(false); });
  await settle();
  assert.equal(clearance(), "230px", "footer removal releases its clearance");
  await act(async () => { controls.chrome(false); });
  await settle();
  assert.equal(clearance(), "0px", "route change releases docked chrome");
  assert.equal(toastChromeElements(doc).length, 0, "Strict Mode and unmount leave no registered elements");
});
