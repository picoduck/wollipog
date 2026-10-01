import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionCommandPermissions, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { requestArchiveSearch, takeArchiveSearch } from "../archive-search-handoff.js";
import { deleteSessionMessage, stopArchivedSessionMessage } from "../session-confirmation-copy.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { ArchivedSessionsView } from "./ArchivedSessionsView.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/archived" });
installDomTestCleanup(domWindow);
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

function snapshot(capabilities: UiSnapshotMessage["capabilities"] = {}): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      ...capabilities,
    },
    runners: [], boxes: [], projects: [], sessions: [], runs: [], pods: [],
  };
}

function archiveResponse(rows: SessionView[]): Awaited<ReturnType<ApiClient["archiveSessionPage"]>> {
  return {
    sessions: rows,
    snippets: {},
    metadata: Object.fromEntries(rows.map((item) => [item.id, {
      project: item.projectName ?? "No Project",
      location: item.workspaceName ?? "No Location",
      agent: "Codex App Server",
    }])),
    nextCursor: null,
    hasMore: false,
    facets: {
      projects: [...new Set(rows.map((item) => item.projectName ?? "No Project"))].sort(),
      locations: [...new Set(rows.map((item) => item.workspaceName ?? "No Location"))].sort(),
      agents: ["Codex App Server"],
    },
  };
}

let sequence = 0;

async function mount(
  sessions: SessionView[],
  overrides: Partial<ApiClient> = {},
  options: { initialConnection?: "online" | "unauthorized"; unarchiveAndRestart?: boolean } = {},
) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  const navigated: View[] = [];
  const navigation: ViewNavigation = {
    current: () => ({ name: "archived" }),
    push: (view) => { navigated.push(view); },
    listen: () => () => {},
  };
  sequence += 1;
  let credentialChange: (() => void) | null = null;
  const connection: UiConnectionRuntime = {
    instanceId: `archive-browser-${sequence}`,
    runtimeKey: `archive-browser-${sequence}:1`,
    createSocket: () => socket,
    onCredentialChange: (listener) => {
      credentialChange = listener;
      return () => { credentialChange = null; };
    },
    close() {},
  };
  let archivePageCalls = 0;
  const archiveInputs: Parameters<ApiClient["archiveSessionPage"]>[0][] = [];
  const client = {
    ...api,
    listAllSessions: async () => ({ sessions }),
    search: async () => ({ results: [] }),
    archiveSessionPage: async (input) => {
      archivePageCalls += 1;
      archiveInputs.push(input);
      const offset = Number(input.cursor ?? "0");
      const ordered = [...sessions].filter((item) => {
        const pendingArchive = item.archiveStatus === "stop_pending" || item.archiveStatus === "stop_failed";
        if (input.archive === "archived" && !item.archived && !pendingArchive) return false;
        if (input.archive === "unarchived" && (item.archived || pendingArchive)) return false;
        if (input.lifecycle !== "all" && item.status !== input.lifecycle) return false;
        if (input.project && item.projectName !== input.project) return false;
        if (input.location && item.workspaceName !== input.location) return false;
        if (input.agent && input.agent !== "Codex App Server") return false;
        return !input.q || [item.id, item.title].join("\n").toLocaleLowerCase().includes(input.q.toLocaleLowerCase());
      }).sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
      const pageSessions = ordered.slice(offset, offset + 50);
      const nextCursor = offset + pageSessions.length < ordered.length ? String(offset + pageSessions.length) : null;
      return {
        sessions: pageSessions,
        snippets: {},
        metadata: Object.fromEntries(pageSessions.map((item) => [item.id, {
          project: item.projectName ?? "No Project",
          location: item.workspaceName ?? "No Location",
          agent: "Codex App Server",
        }])),
        nextCursor,
        hasMore: nextCursor !== null,
        facets: {
          projects: [...new Set(sessions.map((item) => item.projectName ?? "No Project"))].sort(),
          locations: [...new Set(sessions.map((item) => item.workspaceName ?? "No Location"))].sort(),
          agents: ["Codex App Server"],
        },
      };
    },
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
  await act(async () => {
    if (options.initialConnection === "unauthorized") socket.onclose?.({ code: 1008 });
    else socket.push(snapshot(options.unarchiveAndRestart ? { unarchiveAndRestart: true } : {}));
    await Promise.resolve();
  });
  return {
    container,
    root,
    socket,
    navigated,
    archiveInputs,
    archivePageCalls: () => archivePageCalls,
    reconnectWithCredential: async () => {
      await act(async () => {
        credentialChange?.();
        await Promise.resolve();
      });
      await act(async () => {
        socket.push(snapshot());
        await Promise.resolve();
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(result, `${label} button exists`);
  return result;
}

/** A menu item's label, without the refusal reason on its second line. */
function itemLabel(item: Element): string | undefined {
  return (item.querySelector(".menu-text") ?? item).textContent?.trim();
}

/**
 * Visit every row action (§14: one inline action, the rest behind the row's ⋯), reading the ⋯
 * items while that row's menu is open. A menu item is portalled to <body>.
 */
async function eachRowAction(
  container: HTMLElement,
  visit: (action: HTMLButtonElement, label: string, inMenu: boolean) => Promise<void> | void,
): Promise<void> {
  for (const row of container.querySelectorAll("tbody tr")) {
    for (const inline of row.querySelectorAll<HTMLButtonElement>(".archive-row-actions > .btn")) {
      await visit(inline, inline.textContent!.trim(), false);
    }
    const trigger = row.querySelector<HTMLButtonElement>('button[aria-label^="More Actions for"]');
    if (!trigger) continue;
    await act(async () => { fireDomEvent.click(trigger); });
    for (const item of (domWindow.document as unknown as Document).querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')) {
      await visit(item, itemLabel(item)!, true);
    }
    if (trigger.getAttribute("aria-expanded") === "true") await act(async () => { fireDomEvent.click(trigger); });
  }
}

/** The row action with this label, inline or in ⋯; a menu item is returned with its menu open. */
async function rowAction(container: HTMLElement, label: string): Promise<HTMLButtonElement> {
  const inline = [...container.querySelectorAll<HTMLButtonElement>(".archive-row-actions > .btn")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (inline) return inline;
  for (const trigger of container.querySelectorAll<HTMLButtonElement>('button[aria-label^="More Actions for"]')) {
    await act(async () => { fireDomEvent.click(trigger); });
    const item = [...(domWindow.document as unknown as Document).querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
      .find((candidate) => itemLabel(candidate) === label);
    if (item) return item;
    await act(async () => { fireDomEvent.click(trigger); });
  }
  assert.fail(`${label} row action exists`);
}

test("empty archives expose labelled choice filters and a screen-reader status", async () => {
  const fixture = await mount([]);
  assert.match(fixture.container.textContent ?? "", /No Archived Sessions/);
  assert.equal(fixture.container.querySelector('[role="status"]')?.textContent?.trim(), "Showing 0 Sessions");
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
  assert.match(fixture.container.textContent ?? "", /Archived.*Awaiting Prompt/s,
    "archive and canonical lifecycle labels are both text-backed");
  assert.equal(fixture.container.querySelector('nav[aria-label="Archived Sessions Pagination"]')?.textContent?.includes("Page 1"), true);
  assert.ok(await rowAction(fixture.container, "Stop"), "ordinary nonterminal archived sessions retain the Stop action");
  const tableRegion = fixture.container.querySelector<HTMLElement>('[role="region"][aria-label="Archived Sessions Table"]');
  assert.equal(tableRegion?.tabIndex, 0, "the horizontally scrolling table is keyboard reachable");
  assert.equal(fixture.container.querySelectorAll('th[scope="col"]').length, 7,
    "every table header declares its column scope");

  const firstLink = fixture.container.querySelector<HTMLAnchorElement>('tbody a[href^="/sessions/"]');
  assert.ok(firstLink, "session titles are direct links");
  await act(async () => { fireDomEvent.click(firstLink!, { button: 0 }); });
  assert.equal(fixture.navigated.at(-1)?.name, "session");

  await act(async () => { fireDomEvent.click(button(fixture.container, "Next Page")); });
  assert.equal(fixture.container.querySelectorAll("tbody tr").length, 5);
  assert.match(fixture.container.textContent ?? "", /Page 2/);

  const lifecycle = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Lifecycle State:"]');
  assert.ok(lifecycle);
  await act(async () => { lifecycle.click(); });
  const inputRequired = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((option) => option.textContent?.trim() === "Awaiting Input");
  assert.ok(inputRequired);
  await act(async () => { inputRequired.click(); });
  assert.equal(fixture.container.querySelectorAll("tbody tr").length, 1);
  assert.match(fixture.container.textContent ?? "", /Awaiting Input/);

  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: session(0, { status: "stopped", updatedAt: 100 }) });
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /No Matching Sessions/,
    "a second client's lifecycle change immediately re-evaluates the active filter");
  await fixture.unmount();
});

test("search input debounces to one request and preserves server row order", async () => {
  const fixture = await mount([
    session(1, { id: "older", title: "Older", createdAt: 1, updatedAt: 999 }),
    session(2, { id: "newer", title: "Newer", createdAt: 2, updatedAt: 1 }),
  ]);
  const initialCalls = fixture.archivePageCalls();
  const links = [...fixture.container.querySelectorAll<HTMLAnchorElement>("tbody a")];
  assert.deepEqual(links.map((link) => link.textContent), ["Newer", "Older"],
    "the browser preserves the server's immutable createdAt cursor order");
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    for (const value of ["n", "ne", "new", "newe", "newer"]) {
      input.value = value;
      fireDomEvent.change(input);
    }
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  assert.equal(fixture.archivePageCalls(), initialCalls + 1);
  await fixture.unmount();
});

test("the palette's Search Archived Sessions opens the archive already searching its words (#1978)", async () => {
  requestArchiveSearch("login");
  const fixture = await mount([session(1, { id: "one", title: "Login work" })]);
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  assert.equal(input.value, "login");
  assert.equal(fixture.archiveInputs[0]?.q, "login", "the first page is already the search, not the whole archive");
  assert.equal(takeArchiveSearch(), null, "the query is taken once");

  // With the archive already open under the palette, the handoff arrives as an event.
  await act(async () => { requestArchiveSearch("deploy"); });
  assert.equal(input.value, "deploy");
  await fixture.unmount();
});

test("a Project literally named all is encoded distinctly from All Projects", async () => {
  const rows = [session(1, { projectName: "all" })];
  const fixture = await mount(rows);
  const project = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Project:"]')!;
  await act(async () => { project.click(); });
  const namedAll = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((option) => option.textContent?.trim() === "all");
  assert.ok(namedAll);
  await act(async () => {
    namedAll.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(fixture.archiveInputs.at(-1)?.project, "all");

  const callsBeforeUpdate = fixture.archivePageCalls();
  const updated = session(1, { projectName: "Other Project", updatedAt: 20 });
  rows[0] = updated;
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: updated });
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /No Matching Sessions/,
    "literal all remains an active facet during live reconciliation");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
  assert.equal(fixture.archivePageCalls(), callsBeforeUpdate + 1);
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
  await act(async () => { fireDomEvent.click(button(fixture.container, "Unarchive")); await Promise.resolve(); });
  assert.deepEqual(calls, [[archived.id, false]]);
  assert.match(fixture.container.textContent ?? "", /No Archived Sessions/);
  await fixture.unmount();
});

function hasButton(container: HTMLElement, label: string): boolean {
  return [...container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === label);
}

test("Unarchive and Restart is one server request that opens the restarting session without Undo", async () => {
  const restoreCalls: string[] = [];
  const archived = session(1, { status: "completed" });
  const fixture = await mount([archived], {
    setArchived: async () => {
      throw new Error("the combined action must not compose a plain unarchive");
    },
    restart: async () => {
      throw new Error("the combined action must not compose a separate restart");
    },
    unarchiveAndRestart: async (id) => {
      restoreCalls.push(id);
      return { ...archived, archived: false, status: "starting", updatedAt: archived.updatedAt + 1 };
    },
  }, { unarchiveAndRestart: true });

  assert.equal(hasButton(fixture.container, "Unarchive"), false, "one combined action replaces the two-step flow");
  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Unarchive and Restart"));
    await Promise.resolve();
  });

  assert.deepEqual(restoreCalls, [archived.id]);
  assert.deepEqual(fixture.navigated, [{ name: "session", id: archived.id }]);
  assert.match(fixture.container.textContent ?? "", /Session restored and restarting\./);
  assert.equal(hasButton(fixture.container, "Undo"), false,
    "Undo would re-archive a running session without stopping it");
  await fixture.unmount();
});

test("an Unarchive and Restart preflight refusal keeps the row archived with an actionable error", async () => {
  const archived = session(1, { status: "completed" });
  const fixture = await mount([archived], {
    unarchiveAndRestart: async () => {
      throw new ApiError("runner is offline", 409, undefined, { error: "runner is offline", archived: true });
    },
  }, { unarchiveAndRestart: true });
  const loadsBefore = fixture.archivePageCalls();

  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Unarchive and Restart"));
    await Promise.resolve();
  });

  assert.match(fixture.container.textContent ?? "",
    /Could not unarchive and restart session: runner is offline\. The session is still archived\./);
  assert.equal(button(fixture.container, "Unarchive and Restart").disabled, false, "the action can be retried");
  assert.deepEqual(fixture.navigated, []);
  assert.equal(fixture.archivePageCalls(), loadsBefore, "a definite refusal needs no reconciliation");
  await fixture.unmount();
});

test("an ambiguous Unarchive and Restart failure reconciles the row against the server", async () => {
  const archived = session(1, { status: "completed" });
  const fixture = await mount([archived], {
    unarchiveAndRestart: async () => {
      throw new TypeError("Failed to fetch");
    },
  }, { unarchiveAndRestart: true });
  const loadsBefore = fixture.archivePageCalls();

  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Unarchive and Restart"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.match(fixture.container.textContent ?? "", /Could not confirm Unarchive and Restart: Failed to fetch\./);
  assert.ok(fixture.archivePageCalls() > loadsBefore, "delivery uncertainty is resolved from the server");
  await fixture.unmount();
});

test("an older control plane keeps the plain Unarchive and never emulates the combined action", async () => {
  const archived = session(1, { status: "completed" });
  const calls: string[] = [];
  const fixture = await mount([archived], {
    setArchived: async (id, value) => {
      calls.push(`archive:${id}:${value}`);
      return { ...archived, archived: value, updatedAt: archived.updatedAt + 1 };
    },
    restart: async (id) => {
      calls.push(`restart:${id}`);
      return archived;
    },
    unarchiveAndRestart: async (id) => {
      calls.push(`combined:${id}`);
      return archived;
    },
  });

  assert.equal(hasButton(fixture.container, "Unarchive and Restart"), false);
  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Unarchive"));
    await Promise.resolve();
  });
  assert.deepEqual(calls, [`archive:${archived.id}:false`], "no restart is composed on the client");
  await fixture.unmount();
});

test("Stopping sessions keep their Stop recovery path instead of Unarchive and Restart", async () => {
  const pending = session(2, {
    archived: false,
    status: "stopped",
    archiveStatus: "stop_pending",
  } as Partial<SessionView>);
  const fixture = await mount([pending], {}, { unarchiveAndRestart: true });

  assert.equal(hasButton(fixture.container, "Unarchive and Restart"), false);
  assert.ok(button(fixture.container, "Retry Stop"));
  await fixture.unmount();
});

test("Stopping sessions fall back to the legacy idempotent archive mutation", async () => {
  const calls: Array<[string, boolean]> = [];
  const pending = session(2, {
    archived: false,
    status: "stopped",
    archiveStatus: "stop_pending",
  } as Partial<SessionView>);
  const fixture = await mount([pending], {
    retryStop: async () => {
      throw new Error("the v85-only route must not be called");
    },
    setArchived: async (id, archived) => {
      calls.push([id, archived]);
      return pending;
    },
  });

  // The Stop is still being delivered to a connected runner, so it reads Stop Pending (#208).
  assert.match(fixture.container.textContent ?? "", /Stop Pending/);
  const retry = button(fixture.container, "Retry Stop");
  assert.equal([...fixture.container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Stop"), false,
    "pending recovery replaces the ordinary Stop action even for a terminal lifecycle");
  await act(async () => { fireDomEvent.click(retry); await Promise.resolve(); });

  assert.deepEqual(calls, [[pending.id, true]], "legacy retry reissues the archive intent");
  assert.equal(fixture.container.querySelector('.toast-region[aria-live="polite"] [role="status"]')?.textContent?.includes("Stop retry requested."), true,
    "success is announced in the accessible live toast region");
  await fixture.unmount();
});

test("Stop Failed sessions disclose bounded failure detail and expose Retry Stop", async () => {
  const calls: string[] = [];
  const failed = session(3, {
    archived: false,
    status: "stopped",
    archiveStatus: "stop_failed",
    archiveOperation: {
      operationId: "stop-operation",
      status: "stop_failed",
      requestedAt: 100,
      lastAttemptAt: 200,
      attemptCount: 3,
      capacityReleased: false,
      failure: { code: "retry_exhausted", message: "Automatic retries were exhausted.", failedAt: 300 },
    },
  });
  const fixture = await mount([failed], {
    retryStop: async (id) => {
      calls.push(id);
      return {
        ...failed,
        archiveStatus: "stop_pending",
        archiveOperation: { ...failed.archiveOperation!, status: "stop_pending", failure: undefined },
      };
    },
  });

  const badge = [...fixture.container.querySelectorAll<HTMLElement>(".archive-state-badges .status")]
    .find((candidate) => candidate.textContent?.trim() === "Stop Failed");
  assert.equal(badge?.title, "Automatic retries were exhausted.");
  await act(async () => { fireDomEvent.click(button(fixture.container, "Retry Stop")); await Promise.resolve(); });
  assert.deepEqual(calls, [failed.id]);
  await fixture.unmount();
});

test("a successful deletion cannot be resurrected by the live session overlay", async () => {
  const archived = session(4);
  const deleted: string[] = [];
  const fixture = await mount([archived], {
    deleteSession: async (id) => { deleted.push(id); },
  });

  const open = await rowAction(fixture.container, "Open");
  await act(async () => {
    fireDomEvent.click(open);
    await Promise.resolve();
  });
  const remove = await rowAction(fixture.container, "Delete");
  await act(async () => {
    fireDomEvent.click(remove);
    await Promise.resolve();
  });
  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Delete Session"));
    await Promise.resolve();
  });

  assert.deepEqual(deleted, [archived.id]);
  assert.doesNotMatch(fixture.container.textContent ?? "", /Archived Session 4/);

  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: session(5, { updatedAt: 100 }) });
    await Promise.resolve();
  });
  assert.doesNotMatch(fixture.container.textContent ?? "", /Archived Session 4/,
    "an unrelated live update does not merge the deleted cached session back into the catalog");
  assert.doesNotMatch(fixture.container.textContent ?? "", /Archived Session 5/,
    "a bounded page does not expand based on websocket arrival order");
  await fixture.unmount();
});

/** Opens a row action's confirmation and returns its body, then cancels it. */
async function confirmationBody(container: HTMLElement, action: string): Promise<string> {
  const item = await rowAction(container, action);
  await act(async () => {
    fireDomEvent.click(item);
    await Promise.resolve();
  });
  const body = container.querySelector(".feedback-confirmation .confirmation-message")?.textContent ?? "";
  await act(async () => {
    fireDomEvent.click(button(container, "Cancel"));
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return body;
}

const MULTI_LINE_TITLE = "Fix the half-cent rounding bug\nRequirements:\n- keep cents";

test("Delete Session names the session by its one-line title in the session header's words (#2278)", async () => {
  const fixture = await mount([session(6, { title: MULTI_LINE_TITLE, status: "stopped" })]);

  const body = await confirmationBody(fixture.container, "Delete");
  assert.equal(body, deleteSessionMessage(MULTI_LINE_TITLE));
  assert.equal(body, "“Fix the half-cent rounding bug” and its history are removed from Wollipog. This can't be undone.");
  assert.ok(!body.includes("\n") && !body.includes("Requirements"), "only the title's first line is quoted");
  await fixture.unmount();
});

test("Stop Session names the session by its one-line title and mentions queued messages only when there are some (#2278)", async () => {
  const queued = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `queued-${index}`, text: `Queued ${index}` }));
  for (const [count, expected] of [
    [0, "“Fix the half-cent rounding bug” stops now. It stays in Archived Sessions with its transcript."],
    [1, "“Fix the half-cent rounding bug” stops now and its 1 queued message is discarded. It stays in Archived Sessions with its transcript."],
    [2, "“Fix the half-cent rounding bug” stops now and its 2 queued messages are discarded. It stays in Archived Sessions with its transcript."],
  ] as const) {
    const fixture = await mount([session(7, {
      title: MULTI_LINE_TITLE,
      status: "running",
      ...(count ? { queued: queued(count) } : {}),
    })]);

    const body = await confirmationBody(fixture.container, "Stop");
    assert.equal(body, expected);
    assert.equal(body, stopArchivedSessionMessage(MULTI_LINE_TITLE, count));
    assert.ok(!body.includes("\n") && !body.includes("Requirements"), "only the title's first line is quoted");
    assert.equal(/queued/.test(body), count > 0, "the queued clause appears only when messages are queued");
    assert.doesNotMatch(body, /Stop Turn|composer/, "an archived session shows no composer");
    await fixture.unmount();
  }
});

test("Stop Session counts only queued messages still waiting, not settled delivery receipts (#2278)", async () => {
  const fixture = await mount([session(8, {
    title: "Settled Receipts",
    status: "running",
    queued: [
      { id: "waiting", text: "Still waiting" },
      { id: "failed", text: "Failed to deliver", durableDeliveryState: "failed" },
    ],
  })]);

  const body = await confirmationBody(fixture.container, "Stop");
  assert.equal(body, "“Settled Receipts” stops now and its 1 queued message is discarded. It stays in Archived Sessions with its transcript.");
  await fixture.unmount();
});

test("Stop Session counts the live queue the session header counts, even when the archive row has none (#2278)", async () => {
  // A steer converted to a queued prompt exists only in the runner's queue: the REST row has no
  // `queued`, and the live upsert that carries it keeps the same updatedAt, so the row is not replaced.
  const row = session(9, { title: "Runner Queue", status: "running", updatedAt: 50 });
  const fixture = await mount([row]);
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: { ...row, queued: [{ id: "steer-converted", text: "Converted steer" }] } });
    await Promise.resolve();
  });

  const body = await confirmationBody(fixture.container, "Stop");
  assert.equal(body, "“Runner Queue” stops now and its 1 queued message is discarded. It stays in Archived Sessions with its transcript.");
  await fixture.unmount();
});

test("paged search failures expose a retryable load error", async () => {
  const archived = session(3, { title: "Metadata Match" });
  const fixture = await mount([archived], {
    archiveSessionPage: async () => { throw new Error("search unavailable"); },
  });
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]');
  assert.ok(input);
  await act(async () => {
    input.value = "metadata";
    fireDomEvent.change(input);
  });
  await act(async () => { await Promise.resolve(); });
  assert.match(
    fixture.container.textContent ?? "",
    /Could not load archived sessions: search unavailable/,
  );
  await fixture.unmount();
});

test("reconnecting during a pending archive load schedules exactly one post-load revalidation", async () => {
  const stale = session(1, { title: "Stale Archived Session" });
  const fresh = session(2, { title: "Fresh Archived Session" });
  let calls = 0;
  let resolveInitial!: (response: Awaited<ReturnType<ApiClient["archiveSessionPage"]>>) => void;
  const initial = new Promise<Awaited<ReturnType<ApiClient["archiveSessionPage"]>>>((resolve) => {
    resolveInitial = resolve;
  });
  const fixture = await mount([], {
    archiveSessionPage: async () => {
      calls += 1;
      return calls === 1 ? initial : archiveResponse([fresh]);
    },
  });
  assert.equal(calls, 1);

  await act(async () => {
    fixture.socket.onclose?.({ code: 1006 });
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_550));
    fixture.socket.push(snapshot());
    await Promise.resolve();
  });
  assert.equal(calls, 1, "reconnect records a pending refresh instead of overlapping the active request");

  await act(async () => {
    resolveInitial(archiveResponse([stale]));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.equal(calls, 2, "the completed request is followed by one bounded revalidation");
  assert.match(fixture.container.textContent ?? "", /Fresh Archived Session/);
  assert.doesNotMatch(fixture.container.textContent ?? "", /Stale Archived Session/);
  await fixture.unmount();
});

test("first online connection revalidates a catalog loaded while unauthorized", async () => {
  const stale = session(42, { id: "initial-unauthorized-stale", title: "Initial Unauthorized Stale" });
  const fresh = session(43, { id: "initial-unauthorized-fresh", title: "Initial Unauthorized Fresh" });
  let current = stale;
  let calls = 0;
  const fixture = await mount([], {
    archiveSessionPage: async () => {
      calls += 1;
      return archiveResponse([current]);
    },
  }, { initialConnection: "unauthorized" });
  assert.equal(calls, 1);
  assert.match(fixture.container.textContent ?? "", /Initial Unauthorized Stale/);

  current = fresh;
  await act(async () => {
    fixture.socket.push(snapshot());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(calls, 2);
  assert.match(fixture.container.textContent ?? "", /Initial Unauthorized Fresh/);
  assert.doesNotMatch(fixture.container.textContent ?? "", /Initial Unauthorized Stale/);
  await fixture.unmount();
});

test("a live title update removes a row that no longer matches the active query", async () => {
  const rows = [session(1, { title: "Needle Session" })];
  const fixture = await mount(rows);
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "needle";
    fireDomEvent.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  assert.match(fixture.container.textContent ?? "", /Needle Session/);
  const callsBeforeUpdate = fixture.archivePageCalls();

  const updated = session(1, { title: "Different Session", updatedAt: 20 });
  rows[0] = updated;
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: updated });
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

  assert.match(fixture.container.textContent ?? "", /No Matching Sessions/);
  assert.equal(fixture.archivePageCalls(), callsBeforeUpdate + 1);
  await fixture.unmount();
});

test("a live Project update removes a row that no longer matches the active facet", async () => {
  const rows = [session(1, { projectName: "Wollipog" })];
  const fixture = await mount(rows);
  const project = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Project:"]')!;
  await act(async () => { project.click(); });
  const wollipog = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((option) => option.textContent?.trim() === "Wollipog");
  assert.ok(wollipog);
  await act(async () => {
    wollipog.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(fixture.container.textContent ?? "", /Archived Session 1/);
  const callsBeforeUpdate = fixture.archivePageCalls();

  const updated = session(1, { projectName: "Other Project", updatedAt: 20 });
  rows[0] = updated;
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: updated });
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

  assert.match(fixture.container.textContent ?? "", /No Matching Sessions/);
  assert.equal(fixture.archivePageCalls(), callsBeforeUpdate + 1);
  await fixture.unmount();
});

test("an unresolved live Location preserves the server facet match until bounded revalidation", async () => {
  let current = session(41, {
    id: "resolved-location",
    title: "Server Location Match",
    projectLocationId: "location-not-yet-in-projects",
    workspaceName: "Workspace Fallback",
  });
  let calls = 0;
  const serverResponse = () => ({
    ...archiveResponse([current]),
    metadata: {
      [current.id]: { project: "Wollipog", location: "Server Location", agent: "Codex App Server" },
    },
    facets: { projects: ["Wollipog"], locations: ["Server Location"], agents: ["Codex App Server"] },
  });
  const fixture = await mount([], {
    archiveSessionPage: async () => {
      calls += 1;
      return serverResponse();
    },
  });
  const location = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Location:"]')!;
  await act(async () => { location.click(); });
  const serverLocation = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((option) => option.textContent?.trim() === "Server Location");
  assert.ok(serverLocation);
  await act(async () => {
    serverLocation.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(fixture.container.textContent ?? "", /Server Location Match/);
  const callsBeforeUpdate = calls;

  current = { ...current, updatedAt: current.updatedAt + 1 };
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: current });
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /Server Location Match/,
    "missing client metadata cannot transiently invalidate the server facet match");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

  assert.equal(calls, callsBeforeUpdate + 1);
  assert.match(fixture.container.textContent ?? "", /Server Location Match/);
  await fixture.unmount();
});

test("an unresolved Workspace name preserves the server Location facet until bounded revalidation", async () => {
  let current = session(44, {
    id: "resolved-workspace-location",
    title: "Server Workspace Match",
    projectLocationId: null,
    workspaceId: "workspace-resolved-only-on-server",
    workspaceName: null,
  });
  let calls = 0;
  const serverResponse = () => ({
    ...archiveResponse([current]),
    metadata: {
      [current.id]: { project: "Wollipog", location: "Resolved Workspace", agent: "Codex App Server" },
    },
    facets: { projects: ["Wollipog"], locations: ["Resolved Workspace"], agents: ["Codex App Server"] },
  });
  const fixture = await mount([], {
    archiveSessionPage: async () => {
      calls += 1;
      return serverResponse();
    },
  });
  const location = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Location:"]')!;
  await act(async () => { location.click(); });
  const resolvedWorkspace = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((option) => option.textContent?.trim() === "Resolved Workspace");
  assert.ok(resolvedWorkspace);
  await act(async () => {
    resolvedWorkspace.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const callsBeforeUpdate = calls;

  current = { ...current, updatedAt: current.updatedAt + 1 };
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: current });
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /Server Workspace Match/);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

  assert.equal(calls, callsBeforeUpdate + 1);
  assert.match(fixture.container.textContent ?? "", /Server Workspace Match/);
  await fixture.unmount();
});

test("Undo restores an unarchived row in server cursor order", async () => {
  const rows = [
    session(3, { id: "newest", title: "Newest", createdAt: 30 }),
    session(2, { id: "middle", title: "Middle", createdAt: 20 }),
    session(1, { id: "oldest", title: "Oldest", createdAt: 10 }),
  ];
  const fixture = await mount(rows, {
    setArchived: async (id, archived) => {
      const index = rows.findIndex((item) => item.id === id);
      assert.notEqual(index, -1);
      const updated = { ...rows[index]!, archived, updatedAt: rows[index]!.updatedAt + 1 };
      rows[index] = updated;
      return updated;
    },
  });
  const rowTitles = () => [...fixture.container.querySelectorAll<HTMLAnchorElement>("tbody a")]
    .map((link) => link.textContent);
  assert.deepEqual(rowTitles(), ["Newest", "Middle", "Oldest"]);

  const newestRow = [...fixture.container.querySelectorAll<HTMLElement>("tbody tr")]
    .find((row) => row.textContent?.includes("Newest"));
  assert.ok(newestRow);
  await act(async () => {
    fireDomEvent.click(button(newestRow, "Unarchive"));
    await Promise.resolve();
  });
  assert.deepEqual(rowTitles(), ["Middle", "Oldest"]);

  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Undo"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(rowTitles(), ["Newest", "Middle", "Oldest"]);

  await fixture.unmount();
});
test("server search rows remain authoritative when local derived labels differ", async () => {
  const serverMatch = session(30, { id: "server-match", title: "Server Match", status: "idle" });
  const fixture = await mount([], {
    archiveSessionPage: async () => archiveResponse([serverMatch]),
  });
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "idle";
    fireDomEvent.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

  assert.match(fixture.container.textContent ?? "", /Server Match/,
    "the client does not reject a row the server matched using raw lifecycle data");
  await fixture.unmount();
});

test("a live idle upsert preserves a server lifecycle-label match without revalidation", async () => {
  const rows = [session(35, { id: "idle-match", title: "Lifecycle Search Result", status: "idle" })];
  let calls = 0;
  const fixture = await mount([], {
    archiveSessionPage: async (input) => {
      calls += 1;
      return archiveResponse(!input.q || input.q.toLocaleLowerCase() === "idle" ? rows : []);
    },
  });
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "idle";
    fireDomEvent.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  assert.match(fixture.container.textContent ?? "", /Lifecycle Search Result/);
  const callsBeforeUpdate = calls;

  rows[0] = { ...rows[0]!, updatedAt: rows[0]!.updatedAt + 1 };
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: rows[0]! });
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /Lifecycle Search Result/,
    "the server-returned row never flickers out after the upsert");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
  assert.equal(calls, callsBeforeUpdate, "search-label parity avoids an unnecessary request");
  await fixture.unmount();
});

test("a live upsert preserves an unreproducible server search match until bounded revalidation", async () => {
  let current = session(40, { id: "resolved-match", title: "Resolved Metadata Result" });
  let calls = 0;
  const fixture = await mount([], {
    archiveSessionPage: async () => {
      calls += 1;
      return archiveResponse([current]);
    },
  });
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "server-only-location";
    fireDomEvent.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  assert.match(fixture.container.textContent ?? "", /Resolved Metadata Result/);
  const callsBeforeUpdate = calls;

  current = { ...current, updatedAt: current.updatedAt + 1 };
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: current });
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /Resolved Metadata Result/,
    "an uncertain client-side search miss does not transiently hide the server match");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

  assert.equal(calls, callsBeforeUpdate + 1);
  assert.match(fixture.container.textContent ?? "", /Resolved Metadata Result/);
  await fixture.unmount();
});

test("a REST mutation preserves an unreproducible server search match until bounded revalidation", async () => {
  let current = session(45, { id: "mutation-server-match", title: "Mutation Server Match" });
  let calls = 0;
  const fixture = await mount([], {
    archiveSessionPage: async () => {
      calls += 1;
      return archiveResponse([current]);
    },
    stop: async () => {
      current = { ...current, updatedAt: current.updatedAt + 1 };
      return current;
    },
  });
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "server-only-metadata";
    fireDomEvent.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  const callsBeforeMutation = calls;

  const stopAction = await rowAction(fixture.container, "Stop");
  await act(async () => { fireDomEvent.click(stopAction); });
  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Stop Session"));
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /Mutation Server Match/,
    "the mutation response does not transiently invalidate the server search match");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

  assert.equal(calls, callsBeforeMutation + 1);
  assert.match(fixture.container.textContent ?? "", /Mutation Server Match/);
  await fixture.unmount();
});

test("credential-only reconnect revalidates the archive exactly once", async () => {
  const stale = session(36, { id: "credential-stale", title: "Credential Stale" });
  const fresh = session(37, { id: "credential-fresh", title: "Credential Fresh" });
  let calls = 0;
  const fixture = await mount([], {
    archiveSessionPage: async () => archiveResponse([++calls === 1 ? stale : fresh]),
  });
  assert.equal(calls, 1);

  await fixture.reconnectWithCredential();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.equal(calls, 2);
  assert.match(fixture.container.textContent ?? "", /Credential Fresh/);
  assert.doesNotMatch(fixture.container.textContent ?? "", /Credential Stale/);
  await fixture.unmount();
});

test("credential reconnect during a pending load schedules one non-overlapping revalidation", async () => {
  const stale = session(38, { id: "pending-stale", title: "Pending Stale" });
  const fresh = session(39, { id: "pending-fresh", title: "Pending Fresh" });
  let calls = 0;
  let resolveInitial!: (response: Awaited<ReturnType<ApiClient["archiveSessionPage"]>>) => void;
  const initial = new Promise<Awaited<ReturnType<ApiClient["archiveSessionPage"]>>>((resolve) => {
    resolveInitial = resolve;
  });
  const fixture = await mount([], {
    archiveSessionPage: async () => ++calls === 1 ? initial : archiveResponse([fresh]),
  });
  assert.equal(calls, 1);

  await fixture.reconnectWithCredential();
  assert.equal(calls, 1, "credential recovery does not overlap the pending request");
  await act(async () => {
    resolveInitial(archiveResponse([stale]));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.equal(calls, 2);
  assert.match(fixture.container.textContent ?? "", /Pending Fresh/);
  assert.doesNotMatch(fixture.container.textContent ?? "", /Pending Stale/);
  await fixture.unmount();
});

test("a stale live snapshot cannot overwrite a newer REST row or trigger a refresh loop", async () => {
  const fresh = session(31, { id: "versioned", title: "Fresh REST Row", updatedAt: 120 });
  const fixture = await mount([fresh]);
  const callsBeforeUpdate = fixture.archivePageCalls();

  await act(async () => {
    fixture.socket.push({
      type: "session_upsert",
      session: { ...fresh, title: "Stale Live Row", status: "running", updatedAt: 100 },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  assert.match(fixture.container.textContent ?? "", /Fresh REST Row/);
  assert.doesNotMatch(fixture.container.textContent ?? "", /Stale Live Row/);
  assert.equal(fixture.archivePageCalls(), callsBeforeUpdate);
  await fixture.unmount();
});

test("bursty live filter misses coalesce into one bounded revalidation", async () => {
  const rows = [
    session(32, { id: "burst-one", title: "Needle One" }),
    session(33, { id: "burst-two", title: "Needle Two" }),
  ];
  const fixture = await mount(rows);
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "needle";
    fireDomEvent.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  const callsBeforeUpdate = fixture.archivePageCalls();

  const first = { ...rows[0]!, title: "Different One", updatedAt: 100 };
  const second = { ...rows[1]!, title: "Different Two", updatedAt: 101 };
  rows.splice(0, rows.length, first, second);
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: first });
    await Promise.resolve();
  });
  await act(async () => {
    fixture.socket.push({ type: "session_upsert", session: second });
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

  assert.equal(fixture.archivePageCalls(), callsBeforeUpdate + 1);
  assert.match(fixture.container.textContent ?? "", /No Matching Sessions/);
  await fixture.unmount();
});

test("Undo revalidates with the filters active when Undo is clicked", async () => {
  const rows = [session(34, { id: "undo-current-filter", title: "Undo Current Filter" })];
  const fixture = await mount(rows, {
    setArchived: async (id, archived) => {
      const updated = { ...rows[0]!, id, archived, updatedAt: rows[0]!.updatedAt + 1 };
      rows[0] = updated;
      return updated;
    },
  });

  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Unarchive"));
    await Promise.resolve();
  });
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "current-filter";
    fireDomEvent.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  await act(async () => {
    fireDomEvent.click(button(fixture.container, "Undo"));
    await Promise.resolve();
  });

  assert.equal(fixture.archiveInputs.at(-1)?.q, "current-filter");
  await fixture.unmount();
});

const VIEWER = "Your Viewer role is read-only.";
const viewerPermissions: SessionCommandPermissions = {
  stop: { allowed: false, reason: VIEWER },
  restart: { allowed: false, reason: VIEWER },
  stopBackgroundJob: { allowed: false, reason: VIEWER },
  archive: { allowed: false, reason: VIEWER },
  unarchive: { allowed: false, reason: VIEWER },
  prompt: { allowed: false, reason: VIEWER },
  delete: { allowed: false, reason: VIEWER },
};

function buttons(container: HTMLElement, label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((candidate) => candidate.textContent?.trim() === label);
}

function viewerRows(commandPermissions: SessionCommandPermissions | undefined): SessionView[] {
  const permissions = commandPermissions ? { commandPermissions } : {};
  return [
    session(40, { id: "viewer-archived-running", title: "Archived Running", status: "running", ...permissions }),
    session(41, { id: "viewer-archived-stopped", title: "Archived Stopped", status: "stopped", ...permissions }),
    session(42, {
      id: "viewer-stop-failed", title: "Stop Failed", archived: false, status: "running",
      archiveStatus: "stop_failed",
      archiveOperation: {
        operationId: "stop-operation-viewer", status: "stop_failed", requestedAt: 1, lastAttemptAt: 2, attemptCount: 1,
        capacityReleased: false, failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
      },
      ...permissions,
    }),
  ];
}

function recordingClient(calls: string[]): Partial<ApiClient> {
  return {
    setArchived: async (id, archived) => { calls.push(`archived:${id}:${archived}`); return session(0, { id }); },
    unarchiveAndRestart: async (id) => { calls.push(`unarchive-and-restart:${id}`); return { ok: true } as never; },
    retryStop: async (id) => { calls.push(`retry-stop:${id}`); return session(0, { id }); },
    stop: async (id) => { calls.push(`stop:${id}`); return session(0, { id }); },
    deleteSession: async (id) => { calls.push(`delete:${id}`); return undefined as never; },
  };
}

test("a Viewer sees every refused row action disabled with its reason, and nothing is confirmed or sent", async () => {
  for (const unarchiveAndRestart of [false, true]) {
    const calls: string[] = [];
    const fixture = await mount(viewerRows(viewerPermissions), recordingClient(calls), { unarchiveAndRestart });
    try {
      const restore = unarchiveAndRestart ? "Unarchive and Restart" : "Unarchive";
      const refused: string[] = [];
      await eachRowAction(fixture.container, async (action, label, inMenu) => {
        if (label === "Open") {
          assert.equal(action.disabled, false, "Open still works");
          return;
        }
        refused.push(label);
        assert.equal(action.disabled, true, `${label} is disabled`);
        // Inline, the reason is the button's title; in ⋯ it is the item's visible second line.
        if (inMenu) assert.equal(action.querySelector(".menu-desc")?.textContent, VIEWER, `${label} shows the reason`);
        else assert.equal(action.title, VIEWER, `${label} states the reason on hover`);
        const describedBy = action.getAttribute("aria-describedby");
        assert.ok(describedBy, `${label} is described by its reason`);
        assert.equal(domWindow.document.getElementById(describedBy)?.textContent, VIEWER);
        await act(async () => { fireDomEvent.click(action); await Promise.resolve(); });
      });
      assert.deepEqual(refused.sort(),
        [restore, restore, "Delete", "Delete", "Retry Stop", "Stop"].sort(), "every refused action stays listed");
      assert.deepEqual(calls, [], "nothing is sent");
      assert.doesNotMatch(domWindow.document.body.textContent ?? "", /Stop this session\?|Delete this session\?/u,
        "no confirmation opens");
    } finally {
      await fixture.unmount();
    }
  }
});

test("each row has one inline action and ⋯ for the rest, with Delete last after a separator (§14)", async () => {
  const fixture = await mount([session(7, { title: "Archived Running", status: "running" })]);
  try {
    const cell = fixture.container.querySelector("tbody tr .actions-cell")!;
    assert.deepEqual([...cell.querySelectorAll(".btn")].map((candidate) => candidate.textContent?.trim()), ["Unarchive"],
      "one small ghost button, never a row of text buttons");
    const trigger = cell.querySelector<HTMLButtonElement>('button[aria-label="More Actions for Archived Running"]');
    assert.ok(trigger?.classList.contains("icon-btn"), "the rest are behind an icon ⋯");
    await act(async () => { fireDomEvent.click(trigger!); });
    const doc = domWindow.document as unknown as Document;
    const menu = doc.querySelector('[role="menu"]')!;
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"], [role="separator"]')]
      .map((node) => node.getAttribute("role") === "separator" ? "—" : itemLabel(node)), ["Stop", "Open", "—", "Delete"]);
    assert.ok(menu.querySelector('[role="menuitem"]:last-of-type')?.classList.contains("danger"));
    await act(async () => { fireDomEvent.keyDown(menu.querySelector('[role="menuitem"]')!, { key: "Escape" }); });
    // The trigger takes focus back on the next task, after the menu has unmounted.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(doc.querySelector('[role="menu"]') === null, "Escape closes it");
    // Identity, not assert.equal: a failing equal would try to print both DOM nodes.
    assert.ok(doc.activeElement === trigger, "and returns focus to ⋯");
  } finally {
    await fixture.unmount();
  }
});

test("every row action behind ⋯ is reachable from the keyboard: Stop, Open, then Delete after a separator", async () => {
  // §14: the name is the row's open target and the actions column is one inline action plus ⋯, so
  // the actions that moved into ⋯ have to stay reachable without a pointer.
  const target = session(8, { title: "Keyboard Row", status: "running" });
  const fixture = await mount([target]);
  const doc = domWindow.document as unknown as Document;
  const focused = () => (doc.activeElement?.querySelector(".menu-text") ?? doc.activeElement)?.textContent?.trim();
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  try {
    const trigger = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="More Actions for Keyboard Row"]')!;
    const openMenu = async () => {
      trigger.focus();
      await act(async () => { fireDomEvent.keyDown(trigger, { key: "ArrowDown" }); });
      await settle();
    };
    const key = async (name: string) => {
      await act(async () => { fireDomEvent.keyDown(doc.activeElement!, { key: name }); });
    };

    await openMenu();
    assert.equal(focused(), "Stop", "ArrowDown on ⋯ opens it on its first item");
    await key("ArrowDown");
    assert.equal(focused(), "Open");
    await key("End");
    assert.equal(focused(), "Delete", "Delete is last");
    const items = [...doc.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="separator"]')];
    assert.equal(items.at(-2)?.getAttribute("role"), "separator", "after a separator");

    // Enter activates the focused item, as a button does natively.
    await act(async () => { (doc.activeElement as HTMLButtonElement).click(); await Promise.resolve(); });
    assert.match(doc.querySelector('[role="dialog"]')?.textContent ?? "", /removed from Wollipog/u, "Delete asks for confirmation");
    const cancel = [...doc.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((candidate) => candidate.textContent?.trim() === "Cancel")!;
    await act(async () => { cancel.click(); await Promise.resolve(); });
    await settle();

    await openMenu();
    await key("ArrowDown");
    assert.equal(focused(), "Open");
    await act(async () => { (doc.activeElement as HTMLButtonElement).click(); await Promise.resolve(); });
    assert.deepEqual(fixture.navigated.at(-1), { name: "session", id: target.id }, "Open opens the session");
  } finally {
    await fixture.unmount();
  }
});

test("a person the server allows keeps every row action as before", async () => {
  const allowed = { allowed: true as const };
  for (const commandPermissions of [
    { stop: allowed, restart: allowed, archive: allowed, unarchive: allowed, prompt: allowed, delete: allowed,
      stopBackgroundJob: { allowed: false as const, reason: "Only the owner." } },
    undefined,
  ]) {
    const calls: string[] = [];
    const fixture = await mount(viewerRows(commandPermissions), recordingClient(calls));
    try {
      await eachRowAction(fixture.container, (action, label) => {
        assert.equal(action.disabled, false, `${label} stays enabled`);
        assert.equal(action.getAttribute("aria-describedby"), null);
      });
      await act(async () => { fireDomEvent.click(buttons(fixture.container, "Retry Stop")[0]!); await Promise.resolve(); });
      assert.deepEqual(calls, ["retry-stop:viewer-stop-failed"]);
    } finally {
      await fixture.unmount();
    }
  }
});

test("an empty archive stays offline through a reconnect retry instead of claiming to be empty", async () => {
  const fixture = await mount([]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(fixture.container.textContent ?? "", /No Archived Sessions/);

  await act(async () => {
    fixture.socket.onclose?.({ code: 1006 });
    await Promise.resolve();
  });
  assert.match(fixture.container.textContent ?? "", /Reconnecting…/);
  // The store retries after 1.5s and stays "connecting" until the socket opens again.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_600)); });
  assert.match(fixture.container.textContent ?? "", /Reconnecting…/, "a retry in progress is still offline");
  assert.doesNotMatch(fixture.container.textContent ?? "", /No Archived Sessions/);
  await fixture.unmount();
});
