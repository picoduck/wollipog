import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api } from "../api.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { PromptImageView } from "./PromptImageView.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("protected prompt images use authenticated blobs and revoke object URLs on unmount", async () => {
  const priorExport = api.artifactExport;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  const requested: string[] = [];
  const revoked: string[] = [];
  api.artifactExport = async (artifactId: string) => {
    requested.push(artifactId);
    return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  };
  URL.createObjectURL = () => "blob:prompt-image";
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<PromptImageView image={{
        artifactId: "art1", mimeType: "image/png", sizeBytes: 3, sha256: "a".repeat(64),
      }} alt="attachment" />);
      await Promise.resolve();
    });
    assert.deepEqual(requested, ["art1"]);
    assert.equal(container.querySelector("img")?.getAttribute("src"), "blob:prompt-image");
    await act(async () => { root.unmount(); });
    assert.deepEqual(revoked, ["blob:prompt-image"]);
  } finally {
    api.artifactExport = priorExport;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
    container.remove();
  }
});

function mount() {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  return { container, root: createRoot(container) };
}

test("an image whose source fails to load becomes an image-off tile and is reported once", async () => {
  const { container, root } = mount();
  let reported = 0;
  try {
    await act(async () => {
      root.render(<PromptImageView image={{ mimeType: "image/png", data: "iVBORw0KGgo=" }}
        alt="Attached image 1: diagram.png" onBroken={() => { reported += 1; }} />);
    });
    const img = container.querySelector("img");
    assert.ok(img, "the image is tried first");
    await act(async () => { img.dispatchEvent(new domWindow.Event("error") as unknown as Event); });
    // No browser broken-image icon and no alt text spilling out: an icon tile with the name.
    assertNoDomNode(container.querySelector("img"));
    const tile = container.querySelector(".image-broken");
    assert.ok(tile?.querySelector("svg"), "an image-off icon");
    assert.equal(tile?.getAttribute("role"), "img");
    assert.equal(tile?.getAttribute("aria-label"), "Attached image 1: diagram.png");
    assert.equal(tile?.textContent, "");
    await act(async () => { root.render(<PromptImageView image={{ mimeType: "image/png", data: "iVBORw0KGgo=" }}
      alt="Attached image 1: diagram.png" onBroken={() => { reported += 1; }} />); });
    assert.equal(reported, 1);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a stored image shows a spinner while it loads, and an image-off tile if it can't be fetched", async () => {
  const priorExport = api.artifactExport;
  let fail: (error: Error) => void = () => undefined;
  api.artifactExport = () => new Promise<Blob>((_resolve, reject) => { fail = reject; });
  const { container, root } = mount();
  let reported = false;
  try {
    await act(async () => {
      root.render(<PromptImageView image={{ artifactId: "art2", mimeType: "image/png", sizeBytes: 3, sha256: "a".repeat(64) }}
        alt="Attached image 1" onBroken={() => { reported = true; }} />);
    });
    assert.ok(container.querySelector(".image-loading .spinner"), "a spinner while the artifact is fetched");
    assert.equal(container.querySelector(".image-loading")?.getAttribute("aria-label"), "Attached image 1, loading");
    await act(async () => { fail(new Error("forbidden")); await Promise.resolve(); });
    assert.ok(container.querySelector(".image-broken svg"));
    assert.equal(reported, true);
  } finally {
    api.artifactExport = priorExport;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
