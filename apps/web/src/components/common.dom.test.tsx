import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  BackgroundDeliveryBadge,
  BackgroundNotificationBadge,
  BackgroundWorkBadge,
  ActiveSubagentsBadge,
  CopyButton,
  ChangeStatusBadge,
  SessionStatusIndicators,
  UntrackedBackgroundWorkBadge,
} from "./common.js";

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
    assert.ok(badges.every((badge) => badge.getAttribute("role") === "status"));
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

test("active subagent badges expose their count and open the active work", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let opens = 0;
  try {
    await act(async () => {
      root.render(<ActiveSubagentsBadge count={2} onOpen={() => { opens += 1; }} />);
    });
    const badge = container.querySelector<HTMLButtonElement>('button[aria-label="2 Subagents Active"]');
    assert.equal(badge?.textContent?.trim(), "2 Subagents Active");
    await act(async () => { badge?.click(); });
    assert.equal(opens, 1);
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

test("Untracked capability and push receipt badges expose honest Title Case boundaries", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<>
        <UntrackedBackgroundWorkBadge />
        <BackgroundNotificationBadge state="service_accepted" />
        <BackgroundNotificationBadge state="shown" />
        <BackgroundNotificationBadge state="clicked" />
      </>);
    });
    assert.deepEqual(
      [...container.querySelectorAll(".background-work-badge")].map((badge) => badge.textContent),
      ["Detached Work: Untracked", "Push Service Accepted", "Notification Displayed", "Notification Clicked"],
    );
    assert.match(container.querySelector(".background-work-untracked")?.getAttribute("title") ?? "", /cannot promise/i);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});


test("session indicators preserve simultaneous lifecycle, attention, and change dimensions", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<>
        <SessionStatusIndicators disconnected session={{
          status: "running",
          pendingApproval: {
            requestId: "question",
            title: "Choose a database",
            options: [],
            kind: "question",
          },
        }} />
        <ChangeStatusBadge change={{
          kind: "ready_for_review",
          label: "Ready for Review",
          description: "Git confirms reviewable commits.",
          supplement: {
            kind: "uncommitted_changes",
            label: "Uncommitted Changes",
            description: "Git confirms additional local work outside the pull request.",
          },
        }} />
      </>);
    });
    assert.match(container.textContent ?? "", /Running/);
    assert.match(container.textContent ?? "", /Answer Required/);
    assert.match(container.textContent ?? "", /Ready for Review/);
    assert.match(container.textContent ?? "", /Uncommitted Changes/);
    assert.match(container.textContent ?? "", /Disconnected/);
    assert.ok(container.querySelector('[role="group"][aria-label="Session Status"]'));
    assert.equal(container.querySelector('[aria-label="Activity: Running"]')?.textContent?.trim(), "Running");
    assert.equal(container.querySelector('[aria-label="Attention: Answer Required"]')?.textContent?.trim(), "Answer Required");
    assert.equal(container.querySelector('[aria-label="Health: Disconnected"]')?.textContent?.trim(), "Disconnected");
    assert.ok(container.querySelector('[role="group"][aria-label="Change Status"]'));
    assert.equal(container.querySelector('[aria-label="Changes: Ready for Review"]')?.textContent?.trim(), "Ready for Review");
    assert.equal(container.querySelector('[aria-label="Changes: Uncommitted Changes"]')?.textContent?.trim(), "Uncommitted Changes");
    assert.equal(container.querySelectorAll(".change-status-indicators > .status-badge").length, 2,
      "compact surfaces preserve both facts as separate badges");
    const changeBadges = [...container.querySelectorAll(".change-status-indicators > .status-badge")];
    assert.equal(changeBadges[0]?.classList.contains("st-done"), true,
      "review readiness keeps its successful status tone and primary position");
    assert.equal(changeBadges[1]?.classList.contains("st-idle"), true,
      "uncommitted work keeps its neutral attention tone and supplemental position");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
