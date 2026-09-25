import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import { DEVICE_TOKEN_CHANGED_EVENT } from "../device-token.js";
import { ArtifactPreview } from "./ArtifactPreview.js";
import { TranscriptImageCacheProvider } from "./TranscriptImageCache.js";

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
    await act(async () => video?.dispatchEvent(new domWindow.Event("error") as unknown as Event));
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "",
      /This video could not be played in this browser\./u);
    await act(async () => root.unmount());
    assert.deepEqual(revoked, ["blob:private-video"]);
  } finally {
    api.artifactExport = priorExport;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
    container.remove();
  }
});

test("transcript screenshot remount reuses verified bytes until credentials or session change", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const first = artifact("shared-id", bytes);
  const second = { ...first, sessionId: "session_2" };
  const priorExport = api.artifactExport;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  let exports = 0;
  let created = 0;
  const revoked: string[] = [];
  api.artifactExport = async () => {
    exports++;
    return new Blob([bytes], { type: "image/png" });
  };
  URL.createObjectURL = () => `blob:transcript-${++created}`;
  URL.revokeObjectURL = (value) => { revoked.push(value); };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = async (session: string, item: WorkflowArtifactView | null) => {
    await act(async () => root.render(
      <React.StrictMode>
        <TranscriptImageCacheProvider key={session}>
          {item && <ArtifactPreview artifact={item} />}
        </TranscriptImageCacheProvider>
      </React.StrictMode>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await render("session_1", first);
    const firstUrl = container.querySelector("img")?.getAttribute("src");
    assert.ok(firstUrl);
    await render("session_1", null);
    assert.deepEqual(revoked, [firstUrl]);
    await render("session_1", first);
    const secondUrl = container.querySelector("img")?.getAttribute("src");
    assert.ok(secondUrl);
    assert.notEqual(secondUrl, firstUrl);
    assert.equal(exports, 1, "the same session reuses verified image bytes");
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.Event(DEVICE_TOKEN_CHANGED_EVENT));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(exports, 2, "a credential change invalidates retained bytes");
    const afterCredentialChange = container.querySelector("img")?.getAttribute("src");
    assert.ok(afterCredentialChange);
    assert.ok(revoked.includes(secondUrl));
    await render("session_2", second);
    assert.equal(exports, 3, "a different session cannot reuse the first session's image");
    assert.ok(revoked.includes(afterCredentialChange));
    await act(async () => root.unmount());
    assert.equal(revoked.length, 4, "every visible object URL is released");
  } finally {
    api.artifactExport = priorExport;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
    container.remove();
  }
});

test("a mismatched transcript image is never cached and can load on a later mount", async () => {
  const bytes = new Uint8Array([7, 8, 9]);
  const item = artifact("retry-image", bytes);
  const priorExport = api.artifactExport;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  let exports = 0;
  let created = 0;
  api.artifactExport = async () => {
    exports++;
    return new Blob([exports === 1 ? new Uint8Array([9, 8, 7]) : bytes], { type: "image/png" });
  };
  URL.createObjectURL = () => { created++; return "blob:retry-image"; };
  URL.revokeObjectURL = () => {};
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = async (show: boolean) => {
    await act(async () => root.render(
      <TranscriptImageCacheProvider>{show && <ArtifactPreview artifact={item} />}</TranscriptImageCacheProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await render(true);
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /digest does not match/);
    assert.equal(container.querySelector("img"), null);
    assert.equal(created, 0);
    await render(false);
    await render(true);
    assert.equal(exports, 2);
    assert.equal(container.querySelector("img")?.getAttribute("src"), "blob:retry-image");
  } finally {
    await act(async () => root.unmount());
    api.artifactExport = priorExport;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
    container.remove();
  }
});
