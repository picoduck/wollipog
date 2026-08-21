import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { ArchivedSessionsView } from "./ArchivedSessionsView.js";
import { FeedbackProvider } from "./FeedbackProvider.js";

const domWindow = new Window({ url: "http://localhost/archived" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function session(index: number, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: `session-${index}`,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Local Checkout",
    projectId: "project-1",
    projectName: "Wollipog",
    projectLocationId: null,
    agentId: "codex",
    agentName: "Codex",
    title: `Archived Session ${index}`,
    status: index === 0 ? "input_required" : "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: true,
    createdAt: index + 1,
    updatedAt: index + 1,
    lastEventAt: null,
    messageCount: 0,
    preview: null,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    costBudgetUsd: null,
    maxToolCalls: null,
    ...overrides,
  } as SessionView;
}

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [], boxes: [], projects: [], sessions: [], runs: [], pods: [],
  };
}

let sequence = 0;

async function mount(sessions: SessionView[], overrides: Partial<ApiClient> = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const navigated: View[] = [];
  const navigation: ViewNavigation = {
    current: () => ({ name: "archived" }),
    push: (view) => { navigated.push(view); },
    listen: () => () => {},
  };
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `archive-browser-${sequence}`,
    runtimeKey: `archive-browser-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const client = {
    ...api,
    listAllSessions: async () => ({ sessions }),
    search: async () => ({ results: [] }),
    ...overrides,
  } as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            <ArchivedSessionsView />
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => { socket.push(snapshot()); await Promise.resolve(); });
  return {
    container,
    root,
    socket,
    navigated,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(result, `${label} button exists`);
  return result;
}

test("empty archives expose labelled choice filters and a screen-reader status", async () => {
  const fixture = await mount([]);
  assert.match(fixture.container.textContent ?? "", /No Archived Sessions/);
  assert.equal(fixture.container.querySelector('[role="status"]')?.textContent?.trim(), "0 Sessions");
  assert.ok([...fixture.container.querySelectorAll("label")]
    .some((label) => label.textContent?.trim().startsWith("Search Sessions and Transcripts")));
  for (const expected of ["Project", "Location", "Agent", "Archive State", "Lifecycle State"]) {
    assert.ok(fixture.container.querySelector(`button[aria-label^="${expected}:"]`), `${expected} labels its control`);
  }
  assert.equal(fixture.container.querySelectorAll("select").length, 0);
  await fixture.unmount();
});

test("large archives paginate, deep-link, filter, and accept live lifecycle updates", async () => {
  const sessions = Array.from({ length: 55 }, (_, index) => session(index));
  const fixture = await mount(sessions);
  assert.equal(fixture.container.querySelectorAll("tbody tr").length, 50);
  assert.match(fixture.container.textContent ?? "", /Archived.*Idle/s,
    "archive and canonical lifecycle labels are both text-backed");
  assert.equal(fixture.container.querySelector('nav[aria-label="Archived Sessions Pagination"]')?.textContent?.includes("Page 1 of 2"), true);
  assert.ok([...fixture.container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Stop"),
    "ordinary nonterminal archived sessions retain the Stop action");

  const firstLink = fixture.container.querySelector<HTMLAnchorElement>('tbody a[href^="/sessions/"]');
  assert.ok(firstLink, "session titles are direct links");
  await act(async () => { Simulate.click(firstLink!, { button: 0 }); });
  assert.equal(fixture.navigated.at(-1)?.name, "session");

  await act(async () => { Simulate.click(button(fixture.container, "Next Page")); });
  assert.equal(fixture.container.querySelectorAll("tbody tr").length, 5);
  assert.match(fixture.container.textContent ?? "", /Page 2 of 2/);

  const lifecycle = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Lifecycle State:"]');
  assert.ok(lifecycle);
  await act(async () => { lifecycle.click(); });
  const inputRequired = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((option) => option.textContent?.trim() === "Input Required");
  assert.ok(inputRequired);
  await act(async () => { inputRequired.click(); });
  assert.equal(fixture.container.querySelectorAll("tbody tr").length, 1);
  assert.match(fixture.container.textContent ?? "", /Input Required/);

  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: session(0, { status: "stopped", updatedAt: 100 }) });
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /No Matching Sessions/,
    "a second client's lifecycle change immediately re-evaluates the active filter");
  await fixture.unmount();
});

test("unarchive uses the existing authorized mutation and removes the row from the default view", async () => {
  const calls: Array<[string, boolean]> = [];
  const archived = session(1);
  const fixture = await mount([archived], {
    setArchived: async (id, value) => {
      calls.push([id, value]);
      return { ...archived, archived: value, updatedAt: archived.updatedAt + 1 };
    },
  });
  await act(async () => { Simulate.click(button(fixture.container, "Unarchive")); await Promise.resolve(); });
  assert.deepEqual(calls, [[archived.id, false]]);
  assert.match(fixture.container.textContent ?? "", /No Archived Sessions/);
  await fixture.unmount();
});

test("Stop Pending sessions expose an idempotent Retry Stop recovery action", async () => {
  const calls: Array<[string, boolean]> = [];
  const pending = session(2, {
    status: "stopped",
    archiveStatus: "stop_pending",
  } as Partial<SessionView>);
  const fixture = await mount([pending], {
    setArchived: async (id, value) => {
      calls.push([id, value]);
      return pending;
    },
  });

  assert.match(fixture.container.textContent ?? "", /Stop Pending/);
  const retry = button(fixture.container, "Retry Stop");
  assert.equal([...fixture.container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Stop"), false,
    "pending recovery replaces the ordinary Stop action even for a terminal lifecycle");
  await act(async () => { Simulate.click(retry); await Promise.resolve(); });

  assert.deepEqual(calls, [[pending.id, true]], "retry preserves and reissues archive intent");
  assert.equal(fixture.container.querySelector('.toast-region[aria-live="polite"] [role="status"]')?.textContent?.includes("Stop retry requested."), true,
    "success is announced in the accessible live toast region");
  await fixture.unmount();
});
