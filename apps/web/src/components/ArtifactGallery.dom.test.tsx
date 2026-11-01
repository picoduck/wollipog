import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import { ArtifactGallery } from "./ArtifactGallery.js";

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
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// happy-dom has no layout: the stage is 400×300 and every image 400×200, so at fit it fills the
// stage's width and a zoomed image has somewhere to pan.
const elementPrototype = domWindow.HTMLElement.prototype as unknown as HTMLElement;
const STAGE = { left: 0, top: 0, width: 400, height: 300 };
elementPrototype.getBoundingClientRect = function () {
  return { ...STAGE, right: STAGE.width, bottom: STAGE.height, x: 0, y: 0, toJSON() {} } as DOMRect;
};
Object.defineProperty(domWindow.HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 400 });
Object.defineProperty(domWindow.HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 200 });

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");
const shot = (id: string): WorkflowArtifactView => ({
  artifactId: id, sessionId: "session_1", kind: "screenshot", name: `${id}.png`, mimeType: "image/png",
  encoding: "base64", sizeBytes: PNG.byteLength, sha256: PNG_SHA, createdBy: { kind: "agent", id: "session_1" }, createdAt: 1,
});
const clip = (id: string): WorkflowArtifactView => ({ ...shot(id), kind: "video", name: `${id}.webm`, mimeType: "video/webm" });

let root: Root | null = null;
let container: HTMLElement | null = null;
const priorExport = api.artifactExport;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  api.artifactExport = priorExport;
});

function Host({ artifacts }: { artifacts: WorkflowArtifactView[] }) {
  const opener = useRef<HTMLElement | null>(null);
  return <ArtifactGallery artifacts={artifacts} initialId={artifacts[0]!.artifactId} returnFocusRef={opener} onClose={() => {}} />;
}

const settle = () => act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 5)); });
async function open(artifacts: WorkflowArtifactView[]) {
  api.artifactExport = async (id) => new Blob([PNG], { type: id.startsWith("clip") ? "video/webm" : "image/png" });
  container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  root = createRoot(container);
  await act(async () => root!.render(<Host artifacts={artifacts} />));
  await settle();
  await settle();
}

const dialog = () => domWindow.document.querySelector("[role='dialog']") as unknown as HTMLElement;
const position = () => dialog().querySelector(".art-gallery-position")?.textContent;
const stage = () => dialog().querySelector<HTMLElement>(".art-gallery-stage")!;
const zoomed = () => stage().hasAttribute("data-zoomed");
const image = () => dialog().querySelector<HTMLImageElement>(".art-gallery-media");

/** One finger, or several, as a touch screen reports them: each pointer's path, then all lift. */
async function touch(paths: Array<Array<[number, number]>>, target: Element = stage()) {
  const fire = (type: string, pointerId: number, [x, y]: [number, number]) => target.dispatchEvent(
    new domWindow.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: "touch", isPrimary: pointerId === 1, clientX: x, clientY: y,
    }) as unknown as Event,
  );
  await act(async () => {
    paths.forEach((path, index) => fire("pointerdown", index + 1, path[0]!));
    const steps = Math.max(...paths.map((path) => path.length));
    for (let step = 1; step < steps; step++) {
      paths.forEach((path, index) => { if (path[step]) fire("pointermove", index + 1, path[step]!); });
    }
    paths.forEach((path, index) => fire("pointerup", index + 1, path.at(-1)!));
  });
}
const press = async (key: string) => {
  await act(async () => {
    (domWindow.document.activeElement ?? dialog()).dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

test("at fit a horizontal swipe moves between artifacts, and a vertical drag or a tap does not", async () => {
  await open([shot("a"), shot("b"), shot("c")]);
  assert.ok(image(), dialog().innerHTML);
  assert.equal(position(), "1 of 3");
  await touch([[[300, 150], [220, 152], [150, 155]]]);
  assert.equal(position(), "2 of 3", "a swipe to the left shows the next");
  await touch([[[200, 40], [205, 140], [210, 260]]]);
  assert.equal(position(), "2 of 3", "a vertical drag is a scroll, not a swipe");
  await touch([[[100, 150], [180, 150], [260, 150]]]);
  assert.equal(position(), "1 of 3", "a swipe to the right shows the previous");
  await touch([[[260, 150], [180, 150], [100, 150]]]);
  await touch([[[260, 150], [180, 150], [100, 150]]]);
  assert.equal(position(), "3 of 3");
  await touch([[[260, 150], [180, 150], [100, 150]]]);
  assert.equal(position(), "3 of 3", "past the last there is nowhere to go");
});

test("a pinch zooms the image, a zoomed drag pans it without moving on, and Fit to Screen returns", async () => {
  await open([shot("a"), shot("b")]);
  // Two fingers spreading from 100px to 300px apart about the center.
  await touch([[[150, 150], [100, 150], [50, 150]], [[250, 150], [300, 150], [350, 150]]]);
  assert.ok(zoomed(), "the pinch zoomed in");
  assert.match(image()!.style.transform, /scale\(3\)/);
  assert.equal(position(), "1 of 2", "a pinch never moves on");

  await touch([[[300, 150], [200, 150], [100, 150]]]);
  assert.equal(position(), "1 of 2", "zoomed, a drag pans instead of swiping");
  assert.match(image()!.style.transform, /translate\(-200px, 0px\)/, image()!.style.transform);
  // As far as the edge and no further: at 3x the 400px image has 400px of travel each way.
  await touch([[[390, 150], [10, 150]], ]);
  assert.match(image()!.style.transform, /translate\(-400px, 0px\)/, image()!.style.transform);

  const fit = [...dialog().querySelectorAll("button")].find((button) => button.textContent?.trim() === "Fit to Screen")!;
  await act(async () => { fit.click(); });
  assert.ok(!zoomed(), "Fit to Screen returns to fit");
  assert.equal(image()!.style.transform, "");
  await touch([[[300, 150], [150, 150]]]);
  assert.equal(position(), "2 of 2", "at fit again, a swipe moves on");
});

test("a double tap zooms in at the tap and back out; + and 0 do the same from the keyboard", async () => {
  await open([shot("a"), shot("b")]);
  await touch([[[100, 150]]]);
  await touch([[[100, 150]]]);
  assert.ok(zoomed(), "a double tap zoomed in");
  // The browser reports the same double tap as a dblclick too: it must not undo the zoom.
  await act(async () => {
    stage().dispatchEvent(new domWindow.MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 100, clientY: 150 }) as unknown as Event);
  });
  assert.ok(zoomed(), "the double tap's dblclick did not toggle it back");
  await touch([[[100, 150]]]);
  await touch([[[100, 150]]]);
  assert.ok(!zoomed(), "a second double tap returned to fit");
  assert.equal(position(), "1 of 2");
  await press("+");
  assert.ok(zoomed());
  await press("0");
  assert.ok(!zoomed());
  await press("ArrowRight");
  assert.equal(position(), "2 of 2");
});

test("a swipe that starts on a video's player belongs to the player", async () => {
  await open([clip("clip-1"), shot("b")]);
  const video = dialog().querySelector("video");
  assert.ok(video, dialog().innerHTML);
  assert.equal(video!.autoplay, false, "a video never plays by itself");
  assert.ok(video!.hasAttribute("controls"));
  await touch([[[300, 150], [200, 150], [100, 150]]], video!);
  assert.equal(position(), "1 of 2", "scrubbing the video did not move on");
  await touch([[[300, 150], [200, 150], [100, 150]]]);
  assert.equal(position(), "2 of 2", "a swipe beside the player still moves on");
});
