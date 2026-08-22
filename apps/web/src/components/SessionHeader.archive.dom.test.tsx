import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";

const domWindow = new Window({ url: "http://localhost/session/session-stop-failed" });
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label);
  assert.ok(match, `missing button: ${label}`);
  return match;
}

test("Unarchive on an archived Stop Failed session cancels the archive follow-up", async () => {
  const archived: Array<[string, boolean]> = [];
  const retries: string[] = [];
  const session = {
    id: "session-stop-failed",
    runnerId: "runner-1",
    title: "Failed Stop",
    status: "stopped",
    archived: true,
    archiveStatus: "stop_failed",
    archiveOperation: {
      operationId: "stop-operation-1",
      status: "stop_failed",
      requestedAt: 1,
      lastAttemptAt: 2,
      attemptCount: 3,
      capacityReleased: false,
      failure: { code: "retry_exhausted", message: "Stop failed.", failedAt: 3 },
    },
  } as SessionView;
  const client = {
    ...api,
    retryStop: async (id: string) => {
      retries.push(id);
      return { ...session, archiveStatus: "stop_pending" as const };
    },
    setArchived: async (id: string, value: boolean) => {
      archived.push([id, value]);
      return { ...session, archived: value, archiveStatus: undefined, archiveOperation: undefined };
    },
  } as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{
          confirm: async () => { throw new Error("unarchive must not require confirmation"); },
          showToast: () => 1,
          showUndo: () => 1,
          dismissToast: () => undefined,
        }}>
          <SessionHeader
            session={session}
            onBack={() => undefined}
            runnerOnline
            runnerProtocolVersion={85}
            providerLogoutSupported={false}
            stopBeforeArchiveSupported
            exportReady={false}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });

  await act(async () => { button(container, "More Actions").click(); await tick(); });
  await act(async () => { button(container, "Unarchive").click(); await tick(); await tick(); });

  assert.deepEqual(archived, [[session.id, false]]);
  assert.deepEqual(retries, []);
  await act(async () => root.unmount());
  container.remove();
});
