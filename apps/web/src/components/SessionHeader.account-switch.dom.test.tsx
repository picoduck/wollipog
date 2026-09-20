import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { RUNNER_CAPABILITY_MIN_PROTOCOL, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";

const domWindow = new Window({ url: "http://localhost/session/session-account-switch" });
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

const session = {
  id: "session-account-switch",
  runnerId: "runner-1",
  title: "Account Switch",
  status: "idle",
  archived: false,
  driver: "codex-app-server",
  providerAccountId: "work",
  providerAccountLabel: "Work",
} as SessionView;

async function renderHeader(protocolVersion: number, client: ApiClient) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
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
            runnerProtocolVersion={protocolVersion}
            providerLogoutSupported={false}
            stopBeforeArchiveSupported
            exportReady={false}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  const more = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label") === "More Actions");
  assert.ok(more);
  await act(async () => { more.click(); await tick(); });
  return { container, root };
}

test("Switch Account lists headroom and submits the selected account", async () => {
  const requests: string[] = [];
  const client = {
    ...api,
    sessionProviderAccounts: async () => ({ accounts: [{
      id: "personal",
      label: "Personal",
      authStatus: "authenticated" as const,
      usageState: "available" as const,
      freshness: "fresh" as const,
      buckets: [{ id: "five-hour", label: "5 Hour", remainingPercent: 70 }],
    }] }),
    switchSessionProviderAccount: async (_id: string, providerAccountId: string) => {
      requests.push(providerAccountId);
      return { accepted: true as const, scheduled: false };
    },
  } as ApiClient;
  const { container, root } = await renderHeader(
    RUNNER_CAPABILITY_MIN_PROTOCOL.sessionProviderAccountSwitch,
    client,
  );
  const action = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === "Switch Account…");
  assert.ok(action);
  assert.equal(action.disabled, false);
  await act(async () => { action.click(); await tick(); await tick(); });
  assert.match(container.textContent ?? "", /Personal/);
  assert.match(container.textContent ?? "", /5 Hour: 70% remaining/);
  const submit = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Switch Account");
  assert.ok(submit);
  await act(async () => { submit.click(); await tick(); });
  assert.deepEqual(requests, ["personal"]);
  await act(async () => root.unmount());
  container.remove();
});

test("an older runner exposes the action as disabled with an update requirement", async () => {
  const { container, root } = await renderHeader(
    RUNNER_CAPABILITY_MIN_PROTOCOL.sessionProviderAccountSwitch - 1,
    { ...api } as ApiClient,
  );
  const action = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === "Switch Account…");
  assert.ok(action);
  assert.equal(action.disabled, true);
  assert.match(action.title, /requires protocol v171/i);
  await act(async () => root.unmount());
  container.remove();
});
