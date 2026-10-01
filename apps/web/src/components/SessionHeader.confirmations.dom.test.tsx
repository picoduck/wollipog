import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { QueuedPromptView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackContext, type ConfirmationOptions } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";

const domWindow = new Window({ url: "http://localhost/session/session-confirmations" });
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

/** A generated title: only its first line names the session. */
const TITLE = "Fix the half-cent rounding bug.\nRequirements:\n- keep cents";
const queuedEntry = (id: string): QueuedPromptView => ({ id, text: "next", steerable: true, liveQueueObserved: true });

function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

function menuItem(label: string): HTMLButtonElement {
  const match = [...page().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.querySelector(".menu-text")?.textContent?.trim() === label);
  assert.ok(match, `missing menu item: ${label}`);
  return match;
}

/** Opens More Actions, chooses `item`, and returns the confirmation it asked for. */
async function confirmationFor(session: Partial<SessionView>, item: string, options: {
  onSnooze?: () => void;
  answer?: (request: ConfirmationOptions) => boolean;
} = {}) {
  const requests: ConfirmationOptions[] = [];
  const toasts: string[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const fullSession = {
    id: "session-confirmations",
    runnerId: "runner-1",
    title: TITLE,
    status: "running",
    archived: false,
    driver: "codex-app-server",
    ...session,
  } as SessionView;
  const client = {
    ...api,
    setArchived: async (_id: string, archived: boolean) => ({ ...fullSession, archived }),
    retryStop: async () => ({ ...fullSession, archived: true, archiveStatus: "stop_pending" as const }),
    stop: async () => fullSession,
  } as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{
          confirm: async (request) => {
            requests.push(request);
            return options.answer?.(request) ?? false;
          },
          showToast: (message) => { toasts.push(message); return 1; },
          showUndo: (message) => { toasts.push(message); return 1; },
          dismissToast: () => undefined,
        }}>
          <SessionHeader
            session={fullSession}
            onBack={() => undefined}
            runnerOnline
            runnerProtocolVersion={999}
            machineName="Studio Mac"
            providerLogoutSupported
            stopBeforeArchiveSupported
            exportReady={false}
            {...(options.onSnooze ? { onSnooze: options.onSnooze } : {})}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  const trigger = page().querySelector<HTMLButtonElement>('button[aria-label="More Actions"]');
  assert.ok(trigger, "More Actions is rendered");
  await act(async () => { trigger.click(); await tick(); });
  await act(async () => { menuItem(item).click(); await tick(); await tick(); });
  await act(async () => root.unmount());
  container.remove();
  assert.equal(requests.length, 1, `${item} asks once`);
  return { request: requests[0]!, toasts };
}

const MECHANISMS = /runner host|runtime capacity|process/i;

test("Stop Session names the session by its one-line title and counts what is queued", async () => {
  const { request } = await confirmationFor({ queued: [queuedEntry("a"), queuedEntry("b")] }, "Stop Session…");
  assert.equal(request.title, "Stop Session");
  assert.equal(request.confirmLabel, "Stop Session");
  assert.equal(request.tone, "danger");
  assert.equal(request.message,
    "“Fix the half-cent rounding bug” stops now and its 2 queued messages are discarded. "
    + "To interrupt only the current turn, use Stop Turn in the composer.");
  assert.doesNotMatch(request.message, MECHANISMS);

  const idle = await confirmationFor({}, "Stop Session…");
  assert.equal(idle.request.message,
    "“Fix the half-cent rounding bug” stops now. To interrupt only the current turn, use Stop Turn in the composer.",
    "the queued clause is left out when nothing is queued");
});

test("Archive and Stop Session names the session and offers Snooze Instead when the session can be snoozed", async () => {
  let snoozes = 0;
  const { request } = await confirmationFor({}, "Archive and Stop…", { onSnooze: () => { snoozes += 1; } });
  assert.equal(request.title, "Archive and Stop Session");
  assert.equal(request.confirmLabel, "Archive and Stop");
  assert.equal(request.tone, "danger");
  assert.equal(request.message,
    "“Fix the half-cent rounding bug” stops, its queued messages are canceled, and it moves to Archived Sessions. "
    + "You can restore it later.");
  assert.doesNotMatch(request.message, /Snooze/, "the alternative is an action, not a sentence");
  assert.equal(request.secondaryAction?.label, "Snooze Instead…");
  request.secondaryAction?.run();
  assert.equal(snoozes, 1, "Snooze Instead opens Snooze");

  const unsnoozable = await confirmationFor({}, "Archive and Stop…");
  assert.equal(unsnoozable.request.secondaryAction, undefined, "a session that cannot be snoozed is not offered it");
});

test("Archive results are reported in the person's terms", async () => {
  const { toasts } = await confirmationFor({}, "Archive and Stop…", { answer: () => true });
  assert.deepEqual(toasts, ["Session archived."]);
});

test("Retry Stop is not destructive: its primary is the default tone", async () => {
  const { request, toasts } = await confirmationFor({
    status: "stopped",
    archiveStatus: "stop_failed",
    archiveOperation: {
      operationId: "stop-1",
      status: "stop_failed",
      requestedAt: 1,
      lastAttemptAt: 2,
      attemptCount: 3,
      capacityReleased: false,
      failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
    },
  }, "Retry Stop…", { onSnooze: () => undefined, answer: () => true });
  assert.equal(request.title, "Retry Stop");
  assert.equal(request.confirmLabel, "Retry Stop");
  assert.notEqual(request.tone, "danger");
  assert.equal(request.secondaryAction, undefined, "Snooze is not an alternative to a stop already asked for");
  assert.equal(request.message,
    "The last stop didn't finish, so “Fix the half-cent rounding bug” may still be running. "
    + "Wollipog tries to stop it again, then archives it.");
  assert.deepEqual(toasts, ["Archiving. The session is still stopping."]);
});

test("Delete Session names the session and says it can't be undone", async () => {
  const { request } = await confirmationFor({ status: "stopped", archived: true }, "Delete Session…");
  assert.equal(request.title, "Delete Session");
  assert.equal(request.message, "“Fix the half-cent rounding bug” and its history are removed from Wollipog. This can't be undone.");
});

test("Sign Out of Agent names the agent and the machine", async () => {
  const { request } = await confirmationFor({
    status: "idle",
    driver: "acp",
    agentName: "Gemini CLI",
    agentId: "gemini",
  }, "Sign Out of Agent…");
  assert.equal(request.title, "Sign Out");
  assert.equal(request.confirmLabel, "Sign Out");
  assert.equal(request.message,
    "Gemini CLI signs out on Studio Mac, and new sessions with it will ask you to sign in again. "
    + "Saved credentials stay on that machine.");
  assert.doesNotMatch(request.message, /runner host/);
});
