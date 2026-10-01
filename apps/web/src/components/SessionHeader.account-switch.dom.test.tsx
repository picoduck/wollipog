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
import { assertNoDomNode } from "../dom-test-assertions.js";

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

async function renderHeader(
  protocolVersion: number,
  client: ApiClient,
  current: SessionView = session,
  { runnerOnline = true, toasts = [] as string[] } = {},
) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{
          confirm: async () => false,
          showToast: (message: string) => { toasts.push(message); return 1; },
          showUndo: () => 1,
          dismissToast: () => undefined,
        }}>
          <SessionHeader
            session={current}
            onBack={() => undefined}
            runnerOnline={runnerOnline}
            machineName="build-box"
            runnerProtocolVersion={protocolVersion}
            providerLogoutSupported={false}
            stopBeforeArchiveSupported
            exportReady={false}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  const more = [...page().querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label") === "More Actions");
  assert.ok(more);
  await act(async () => { more.click(); await tick(); });
  return { container, mountPoint, root };
}

/** Menus are portalled to <body> (the shared MenuSurface), so queries look there. */
function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
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
  const toasts: string[] = [];
  const { container, mountPoint, root } = await renderHeader(
    RUNNER_CAPABILITY_MIN_PROTOCOL.sessionProviderAccountSwitch,
    client,
    session,
    { toasts },
  );
  const action = [...page().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.querySelector(".menu-text")?.textContent === "Switch Account…");
  assert.ok(action);
  assert.equal(action.disabled, false);
  await act(async () => { action.click(); await tick(); await tick(); });
  assert.match(page().textContent ?? "", /Personal/);
  assert.match(page().textContent ?? "", /5 Hour: 70% remaining/);
  const submit = [...page().querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Switch Account");
  assert.ok(submit);
  await act(async () => { submit.click(); await tick(); });
  assert.deepEqual(requests, ["personal"]);
  assert.deepEqual(toasts, ["Account switched."], "the result is a toast, not a note in the bar (#2161)");
  assertNoDomNode(page().querySelector(".session-header-note, .detail-note"), "the bar holds no note");
  await act(async () => root.unmount());
  mountPoint.remove();
});

test("an older runner exposes the action as disabled with an update requirement", async () => {
  const { container, mountPoint, root } = await renderHeader(
    RUNNER_CAPABILITY_MIN_PROTOCOL.sessionProviderAccountSwitch - 1,
    { ...api } as ApiClient,
  );
  const action = [...page().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.querySelector(".menu-text")?.textContent === "Switch Account…");
  assert.ok(action);
  assert.equal(action.disabled, true);
  assert.equal(action.getAttribute("title"), null, "the reason is visible, not a tooltip (#2161)");
  const reason = page().querySelector(`#${action.getAttribute("aria-describedby")}`);
  assert.equal(reason?.textContent, "Update Wollipog on build-box to use this.");
  await act(async () => root.unmount());
  mountPoint.remove();
});

test("with its machine offline, Switch Account is disabled and its second line names the machine", async () => {
  const { mountPoint, root } = await renderHeader(
    RUNNER_CAPABILITY_MIN_PROTOCOL.sessionProviderAccountSwitch,
    { ...api } as ApiClient,
    session,
    { runnerOnline: false },
  );
  try {
    const action = [...page().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.querySelector(".menu-text")?.textContent === "Switch Account…");
    assert.ok(action);
    assert.equal(action.disabled, true);
    assert.equal(action.getAttribute("title"), null);
    assert.equal(page().querySelector(`#${action.getAttribute("aria-describedby")}`)?.textContent,
      "build-box is offline.");
  } finally {
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});

test("email-shaped account labels stay masked in the header and the Switch Account picker", async () => {
  const accounts = ["work.me@example.com", "work.me@example.org"].map((label, index) => ({
    id: `account-${index}`,
    label,
    authStatus: "authenticated" as const,
    usageState: "available" as const,
    freshness: "fresh" as const,
    buckets: [],
  }));
  const client = {
    ...api,
    sessionProviderAccounts: async () => ({ accounts }),
    switchSessionProviderAccount: async () => ({ accepted: true as const, scheduled: false }),
  } as ApiClient;
  const { container, mountPoint, root } = await renderHeader(
    RUNNER_CAPABILITY_MIN_PROTOCOL.sessionProviderAccountSwitch,
    client,
    { ...session, providerAccountLabel: "current.me@example.com" },
  );
  const html = () => domWindow.document.body.innerHTML;
  const buttonNamed = (name: string) => [...domWindow.document.querySelectorAll("button")]
    .find((button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name) as
      HTMLButtonElement | undefined;
  const openSwitch = async () => {
    const action = [...page().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.querySelector(".menu-text")?.textContent === "Switch Account…");
    assert.ok(action);
    await act(async () => { action.click(); await tick(); await tick(); });
  };
  try {
    await openSwitch();
    assert.equal(html().includes("@example."), false, "no account email is in the DOM before a reveal");
    const titles = [...domWindow.document.querySelectorAll(".choice-row-title")].map((node) => node.textContent);
    assert.deepEqual(titles, ["Hidden Account 1", "Hidden Account 2"]);

    const revealAll = buttonNamed("Show Emails");
    assert.ok(revealAll, "the picker offers one deliberate reveal");
    await act(async () => { revealAll.click(); });
    assert.deepEqual(
      [...domWindow.document.querySelectorAll(".choice-row-title")].map((node) => node.textContent),
      ["work.me@example.com", "work.me@example.org"],
    );
    assert.equal(html().includes("current.me@example.com"), false, "the picker reveal does not reveal other values");

    const cancel = buttonNamed("Cancel");
    assert.ok(cancel);
    await act(async () => { cancel.click(); await tick(); });
    await act(async () => { (page().querySelector('[aria-label="More Actions"]') as HTMLButtonElement).click(); await tick(); });
    await openSwitch();
    assert.equal(html().includes("@example."), false, "reopening the dialog starts hidden again");
  } finally {
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});
