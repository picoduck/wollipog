import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import {
  BackgroundDeliveryBadge,
  BackgroundNotificationBadge,
  BackgroundWorkBadge,
  ActiveSubagentsBadge,
  AttentionBadge,
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

test("background-work badges expose current states and suppress the legacy settled sentinel", async () => {
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

    const badges = [...container.querySelectorAll('.status[data-group="background-work"]')];
    // "Orphaned" is retired everywhere (docs/design-system.md §11.2): lost work reads Lost.
    assert.deepEqual(
      badges.map((badge) => badge.textContent),
      ["Background Work: Waiting on External Job", "Background Work: Continuation Pending", "Background Work: Lost"],
    );
    assert.deepEqual(
      badges.map((badge) => badge.getAttribute("aria-label")),
      ["Background Work: Waiting on External Job", "Background Work: Continuation Pending", "Background Work: Lost"],
    );
    assert.ok(badges.every((badge) => badge.getAttribute("role") === "status"));
    assert.ok(badges.every((badge) => !badge.hasAttribute("title")));
    // Running work pulses in the info tone; lost work is danger and does not pulse.
    assert.deepEqual(
      badges.map((badge) => [badge.classList.contains("t-info"), badge.classList.contains("pulse"), badge.classList.contains("t-danger")]),
      [[true, true, false], [true, true, false], [false, false, true]],
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("compact background-work badges show specific states and expose every full label", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<>
        <BackgroundWorkBadge state="running" compact />
        <BackgroundWorkBadge state="continuation_pending" compact />
        <BackgroundWorkBadge state="orphaned" compact />
        <BackgroundWorkBadge state="resumed" compact />
      </>);
    });
    const badges = [...container.querySelectorAll('[role="status"]')];
    const fullLabels = [
      "Background Work: Waiting on External Job",
      "Background Work: Continuation Pending",
      "Background Work: Lost",
    ];
    assert.deepEqual(badges.map((badge) => badge.getAttribute("aria-label")), fullLabels);
    assert.deepEqual(badges.map((badge) => badge.getAttribute("title")), fullLabels);
    assert.deepEqual(
      badges.map((badge) => badge.querySelector(".sr-only")?.textContent),
      fullLabels,
    );
    assert.deepEqual(
      badges.map((badge) => badge.querySelector('[aria-hidden="true"]:last-child')?.textContent),
      ["Waiting on External Job", "Continuation Pending", "Background Work Lost"],
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("presentational background-work badges do not create a duplicate live region", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<BackgroundWorkBadge state="running" compact announce={false} />);
    });
    const badge = container.querySelector('.status[data-group="background-work"]');
    assert.ok(badge);
    assert.equal(badge.getAttribute("role"), null);
    assert.equal(badge.textContent, "Background Work: Waiting on External JobWaiting on External Job");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("responsive compact background-work badges carry wide and narrow visible labels under one accessible name", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    for (const [state, full, wide, narrow] of [
      ["running", "Waiting on External Job", "Waiting on External Job", "Job"],
      ["continuation_pending", "Continuation Pending", "Continuation Pending", "Pending"],
      ["orphaned", "Lost", "Background Work Lost", "Lost"],
    ] as const) {
      await act(async () => {
        root.render(<BackgroundWorkBadge state={state} compact responsiveCompact announce={false} />);
      });
      const badge = container.querySelector('.status[data-group="background-work"]')!;
      assert.equal(badge.getAttribute("aria-label"), `Background Work: ${full}`);
      assert.equal(badge.querySelector(".status-label-wide")?.textContent, wide);
      assert.equal(badge.querySelector(".status-label-narrow")?.textContent, narrow);
      assert.equal(badge.querySelector(".status-label-wide")?.getAttribute("aria-hidden"), "true");
      assert.equal(badge.querySelector(".status-label-narrow")?.getAttribute("aria-hidden"), "true");
    }
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("background-work indicators become keyboard-native panel controls when actionable", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let opens = 0;
  try {
    await act(async () => root.render(<>
      <BackgroundWorkBadge state="running" onOpen={() => { opens += 1; }} />
      <UntrackedBackgroundWorkBadge onOpen={() => { opens += 1; }} />
      <BackgroundDeliveryBadge state="accepted_without_result" onOpen={() => { opens += 1; }} />
      <BackgroundNotificationBadge state="retry" onOpen={() => { opens += 1; }} />
    </>));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    assert.equal(buttons.length, 4);
    assert.ok(buttons.every((button) => button.getAttribute("aria-controls") === "right-panel"));
    assert.deepEqual(
      [...container.querySelectorAll('[role="status"]')].map((status) => ({
        label: status.getAttribute("aria-label"),
        text: status.textContent,
      })),
      [{
        label: "Background Work: Waiting on External Job",
        text: "Background Work: Waiting on External Job",
      }],
      "an actionable current-state badge keeps one live announcement without changing button semantics",
    );
    for (const button of buttons) await act(async () => button.click());
    assert.equal(opens, 4);
  } finally {
    await act(async () => root.unmount());
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
    assert.equal(badge?.querySelector(".sr-only")?.textContent, "2 Subagents Active");
    assert.equal(badge?.querySelector('[aria-hidden="true"]:last-child')?.textContent, "2 Subagents");
    assert.equal(badge?.title, "2 Subagents Active");
    await act(async () => { badge?.click(); });
    assert.equal(opens, 1);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("attention badges retain their own accessible name without an override", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<AttentionBadge session={{
        status: "input_required",
        pendingApproval: {
          requestId: "question",
          title: "Choose a database",
          options: [],
          kind: "question",
        },
      }} />);
    });
    assert.equal(container.querySelector(".status")?.getAttribute("aria-label"), "Answer Required");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("background-delivery watchdog badges use compact visible labels and explanatory accessible copy", async () => {
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
          <BackgroundDeliveryBadge state="continuation_blocked" />
        </>,
      );
    });
    assert.deepEqual(
      [...container.querySelectorAll('.status[data-group="background-work"]')].map((badge) => badge.textContent),
      [
        "Result Pending",
        "Result Missing",
        "Transcript Delayed",
        "Notification Pending",
        "Result Blocked",
      ],
    );
    const badges = [...container.querySelectorAll<HTMLElement>('.status[data-group="background-work"]')];
    assert.match(badges[0]!.getAttribute("aria-label") ?? "", /^Background Work: Result Pending\. A background job finished/);
    assert.match(badges[0]!.title, /result has not yet been returned to this conversation\.$/);
    // Work that progresses on its own reads as working (info); a missing or blocked result asks for
    // a step, so it takes the needs-you tone (warning), as §11.2 gives Result Missing.
    assert.ok(badges[0]!.classList.contains("t-info"));
    assert.ok(badges[1]!.classList.contains("t-warning"));
    assert.ok(badges.slice(2, 4).every((badge) => badge.classList.contains("t-info")));
    assert.ok(badges[4]!.classList.contains("t-warning"));
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
      [...container.querySelectorAll('.status[data-group="background-work"]')].map((badge) => badge.textContent),
      ["Detached Work: Untracked", "Push Service Accepted", "Notification Displayed", "Notification Clicked"],
    );
    assert.deepEqual(
      [...container.querySelectorAll('.status[data-group="background-work"]')].slice(1)
        .map((badge) => badge.classList.contains("t-success")),
      [true, true, true],
      "settled notification history reads as done, not as attention",
    );
    const untracked = container.querySelector('.status[data-group="background-work"]');
    assert.ok(untracked?.classList.contains("no-dot"), "untracked detached work is a fact, so it is a flag with no dot");
    assert.match(untracked?.getAttribute("title") ?? "", /cannot promise/i);
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
        <SessionStatusIndicators session={{
          status: "queued",
          pendingApproval: null,
          capacityWait: {
            kind: "target_quota",
            description: "Execution target cloud-a is using 2 of 2 slots",
            usedUnits: 2,
            limitUnits: 2,
            requiredUnits: 1,
          },
        }} />
        <SessionStatusIndicators session={{
          status: "idle",
          pendingApproval: null,
          orchestratorCampaign: {
            pendingRequests: { human: 2, orchestrator: 3 },
          } as SessionView["orchestratorCampaign"],
        }} />
        <SessionStatusIndicators session={{
          status: "queued",
          pendingApproval: null,
          capacityWait: {
            kind: "capacity_lock",
            description: "Waiting for a concurrent Runner Capacity update",
            usedUnits: 1,
            limitUnits: 1,
            requiredUnits: 1,
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
    assert.match(container.querySelector('[aria-label="Needs Your Input: 2 Requests"]')?.textContent ?? "", /Needs Your Input\s*2/u);
    assert.match(container.querySelector('[aria-label="Orchestrator Action: 3 Requests"]')?.textContent ?? "", /Orchestrator Action\s*3/u);
    assert.equal(container.querySelector('[aria-label="Health: Disconnected"]')?.textContent?.trim(), "Disconnected");
    assert.equal(
      container.querySelector('[aria-label="Queue Reason: Execution target cloud-a is using 2 of 2 slots"]')
        ?.textContent?.trim(),
      "Target Quota",
    );
    assert.equal(
      container.querySelector('[aria-label="Queue Reason: Waiting for a concurrent Runner Capacity update"]')
        ?.textContent?.trim(),
      "Capacity Sync",
    );
    assert.ok(container.querySelector('[role="group"][aria-label="Change Status"]'));
    assert.equal(container.querySelector('[aria-label="Changes: Ready for Review"]')?.textContent?.trim(), "Ready for Review");
    assert.equal(container.querySelector('[aria-label="Changes: Uncommitted Changes"]')?.textContent?.trim(), "Uncommitted Changes");
    assert.equal(container.querySelectorAll(".change-status-indicators > .status").length, 2,
      "compact surfaces preserve both facts as separate badges");
    const changeBadges = [...container.querySelectorAll(".change-status-indicators > .status")];
    assert.equal(changeBadges[0]?.classList.contains("t-success"), true,
      "review readiness keeps its successful status tone and primary position");
    assert.equal(changeBadges[1]?.classList.contains("t-neutral"), true,
      "uncommitted work is a neutral fact in the supplemental position");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("direct attention and campaign request badges keep distinct destinations", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let directOpens = 0;
  let campaignOpens = 0;
  try {
    await act(async () => {
      root.render(<SessionStatusIndicators
        session={{
          status: "input_required",
          pendingApproval: {
            requestId: "root-question",
            title: "Choose a database",
            options: [],
            kind: "question",
          },
          orchestratorCampaign: {
            pendingRequests: { human: 2, orchestrator: 3 },
          } as SessionView["orchestratorCampaign"],
        }}
        onOpenAttention={() => { directOpens += 1; }}
        onOpenCampaignRequests={() => { campaignOpens += 1; }}
      />);
    });
    const direct = container.querySelector('[aria-label="Attention: Answer Required"]') as HTMLButtonElement;
    const humanCampaign = container.querySelector('[aria-label="Needs Your Input: 2 Requests"]') as HTMLButtonElement;
    const orchestratorCampaign = container.querySelector('[aria-label="Orchestrator Action: 3 Requests"]') as HTMLButtonElement;
    await act(async () => {
      direct.click();
      humanCampaign.click();
      orchestratorCampaign.click();
    });
    assert.equal(directOpens, 1);
    assert.equal(campaignOpens, 2);
  } finally {
    await act(async () => root.unmount());
    happyContainer.remove();
  }
});

test("active-turn capacity and queue ordering keep distinct labels, accessible names, and tooltips", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<>
        <SessionStatusIndicators session={{
          status: "queued",
          pendingApproval: null,
          capacityWait: {
            kind: "active_turn_capacity",
            description: "Active Turn Capacity is 2 of 2 turns used",
            usedUnits: 2,
            limitUnits: 2,
            requiredUnits: 1,
          },
        }} />
        <SessionStatusIndicators session={{
          status: "queued",
          pendingApproval: null,
          capacityWait: {
            kind: "queue_order",
            description: "Waiting behind an older capacity request",
            usedUnits: 1,
            limitUnits: 2,
            requiredUnits: 1,
          },
        }} />
      </>);
    });
    const activeTurnCapacityBadge = container.querySelector(
      '[aria-label="Queue Reason: Active Turn Capacity is 2 of 2 turns used"]',
    );
    assert.equal(activeTurnCapacityBadge?.textContent?.trim(), "Active Turn Capacity");
    assert.equal(activeTurnCapacityBadge?.getAttribute("title"), "Active Turn Capacity is 2 of 2 turns used");
    assert.equal(
      container.querySelector('[aria-label="Queue Reason: Waiting behind an older capacity request"]')
        ?.textContent?.trim(),
      "Queue Order",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
