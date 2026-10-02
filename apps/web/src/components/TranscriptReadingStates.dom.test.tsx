import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import {
  TranscriptHistoryNotice,
  transcriptEmptyKind,
  transcriptHistoryLoadedSentence,
  transcriptReadySentence,
} from "./TranscriptReadingStates.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("each session status maps to one empty transcript", () => {
  assert.equal(transcriptEmptyKind({ status: "idle" }), "awaiting");
  assert.equal(transcriptEmptyKind({ status: "input_required" }), "awaiting");
  assert.equal(transcriptEmptyKind({ status: "running" }), "awaiting");
  assert.equal(transcriptEmptyKind({ status: "queued" }), "starting");
  assert.equal(transcriptEmptyKind({ status: "starting" }), "starting");
  assert.equal(transcriptEmptyKind({ status: "completed" }), "ended");
  assert.equal(transcriptEmptyKind({ status: "failed" }), "ended");
  assert.equal(transcriptEmptyKind({ status: "stopped" }), "ended");
  assert.equal(transcriptEmptyKind({ status: "idle", archived: true }), "ended", "an archived session has ended");
});

test("the ready sentence leaves out whichever place is unknown", () => {
  assert.equal(transcriptReadySentence("Codex", "Wollipog", "Build Box"), "Codex is ready in Wollipog on Build Box.");
  assert.equal(transcriptReadySentence("Codex", undefined, "Build Box"), "Codex is ready on Build Box.");
  assert.equal(transcriptReadySentence("Codex", "Wollipog", undefined), "Codex is ready in Wollipog.");
  assert.equal(transcriptReadySentence("Codex", undefined, undefined), "Codex is ready.");
});

test("the history notice says how much loaded and from where", () => {
  assert.equal(transcriptHistoryLoadedSentence(0, 240, "Build Box"), "No activity loaded from Build Box.");
  assert.equal(transcriptHistoryLoadedSentence(9, 1240, "Build Box"), "Loaded 9 of 1,240 events from Build Box.");
  assert.equal(transcriptHistoryLoadedSentence(9, undefined, "Build Box"), "Loaded 9 events from Build Box.");
  assert.equal(transcriptHistoryLoadedSentence(1, 1, undefined), "Loaded 1 event.");
  assert.equal(transcriptHistoryLoadedSentence(0, undefined, undefined), "No activity loaded.");
});

test("cached content shown while disconnected is one neutral sentence with no action", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <TranscriptHistoryNotice kind="stale" error={null} loaded={9} canRetry={false} onRetry={() => {}} />,
    ));
    const notice = container.querySelector(".notice") as HTMLElement;
    assert.ok(notice.classList.contains("t-neutral") && notice.classList.contains("compact"));
    assert.equal(notice.textContent, "Showing cached activity while disconnected.");
    assert.equal(notice.querySelectorAll("button").length, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
