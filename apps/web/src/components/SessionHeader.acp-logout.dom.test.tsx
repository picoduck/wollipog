import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { QueuedPromptView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";

const domWindow = new Window({ url: "http://localhost/session/session-acp-logout" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

const failedReceipt: QueuedPromptView = {
  id: "cmd-failed",
  text: "a message whose delivery failed",
  steerable: false,
  steerDisabledReason: "provider cancelled",
  durableDeliveryState: "failed",
  durableDeliveryError: "provider cancelled",
};
const uncertainReceipt: QueuedPromptView = { ...failedReceipt, id: "cmd-uncertain", durableDeliveryState: "uncertain" };
const liveEntry: QueuedPromptView = { id: "queue-live", text: "still waiting", steerable: true, liveQueueObserved: true };
const durablePending: QueuedPromptView = {
  id: "cmd-pending",
  text: "awaiting admission",
  steerable: false,
  durableDeliveryState: "pending",
};

/** Opens Session Actions on an idle ACP Session and returns the Sign Out menu item. */
async function signOutItem(queued: QueuedPromptView[] | undefined) {
  const session = {
    id: "session-acp-logout",
    runnerId: "runner-1",
    title: "ACP Session",
    status: "idle",
    archived: false,
    driver: "acp",
    ...(queued ? { queued } : {}),
  } as SessionView;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={{ ...api } as ApiClient}>
        <FeedbackContext.Provider value={{
          confirm: async () => false,
          showToast: () => 1,
          showUndo: () => 1,
          dismissToast: () => undefined,
        }}>
          <SessionHeader
            session={session}
            onBack={() => undefined}
            runnerOnline
            runnerProtocolVersion={999}
            providerLogoutSupported
            stopBeforeArchiveSupported
            exportReady={false}
            onSnooze={() => undefined}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === "More Actions");
  assert.ok(trigger, "the Session Actions trigger is rendered");
  await act(async () => { trigger.click(); await tick(); });
  const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.textContent?.trim() === "Sign Out");
  assert.ok(item, "an idle ACP Session with a capable runner offers Sign Out");
  const disabled = item.disabled;
  await act(async () => root.unmount());
  container.remove();
  return disabled;
}

test("settled delivery receipts do not disable ACP Sign Out on an idle Session", async () => {
  assert.equal(await signOutItem(undefined), false, "control: nothing listed");
  assert.equal(await signOutItem([failedReceipt]), false, "a failed receipt is not pending work");
  assert.equal(await signOutItem([failedReceipt, uncertainReceipt]), false,
    "neither is an uncertain receipt, alone or together with a failed one");
});

test("pending work still disables ACP Sign Out, with or without a receipt beside it", async () => {
  assert.equal(await signOutItem([liveEntry]), true, "a live runner queue entry blocks sign-out");
  assert.equal(await signOutItem([durablePending]), true, "a durable delivery awaiting admission blocks sign-out");
  assert.equal(await signOutItem([failedReceipt, liveEntry]), true,
    "a receipt beside genuinely queued work does not mask that work");
});
