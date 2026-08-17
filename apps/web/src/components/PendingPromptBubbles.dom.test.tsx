import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { PendingPromptView } from "@wollipog/protocol";
import {
  hasNewPendingPrompt,
  PendingPromptBubbles,
  queuedPromptsWithControls,
  shouldShowOptimisticPrompt,
} from "./PendingPromptBubbles.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const pending = (overrides: Partial<PendingPromptView>): PendingPromptView => ({
  commandId: "prompt-1",
  text: "Durable message",
  state: "pending",
  revision: 0,
  attemptCount: 0,
  createdAt: 10,
  updatedAt: 10,
  ...overrides,
});

test("queued and active-turn prompts never create a legacy optimistic transcript bubble", () => {
  assert.equal(shouldShowOptimisticPrompt("idle", false), true);
  assert.equal(shouldShowOptimisticPrompt("queued", false), false);
  assert.equal(shouldShowOptimisticPrompt("starting", false), false);
  assert.equal(shouldShowOptimisticPrompt("running", false), false);
  assert.equal(shouldShowOptimisticPrompt("input_required", false), false);
  assert.equal(shouldShowOptimisticPrompt("idle", true), false);
});

test("a newly returned durable prompt retracts a stale-status optimistic bubble", () => {
  const known = new Set(["older-prompt"]);
  assert.equal(hasNewPendingPrompt(known, [pending({ commandId: "older-prompt" })]), false);
  assert.equal(hasNewPendingPrompt(known, [
    pending({ commandId: "older-prompt" }),
    pending({ commandId: "new-prompt" }),
  ]), true);
  assert.equal(hasNewPendingPrompt(known, undefined), false);
});

test("durable transcript projection retains the live queue's steering controls", () => {
  const queue = [{ id: "new-prompt", text: "Steer me", hasImages: false, steerable: true }];
  assert.equal(queuedPromptsWithControls(queue), queue);
  assert.deepEqual(queuedPromptsWithControls(undefined), []);
});

test("one pending action disables every prompt action", async () => {
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLDivElement);
  const actions: string[] = [];
  try {
    await act(async () => {
      root.render(<PendingPromptBubbles
        prompts={[
          pending({ commandId: "prompt-1", canCancel: true }),
          pending({ commandId: "prompt-2", state: "failed", canDismiss: true }),
        ]}
        deliveredCommandIds={new Set()}
        liveQueueIds={new Set()}
        canCancelLive
        pendingAction="prompt-1"
        onCancelPending={() => actions.push("pending")}
        onCancelLive={() => actions.push("live")}
        onDismiss={() => actions.push("dismiss")}
      />);
    });
    const buttons = [...container.querySelectorAll("button")];
    assert.equal(buttons.length, 2);
    assert.equal(buttons.every((button) => button.disabled), true);
    assert.equal(buttons[0]!.getAttribute("aria-label"), "Cancelling Pending Message");
    assert.equal(buttons[0]!.parentElement?.getAttribute("aria-busy"), "true");
    assert.equal(buttons[1]!.getAttribute("aria-label"), "Dismiss Pending Message");
    assert.equal(buttons[1]!.parentElement?.getAttribute("aria-busy"), null);
    assert.match(container.textContent ?? "", /Cancelling…/);
    await act(async () => { buttons[1]!.click(); });
    assert.deepEqual(actions, []);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("pending prompts render as stable transcript bubbles and reconcile by command id", async () => {
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLDivElement);
  const actions: string[] = [];
  try {
    await act(async () => {
      root.render(<PendingPromptBubbles
        prompts={[
          pending({ commandId: "cancel-local", canCancel: true }),
          pending({ commandId: "cancel-live", state: "queued", attemptCount: 2 }),
          pending({
            commandId: "failed", state: "failed", errorCode: "COMMAND_CANCELLED",
            error: "prompt cancelled before runner delivery", canDismiss: true,
          }),
          pending({ commandId: "delivered", state: "started" }),
        ]}
        deliveredCommandIds={new Set(["delivered"])}
        liveQueueIds={new Set(["cancel-live", "failed"])}
        canCancelLive
        onCancelPending={(id) => actions.push(`pending:${id}`)}
        onCancelLive={(id) => actions.push(`live:${id}`)}
        onDismiss={(id) => actions.push(`dismiss:${id}`)}
      />);
    });
    assert.equal(container.querySelectorAll(".pending-prompt-bubble").length, 3);
    assert.equal(container.querySelector("[data-testid='pending-prompt-delivered']"), null);
    assert.deepEqual(
      [...container.querySelectorAll(".pending-prompt-state")].map((node) => node.textContent),
      ["Pending", "Queued", "Cancelled"],
    );
    const buttons = [...container.querySelectorAll("button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-describedby")), [
      "pending-prompt-details-cancel-local",
      "pending-prompt-details-cancel-live",
      "pending-prompt-details-failed",
    ]);
    await act(async () => { for (const button of buttons) button.click(); });
    assert.deepEqual(actions, ["pending:cancel-local", "live:cancel-live", "dismiss:failed"]);
    assert.match(container.textContent ?? "", /prompt cancelled before runner delivery/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
