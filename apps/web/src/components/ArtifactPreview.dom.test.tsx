import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import { ArtifactPreview } from "./ArtifactPreview.js";

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

function artifact(id: string, bytes: Uint8Array): WorkflowArtifactView {
  return {
    artifactId: id,
    sessionId: "session_1",
    kind: "screenshot",
    name: `${id}.png`,
    mimeType: "image/png",
    encoding: "base64",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdBy: { kind: "system" },
    createdAt: 1,
  };
}

test("artifact preview fences stale loads and revokes its selected image URL on unmount", async () => {
  const firstBytes = new Uint8Array([1, 2, 3]);
  const secondBytes = new Uint8Array([4, 5, 6]);
  let resolveFirst!: (value: Blob) => void;
  let resolveSecond!: (value: Blob) => void;
  const priorExport = api.artifactExport;
  api.artifactExport = (id: string) => new Promise<Blob>((resolve) => {
    if (id === "first") resolveFirst = resolve;
    else resolveSecond = resolve;
  });
  const created: string[] = [];
  const revoked: string[] = [];
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {
    const value = `blob:preview-${created.length + 1}`;
    created.push(value);
    return value;
  };
  URL.revokeObjectURL = (value: string) => { revoked.push(value); };

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<ArtifactPreview artifact={artifact("first", firstBytes)} />); });
    await act(async () => { root.render(<ArtifactPreview artifact={artifact("second", secondBytes)} />); });
    await act(async () => { resolveSecond(new Blob([secondBytes], { type: "image/png" })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.equal(container.querySelector("img")?.getAttribute("src"), "blob:preview-1");

    await act(async () => { resolveFirst(new Blob([firstBytes], { type: "image/png" })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.deepEqual(created, ["blob:preview-1"], "superseded bytes never receive an object URL");

    await act(async () => { root.unmount(); });
    assert.deepEqual(revoked, ["blob:preview-1"]);
  } finally {
    api.artifactExport = priorExport;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
    container.remove();
  }
});
