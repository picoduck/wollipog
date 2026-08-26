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

function archiveResponse(rows: SessionView[]): Awaited<ReturnType<ApiClient["archiveSessionPage"]>> {
  return {
    sessions: rows,
    snippets: {},
    metadata: Object.fromEntries(rows.map((item) => [item.id, {
      project: item.projectName ?? "No Project",
      location: item.workspaceName ?? "No Location",
      agent: "Codex — Interactive",
    }])),
    nextCursor: null,
    hasMore: false,
    facets: {
      projects: [...new Set(rows.map((item) => item.projectName ?? "No Project"))].sort(),
      locations: [...new Set(rows.map((item) => item.workspaceName ?? "No Location"))].sort(),
      agents: ["Codex — Interactive"],
    },
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
        if (input.agent && input.agent !== "Codex — Interactive") return false;
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
          agent: "Codex — Interactive",
        }])),
        nextCursor,
        hasMore: nextCursor !== null,
        facets: {
          projects: [...new Set(sessions.map((item) => item.projectName ?? "No Project"))].sort(),
          locations: [...new Set(sessions.map((item) => item.workspaceName ?? "No Location"))].sort(),
          agents: ["Codex — Interactive"],
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
  await act(async () => { socket.push(snapshot()); await Promise.resolve(); });
  return {
    container,
    root,
    socket,
    navigated,
    archiveInputs,
    archivePageCalls: () => archivePageCalls,
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
  assert.ok([...fixture.container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Stop"),
    "ordinary nonterminal archived sessions retain the Stop action");
  const tableRegion = fixture.container.querySelector<HTMLElement>('[role="region"][aria-label="Archived Sessions Table"]');
  assert.equal(tableRegion?.tabIndex, 0, "the horizontally scrolling table is keyboard reachable");
  assert.equal(fixture.container.querySelectorAll('th[scope="col"]').length, 7,
    "every table header declares its column scope");

  const firstLink = fixture.container.querySelector<HTMLAnchorElement>('tbody a[href^="/sessions/"]');
  assert.ok(firstLink, "session titles are direct links");
  await act(async () => { Simulate.click(firstLink!, { button: 0 }); });
  assert.equal(fixture.navigated.at(-1)?.name, "session");

  await act(async () => { Simulate.click(button(fixture.container, "Next Page")); });
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
      Simulate.change(input);
    }
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  assert.equal(fixture.archivePageCalls(), initialCalls + 1);
  await fixture.unmount();
});

test("a Project literally named all is encoded distinctly from All Projects", async () => {
  const fixture = await mount([session(1, { projectName: "all" })]);
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

  assert.match(fixture.container.textContent ?? "", /Stopping/);
  const retry = button(fixture.container, "Retry Stop");
  assert.equal([...fixture.container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Stop"), false,
    "pending recovery replaces the ordinary Stop action even for a terminal lifecycle");
  await act(async () => { Simulate.click(retry); await Promise.resolve(); });

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

  const badge = [...fixture.container.querySelectorAll<HTMLElement>(".archive-badge")]
    .find((candidate) => candidate.textContent?.trim() === "Stop Failed");
  assert.equal(badge?.title, "Automatic retries were exhausted.");
  await act(async () => { Simulate.click(button(fixture.container, "Retry Stop")); await Promise.resolve(); });
  assert.deepEqual(calls, [failed.id]);
  await fixture.unmount();
});

test("a successful deletion cannot be resurrected by the live session overlay", async () => {
  const archived = session(4);
  const deleted: string[] = [];
  const fixture = await mount([archived], {
    deleteSession: async (id) => { deleted.push(id); },
  });

  await act(async () => {
    Simulate.click(button(fixture.container, "Open"));
    await Promise.resolve();
  });
  await act(async () => {
    Simulate.click(button(fixture.container, "Delete"));
    await Promise.resolve();
  });
  await act(async () => {
    Simulate.click(button(fixture.container, "Delete Session"));
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

test("paged search failures expose a retryable load error", async () => {
  const archived = session(3, { title: "Metadata Match" });
  const fixture = await mount([archived], {
    archiveSessionPage: async () => { throw new Error("search unavailable"); },
  });
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]');
  assert.ok(input);
  await act(async () => {
    input.value = "metadata";
    Simulate.change(input);
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

test("a live title update removes a row that no longer matches the active query", async () => {
  const rows = [session(1, { title: "Needle Session" })];
  const fixture = await mount(rows);
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "needle";
    Simulate.change(input);
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
    Simulate.click(button(newestRow, "Unarchive"));
    await Promise.resolve();
  });
  assert.deepEqual(rowTitles(), ["Middle", "Oldest"]);

  await act(async () => {
    Simulate.click(button(fixture.container, "Undo"));
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
    Simulate.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

  assert.match(fixture.container.textContent ?? "", /Server Match/,
    "the client does not reject a row the server matched using raw lifecycle data");
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
    Simulate.change(input);
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
    Simulate.click(button(fixture.container, "Unarchive"));
    await Promise.resolve();
  });
  const input = fixture.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    input.value = "current-filter";
    Simulate.change(input);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  await act(async () => {
    Simulate.click(button(fixture.container, "Undo"));
    await Promise.resolve();
  });

  assert.equal(fixture.archiveInputs.at(-1)?.q, "current-filter");
  await fixture.unmount();
});
