import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { EventTimeline } from "./EventTimeline.js";

// happy-dom has no layout. A row with content reports 40px plus its own bottom padding, as a
// browser's border box does; an empty row (a turn's artifact past its View All) reports only its
// padding. The reader is short, so most of a long turn's rows are never mounted or measured.
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
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MutationObserver: domWindow.MutationObserver,
  IntersectionObserver: undefined,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: NoopResizeObserver,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
Object.defineProperty(domWindow, "ResizeObserver", { configurable: true, writable: true, value: NoopResizeObserver });

const { cleanup } = installDomTestCleanup(domWindow);

const CONTENT_HEIGHT = 40;
const READER_HEIGHT = 400;
const isRow = (element: Element) => element.hasAttribute("data-virtual-row");
const rowHeight = (row: HTMLElement) =>
  (row.childElementCount > 0 ? CONTENT_HEIGHT : 0) + (Number.parseFloat(row.style.paddingBottom) || 0);
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

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 2]);
const shot = (id: string): WorkflowArtifactView => ({
  artifactId: id, sessionId: "session_1", kind: "screenshot", name: `${id}.png`, mimeType: "image/png",
  encoding: "base64", sizeBytes: PNG.byteLength, sha256: createHash("sha256").update(PNG).digest("hex"),
  createdBy: { kind: "agent", id: "session_1" }, createdAt: 1,
});

function Reader({ items }: { items: TimelineItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="detail-scroll" style={{ height: READER_HEIGHT, overflow: "auto" }}>
      <EventTimeline items={items} sessionActive={false} scrollRef={scrollRef} historyKey="artifacts" />
    </div>
  );
}

test("a turn's artifacts past its View All take no room in the virtual list, mounted or not", async () => {
  const priorExport = api.artifactExport;
  api.artifactExport = async () => new Blob([PNG], { type: "image/png" });
  cleanup(() => { api.artifactExport = priorExport; });
  // Sixty replies first, so the reader at the top never mounts the long turn below them.
  const EARLIER = 60;
  const transcript = (attachments: number): TimelineItem[] => {
    let id = 0;
    return [
      { kind: "user_message", id: ++id, text: "Start.", createdAt: id },
      ...Array.from({ length: EARLIER }, (): TimelineItem =>
        ({ kind: "agent_message", id: ++id, text: `Reply ${id}.`, createdAt: id })),
      { kind: "user_message", id: ++id, text: "Capture everything.", createdAt: id },
      ...Array.from({ length: attachments }, (_, index): TimelineItem =>
        ({ kind: "artifact_attached", id: ++id, artifact: shot(`shot-${index + 1}`), createdAt: id })),
      // The turn closes on a reply, so its footer is that reply's in both transcripts.
      { kind: "agent_message", id: ++id, text: "All attached.", createdAt: id },
      { kind: "user_message", id: ++id, text: "Thanks.", createdAt: id },
      { kind: "agent_message", id: ++id, text: "Done.", createdAt: id },
    ];
  };
  const listHeight = async (items: TimelineItem[]) => {
    const container = domWindow.document.createElement("div") as unknown as HTMLElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    for (let pass = 0; pass < 3; pass++) {
      await act(async () => {
        root.render(<Reader items={items} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const list = container.querySelector<HTMLElement>("[data-virtual-kind='timeline']")!;
    assert.equal(list.dataset.virtualTotal, String(items.length), "every row is still an item of the list");
    assert.ok(container.querySelectorAll("[data-virtual-key^='item:artifact_attached']").length === 0,
      "the long turn is below the mounted range");
    const height = Number.parseFloat(list.style.height);
    await act(async () => root.unmount());
    container.remove();
    return height;
  };
  // Four attachments draw exactly what a hundred do: three previews and View All. The 96 rows
  // past it add nothing, though none of them is ever mounted or measured.
  const drawnOnly = await listHeight(transcript(4));
  const hundred = await listHeight(transcript(100));
  assert.equal(hundred, drawnOnly, "a hidden row is given no room in the list's height");
});
