import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView, WorkflowArtifactPage, WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import { BrowserPanel } from "./BrowserPanel.js";
import type { BrowserArtifactRequest } from "./right-panel-state.js";
import { clearPanelScratch } from "../right-panel-scratch.js";

beforeEach(() => clearPanelScratch());

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function log(id: string): WorkflowArtifactView {
  const text = `${id} body`;
  return {
    artifactId: id, sessionId: "session_1", kind: "test_log", name: `${id}.log`, mimeType: "text/plain",
    encoding: "utf8", sizeBytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"),
    createdBy: { kind: "system" }, createdAt: 1,
  };
}

// Three pages of two, the way the list pages a long session's artifacts.
const PAGES: Record<string, WorkflowArtifactPage> = {
  first: { artifacts: [log("a1"), log("a2")], nextCursor: "p2" },
  p2: { artifacts: [log("a3"), log("a4")], nextCursor: "p3" },
  p3: { artifacts: [log("a5"), log("a6")] },
};

let root: Root | null = null;
let container: HTMLElement | null = null;
const listed: Array<string | undefined> = [];
const handled: number[] = [];
const priorList = api.sessionWorkflowArtifacts;
const priorExport = api.artifactExport;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  listed.length = 0;
  handled.length = 0;
  api.sessionWorkflowArtifacts = priorList;
  api.artifactExport = priorExport;
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
async function render(openArtifact: BrowserArtifactRequest | null) {
  api.sessionWorkflowArtifacts = async (_session: string, cursor?: string) => {
    listed.push(cursor);
    return PAGES[cursor ?? "first"]!;
  };
  api.artifactExport = async (id: string) => new Blob([`${id} body`], { type: "text/plain" });
  if (!container) {
    container = domWindow.document.createElement("div") as unknown as HTMLElement;
    domWindow.document.body.append(container as never);
    root = createRoot(container);
  }
  await act(async () => root!.render(
    <BrowserPanel session={{ id: "session_1" } as SessionView} openArtifact={openArtifact}
      onOpenArtifactHandled={(request) => handled.push(request)} />,
  ));
  for (let index = 0; index < 6; index++) await settle();
}

test("a link to an artifact beyond the first page loads pages until it is found, then opens it", async () => {
  await render({ sessionId: "session_1", artifactId: "a5", request: 1 });
  assert.deepEqual(listed, [undefined, "p2", "p3"], "it read pages only as far as the artifact");
  assert.deepEqual(handled, [1], "the request was acted on once");
  const page = container!.querySelectorAll<HTMLElement>(".browser-artifacts")[1];
  assert.ok(page, container!.innerHTML);
  assert.match(page!.textContent ?? "", /a5 body/, "the linked artifact's page is open");
  assert.ok(container!.querySelector("#browser-artifacts-panel")!.hasAttribute("hidden"), "the list waits under it");
});

test("a link to an artifact no page carries says it is unavailable, and names nothing about it", async () => {
  await render({ sessionId: "session_1", artifactId: "gone", request: 7 });
  assert.deepEqual(listed, [undefined, "p2", "p3"]);
  const panel = container!.querySelector("#browser-artifacts-panel")!;
  assert.ok(!panel.hasAttribute("hidden"), "the list shows");
  assert.match(panel.textContent ?? "", /Artifact Unavailable/);
  assert.doesNotMatch(panel.textContent ?? "", /gone/, "the missing id is not echoed back");
});

test("a link to the tab alone opens the list without reading further pages", async () => {
  await render({ sessionId: "session_1", request: 3 });
  assert.deepEqual(listed, [undefined]);
  assert.deepEqual(handled, [3]);
  assert.equal(container!.querySelectorAll(".browser-artifact-list .row").length, 2);
});
