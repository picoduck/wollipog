import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import type { TimelineItem } from "../timeline.js";
import { EventTimeline } from "./EventTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  // No IntersectionObserver: every image row in reach loads at once, so the test counts exactly
  // which rows ask for bytes.
  IntersectionObserver: undefined,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

function screenshot(id: string, overrides: Partial<WorkflowArtifactView> = {}): WorkflowArtifactView {
  return {
    artifactId: id,
    sessionId: "session_1",
    kind: "screenshot",
    name: `${id}.png`,
    mimeType: "image/png",
    encoding: "base64",
    sizeBytes: PNG.byteLength,
    sha256: PNG_SHA,
    createdBy: { kind: "agent", id: "session_1" },
    createdAt: 1,
    ...overrides,
  };
}

let nextId = 1;
const attached = (artifact: WorkflowArtifactView): TimelineItem =>
  ({ kind: "artifact_attached", id: nextId++, artifact, createdAt: nextId });
const prompt = (text: string): TimelineItem => ({ kind: "user_message", id: nextId++, text, createdAt: nextId });
const reply = (text: string): TimelineItem => ({ kind: "agent_message", id: nextId++, text, createdAt: nextId });

let root: Root | null = null;
let container: HTMLElement | null = null;
const exported: string[] = [];
const priorExport = api.artifactExport;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  exported.length = 0;
  api.artifactExport = priorExport;
  domWindow.document.body.innerHTML = "";
});

async function render(items: TimelineItem[], onOpenArtifact?: (artifact: WorkflowArtifactView) => void) {
  api.artifactExport = async (id: string) => {
    exported.push(id);
    return new Blob([PNG], { type: "image/png" });
  };
  if (!container) {
    container = domWindow.document.createElement("div") as unknown as HTMLElement;
    domWindow.document.body.append(container as never);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(<EventTimeline items={items} historyKey="session_1:0" onOpenArtifact={onOpenArtifact} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const previews = () => [...container!.querySelectorAll<HTMLElement>(".tl-artifact:not(.tl-artifact-more)")]
  .map((card) => card.dataset.artifactId);
const buttonNamed = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name) ?? null;
const dialog = () => domWindow.document.querySelector("[role='dialog']") as unknown as HTMLElement | null;
const position = () => dialog()?.querySelector(".art-gallery-position")?.textContent;
const press = async (key: string) => {
  const target = (domWindow.document.activeElement ?? dialog()) as unknown as HTMLElement;
  await act(async () => {
    target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event);
  });
};

test("eight artifacts in one turn show three previews and one counted View All, and only those load", async () => {
  nextId = 1;
  const turnOne = Array.from({ length: 8 }, (_, index) => screenshot(`shot-${index + 1}`));
  const items = [
    prompt("Capture every state."),
    ...turnOne.map(attached),
    reply("Here are the captures."),
    prompt("And the phone?"),
    attached(screenshot("phone-1")),
    attached(screenshot("phone-2")),
  ];
  await render(items);

  assert.deepEqual(previews(), ["shot-1", "shot-2", "shot-3", "phone-1", "phone-2"]);
  const viewAll = container!.querySelectorAll(".tl-artifact-more");
  assert.equal(viewAll.length, 1, "only the turn past its limit has a View All");
  assert.ok(buttonNamed(viewAll[0]!, "View All 8 Artifacts"), viewAll[0]!.textContent ?? "");
  assert.match(viewAll[0]!.textContent ?? "", /5 more from this turn/);
  // Media loads for what is drawn, never for the five the View All stands for.
  assert.deepEqual([...new Set(exported)].sort(), ["phone-1", "phone-2", "shot-1", "shot-2", "shot-3"]);
});

test("a repeated delivery of an artifact is not drawn or counted twice", async () => {
  nextId = 1;
  const shots = Array.from({ length: 4 }, (_, index) => screenshot(`shot-${index + 1}`));
  const items = [prompt("Capture it."), ...shots.map(attached)];
  await render(items);
  assert.ok(buttonNamed(container!, "View All 4 Artifacts"));
  // The same events again, as a replayed or re-polled page delivers them.
  await render([...items, ...shots.map(attached), attached(shots[0]!)]);
  assert.deepEqual(previews(), ["shot-1", "shot-2", "shot-3"]);
  assert.ok(buttonNamed(container!, "View All 4 Artifacts"), container!.innerHTML);
  assert.equal(container!.querySelectorAll(".tl-artifact-more").length, 1);
});

test("View All opens the viewer on the first omitted artifact, steps to every one, and returns focus", async () => {
  nextId = 1;
  const shots = Array.from({ length: 8 }, (_, index) => screenshot(`shot-${index + 1}`));
  await render([prompt("Capture every state."), ...shots.map(attached)]);
  const viewAll = buttonNamed(container!, "View All 8 Artifacts")!;
  viewAll.focus();
  await act(async () => { viewAll.click(); });
  assert.ok(dialog(), "the viewer opened");
  assert.equal(position(), "4 of 8");
  assert.equal(dialog()!.querySelector("h2, .modal-title")?.textContent, "shot-4.png");

  const next = buttonNamed(dialog()!, "Next")!;
  for (let step = 0; step < 4; step++) await act(async () => { next.click(); });
  assert.equal(position(), "8 of 8");
  assert.equal(next.disabled, true, "Next stops at the last artifact");
  await press("ArrowLeft");
  assert.equal(position(), "7 of 8", "← steps back");
  await press("ArrowRight");
  assert.equal(position(), "8 of 8");

  await act(async () => {
    buttonNamed(dialog()!, "Done")!.click();
    await new Promise((resolve) => domWindow.setTimeout(resolve, 10));
  });
  assert.ok(dialog() === null, "the viewer closed");
  assert.ok(domWindow.document.activeElement === (viewAll as never), "focus returns to View All");
});

// Copy Link needs a dashboard address another device can open, which this bare tree has none of;
// the link itself is navigation.test.ts's, and the Browser e2e copies one.
test("a preview offers the viewer and Open in Browser, which closes the viewer first", async () => {
  nextId = 1;
  const opened: string[] = [];
  const shot = screenshot("only");
  await render([prompt("Capture it."), attached(shot)], (artifact) => opened.push(artifact.artifactId));
  const card = container!.querySelector<HTMLElement>(".tl-artifact")!;
  await act(async () => { buttonNamed(card, "Open in Browser")!.click(); });
  assert.deepEqual(opened, ["only"]);

  await act(async () => { buttonNamed(card, "Open in Viewer")!.click(); });
  assert.equal(position(), "1 of 1");
  assert.ok(buttonNamed(dialog()!, "Next") === null, "a single artifact has no steps");
  await act(async () => { buttonNamed(dialog()!, "Open in Browser")!.click(); });
  assert.ok(dialog() === null, "Open in Browser closes the viewer first");
  assert.deepEqual(opened, ["only", "only"]);
});

test("a video waits to be asked for and never plays by itself; another type is a file card", async () => {
  nextId = 1;
  const clip = screenshot("clip", { kind: "video", name: "clip.webm", mimeType: "video/webm" });
  const log = screenshot("log", { kind: "test_log", name: "run.log", mimeType: "text/plain", encoding: "utf8" });
  await render([prompt("Record it."), attached(clip), attached(log)]);
  assert.deepEqual(exported, [], "nothing loads before it is asked for");
  const [videoCard, logCard] = [...container!.querySelectorAll<HTMLElement>(".tl-artifact")];
  assert.ok(buttonNamed(videoCard!, "Load Video"));
  assert.match(logCard!.textContent ?? "", /No inline preview for this type/);
  assert.ok(buttonNamed(logCard!, "Open in Viewer"), "a file card still opens in the viewer");
});
