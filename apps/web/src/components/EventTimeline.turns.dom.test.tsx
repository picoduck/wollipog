import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { EventTimeline } from "./EventTimeline.js";

// happy-dom has no layout. Each virtual row reports a fixed content height plus its own bottom
// padding, as a browser's border box does, so the list's committed row positions are exactly the
// rhythm the transcript asks for.
const domWindow = new Window({ url: "http://localhost/" });
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: NoopResizeObserver,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
Object.defineProperty(domWindow, "ResizeObserver", { configurable: true, writable: true, value: NoopResizeObserver });

const { cleanup } = installDomTestCleanup(domWindow);

const CONTENT_HEIGHT = 40;
const READER_HEIGHT = 4_000;
const isRow = (element: Element) => element.hasAttribute("data-virtual-row");
const rowHeight = (row: HTMLElement) => CONTENT_HEIGHT + (Number.parseFloat(row.style.paddingBottom) || 0);
const rowTop = (row: HTMLElement) => Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1] ?? 0);

const elementPrototype = domWindow.HTMLElement.prototype as unknown as HTMLElement;
Object.defineProperty(elementPrototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) { return isRow(this) ? rowHeight(this) : READER_HEIGHT; },
});
Object.defineProperty(elementPrototype, "offsetWidth", { configurable: true, get: () => 800 });
elementPrototype.getBoundingClientRect = function (this: HTMLElement) {
  const height = isRow(this) ? rowHeight(this) : READER_HEIGHT;
  return { top: 0, left: 0, right: 800, bottom: height, width: 800, height, x: 0, y: 0, toJSON() {} } as DOMRect;
};

const at = (minute: number, second = 0) => Date.UTC(2026, 9, 2, 9, minute, second);
const turn = (base: number, number: number): TimelineItem[] => [
  { kind: "user_message", id: base, text: `Prompt ${number}`, createdAt: at(number * 5) },
  { kind: "checkpoint", id: base + 1, turn: number },
  { kind: "agent_message", id: base + 2, text: `Looking at turn ${number}.`, createdAt: at(number * 5, 2) },
  { kind: "agent_message", id: base + 3, text: `Turn ${number} is done.`, createdAt: at(number * 5, 20), lastActivityAt: at(number * 5, 26) },
  { kind: "conversation_checkpoint", id: base + 4, turn: number },
];
const threeTurns: TimelineItem[] = [...turn(10, 1), ...turn(20, 2), ...turn(30, 3)];

function Reader({ items, sessionActive }: { items: TimelineItem[]; sessionActive: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="detail-scroll" style={{ height: READER_HEIGHT, overflow: "auto" }}>
      <EventTimeline items={items} sessionActive={sessionActive} scrollRef={scrollRef} historyKey="turns" />
    </div>
  );
}

async function mount(items: TimelineItem[], sessionActive: boolean) {
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<Reader items={items} sessionActive={sessionActive} />));
  // Measurement settles over a commit or two; let it.
  await act(async () => root.render(<Reader items={items} sessionActive={sessionActive} />));
  const rows = [...container.querySelectorAll<HTMLElement>("[data-virtual-row]")]
    .sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index));
  cleanup(() => act(async () => root.unmount()));
  return { container, rows };
}

test("rows inside a turn are 12px apart and each new turn opens 32px below the previous footer", async () => {
  const { container, rows } = await mount(threeTurns, false);
  assert.equal(rows.length, 9, "three prompts and six answers; checkpoints render no row");
  assert.doesNotMatch(container.textContent ?? "", /Start Turn|End Turn/);

  const gaps = rows.slice(1).map((row, index) => rowTop(row) - (rowTop(rows[index]!) + CONTENT_HEIGHT));
  assert.deepEqual(gaps, [12, 12, 32, 12, 12, 32, 12, 12]);

  const footers = [...container.querySelectorAll<HTMLElement>(".tl-turn-footer")];
  assert.equal(footers.length, 3, "one footer per settled turn");
  for (const [index, footer] of footers.entries()) {
    const owner = footer.closest<HTMLElement>("[data-virtual-row]")!;
    assert.equal(owner, rows[index * 3 + 2], "the footer closes its turn's last row");
    assert.equal(owner.lastElementChild, footer, "nothing in the row follows the footer");
    assert.equal(footer.querySelector(".tl-turn-label")?.textContent, `Turn ${index + 1}`);
    assert.match(footer.querySelector("time")?.textContent ?? "", /^\d{1,2}:\d{2}\s?[AP]M$/, "a clock time without seconds");
    assert.match(footer.querySelector("[role='tooltip']")?.textContent ?? "",
      /^Started \d{1,2}:\d{2}:00\s?[AP]M, finished \d{1,2}:\d{2}:26\s?[AP]M \(26s\)$/);
    assert.ok(footer.querySelector("[aria-label='Copy Reply']"));
  }
  for (const row of rows) {
    assert.doesNotMatch(row.textContent?.replace(/Started .*\(\d+s\)/, "") ?? "", /Recorded|Started|Last Activity|→/,
      "no message row names a time range or timestamp label");
  }
});

test("a running turn has no footer; the settled turns before it keep theirs", async () => {
  const running = [...threeTurns.slice(0, -1)];
  const { container } = await mount(running, true);
  const labels = [...container.querySelectorAll(".tl-turn-footer .tl-turn-label")].map((label) => label.textContent);
  assert.deepEqual(labels, ["Turn 1", "Turn 2"]);
});
