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

test("verified video artifacts render a private inline player and release their URL", async () => {
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
  const item: WorkflowArtifactView = { ...artifact("clip", bytes), kind: "video", name: "clip.webm", mimeType: "video/webm" };
  const priorExport = api.artifactExport;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  api.artifactExport = async () => new Blob([bytes], { type: "video/webm" });
  URL.createObjectURL = () => "blob:private-video";
  URL.revokeObjectURL = (value) => { revoked.push(value); };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ArtifactPreview artifact={item} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const video = container.querySelector("video.artifact-preview-video");
    assert.equal(video?.getAttribute("src"), "blob:private-video");
    assert.equal(video?.hasAttribute("controls"), true);
    assert.equal(video?.hasAttribute("playsinline"), true);
    await act(async () => root.unmount());
    assert.deepEqual(revoked, ["blob:private-video"]);
  } finally {
    api.artifactExport = priorExport;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
    container.remove();
  }
});
