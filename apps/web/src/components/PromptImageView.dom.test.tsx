import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api } from "../api.js";
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
