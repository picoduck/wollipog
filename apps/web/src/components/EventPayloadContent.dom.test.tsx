import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { EventPayloadReference } from "@wollipog/protocol";
import { api } from "../api.js";
import { EventPayloadContent, loadEventPayloadReferences } from "./EventPayloadContent.js";

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

function ref(artifactId: string, text: string, mimeType: EventPayloadReference["mimeType"] = "text/plain"): EventPayloadReference {
  return {
    artifactId,
    mimeType,
    encoding: "utf8",
    sizeBytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

test("event payload loader reconstructs ordered chunks after MIME, size, digest, and UTF-8 checks", async () => {
  const refs = [ref("a", "first "), ref("b", "second")];
  const blobs = new Map([
    ["a", new Blob(["first "], { type: "text/plain" })],
    ["b", new Blob(["second"], { type: "text/plain; charset=utf-8" })],
  ]);
  assert.equal(await loadEventPayloadReferences(refs, "text/plain", async (id) => blobs.get(id)!), "first second");

  await assert.rejects(
    loadEventPayloadReferences([ref("bad", "right")], "text/plain", async () => new Blob(["wrong"], { type: "text/plain" })),
    /metadata|digest/,
  );
  await assert.rejects(
    loadEventPayloadReferences([ref("bad", "right")], "text/plain", async () => new Blob(["right"], { type: "text\/x-diff" })),
    /metadata/,
  );
  const invalidBytes = new Uint8Array([0xff]).buffer;
  const invalidRef = {
    ...ref("bad-utf8", "x"),
    sizeBytes: 1,
    sha256: createHash("sha256").update(new Uint8Array(invalidBytes)).digest("hex"),
  };
  await assert.rejects(
    loadEventPayloadReferences([invalidRef], "text/plain", async () => new Blob([invalidBytes], { type: "text/plain" })),
    /encoded data|UTF-8/i,
  );
});

test("event payload content is preview-first, explicitly loads, hides, and retries", async () => {
  const priorExport = api.artifactExport;
  const references = [ref("payload", "complete payload")];
  const requested: string[] = [];
  let fail = true;
  api.artifactExport = async (artifactId: string) => {
    requested.push(artifactId);
    if (fail) throw new Error("temporary failure");
    return new Blob(["complete payload"], { type: "text/plain" });
  };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <EventPayloadContent preview="preview" references={references} mimeType="text/plain" label="output">
          {(text) => <pre>{text}</pre>}
        </EventPayloadContent>,
      );
    });
    assert.deepEqual(requested, []);
    assert.equal(container.querySelector("pre")?.textContent, "preview");

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /temporary failure/);

    fail = false;
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(requested, ["payload", "payload"]);
    assert.equal(container.querySelector("pre")?.textContent, "complete payload");

    await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); });
    assert.equal(container.querySelector("pre")?.textContent, "preview");
  } finally {
    await act(async () => { root.unmount(); });
    api.artifactExport = priorExport;
    container.remove();
  }
});

test("unmount fences a pending artifact load from updating discarded row state", async () => {
  const priorExport = api.artifactExport;
  const references = [ref("delayed", "complete payload")];
  let resolveExport!: (blob: Blob) => void;
  api.artifactExport = () => new Promise<Blob>((resolve) => { resolveExport = resolve; });
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <EventPayloadContent preview="preview" references={references} mimeType="text/plain" label="output">
          {(text) => <pre>{text}</pre>}
        </EventPayloadContent>,
      );
    });
    await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); });
    await act(async () => {
      root.unmount();
      resolveExport(new Blob(["complete payload"], { type: "text/plain" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "");
  } finally {
    api.artifactExport = priorExport;
    container.remove();
  }
});
