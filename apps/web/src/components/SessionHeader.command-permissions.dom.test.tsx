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
import { assertNoDomNode } from "../dom-test-assertions.js";

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
  rename: { allowed: false, reason: VIEWER },
};

function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  // A refused item's reason is its second line, so match the label, not the whole row.
  const match = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => (candidate.querySelector(".menu-text") ?? candidate).textContent?.trim() === label);
  assert.ok(match, `missing menu item: ${label}`);
  return match;
}

function description(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
    .map((id) => domWindow.document.getElementById(id)?.textContent ?? "").join(" ");
}

async function renderHeader(
  session: SessionView,
  calls: string[],
  unarchiveAndRestartSupported = false,
  extra: Partial<React.ComponentProps<typeof SessionHeader>> = {},
) {
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
            {...extra}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  const moreActions = page().querySelector<HTMLButtonElement>('button[aria-label="More Actions"]');
  assert.ok(moreActions, "missing More Actions");
  await act(async () => { moreActions.click(); await tick(); });
  return {
    container,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

/** Menus are portalled to <body> (the shared MenuSurface), so queries look there. */
function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

test("a Viewer sees Stop Session disabled with the reason, and nothing is confirmed or sent (#1843)", async () => {
  const calls: string[] = [];
  const header = await renderHeader({
    id: "session-running", runnerId: "runner-1", title: "Running", status: "running", archived: false,
    commandPermissions: readOnly,
  } as SessionView, calls);
  try {
    const stop = menuItem(page(), "Stop Session");
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
    const restart = menuItem(page(), "Restart");
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
    const retry = menuItem(page(), "Retry Stop");
    assert.equal(retry.disabled, true);
    assert.equal(description(retry), VIEWER);
    assert.equal(page().querySelectorAll("#session-runtime-caution").length, 1,
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
      const stop = menuItem(page(), "Stop Session");
      assert.equal(stop.disabled, false);
      assert.equal(stop.getAttribute("aria-describedby"), null);
      assert.equal(stop.title, "Terminate the agent process and discard queued messages");
      assertNoDomNode(page().querySelector("#session-runtime-caution"));
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
      const item = menuItem(page(), label);
      assert.equal(item.disabled, true, `${label} is disabled`);
      assert.equal(item.title, VIEWER);
      assert.equal(description(item), VIEWER, `${label} is described by the reason`);
      assert.equal(page().querySelector("#session-archive-caution")?.textContent, VIEWER,
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
      const archive = menuItem(page(), "Archive and Stop");
      assert.equal(archive.disabled, false);
      assert.equal(archive.getAttribute("aria-describedby"), null);
      assertNoDomNode(page().querySelector("#session-archive-caution"));
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
      const restore = menuItem(page(), "Unarchive and Restart");
      assert.equal(restore.disabled, false);
      await act(async () => { restore.click(); await tick(); await tick(); });
      assert.deepEqual(calls, ["unarchive-and-restart:session-archived"]);
    } finally {
      await archived.unmount();
    }
  }
});

test("a Viewer sees Rename Session disabled with the reason, and the rename dialog does not open (#1857)", async () => {
  for (const commandPermissions of [readOnly, { ...readOnly, rename: { allowed: true } }, undefined] satisfies Array<SessionCommandPermissions | undefined>) {
    const refused = commandPermissions?.rename?.allowed === false;
    const header = await renderHeader({
      id: "session-rename", runnerId: "runner-1", title: "Rename Me", status: "idle", archived: false,
      ...(commandPermissions ? { commandPermissions } : {}),
    } as SessionView, []);
    try {
      const rename = menuItem(page(), "Rename Session…");
      assert.equal(rename.disabled, refused, refused ? "refused rename is disabled" : "rename is offered as before");
      if (refused) {
        assert.equal(rename.title, VIEWER);
        assert.equal(description(rename), VIEWER);
        assert.equal(page().querySelector("#session-rename-caution")?.textContent, VIEWER);
      } else {
        assertNoDomNode(page().querySelector("#session-rename-caution"));
      }
      await act(async () => { rename.click(); await tick(); });
      const dialog = domWindow.document.querySelector('[role="dialog"]');
      assert.equal(dialog !== null, !refused, refused ? "no rename dialog opens" : "the rename dialog opens");
    } finally {
      await header.unmount();
    }
  }
});

test("a Viewer's Fork Conversation is disabled and describes the refusal; an allowed person's is unchanged (#1864)", async () => {
  const calls: string[] = [];
  const refused = await renderHeader({
    id: "session-fork", runnerId: "runner-1", title: "Fork", status: "idle", archived: false,
    commandPermissions: { ...readOnly, fork: { allowed: false, reason: VIEWER } },
  } as SessionView, calls, false, {
    // SessionDetail folds the fork verdict into the availability it passes down.
    forkAvailability: { available: false, reason: VIEWER },
    onFork: () => { calls.push("fork"); },
  });
  try {
    const fork = refused.container.querySelector<HTMLButtonElement>('button[aria-label="Fork Conversation"]');
    assert.ok(fork, "missing Fork Conversation");
    assert.equal(fork.disabled, true);
    assert.equal(fork.title, VIEWER);
    assert.equal(description(fork), VIEWER, "the reason is announced, not only shown on hover");
    await act(async () => { fork.click(); await tick(); });
    assert.deepEqual(calls, []);
  } finally {
    await refused.unmount();
  }

  for (const commandPermissions of [{ ...readOnly, fork: { allowed: true } }, undefined]) {
    const allowedCalls: string[] = [];
    const allowed = await renderHeader({
      id: "session-fork", runnerId: "runner-1", title: "Fork", status: "idle", archived: false,
      ...(commandPermissions ? { commandPermissions } : {}),
    } as SessionView, allowedCalls, false, {
      forkAvailability: { available: true, forkTurn: 3 },
      onFork: () => { allowedCalls.push("fork"); },
    });
    try {
      const fork = allowed.container.querySelector<HTMLButtonElement>('button[aria-label="Fork Conversation"]');
      assert.ok(fork, "missing Fork Conversation");
      assert.equal(fork.disabled, false);
      assert.equal(fork.title, "Fork Conversation");
      assert.equal(fork.getAttribute("aria-describedby"), null);
      assertNoDomNode(page().querySelector("#session-fork-refusal"));
    } finally {
      await allowed.unmount();
    }
  }
});
