import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ActiveTurnProgress } from "../turn-progress.js";
import { WorkingIndicator } from "./WorkingIndicator.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

test("the merged working row renders observable progress and deep-links the current operation event", async () => {
  const progress: ActiveTurnProgress = {
    turnEventId: 1,
    turnStartedAt: 1_000,
    lastActivityAt: 61_000,
    currentOperation: { eventId: 42, title: "Run Focused Tests", toolKind: "agent", subagentId: "agent-42" },
    completedTools: 3,
    failedTools: 2,
    currentPlanStep: { content: "Verify the release", status: "in_progress" },
    retryGroup: { eventId: 41, title: "Run Focused Tests", attempts: 3, retries: 2, latestError: "ECONNRESET" },
    waitingReason: { kind: "approval", label: "Waiting for Approval", title: "Run release command" },
  };
  const revealed: number[] = [];
  const openedSubagents: string[] = [];
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <WorkingIndicator
        progress={progress}
        now={121_000}
        onRevealCurrentOperation={(eventId) => revealed.push(eventId)}
        onOpenSubagent={(subagentId) => openedSubagents.push(subagentId)}
      />,
    ));
    assert.match(container.textContent ?? "", /Elapsed2m 0s/);
    assert.match(container.textContent ?? "", /Last Activity1m Ago/);
    assert.match(container.textContent ?? "", /Completed3/);
    assert.match(container.textContent ?? "", /Failed2/);
    assert.match(container.textContent ?? "", /Retried 2 TimesECONNRESET/);
    assert.match(container.textContent ?? "", /Waiting for Approval/);
    assert.match(container.textContent ?? "", /Plan StepVerify the release/);
    const region = container.querySelector('[aria-label="Active Turn Progress"]');
    assert.ok(region, "the row keeps the Active Turn Progress landmark the strip owned");
    const operation = container.querySelector<HTMLButtonElement>(".tl-working-operation")!;
    assert.equal(operation.textContent, "Run Focused Tests");
    await act(async () => operation.click());
    assert.deepEqual(revealed, [42]);
    const subagent = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Open Subagent")!;
    await act(async () => subagent.click());
    assert.deepEqual(openedSubagents, ["agent-42"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("without derived progress the row stays the plain Working indicator", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WorkingIndicator label="Read config.ts" />));
    assert.match(container.textContent ?? "", /Read config\.ts/);
    assert.equal(container.querySelector(".tl-working-metric"), null,
      "no metric slots render before any turn facts are observable");
    assert.equal(container.querySelector(".tl-working-operation"), null,
      "without an event id there is nothing to deep-link");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
