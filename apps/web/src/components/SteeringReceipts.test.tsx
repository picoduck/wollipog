import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import type { SteeringAttemptView } from "@wollipog/protocol";
import type { TimelineItem } from "../timeline.js";
import {
  deriveSteeringReceipts,
  MAX_RECENT_PREVIOUS_TURN_RECEIPTS,
  MAX_VISIBLE_STEERING_RECEIPTS,
  SteeringReceipts,
} from "./SteeringReceipts.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function attempt(
  submissionId: string,
  state: SteeringAttemptView["state"],
  overrides: Partial<SteeringAttemptView> = {},
): SteeringAttemptView {
  return {
    submissionId,
    turnId: "turn-1",
    source: "direct",
    text: `Preview ${submissionId}`,
    state,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

test("receipt derivation exposes every durable label and retires only canonical accepted messages", () => {
  const attempts = [
    attempt("pending", "pending"),
    attempt("accepted-visible", "accepted"),
    attempt("accepted-retired", "accepted"),
    attempt("converted", "converted_to_queue", { reason: "stale_turn" }),
    attempt("rejected", "rejected", { reason: "provider_rejected" }),
    attempt("uncertain", "uncertain", { reason: "transport_uncertain" }),
    attempt("queued-again", "uncertain", {
      resolution: { action: "queue_again", state: "applied", queuedPromptId: "queued-1" },
    }),
    attempt("dismissed", "uncertain", { resolution: { action: "dismiss", state: "applied" } }),
  ];
  const timelineItems: TimelineItem[] = [
    {
      kind: "user_message",
      id: 1,
      text: "Canonical",
      submissionId: "accepted-retired",
      deliveryIntent: "steer",
    },
    { kind: "user_message", id: 2, text: "Not canonical", submissionId: "accepted-visible" },
  ];
  const receipts = deriveSteeringReceipts(attempts, timelineItems, "turn-1");
  assert.deepEqual(receipts.map(({ attempt, label }) => [attempt.submissionId, label]), [
    ["pending", "Steering\u2026"],
    ["accepted-visible", "Accepted"],
    ["converted", "Converted to Queue"],
    ["rejected", "Rejected"],
    ["uncertain", "Delivery Uncertain"],
    ["queued-again", "Queued Again"],
  ]);
});

test("receipt derivation remains bounded to the projected recovery limit", () => {
  const receipts = deriveSteeringReceipts(
    Array.from({ length: MAX_VISIBLE_STEERING_RECEIPTS + 7 }, (_, index) =>
      attempt(`bounded-${index}`, "rejected", { reason: "provider_rejected" })
    ),
    [],
    "turn-1",
  );
  assert.equal(receipts.length, MAX_VISIBLE_STEERING_RECEIPTS);
  assert.equal(receipts.at(-1)?.attempt.submissionId, "bounded-49");
});

test("receipt retirement keeps unresolved and current-turn work plus the recent previous-turn tail", () => {
  const previousTerminal = Array.from(
    { length: MAX_RECENT_PREVIOUS_TURN_RECEIPTS + 1 },
    (_, index) => attempt(`previous-${index}`, "rejected", {
      turnId: "turn-previous",
      createdAt: 100 - index,
      reason: "provider_rejected",
    }),
  );
  const attempts = [
    attempt("pending-previous", "pending", { turnId: "turn-previous", createdAt: 1 }),
    attempt("uncertain-previous", "uncertain", {
      turnId: "turn-previous",
      createdAt: 2,
      reason: "transport_uncertain",
    }),
    attempt("resolution-pending-previous", "uncertain", {
      turnId: "turn-previous",
      createdAt: 3,
      reason: "transport_uncertain",
      resolution: { action: "queue_again", state: "pending" },
    }),
    attempt("current-rejected", "rejected", {
      turnId: "turn-current",
      createdAt: 4,
      reason: "provider_rejected",
    }),
    attempt("current-accepted", "accepted", { turnId: "turn-current", createdAt: 5 }),
    attempt("current-canonical", "accepted", { turnId: "turn-current", createdAt: 6 }),
    attempt("previous-canonical", "accepted", { turnId: "turn-previous", createdAt: 200 }),
    ...previousTerminal,
  ];
  const timelineItems: TimelineItem[] = [
    {
      kind: "user_message",
      id: 10,
      text: "Canonical current steer",
      submissionId: "current-canonical",
      deliveryIntent: "steer",
    },
    {
      kind: "user_message",
      id: 11,
      text: "Canonical previous steer",
      submissionId: "previous-canonical",
      deliveryIntent: "steer",
    },
  ];

  assert.deepEqual(
    deriveSteeringReceipts(attempts, timelineItems, "turn-current")
      .map(({ attempt: receipt }) => receipt.submissionId),
    [
      "pending-previous",
      "uncertain-previous",
      "resolution-pending-previous",
      "current-rejected",
      "current-accepted",
      "previous-0",
      "previous-1",
      "previous-2",
      "previous-3",
      "previous-4",
    ],
  );
});

test("receipt markup shows bounded reasons, pending resolution copy, disabled actions, and E2E identity", () => {
  const html = renderToStaticMarkup(<SteeringReceipts
    attempts={[
      attempt("converted", "converted_to_queue", { reason: "stale_turn" }),
      attempt("rejected", "rejected", { reason: "provider_rejected" }),
      attempt("uncertain", "uncertain", { reason: "transport_uncertain" }),
      attempt("pending-resolution", "uncertain", {
        reason: "transport_uncertain",
        resolution: { action: "queue_again", state: "pending" },
      }),
    ]}
    timelineItems={[]}
    activeTurnId="turn-1"
    onQueueAgain={() => {}}
    onDismiss={() => {}}
  />);
  assert.match(html, /data-testid="steering-attempt-converted"/);
  assert.match(html, /Stale turn\./);
  assert.match(html, /Provider rejected\./);
  assert.match(html, /Transport uncertain\./);
  assert.match(html, /Queue Again is pending\./);
  assert.match(html, /aria-busy="true"/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
});

test("uncertain receipt actions call the matching callback and local pending state disables both", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const queueAgain: string[] = [];
  const dismissed: string[] = [];
  const uncertain = attempt("actionable", "uncertain", { reason: "transport_uncertain" });
  const render = (pendingAction?: "queue_again" | "dismiss") => (
    <SteeringReceipts
      attempts={[uncertain]}
      timelineItems={[]}
      pendingActions={pendingAction ? new Map([["actionable", pendingAction]]) : undefined}
      onQueueAgain={(submissionId) => queueAgain.push(submissionId)}
      onDismiss={(submissionId) => { dismissed.push(submissionId); }}
    />
  );

  await act(async () => root.render(render()));
  let buttons = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  assert.deepEqual(buttons.map((button) => button.textContent?.trim()), ["Queue Again", "Dismiss"]);
  await act(async () => { buttons[0]!.click(); buttons[1]!.click(); });
  assert.deepEqual(queueAgain, ["actionable"]);
  assert.deepEqual(dismissed, ["actionable"]);

  await act(async () => root.render(render("dismiss")));
  buttons = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  assert.equal(buttons.every((button) => button.disabled), true);
  assert.match(container.textContent ?? "", /Dismiss is pending\./);
  await act(async () => { buttons[0]!.click(); buttons[1]!.click(); });
  assert.deepEqual(queueAgain, ["actionable"], "disabled actions cannot double-submit");
  assert.deepEqual(dismissed, ["actionable"], "disabled actions cannot double-submit");

  await act(async () => root.unmount());
  container.remove();
});

test("one rejected receipt can be durably dismissed", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const dismissed: string[] = [];

  await act(async () => root.render(<SteeringReceipts
    attempts={[attempt("rejected-one", "rejected", { reason: "no_active_provider_turn" })]}
    timelineItems={[]}
    onQueueAgain={() => {}}
    onDismiss={(submissionId) => { dismissed.push(submissionId); }}
  />));
  const button = container.querySelector("button") as HTMLButtonElement;
  assert.equal(button.textContent?.trim(), "Dismiss");
  await act(async () => button.click());
  assert.deepEqual(dismissed, ["rejected-one"]);

  await act(async () => root.unmount());
  container.remove();
});

test("multiple rejected receipts collapse and clear together without touching actionable receipts", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const dismissed: string[] = [];
  let dismissalsInFlight = 0;
  let maxDismissalsInFlight = 0;

  await act(async () => root.render(<SteeringReceipts
    attempts={[
      attempt("rejected-a", "rejected"),
      attempt("rejected-b", "rejected"),
      attempt("rejected-c", "rejected"),
      attempt("pending-actionable", "pending"),
      attempt("uncertain-actionable", "uncertain"),
    ]}
    timelineItems={[]}
    pendingActions={new Map([["rejected-b", "dismiss"]])}
    onQueueAgain={() => {}}
    onDismiss={async (submissionId) => {
      dismissalsInFlight += 1;
      maxDismissalsInFlight = Math.max(maxDismissalsInFlight, dismissalsInFlight);
      await Promise.resolve();
      dismissed.push(submissionId);
      dismissalsInFlight -= 1;
    }}
  />));

  const group = container.querySelector(".steering-terminal-receipts") as HTMLDivElement;
  assert.ok(group);
  const toggle = group.querySelector('[aria-controls="rejected-steering-receipts"]') as HTMLButtonElement;
  assert.equal(toggle.getAttribute("aria-expanded"), "false",
    "the terminal group has a bounded collapsed footprint by default");
  assert.match(toggle.textContent ?? "", /3 Rejected Receipts/);
  assert.ok(container.querySelector('[data-testid="steering-attempt-pending-actionable"]'));
  assert.ok(container.querySelector('[data-testid="steering-attempt-uncertain-actionable"]'));
  const clearAll = [...group.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Clear All") as HTMLButtonElement;
  await act(async () => {
    clearAll.click();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
  assert.deepEqual(dismissed, ["rejected-a", "rejected-c"]);
  assert.equal(maxDismissalsInFlight, 1, "bulk dismissal applies bounded backpressure");

  await act(async () => root.unmount());
  container.remove();
});

test("applied dismissals stay absent after authoritative session state refreshes", () => {
  const rejected = attempt("dismissed-rejection", "rejected", {
    resolution: { action: "dismiss", state: "applied" },
  });
  assert.deepEqual(deriveSteeringReceipts([rejected], [], "turn-1"), []);
  assert.deepEqual(deriveSteeringReceipts([{ ...rejected }], [], "turn-1"), []);
});

test("a bounded window is not evidence that an accepted steer never landed", () => {
  const accepted: SteeringAttemptView = {
    submissionId: "submission-accepted",
    turnId: "turn-1",
    state: "accepted",
    createdAt: 1,
    updatedAt: 2,
  } as SteeringAttemptView;
  // Its canonical steer message sits in an unloaded turn; inferring from that absence would show an
  // unsettled receipt for a steer the provider already applied.
  assert.deepEqual(deriveSteeringReceipts([accepted], [], undefined, true), []);
  assert.equal(deriveSteeringReceipts([accepted], [], undefined, false).length, 1);
});
