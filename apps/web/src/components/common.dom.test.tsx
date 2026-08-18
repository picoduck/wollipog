import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { BackgroundDeliveryBadge, BackgroundWorkBadge, CopyButton } from "./common.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

async function renderCopyButton(writeText: () => Promise<void>) {
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(<CopyButton text="launch command" ariaLabel="Copy Launch Command" iconOnly className="copy-btn icon-only-copy" />);
  });
  return { container, root };
}

test("icon-only copy controls show visible success feedback", async () => {
  const { container, root } = await renderCopyButton(async () => {});
  try {
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = container.querySelector("button")!;
    assert.equal(button.classList.contains("copy-status-copied"), true);
    assert.ok(button.querySelector(".copy-status-icon-copied"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("icon-only copy controls show visible failure feedback", async () => {
  const { container, root } = await renderCopyButton(async () => { throw new Error("blocked"); });
  try {
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = container.querySelector("button")!;
    assert.equal(button.classList.contains("copy-status-failed"), true);
    assert.ok(button.querySelector(".copy-status-icon-failed"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("background-work badges expose every durable state with Title Case visible text", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <>
          <BackgroundWorkBadge state="running" />
          <BackgroundWorkBadge state="continuation_pending" />
          <BackgroundWorkBadge state="orphaned" />
          <BackgroundWorkBadge state="resumed" />
        </>,
      );
    });

    const badges = [...container.querySelectorAll(".background-work-badge")];
    assert.deepEqual(
      badges.map((badge) => badge.textContent),
      ["Background Work: Waiting on External Job", "Background Work: Continuation Pending", "Background Work: Orphaned", "Background Work: Resumed"],
    );
    assert.deepEqual(
      badges.map((badge) => badge.getAttribute("aria-label")),
      ["Background Work: Waiting on External Job", "Background Work: Continuation Pending", "Background Work: Orphaned", "Background Work: Resumed"],
    );
    assert.deepEqual(
      badges.map((badge) => [...badge.classList].at(-1)),
      ["background-work-running", "background-work-running", "background-work-orphaned", "background-work-resumed"],
    );
    assert.equal(container.querySelectorAll(".background-work-dot[aria-hidden='true']").length, 4);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("background-delivery watchdog badges use precise Title Case stage labels", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <>
          <BackgroundDeliveryBadge state="terminal_without_continuation" />
          <BackgroundDeliveryBadge state="accepted_without_result" />
          <BackgroundDeliveryBadge state="result_not_projected" />
          <BackgroundDeliveryBadge state="dashboard_observation_pending" />
        </>,
      );
    });
    assert.deepEqual(
      [...container.querySelectorAll(".background-work-badge")].map((badge) => badge.textContent),
      [
        "Background Delivery: Terminal Result Awaiting Continuation",
        "Background Delivery: Accepted Continuation Awaiting Result",
        "Background Delivery: Result Awaiting Transcript Projection",
        "Background Delivery: Notification Awaiting Dashboard",
      ],
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
