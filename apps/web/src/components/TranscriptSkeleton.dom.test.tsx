import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import {
  TRANSCRIPT_SKELETON_SENTENCE_DELAY_MS,
  TranscriptSkeleton,
  transcriptLoadingSentence,
} from "./TranscriptSkeleton.js";

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

async function mount(element: React.ReactElement) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    sentence: () => container.querySelector(".transcript-skeleton-sentence"),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the skeleton is two turns, each a bubble, a work bar and three prose lines", async () => {
  const view = await mount(<TranscriptSkeleton />);
  try {
    const turns = view.container.querySelectorAll(".transcript-skeleton-turn");
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.equal(turn.getAttribute("aria-hidden"), "true");
      assert.equal(turn.querySelectorAll(".transcript-skeleton-bubble").length, 1);
      assert.equal(turn.querySelectorAll(".transcript-skeleton-work").length, 1);
      assert.equal(turn.querySelectorAll(".transcript-skeleton-prose > span").length, 3);
    }
  } finally {
    await view.unmount();
  }
});

test("after 3 seconds the skeleton says how long a conversation it is loading", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const view = await mount(<TranscriptSkeleton sentence={transcriptLoadingSentence(1240)} />);
  try {
    assertNoDomNode(view.sentence(), "a quick load never shows the sentence");
    await act(async () => mock.timers.tick(TRANSCRIPT_SKELETON_SENTENCE_DELAY_MS - 1));
    assertNoDomNode(view.sentence(), "not before 3 seconds");
    await act(async () => mock.timers.tick(1));
    assert.equal(view.sentence()?.textContent, "Loading a long conversation (1,240 events)…");
    // Inside the skeleton's status region, so it is announced once.
    assert.equal(view.sentence()?.closest("[role='status']"), view.container.querySelector(".transcript-skeleton"));
  } finally {
    await view.unmount();
    mock.timers.reset();
  }
});

test("without a count the sentence names the conversation alone", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const view = await mount(<TranscriptSkeleton sentence={transcriptLoadingSentence(0)} />);
  try {
    await act(async () => mock.timers.tick(TRANSCRIPT_SKELETON_SENTENCE_DELAY_MS));
    assert.equal(view.sentence()?.textContent, "Loading the conversation…");
  } finally {
    await view.unmount();
    mock.timers.reset();
  }
});

test("a skeleton without a sentence never adds one", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const view = await mount(<TranscriptSkeleton label="Loading Session" />);
  try {
    await act(async () => mock.timers.tick(TRANSCRIPT_SKELETON_SENTENCE_DELAY_MS * 2));
    assertNoDomNode(view.sentence(), "the session placeholder's skeleton has no sentence (#2202)");
  } finally {
    await view.unmount();
    mock.timers.reset();
  }
});

test("the loading sentence counts events in words", () => {
  assert.equal(transcriptLoadingSentence(undefined), "Loading the conversation…");
  assert.equal(transcriptLoadingSentence(null), "Loading the conversation…");
  assert.equal(transcriptLoadingSentence(1), "Loading a long conversation (1 event)…");
  assert.equal(transcriptLoadingSentence(12_345), "Loading a long conversation (12,345 events)…");
});
