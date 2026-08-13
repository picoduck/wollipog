import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView, WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import { BrowserPanel } from "./BrowserPanel.js";

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

function artifact(id: string, text: string): WorkflowArtifactView {
  return {
    artifactId: id,
    sessionId: "session_1",
    kind: "test_log",
    name: `${id}.log`,
    mimeType: "text/plain",
    encoding: "utf8",
    sizeBytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    createdBy: { kind: "system" },
    createdAt: 1,
  };
}

test("browser panel paginates metadata and fetches exact bodies only after selection", async () => {
  const first = artifact("first", "first body");
  const second = artifact("second", "second body");
  const priorList = api.sessionWorkflowArtifacts;
  const priorExport = api.artifactExport;
  const listed: Array<string | undefined> = [];
  const exported: string[] = [];
  api.sessionWorkflowArtifacts = async (_sessionId: string, cursor?: string) => {
    listed.push(cursor);
    return cursor ? { artifacts: [second] } : { artifacts: [first], nextCursor: "page-2" };
  };
  api.artifactExport = async (id: string) => {
    exported.push(id);
    return new Blob([id === "first" ? "first body" : "second body"], { type: "text/plain" });
  };

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<BrowserPanel session={{ id: "session_1" } as SessionView} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(exported, [], "metadata listing never materializes artifact bodies");
    assert.equal(container.querySelectorAll(".browser-artifact-row").length, 1);

    const loadMore = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Load More") as HTMLButtonElement;
    await act(async () => {
      loadMore.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(listed, [undefined, "page-2"]);
    assert.equal(container.querySelectorAll(".browser-artifact-row").length, 2);

    await act(async () => { (container.querySelector(".browser-artifact-row") as HTMLButtonElement).click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.deepEqual(exported, ["first"]);
    assert.equal(container.querySelector("pre")?.textContent, "first body", container.innerHTML);
  } finally {
    await act(async () => { root.unmount(); });
    api.sessionWorkflowArtifacts = priorList;
    api.artifactExport = priorExport;
    container.remove();
  }
});
