import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionCommandPermissions, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";

const domWindow = new Window({ url: "http://localhost/session/session-permissions" });
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
const VIEWER = "Your Viewer role is read-only.";
const readOnly: SessionCommandPermissions = {
  stop: { allowed: false, reason: VIEWER },
  restart: { allowed: false, reason: VIEWER },
  stopBackgroundJob: { allowed: false, reason: VIEWER },
  archive: { allowed: false, reason: VIEWER },
  unarchive: { allowed: false, reason: VIEWER },
  prompt: { allowed: false, reason: VIEWER },
  delete: { allowed: false, reason: VIEWER },
};

function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(match, `missing menu item: ${label}`);
  return match;
}

function description(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
    .map((id) => domWindow.document.getElementById(id)?.textContent ?? "").join(" ");
}

async function renderHeader(session: SessionView, calls: string[], unarchiveAndRestartSupported = false) {
  const client = {
    ...api,
    stop: async (id: string) => { calls.push(`stop:${id}`); return session; },
    restart: async (id: string) => { calls.push(`restart:${id}`); return session; },
    retryStop: async (id: string) => { calls.push(`retry:${id}`); return session; },
    setArchived: async (id: string, archived: boolean) => { calls.push(`archived:${id}:${archived}`); return session; },
    unarchiveAndRestart: async (id: string) => { calls.push(`unarchive-and-restart:${id}`); return { ok: true }; },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{
          confirm: async () => { calls.push("confirm"); return true; },
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
            unarchiveAndRestartSupported={unarchiveAndRestartSupported}
            exportReady={false}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  const moreActions = container.querySelector<HTMLButtonElement>('button[aria-label="More Actions"]');
  assert.ok(moreActions, "missing More Actions");
  await act(async () => { moreActions.click(); await tick(); });
  return {
    container,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("a Viewer sees Stop Session disabled with the reason, and nothing is confirmed or sent (#1843)", async () => {
  const calls: string[] = [];
  const header = await renderHeader({
    id: "session-running", runnerId: "runner-1", title: "Running", status: "running", archived: false,
    commandPermissions: readOnly,
  } as SessionView, calls);
  try {
    const stop = menuItem(header.container, "Stop Session");
    assert.equal(stop.disabled, true);
    assert.equal(stop.title, VIEWER);
    assert.equal(description(stop), VIEWER);
    await act(async () => { stop.click(); await tick(); });
    assert.deepEqual(calls, []);
  } finally {
    await header.unmount();
  }
});

test("a Viewer sees Restart and Retry Stop disabled with the reason (#1843)", async () => {
  const calls: string[] = [];
  const stopped = await renderHeader({
    id: "session-stopped", runnerId: "runner-1", title: "Stopped", status: "stopped", archived: false,
    commandPermissions: readOnly,
  } as SessionView, calls);
  try {
    const restart = menuItem(stopped.container, "Restart");
    assert.equal(restart.disabled, true);
    assert.equal(description(restart), VIEWER);
    await act(async () => { restart.click(); await tick(); });
  } finally {
    await stopped.unmount();
  }
  const failed = await renderHeader({
    id: "session-stop-failed", runnerId: "runner-1", title: "Stop Failed", status: "running", archived: false,
    stopOperation: {
      operationId: "stop-1", status: "stop_failed", requestedAt: 1, lastAttemptAt: 2, attemptCount: 1,
      capacityReleased: false, failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
    },
    commandPermissions: readOnly,
  } as SessionView, calls);
  try {
    const retry = menuItem(failed.container, "Retry Stop");
    assert.equal(retry.disabled, true);
    assert.equal(description(retry), VIEWER);
    assert.equal(failed.container.querySelectorAll("#session-runtime-caution").length, 1,
      "one caution serves every refused Runtime item");
    await act(async () => { retry.click(); await tick(); });
  } finally {
    await failed.unmount();
  }
  assert.deepEqual(calls, []);
});

test("a person who may stop and restart keeps the Runtime items as before (#1843)", async () => {
  for (const commandPermissions of [
    // A non-owning admin: Stop Job is refused, stopping and restarting are not.
    { stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: false, reason: "Only the owner." } },
    // A control plane that sends no permissions.
    undefined,
  ] satisfies Array<SessionCommandPermissions | undefined>) {
    const calls: string[] = [];
    const header = await renderHeader({
      id: "session-running", runnerId: "runner-1", title: "Running", status: "running", archived: false,
      ...(commandPermissions ? { commandPermissions } : {}),
    } as SessionView, calls);
    try {
      const stop = menuItem(header.container, "Stop Session");
      assert.equal(stop.disabled, false);
      assert.equal(stop.getAttribute("aria-describedby"), null);
      assert.equal(stop.title, "Terminate the agent process and discard queued messages");
      assert.equal(header.container.querySelector("#session-runtime-caution"), null);
      await act(async () => { stop.click(); await tick(); await tick(); });
      assert.deepEqual(calls, ["confirm", "stop:session-running"]);
    } finally {
      await header.unmount();
    }
  }
});

const stopFailedArchive = {
  archiveStatus: "stop_failed",
  archiveOperation: {
    operationId: "archive-1", status: "stop_failed", requestedAt: 1, lastAttemptAt: 2, attemptCount: 1,
    capacityReleased: false, failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
  },
};

test("a Viewer sees the archive item disabled with the reason in every state, and nothing is confirmed or sent", async () => {
  const cases: Array<{ label: string; session: Partial<SessionView>; unarchiveAndRestart?: boolean }> = [
    { label: "Archive and Stop", session: { status: "running", archived: false } },
    { label: "Archive", session: { status: "stopped", archived: false } },
    { label: "Retry Stop", session: { status: "running", archived: false, ...stopFailedArchive } as Partial<SessionView> },
    { label: "Unarchive", session: { status: "stopped", archived: true } },
    { label: "Unarchive and Restart", session: { status: "stopped", archived: true }, unarchiveAndRestart: true },
  ];
  for (const { label, session, unarchiveAndRestart } of cases) {
    const calls: string[] = [];
    const header = await renderHeader({
      id: "session-archive", runnerId: "runner-1", title: "Archive", ...session, commandPermissions: readOnly,
    } as SessionView, calls, unarchiveAndRestart);
    try {
      const item = menuItem(header.container, label);
      assert.equal(item.disabled, true, `${label} is disabled`);
      assert.equal(item.title, VIEWER);
      assert.equal(description(item), VIEWER, `${label} is described by the reason`);
      assert.equal(header.container.querySelector("#session-archive-caution")?.textContent, VIEWER,
        "the reason is visible in the menu");
      await act(async () => { item.click(); await tick(); await tick(); });
      assert.deepEqual(calls, [], `${label} confirms and sends nothing`);
    } finally {
      await header.unmount();
    }
  }
});

test("a person who may archive and unarchive keeps the archive item as before", async () => {
  for (const commandPermissions of [
    // A non-owning admin: only Stop Job is refused.
    { stop: { allowed: true }, restart: { allowed: true }, archive: { allowed: true },
      unarchive: { allowed: true }, prompt: { allowed: true }, delete: { allowed: true },
      stopBackgroundJob: { allowed: false, reason: "Only the owner." } },
    // A control plane that predates the archive permissions, and one that sends none.
    { stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true } },
    undefined,
  ] satisfies Array<SessionCommandPermissions | undefined>) {
    const calls: string[] = [];
    const running = await renderHeader({
      id: "session-running", runnerId: "runner-1", title: "Running", status: "running", archived: false,
      ...(commandPermissions ? { commandPermissions } : {}),
    } as SessionView, calls);
    try {
      const archive = menuItem(running.container, "Archive and Stop");
      assert.equal(archive.disabled, false);
      assert.equal(archive.getAttribute("aria-describedby"), null);
      assert.equal(running.container.querySelector("#session-archive-caution"), null);
      await act(async () => { archive.click(); await tick(); await tick(); });
      assert.deepEqual(calls, ["confirm", "archived:session-running:true"]);
    } finally {
      await running.unmount();
    }
    calls.length = 0;
    const archived = await renderHeader({
      id: "session-archived", runnerId: "runner-1", title: "Archived", status: "stopped", archived: true,
      ...(commandPermissions ? { commandPermissions } : {}),
    } as SessionView, calls, true);
    try {
      const restore = menuItem(archived.container, "Unarchive and Restart");
      assert.equal(restore.disabled, false);
      await act(async () => { restore.click(); await tick(); await tick(); });
      assert.deepEqual(calls, ["unarchive-and-restart:session-archived"]);
    } finally {
      await archived.unmount();
    }
  }
});
