import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ActiveTurnProgress } from "../turn-progress.js";
import { ACTIVE_TURN_SILENCE_MS, WorkingIndicator } from "./WorkingIndicator.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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

const running: ActiveTurnProgress = {
  turnEventId: 1,
  turnStartedAt: 1_000,
  lastActivityAt: 61_000,
  currentOperation: { eventId: 42, title: "Run Focused Tests", toolKind: "execute" },
  completedTools: 0,
  failedTools: 0,
};

async function mount(): Promise<{ container: HTMLDivElement; root: Root; unmount: () => Promise<void> }> {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function text(element: Element | null | undefined): string {
  return element?.textContent ?? "";
}

function liveRegion(container: HTMLElement): Element | null {
  return container.querySelector('[role="status"][aria-live="polite"]');
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name);
}

test("a running turn with no failures is one line: Working, the elapsed time and the current step", async () => {
  const revealed: number[] = [];
  const { container, root, unmount } = await mount();
  try {
    await act(async () => root.render(
      <WorkingIndicator progress={running} now={121_000} onRevealCurrentOperation={(eventId) => revealed.push(eventId)} />,
    ));
    const region = container.querySelector('[aria-label="Active Turn Progress"]');
    assert.ok(region, "the row keeps the Active Turn Progress landmark");
    const line = container.querySelector(".tl-working-line");
    assert.equal(text(line?.querySelector(".tl-working-state")), "Working");
    assert.equal(text(line?.querySelector(".tl-working-elapsed")), "2m 0s");
    const step = line?.querySelector<HTMLButtonElement>("button.link.tl-working-step-text");
    assert.equal(text(step), "Run Focused Tests");
    assertNoDomNode(container.querySelector(".tl-working-note"), "nothing went wrong, so there is no exception line");
    const visible = text(line);
    assert.doesNotMatch(visible, /Completed|Failed|Last Activity|\b0\b/i);
    assertNoDomNode(container.querySelector(".tl-working-metric"), "the bold metric labels are gone");
    // Zero counts never render, not even in the tooltip.
    const tooltip = container.querySelector('[role="tooltip"]');
    assert.equal(text(tooltip), "Show this step in the transcript.");
    assert.equal(step?.getAttribute("aria-describedby"), tooltip?.id);
    await act(async () => step!.click());
    assert.deepEqual(revealed, [42]);
    assert.equal(container.querySelectorAll("button").length, 1, "no action without a subagent or a pending request");
  } finally {
    await unmount();
  }
});

test("the completed count and the plan step move into the step link's tooltip", async () => {
  const { container, root, unmount } = await mount();
  try {
    await act(async () => root.render(
      <WorkingIndicator
        progress={{ ...running, completedTools: 3, currentPlanStep: { content: "Verify the release", status: "in_progress" } }}
        now={121_000}
        onRevealCurrentOperation={() => {}}
      />,
    ));
    const tooltip = container.querySelector('[role="tooltip"]');
    assert.equal(text(tooltip), "Show this step in the transcript. 3 completed. Plan step: Verify the release");
    assert.doesNotMatch(text(container.querySelector(".tl-working-line"))
      .replace(text(tooltip), ""), /completed|Plan/i, "neither shows on the line itself");
  } finally {
    await unmount();
  }
});

test("one failed step with two retries adds an exception line in the danger color", async () => {
  const { container, root, unmount } = await mount();
  try {
    await act(async () => root.render(
      <WorkingIndicator
        progress={{
          ...running,
          completedTools: 2,
          failedTools: 1,
          retryGroup: { eventId: 41, title: "Run Focused Tests", attempts: 3, retries: 2, latestError: "ECONNRESET" },
        }}
        now={121_000}
        onRevealCurrentOperation={() => {}}
      />,
    ));
    const note = container.querySelector("p.tl-working-note");
    assert.ok(note, "a failure earns the second line");
    assert.equal(text(note?.querySelector(".tl-working-failed")), "1 failed");
    const retry = note?.querySelector(".tl-working-retry");
    assert.equal(text(retry), "Retried 2 times: ECONNRESET");
    assert.equal(retry?.getAttribute("title"), "ECONNRESET", "the full error stays reachable when it clips");
    assert.equal(text(container.querySelector(".tl-working-state")), "Working");
  } finally {
    await unmount();
  }
});

test("one retry reads in the singular", async () => {
  const { container, root, unmount } = await mount();
  try {
    await act(async () => root.render(
      <WorkingIndicator
        progress={{
          ...running,
          failedTools: 2,
          retryGroup: { eventId: 41, title: "Run Focused Tests", attempts: 2, retries: 1, latestError: "exit 1" },
        }}
        now={121_000}
      />,
    ));
    assert.equal(text(container.querySelector(".tl-working-retry")), "Retried 1 time: exit 1");
    assert.equal(text(container.querySelector(".tl-working-failed")), "2 failed");
  } finally {
    await unmount();
  }
});

test("after 120 seconds without activity the note says so, and new output removes it", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const { container, root, unmount } = await mount();
  try {
    const startedAt = Date.now();
    const progress: ActiveTurnProgress = { ...running, turnStartedAt: startedAt, lastActivityAt: startedAt };
    await act(async () => root.render(<WorkingIndicator progress={progress} onRevealCurrentOperation={() => {}} />));
    assertNoDomNode(container.querySelector(".tl-working-note"), "a fresh turn is not silent");

    await act(async () => mock.timers.tick(ACTIVE_TURN_SILENCE_MS - 1_000));
    assertNoDomNode(container.querySelector(".tl-working-note"), "119 seconds is not yet silence");

    await act(async () => mock.timers.tick(1_000));
    assert.equal(text(container.querySelector(".tl-working-note")), "No new output for 2m");

    await act(async () => mock.timers.tick(60_000));
    assert.equal(text(container.querySelector(".tl-working-note")), "No new output for 3m");

    await act(async () => root.render(
      <WorkingIndicator progress={{ ...progress, lastActivityAt: Date.now() }} onRevealCurrentOperation={() => {}} />,
    ));
    assertNoDomNode(container.querySelector(".tl-working-note"), "new output ends the silence");
  } finally {
    await unmount();
    mock.timers.reset();
  }
});

test("a pending approval outranks progress: Approval Required and a Review action", async () => {
  const reviewed: string[] = [];
  const opened: string[] = [];
  const { container, root, unmount } = await mount();
  try {
    await act(async () => root.render(
      <WorkingIndicator
        progress={{
          ...running,
          lastActivityAt: 1_000,
          currentOperation: { ...running.currentOperation!, subagentId: "agent-42" },
          waitingReason: { kind: "approval", label: "Waiting for Approval", title: "Run release command", requestId: "approval-7" },
        }}
        now={1_000_000}
        onRevealCurrentOperation={() => {}}
        onOpenSubagent={(id) => opened.push(id)}
        onReviewPendingRequest={(requestId) => reviewed.push(requestId)}
      />,
    ));
    const badge = container.querySelector(".tl-working-line .status");
    assert.equal(text(badge), "Approval Required");
    assert.ok(badge?.classList.contains("t-warning"), "the attention badge carries the warning tone");
    assert.doesNotMatch(text(container), /Working/, "Working is not shown while the turn waits on the person");
    assertNoDomNode(container.querySelector(".working-dots"), "nothing is progressing, so nothing animates");
    assertNoDomNode(container.querySelector(".tl-working-note"), "waiting on the person is not silence");
    assert.equal(buttonNamed(container, "Open Agent"), undefined, "at most one action, and Review outranks Open Agent");
    const review = buttonNamed(container, "Review");
    assert.ok(review?.classList.contains("ghost"));
    await act(async () => review!.click());
    assert.deepEqual(reviewed, ["approval-7"]);
    assert.deepEqual(opened, []);
  } finally {
    await unmount();
  }
});

test("a pending question reads Answer Required", async () => {
  const { container, root, unmount } = await mount();
  try {
    await act(async () => root.render(
      <WorkingIndicator
        progress={{
          ...running,
          waitingReason: { kind: "question", label: "Waiting for Answer to Question", title: "Pick a channel", requestId: "q-1" },
        }}
        now={121_000}
        onReviewPendingRequest={() => {}}
      />,
    ));
    assert.equal(text(container.querySelector(".tl-working-line .status")), "Answer Required");
    assert.ok(buttonNamed(container, "Review"));
  } finally {
    await unmount();
  }
});

test("a subagent's step offers Open Agent as the line's one action", async () => {
  const opened: string[] = [];
  const { container, root, unmount } = await mount();
  try {
    await act(async () => root.render(
      <WorkingIndicator
        progress={{ ...running, currentOperation: { ...running.currentOperation!, subagentId: "agent-42" } }}
        now={121_000}
        onOpenSubagent={(id) => opened.push(id)}
      />,
    ));
    const open = buttonNamed(container, "Open Agent");
    assert.ok(open?.matches(".btn.sm.ghost"));
    assert.equal(buttonNamed(container, "Open Subagent"), undefined);
    await act(async () => open!.click());
    assert.deepEqual(opened, ["agent-42"]);
  } finally {
    await unmount();
  }
});

test("the live region announces a change of state once, not the clock or the step", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const { container, root, unmount } = await mount();
  try {
    const startedAt = Date.now();
    const progress: ActiveTurnProgress = { ...running, turnStartedAt: startedAt, lastActivityAt: startedAt };
    await act(async () => root.render(<WorkingIndicator progress={progress} />));
    const region = liveRegion(container);
    assert.equal(text(region), "Working");

    const mutations: string[] = [];
    const observer = new domWindow.MutationObserver(() => mutations.push(text(liveRegion(container))));
    observer.observe(region as unknown as import("happy-dom").Node, { childList: true, characterData: true, subtree: true });

    for (let second = 0; second < 5; second += 1) await act(async () => mock.timers.tick(1_000));
    assert.notEqual(text(container.querySelector(".tl-working-elapsed")), "", "the clock did tick");
    await act(async () => root.render(
      <WorkingIndicator progress={{ ...progress, currentOperation: { eventId: 43, title: "Read config.ts" } }} />,
    ));
    assert.equal(text(liveRegion(container)), "Working");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(mutations, [], "elapsed ticks and step changes do not touch the live region");

    const waiting: ActiveTurnProgress = {
      ...progress,
      waitingReason: { kind: "approval", label: "Waiting for Approval", title: "Deploy", requestId: "a-1" },
    };
    await act(async () => root.render(<WorkingIndicator progress={waiting} />));
    await act(async () => mock.timers.tick(1_000));
    await act(async () => root.render(<WorkingIndicator progress={waiting} />));
    assert.equal(text(liveRegion(container)), "Approval Required");

    await act(async () => root.render(<WorkingIndicator progress={{ ...progress, failedTools: 1 }} />));
    assert.equal(text(liveRegion(container)), "Working, 1 failed", "a new failure is announced");
    await new Promise((resolve) => setImmediate(resolve));
    observer.disconnect();
    assert.deepEqual([...new Set(mutations)], ["Approval Required", "Working, 1 failed"],
      "each state change reaches the live region, and nothing else does");
  } finally {
    await unmount();
    mock.timers.reset();
  }
});

test("without derived progress the row stays the plain Working indicator", async () => {
  const { container, root, unmount } = await mount();
  try {
    await act(async () => root.render(<WorkingIndicator label="Read config.ts" />));
    assert.equal(text(container.querySelector(".tl-working-state")), "Working");
    assert.equal(text(container.querySelector(".tl-working-step-text")), "Read config.ts");
    assertNoDomNode(container.querySelector("button"),
      "without an event id there is nothing to deep-link");
    assertNoDomNode(container.querySelector(".tl-working-note"),
      "no exception line before any turn facts are observable");
  } finally {
    await unmount();
  }
});
