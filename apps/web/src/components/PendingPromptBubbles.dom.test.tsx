import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { PendingPromptView } from "@wollipog/protocol";
import {
  hasNewPendingPrompt,
  pendingPromptLabel,
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

test("worktree-blocked durable prompts are clearly labelled Not Sent", () => {
  assert.equal(pendingPromptLabel(pending({
    state: "failed",
    errorCode: "WORKTREE_RECOVERY_REQUIRED",
    canRetry: true,
  })), "Not Sent");
});

test("worktree-blocked Retry remains visible but waits for confirmed recovery", async () => {
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLDivElement);
  const actions: string[] = [];
  try {
    await act(async () => root.render(<PendingPromptBubbles
      prompts={[pending({
        state: "failed", errorCode: "WORKTREE_RECOVERY_REQUIRED", canDismiss: true, canRetry: true,
      })]}
      deliveredCommandIds={new Set()}
      liveQueueIds={new Set()}
      canCancelLive={false}
      worktreeRecoveryPending
      onCancelPending={() => {}}
      onCancelLive={() => {}}
      onDismiss={() => actions.push("dismiss")}
      onRetry={() => actions.push("retry")}
    />));
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    assert.equal(retry.disabled, true);
    assert.match(retry.title, /Recover the selected worktree/u);
    await act(async () => retry.click());
    assert.deepEqual(actions, []);
    const dismiss = [...container.querySelectorAll("button")].find((button) => button.textContent === "Dismiss")!;
    assert.equal(dismiss.disabled, false, "the retained unsent prompt can be abandoned explicitly");
    await act(async () => dismiss.click());
    assert.deepEqual(actions, ["dismiss"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a stale authentication receipt cannot re-enable Retry during worktree recovery", async () => {
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLDivElement);
  const actions: string[] = [];
  const noOp = () => {};
  // The receipt still records the earlier authentication failure because it was retained before
  // the selected worktree failed pre-launch verification. The server rejects the retry with
  // HTTP 409 on the live recovery state alone, so the receipt's code must not re-enable it.
  const staleAuthReceipt = pending({
    commandId: "stale-auth-retry",
    state: "failed",
    errorCode: "PROVIDER_AUTHENTICATION_REQUIRED",
    error: "authentication recovery was dismissed; this message was not sent",
    canDismiss: true,
    canRetry: true,
  });
  const render = async (worktreeRecoveryPending: boolean) => {
    await act(async () => root.render(<PendingPromptBubbles
      prompts={[staleAuthReceipt]}
      deliveredCommandIds={new Set()}
      liveQueueIds={new Set()}
      canCancelLive={false}
      worktreeRecoveryPending={worktreeRecoveryPending}
      onCancelPending={noOp}
      onCancelLive={noOp}
      onDismiss={() => actions.push("dismiss")}
      onRetry={() => actions.push("retry")}
    />));
  };
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
  try {
    await render(true);
    const retry = button("Retry");
    assert.equal(retry.disabled, true,
      "a retry the server answers with HTTP 409 must not be offered as an available action");
    assert.match(retry.title, /Recover the selected worktree/u);
    await act(async () => retry.click());
    assert.deepEqual(actions, []);
    assert.equal(button("Dismiss").disabled, false,
      "the stale receipt can still be cleared while the worktree is unrecovered");

    // Authentication-only recovery keeps its existing behavior: the same receipt retries freely
    // once no worktree recovery is live.
    await render(false);
    const enabled = button("Retry");
    assert.equal(enabled.disabled, false);
    assert.equal(enabled.title, "");
    await act(async () => enabled.click());
    assert.deepEqual(actions, ["retry"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
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
        onRetry={() => actions.push("retry")}
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
          pending({
            commandId: "auth-retry", state: "failed", errorCode: "PROVIDER_AUTHENTICATION_REQUIRED",
            error: "authentication recovery was dismissed; this message was not sent",
            canDismiss: true, canRetry: true,
          }),
          pending({ commandId: "delivered", state: "started" }),
        ]}
        deliveredCommandIds={new Set(["delivered"])}
        liveQueueIds={new Set(["cancel-live", "failed"])}
        canCancelLive
        onCancelPending={(id) => actions.push(`pending:${id}`)}
        onCancelLive={(id) => actions.push(`live:${id}`)}
        onDismiss={(id) => actions.push(`dismiss:${id}`)}
        onRetry={(id) => actions.push(`retry:${id}`)}
      />);
    });
    assert.equal(container.querySelectorAll(".pending-prompt-bubble").length, 4);
    assert.equal(container.querySelector("[data-testid='pending-prompt-delivered']"), null);
    assert.deepEqual(
      [...container.querySelectorAll(".pending-prompt-state")].map((node) => node.textContent),
      ["Pending", "Queued", "Cancelled", "Delivery Failed"],
    );
    const buttons = [...container.querySelectorAll("button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-describedby")), [
      "pending-prompt-details-cancel-local",
      "pending-prompt-details-cancel-live",
      "pending-prompt-details-failed",
      "pending-prompt-details-auth-retry",
      "pending-prompt-details-auth-retry",
    ]);
    await act(async () => { for (const button of buttons) button.click(); });
    assert.deepEqual(actions, [
      "pending:cancel-local",
      "live:cancel-live",
      "dismiss:failed",
      "dismiss:auth-retry",
      "retry:auth-retry",
    ]);
    assert.match(container.textContent ?? "", /prompt cancelled before runner delivery/);
    assert.match(container.textContent ?? "", /message was not sent/);

    const noOp = () => {};
    await act(async () => {
      root.render(<PendingPromptBubbles
        prompts={[pending({
          commandId: "auth-retry", state: "failed", errorCode: "PROVIDER_AUTHENTICATION_REQUIRED",
          error: "authentication recovery was dismissed; this message was not sent",
          canDismiss: true, canRetry: true,
        })]}
        deliveredCommandIds={new Set()}
        liveQueueIds={new Set()}
        canCancelLive
        pendingAction="auth-retry"
        onCancelPending={noOp}
        onCancelLive={noOp}
        onDismiss={noOp}
        onRetry={noOp}
      />);
    });
    assert.deepEqual(
      [...container.querySelectorAll("button")].map((button) => [button.textContent, button.getAttribute("aria-label"), button.disabled]),
      [["Dismiss", "Dismiss Pending Message", true], ["Retry", "Retry Message", true]],
      "a shared busy identity must not claim both mutually exclusive actions are running",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("started prompts retire from partial transcripts using durable user-event evidence", async () => {
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  let root = createRoot(container as unknown as HTMLDivElement);
  const noOp = () => {};
  const render = async (prompts: PendingPromptView[]) => {
    await act(async () => {
      root.render(<PendingPromptBubbles
        prompts={prompts}
        // The correlated user_message is deliberately outside the loaded timeline page.
        deliveredCommandIds={new Set()}
        liveQueueIds={new Set()}
        canCancelLive={false}
        onCancelPending={noOp}
        onCancelLive={noOp}
        onDismiss={noOp}
        onRetry={noOp}
      />);
    });
  };
  const beforeCapacityRelease = pending({
    commandId: "admission-queued",
    state: "queued",
    attemptCount: 287,
  });
  const recoverable = pending({
    commandId: "uncertain",
    state: "uncertain",
    attemptCount: 4,
    canDismiss: true,
  });
  const afterCapacityRelease = {
    ...beforeCapacityRelease,
    state: "started" as const,
    userEventSeq: 991,
  };
  try {
    await render([beforeCapacityRelease, recoverable]);
    assert.ok(container.querySelector('[data-testid="pending-prompt-admission-queued"]'));
    assert.match(container.textContent ?? "", /287 Delivery Attempts/);

    await render([afterCapacityRelease, recoverable]);
    assert.equal(container.querySelector('[data-testid="pending-prompt-admission-queued"]'), null,
      "the receipt's sequence is authoritative even without its event in the loaded page");
    assert.ok(container.querySelector('[data-testid="pending-prompt-uncertain"]'),
      "an uncertain receipt without durable user-event evidence remains recoverable");

    await act(async () => { root.unmount(); });
    root = createRoot(container as unknown as HTMLDivElement);
    await render([afterCapacityRelease, recoverable]);
    assert.equal(container.querySelector('[data-testid="pending-prompt-admission-queued"]'), null,
      "refresh/reconnect cannot resurrect a durable delivered prompt");
    assert.ok(container.querySelector('[data-testid="pending-prompt-uncertain"]'));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("retained-prompt Retry and Dismiss are described by the message and the recovery reason", async () => {
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLDivElement);
  const noOp = () => {};
  const render = async (worktreeRecoveryPending: boolean) => {
    await act(async () => root.render(<PendingPromptBubbles
      prompts={[pending({
        commandId: "retained", state: "failed", errorCode: "WORKTREE_RECOVERY_REQUIRED",
        error: "The selected worktree could not be verified; this message was not sent.",
        canDismiss: true, canRetry: true,
      })]}
      deliveredCommandIds={new Set()}
      liveQueueIds={new Set()}
      canCancelLive={false}
      worktreeRecoveryPending={worktreeRecoveryPending}
      onCancelPending={noOp}
      onCancelLive={noOp}
      onDismiss={noOp}
      onRetry={noOp}
    />));
  };
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
  const described = (control: Element) =>
    (control.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean).map((id) => {
      const target = domWindow.document.getElementById(id);
      assert.ok(target && container.contains(target as never), `aria-describedby target ${id} is rendered`);
      return target.textContent ?? "";
    });
  try {
    await render(true);
    assert.equal(button("Retry").getAttribute("aria-label"), "Retry Message");
    assert.equal(button("Dismiss").getAttribute("aria-label"), "Dismiss Pending Message");
    assert.deepEqual(described(button("Retry")), [
      "Durable messageThe selected worktree could not be verified; this message was not sent.",
      "Recover the selected worktree before retrying this message.",
    ], "a disabled Retry announces why it is unavailable, not only a tooltip");
    assert.deepEqual(described(button("Dismiss")), [
      "Durable messageThe selected worktree could not be verified; this message was not sent.",
    ], "Dismiss stays available, so it carries only the retained message");

    await render(false);
    assert.deepEqual(described(button("Retry")), [
      "Durable messageThe selected worktree could not be verified; this message was not sent.",
    ], "the recovery reason is withdrawn once the worktree is recovered");
    assert.equal(container.querySelector("#pending-prompt-recovery-retained"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
