import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { EventTimeline } from "./EventTimeline.js";
import type { TimelineItem } from "../timeline.js";

const domWindow = new Window();
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
  React,
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

const startedAt = Date.UTC(2026, 7, 4, 12, 0, 0);

/** A step's visible trailing fact, without its tooltip. */
const trailText = (step: Element | null | undefined): string | undefined => {
  const trail = step?.querySelector(".tl-step-trail");
  if (!trail) return undefined;
  return [...trail.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("") || undefined;
};
const stepNamed = (container: Element, title: string): HTMLElement | undefined =>
  [...container.querySelectorAll<HTMLElement>(".tl-step")].find((step) => step.querySelector(".tl-step-title")?.textContent === title);
const items: TimelineItem[] = [
  {
    kind: "agent_message",
    id: 1,
    text: "Streaming response",
    createdAt: startedAt,
    lastActivityAt: startedAt + 20_000,
  },
  {
    kind: "agent_thought",
    id: 2,
    text: "Recorded thought",
    createdAt: startedAt + 30_000,
    lastActivityAt: startedAt + 30_000,
    completedAt: startedAt + 30_000,
  },
  {
    kind: "tool_call",
    id: 3,
    toolCallId: "bare",
    title: "Bare Tool",
    status: "running",
    text: "",
    startedAt: startedAt + 40_000,
    lastActivityAt: startedAt + 50_000,
  },
  {
    kind: "tool_call",
    id: 4,
    toolCallId: "details",
    title: "Details Tool",
    status: "completed",
    text: "output",
    startedAt: startedAt + 60_000,
    lastActivityAt: startedAt + 70_000,
    completedAt: startedAt + 70_000,
  },
];

test("steps show one trailing duration with their exact span in its tooltip, and every timeline shares one page clock", async () => {
  let intervalStarts = 0;
  let intervalClears = 0;
  let visibilityAdds = 0;
  let visibilityRemoves = 0;
  const testDocument = document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalAdd = testDocument.addEventListener.bind(testDocument);
  const originalRemove = testDocument.removeEventListener.bind(testDocument);
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: (() => { intervalStarts += 1; return 101; }) as unknown as typeof setInterval,
  });
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    writable: true,
    value: (() => { intervalClears += 1; }) as typeof clearInterval,
  });
  testDocument.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "visibilitychange") visibilityAdds += 1;
    originalAdd(type, listener, options);
  }) as unknown as typeof testDocument.addEventListener;
  testDocument.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "visibilitychange") visibilityRemoves += 1;
    originalRemove(type, listener);
  }) as unknown as typeof testDocument.removeEventListener;

  const container = testDocument.createElement("div");
  testDocument.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <>
          <EventTimeline items={items} sessionActive />
          <EventTimeline items={items.map((item) => ({ ...item, id: item.id + 10 })) as TimelineItem[]} sessionActive />
        </>,
      );
    });
    assert.equal(intervalStarts, 1, "two timelines and many rows still create one interval");
    assert.equal(visibilityAdds, 1, "the page clock owns one visibility listener");

    for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
      await act(async () => disclosure.click());
    }

    assert.equal(container.querySelectorAll(".tl-step").length, 6, "two tools and a thought in each timeline");
    assert.equal(container.querySelectorAll("details.tl-step").length, 4, "the thought and the tool with output disclose");
    assert.equal(container.querySelectorAll(".tl-step time, .tl-step .tl-timestamp-meta").length, 0,
      "no step carries a Started, Last Activity or Recorded line");
    assert.equal(container.querySelectorAll(".tl-agent-msg time").length, 0, "message rows carry no timestamp");

    const details = stepNamed(container, "Details Tool");
    assert.ok(details);
    assert.equal(trailText(details), "10s", "one trailing fact: the duration");
    const toolSummary = details.querySelector<HTMLElement>("summary");
    assert.ok(toolSummary);
    assert.equal(toolSummary.getAttribute("aria-label"), "Details Tool · Completed");
    const toolDescription = toolSummary.getAttribute("aria-describedby");
    assert.ok(toolDescription);
    const tooltip = testDocument.getElementById(toolDescription);
    assert.equal(tooltip?.getAttribute("role"), "tooltip");
    assert.match(tooltip?.textContent ?? "", /^Started .+, finished .+ \(10s\)$/, "the exact span lives in the trail's tooltip");
    assert.ok(details.querySelector(".tl-step-trail")?.contains(tooltip!));

    const thought = container.querySelector<HTMLElement>("details.tl-step summary[aria-label^='Thought']");
    assert.ok(thought, "a thought is a step");
    for (const head of container.querySelectorAll(".tl-step-head")) {
      assert.doesNotMatch(head.textContent ?? "", /Recorded|Last Activity/);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(globalThis, "setInterval", { configurable: true, writable: true, value: originalSetInterval });
    Object.defineProperty(globalThis, "clearInterval", { configurable: true, writable: true, value: originalClearInterval });
    testDocument.addEventListener = originalAdd as typeof testDocument.addEventListener;
    testDocument.removeEventListener = originalRemove as typeof testDocument.removeEventListener;
  }
  assert.equal(intervalClears, 1);
  assert.equal(visibilityRemoves, 1);
});

test("quiet active sessions keep the shared clock advancing", async () => {
  let now = startedAt;
  let tick: (() => void) | undefined;
  const originalDateNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => now });
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: ((callback: () => void) => { tick = callback; return 303; }) as unknown as typeof setInterval,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<EventTimeline items={[{ kind: "turn_interrupted", id: 30, createdAt: startedAt }]} sessionActive />);
    });
    assert.equal(container.querySelector("time [aria-hidden='true']")?.textContent, "just now");
    assert.ok(tick, "an active session owns the clock even when all current rows are point-in-time records");
    now += 120_000;
    await act(async () => tick?.());
    assert.equal(container.querySelector("time [aria-hidden='true']")?.textContent, "2m ago");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(Date, "now", { configurable: true, writable: true, value: originalDateNow });
    Object.defineProperty(globalThis, "setInterval", { configurable: true, writable: true, value: originalSetInterval });
  }
});

test("clock ticks update timestamp consumers without rerendering general timeline rows", async () => {
  let now = startedAt;
  let tick: (() => void) | undefined;
  let kindReads = 0;
  const originalDateNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => now });
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: ((callback: () => void) => { tick = callback; return 304; }) as unknown as typeof setInterval,
  });
  const countedItem = { id: 40, createdAt: startedAt } as unknown as TimelineItem;
  Object.defineProperty(countedItem, "kind", {
    configurable: true,
    enumerable: true,
    get: () => {
      kindReads += 1;
      return "turn_interrupted";
    },
  });
  const countedItems = [countedItem];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EventTimeline items={countedItems} sessionActive />));
    const readsAfterMount = kindReads;
    assert.ok(readsAfterMount > 0);
    assert.equal(container.querySelector("time [aria-hidden='true']")?.textContent, "just now");
    assert.ok(tick);

    now += 120_000;
    await act(async () => tick?.());

    assert.equal(container.querySelector("time [aria-hidden='true']")?.textContent, "2m ago");
    assert.equal(kindReads, readsAfterMount,
      "the changing clock context reaches time consumers without reevaluating the row item");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(Date, "now", { configurable: true, writable: true, value: originalDateNow });
    Object.defineProperty(globalThis, "setInterval", { configurable: true, writable: true, value: originalSetInterval });
  }
});

test("the shared clock starts when enabled, pauses while hidden, republishes on return, and tears down", async () => {
  let now = startedAt;
  let intervalStarts = 0;
  let intervalClears = 0;
  let visibilityAdds = 0;
  let visibilityRemoves = 0;
  const originalDateNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalAdd = document.addEventListener.bind(document);
  const originalRemove = document.removeEventListener.bind(document);
  const ownVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const setVisibility = (value: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
  };
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => now });
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: (() => { intervalStarts += 1; return 404; }) as unknown as typeof setInterval,
  });
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    writable: true,
    value: (() => { intervalClears += 1; }) as typeof clearInterval,
  });
  document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "visibilitychange") visibilityAdds += 1;
    originalAdd(type, listener, options);
  }) as unknown as typeof document.addEventListener;
  document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "visibilitychange") visibilityRemoves += 1;
    originalRemove(type, listener, options);
  }) as unknown as typeof document.removeEventListener;
  setVisibility("visible");

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const pointItem: TimelineItem[] = [{ kind: "turn_interrupted", id: 31, createdAt: startedAt }];
  try {
    await act(async () => root.render(<EventTimeline items={pointItem} sessionActive={false} />));
    assert.equal(intervalStarts, 0, "disabled timelines do not subscribe");

    now += 120_000;
    await act(async () => root.render(<EventTimeline items={pointItem} sessionActive />));
    assert.equal(intervalStarts, 1, "false-to-true starts the page clock");
    assert.equal(visibilityAdds, 1);
    assert.equal(container.querySelector("time [aria-hidden='true']")?.textContent, "2m ago",
      "enabling immediately publishes the current time");

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(intervalClears, 1, "hiding the page pauses the timer");

    now += 60_000;
    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    assert.equal(intervalStarts, 2, "returning to the page restarts the timer");
    assert.equal(container.querySelector("time [aria-hidden='true']")?.textContent, "3m ago",
      "returning immediately republishes before the next interval");

    await act(async () => root.render(<EventTimeline items={pointItem} sessionActive={false} />));
    assert.equal(intervalClears, 2, "true-to-false tears down the timer");
    assert.equal(visibilityRemoves, 1, "true-to-false removes the shared visibility listener");
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(intervalStarts, 2, "a torn-down clock cannot restart from later visibility events");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(Date, "now", { configurable: true, writable: true, value: originalDateNow });
    Object.defineProperty(globalThis, "setInterval", { configurable: true, writable: true, value: originalSetInterval });
    Object.defineProperty(globalThis, "clearInterval", { configurable: true, writable: true, value: originalClearInterval });
    document.addEventListener = originalAdd as typeof document.addEventListener;
    document.removeEventListener = originalRemove as typeof document.removeEventListener;
    if (ownVisibilityDescriptor) Object.defineProperty(document, "visibilityState", ownVisibilityDescriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("live elapsed time never falls behind the latest observed activity", async () => {
  const nowBehindObservation = startedAt + 45_000;
  const originalDateNow = Date.now;
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => nowBehindObservation });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const observedTool: TimelineItem[] = [{
    kind: "tool_call",
    id: 32,
    toolCallId: "clock-behind",
    title: "Observed Tool",
    status: "running",
    text: "",
    startedAt: startedAt + 40_000,
    lastActivityAt: startedAt + 50_000,
  }];
  try {
    await act(async () => root.render(<EventTimeline items={observedTool} sessionActive />));
    const disclosure = container.querySelector<HTMLButtonElement>(".tl-work > .disclosure-trigger");
    assert.ok(disclosure);
    await act(async () => disclosure.click());
    assert.equal(trailText(container.querySelector(".tl-step")), "10s",
      "elapsed is bounded below by the observed start-to-activity span even when the clock is behind");
    await act(async () => root.render(<EventTimeline items={observedTool} sessionActive={false} />));
    assert.equal(trailText(container.querySelector(".tl-step")), "10s",
      "the active-to-idle transition preserves the same defensible duration");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(Date, "now", { configurable: true, writable: true, value: originalDateNow });
  }
});

test("a live one-observation tool counts its elapsed time until it becomes a stable record", async () => {
  const originalDateNow = Date.now;
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => startedAt + 10_000 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const oneObservationTool: TimelineItem[] = [{
    kind: "tool_call",
    id: 33,
    toolCallId: "one-live-observation",
    title: "Live Tool",
    status: "running",
    text: "",
    startedAt,
    lastActivityAt: startedAt,
  }];
  try {
    await act(async () => root.render(<EventTimeline items={oneObservationTool} sessionActive />));
    const disclosure = container.querySelector<HTMLButtonElement>(".tl-work > .disclosure-trigger");
    assert.ok(disclosure);
    await act(async () => disclosure.click());
    assert.equal(trailText(container.querySelector(".tl-step")), "10s");
    assert.match(container.querySelector(".tl-step-trail > span")?.textContent ?? "", /^Started /);

    await act(async () => root.render(<EventTimeline items={oneObservationTool} sessionActive={false} />));
    assert.equal(trailText(container.querySelector(".tl-step")), undefined, "one observation has no duration to show");
    assert.match(container.querySelector(".tl-step-trail .sr-only")?.textContent ?? "", /^Finished [^(]+$/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(Date, "now", { configurable: true, writable: true, value: originalDateNow });
  }
});

test("live point-in-time rows remain one Recorded timestamp, and a prompt carries none", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EventTimeline
      items={[{ kind: "user_message", id: 34, text: "Queued prompt", createdAt: startedAt }]}
      sessionActive
    />));
    assert.equal(container.querySelectorAll("time").length, 0, "the turn footer, not the prompt, carries its time");
    assert.doesNotMatch(container.textContent ?? "", /Recorded|Started|Last Activity/);

    await act(async () => root.render(<EventTimeline
      items={[{ kind: "turn_interrupted", id: 35, createdAt: startedAt }]}
      sessionActive
    />));
    assert.equal(container.querySelectorAll(".tl-interrupted time").length, 1);
    assert.equal(container.querySelector(".tl-interrupted .tl-timestamp-label")?.textContent, "Recorded");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("inactive sessions show stable absolute times and bound dangling tools to observed activity", async () => {
  let intervalStarts = 0;
  const originalSetInterval = globalThis.setInterval;
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: (() => { intervalStarts += 1; return 202; }) as unknown as typeof setInterval,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<EventTimeline items={items} sessionActive={false} />);
    });
    for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
      await act(async () => disclosure.click());
    }

    assert.equal(intervalStarts, 0, "terminal sessions do not retain the live ticker");
    const danglingTool = stepNamed(container, "Bare Tool");
    assert.ok(danglingTool);
    assert.equal(trailText(danglingTool), "10s", "a dangling tool's duration ends at its last observed activity");

    for (const trail of container.querySelectorAll(".tl-step-trail")) {
      assert.doesNotMatch(trail.textContent ?? "", /ago|just now/i, "a settled step's span is absolute");
    }

    const subagentItems: TimelineItem[] = [
      {
        kind: "tool_call",
        id: 20,
        toolCallId: "agent",
        title: "Agent",
        toolKind: "agent",
        status: "completed",
        text: "",
        startedAt,
        lastActivityAt: startedAt + 10_000,
        completedAt: startedAt + 10_000,
        subagentRollup: { durationMs: 10_000, inputTokens: 5, outputTokens: 3 },
      },
      {
        kind: "tool_call",
        id: 21,
        toolCallId: "child",
        title: "Child Tool",
        status: "completed",
        text: "",
        parentToolUseId: "agent",
        startedAt: startedAt + 1_000,
        lastActivityAt: startedAt + 2_000,
        completedAt: startedAt + 2_000,
      },
    ];
    await act(async () => root.render(<EventTimeline items={subagentItems} sessionActive={false} />));
    for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
      await act(async () => disclosure.click());
    }
    const subagent = container.querySelector<HTMLElement>(".tl-subagent");
    assert.ok(subagent);
    assert.equal(subagent.textContent?.match(/Duration/g)?.length, 1, "subagent duration is rendered once");
    const subagentToggle = subagent.querySelector<HTMLButtonElement>(".subagent-toggle");
    assert.ok(subagentToggle);
    assert.match(subagentToggle.getAttribute("aria-label") ?? "", /^Agent · 1 Step · Completed/);
    assert.doesNotMatch(subagentToggle.getAttribute("aria-label") ?? "", /Started|Last Activity|2026/);
    const subagentDescription = subagentToggle.getAttribute("aria-describedby");
    assert.ok(subagentDescription);
    assert.match(document.getElementById(subagentDescription)?.textContent ?? "", /Started.*Last Activity.*Duration/s);

    const oneEventTool: TimelineItem[] = [{
      kind: "tool_call",
      id: 22,
      toolCallId: "single-terminal-event",
      title: "Imported Tool",
      status: "completed",
      text: "",
      startedAt,
      lastActivityAt: startedAt,
      completedAt: startedAt,
    }];
    await act(async () => root.render(<EventTimeline items={oneEventTool} sessionActive={false} />));
    assert.doesNotMatch(container.textContent ?? "", /Duration|0ms/,
      "one terminal observation does not fabricate a zero-duration measurement");
    assert.equal(trailText(container.querySelector(".tl-step")), undefined);
    assert.match(container.querySelector(".tl-step-trail .sr-only")?.textContent ?? "", /^Finished /,
      "one terminal tool observation is described by its one time");

    const oneEventSubagent: TimelineItem[] = [
      {
        kind: "tool_call",
        id: 23,
        toolCallId: "single-agent-event",
        title: "Imported Agent",
        toolKind: "agent",
        status: "completed",
        text: "",
        startedAt,
        lastActivityAt: startedAt,
        completedAt: startedAt,
      },
      {
        kind: "tool_call",
        id: 24,
        toolCallId: "single-agent-child",
        title: "Imported Child",
        status: "completed",
        text: "",
        parentToolUseId: "single-agent-event",
        startedAt,
        lastActivityAt: startedAt,
        completedAt: startedAt,
      },
    ];
    await act(async () => root.render(<EventTimeline items={oneEventSubagent} sessionActive={false} />));
    assert.equal(container.querySelector(".tl-subagent-time .tl-timestamp-label")?.textContent, "Recorded",
      "one imported subagent observation uses the same one-point copy as messages and thoughts");
    assert.equal(container.querySelectorAll(".tl-subagent-time time").length, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(globalThis, "setInterval", { configurable: true, writable: true, value: originalSetInterval });
  }
});
