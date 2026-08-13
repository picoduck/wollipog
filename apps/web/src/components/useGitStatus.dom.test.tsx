import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GitStatusInfo, GitSummaryInfo, SessionView } from "@wollipog/protocol";
import { ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import {
  GIT_STATUS_POLL_MS,
  useGitStatus,
  useGitSummary,
  type GitStatus,
  type GitSummary,
} from "./useGitStatus.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

function session(
  id: string,
  worktreePath: string | null,
  sessionStatus: SessionView["status"] = "idle",
): SessionView {
  return {
    id,
    runnerId: "runner",
    status: sessionStatus,
    worktreePath,
    useWorktree: worktreePath !== null,
  } as SessionView;
}

function status(branch: string): GitStatusInfo {
  return { branch, files: [], hasChanges: false, ahead: 0, remoteUrl: null };
}

function summary(branch: string): GitSummaryInfo {
  return {
    branch,
    ahead: 0,
    behind: 0,
    hasChanges: false,
    addedLines: 0,
    deletedLines: 0,
    remoteUrl: null,
    pr: null,
    checks: null,
  };
}

interface HarnessState {
  status: GitStatus;
  summary: GitSummary;
}

function Harness({
  value,
  online,
  rich,
  reconnect = 0,
  onState,
}: {
  value: SessionView;
  online: boolean;
  rich: boolean;
  reconnect?: number;
  onState: (state: HarnessState) => void;
}) {
  const git = useGitStatus(value, online, rich, reconnect);
  const gitSummary = useGitSummary(value, online, rich, git.mutationRevision, reconnect);
  onState({ status: git, summary: gitSummary });
  return (
    <div>
      <span id="branch">{git.status?.branch ?? "none"}</span>
      <span id="busy">{String(git.busy)}</span>
      <button type="button" id="status-refresh" onClick={() => void git.refresh()}>Status</button>
      <button type="button" id="paired-refresh" onClick={() => void Promise.all([
        git.refreshStatusOnly(), gitSummary.refresh(),
      ])}>Paired</button>
      <button type="button" id="install" onClick={() => git.install(status("installed"))}>Install</button>
    </div>
  );
}

test("primary reads require v76 proof while legacy linked reads stay enabled", async () => {
  const calls: string[] = [];
  const client = {
    git: async (id: string) => {
      calls.push(`status:${id}`);
      return { status: status(`branch-${id}`) };
    },
    gitSummary: async (id: string) => {
      calls.push(`summary:${id}`);
      return { summary: summary(`branch-${id}`) };
    },
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("primary-old", null)} online rich={false} onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.deepEqual(calls, []);
    assert.equal(state.status.status, null);

    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("primary-v76", null)} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.deepEqual(calls.sort(), ["status:primary-v76", "summary:primary-v76"]);
    assert.equal((state.status.status as GitStatusInfo | null)?.branch, "branch-primary-v76");

    calls.length = 0;
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("linked-old", "/repo/wt")} online rich={false} onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.deepEqual(calls.sort(), ["status:linked-old", "summary:linked-old"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("session tags and disabled transitions reject late responses and settle busy state", async () => {
  const pending = new Map<string, {
    status?: (value: { status: GitStatusInfo }) => void;
    summary?: (value: { summary: GitSummaryInfo }) => void;
  }>();
  const client = {
    git: (id: string) => new Promise<{ status: GitStatusInfo }>((resolve) => {
      pending.set(id, { ...pending.get(id), status: resolve });
    }),
    gitSummary: (id: string) => new Promise<{ summary: GitSummaryInfo }>((resolve) => {
      pending.set(id, { ...pending.get(id), summary: resolve });
    }),
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("a", null)} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.equal(state.status.busy, true);

    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("b", null)} online={false} rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.equal(state.status.busy, false);
    assert.equal(container.querySelector("#branch")?.textContent, "none");
    const disabledStatus = state.status;
    const disabledSummary = state.summary;

    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("b", null)} online={false} rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.equal(state.status, disabledStatus, "disabled status projection stays referentially stable");
    assert.equal(state.summary, disabledSummary, "disabled summary projection stays referentially stable");

    await act(async () => {
      pending.get("a")!.status!({ status: status("branch-a") });
      pending.get("a")!.summary!({ summary: summary("branch-a") });
      await Promise.resolve();
    });
    assert.equal(container.querySelector("#branch")?.textContent, "none");
    assert.equal(state.status.status, null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("imperative status refresh and mutation update summary without duplicating paired mount reads", async () => {
  let statusCalls = 0;
  let summaryCalls = 0;
  const client = {
    git: async () => ({ status: status(`status-${++statusCalls}`) }),
    gitSummary: async () => ({ summary: summary(`summary-${++summaryCalls}`) }),
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("primary", null)} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.deepEqual([statusCalls, summaryCalls], [1, 1]);

    await act(async () => container.querySelector<HTMLButtonElement>("#status-refresh")!.click());
    assert.deepEqual([statusCalls, summaryCalls], [2, 2]);

    await act(async () => container.querySelector<HTMLButtonElement>("#paired-refresh")!.click());
    assert.deepEqual([statusCalls, summaryCalls], [3, 3]);

    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness
          value={session("primary", null, "running")}
          online
          rich
          onState={(next) => { state = next; }}
        />
      </ApiProvider>,
    ));
    assert.deepEqual([statusCalls, summaryCalls], [3, 3], "active turns suppress lifecycle reads");
    await act(async () => container.querySelector<HTMLButtonElement>("#install")!.click());
    assert.equal(state.status.status?.branch, "installed");
    assert.equal(summaryCalls, 4);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("mutation-carried status preserves an in-flight read handle and queues later refreshes", async () => {
  let statusCalls = 0;
  const settlements: Array<(value: { status: GitStatusInfo }) => void> = [];
  const client = {
    git: async () => {
      statusCalls += 1;
      if (statusCalls === 1) return { status: status("mounted") };
      return new Promise<{ status: GitStatusInfo }>((resolve) => settlements.push(resolve));
    },
    gitSummary: async () => ({ summary: summary("summary") }),
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("primary", null)} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.equal(statusCalls, 1);

    await act(async () => {
      void state.status.refreshStatusOnly();
      await Promise.resolve();
    });
    assert.equal(statusCalls, 2);
    await act(async () => container.querySelector<HTMLButtonElement>("#install")!.click());
    assert.equal(state.status.status?.branch, "installed");
    await act(async () => {
      void state.status.refreshStatusOnly();
      await Promise.resolve();
    });
    assert.equal(statusCalls, 2, "a refresh after install does not overlap the invalidated request");

    await act(async () => {
      settlements.shift()!({ status: status("obsolete") });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(statusCalls, 3, "the queued refresh starts after the invalidated request settles");
    assert.equal(state.status.status?.branch, "installed", "the invalidated response cannot replace installed status");
    await act(async () => {
      settlements.shift()!({ status: status("refreshed") });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(state.status.status?.branch, "refreshed");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("structured no-repository errors survive both read hooks", async () => {
  const client = {
    git: async () => { throw new ApiError("resolved to a different repository", 409, "GIT_NO_REPOSITORY"); },
    gitSummary: async () => { throw new ApiError("resolved to a different repository", 409, "GIT_NO_REPOSITORY"); },
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("gone", null)} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.equal(state.status.errorCode, "GIT_NO_REPOSITORY");
    assert.equal(state.summary.errorCode, "GIT_NO_REPOSITORY");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a materialized worktree path retries failed reads without a turn-state change", async () => {
  let ready = false;
  let statusCalls = 0;
  let summaryCalls = 0;
  const client = {
    git: async () => {
      statusCalls += 1;
      if (!ready) throw new Error("the session's worktree is still being prepared");
      return { status: status("materialized") };
    },
    gitSummary: async () => {
      summaryCalls += 1;
      if (!ready) throw new Error("the session's worktree is still being prepared");
      return { summary: summary("materialized") };
    },
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("pending", null, "running")} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.equal(state.status.error, "the session's worktree is still being prepared");
    assert.deepEqual([statusCalls, summaryCalls], [1, 1]);

    ready = true;
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("pending", "/repo/wt", "running")} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.deepEqual([statusCalls, summaryCalls], [2, 2]);
    assert.equal(state.status.error, null);
    assert.equal(state.summary.error, null);
    assert.equal(state.status.status?.branch, "materialized");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

function fakeClock(startedAt: number) {
  let now = startedAt;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => now });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: ((callback: () => void, delay = 0) => {
      const id = nextId++;
      timers.set(id, { at: now + Number(delay), callback });
      return id;
    }) as unknown as typeof setTimeout,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout,
  });

  return {
    async advance(ms: number) {
      now += ms;
      let due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      while (due.length > 0) {
        for (const [id, timer] of due) {
          timers.delete(id);
          await act(async () => {
            timer.callback();
            await Promise.resolve();
            await Promise.resolve();
          });
        }
        due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at);
      }
    },
    pending: () => timers.size,
    restore() {
      Object.defineProperty(Date, "now", { configurable: true, writable: true, value: originalDateNow });
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        writable: true,
        value: originalSetTimeout,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        writable: true,
        value: originalClearTimeout,
      });
    },
  };
}

test("visible idle cadence polls status only and lifecycle boundaries refresh both reads", async () => {
  const clock = fakeClock(10_000);
  const ownVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const setVisibility = (value: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
  };
  setVisibility("visible");
  let statusCalls = 0;
  let summaryCalls = 0;
  const client = {
    git: async () => ({ status: status(`status-${++statusCalls}`) }),
    gitSummary: async () => ({ summary: summary(`summary-${++summaryCalls}`) }),
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  const render = async (
    value: SessionView,
    online = true,
    reconnect = 0,
    rich = true,
  ) => {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness
          value={value}
          online={online}
          rich={rich}
          reconnect={reconnect}
          onState={(next) => { state = next; }}
        />
      </ApiProvider>,
    ));
  };
  try {
    await render(session("primary", null));
    assert.deepEqual([statusCalls, summaryCalls], [1, 1]);
    assert.equal(clock.pending(), 1, "idle rich status owns one timeout");

    await clock.advance(GIT_STATUS_POLL_MS - 1);
    assert.deepEqual([statusCalls, summaryCalls], [1, 1]);
    await clock.advance(1);
    assert.deepEqual([statusCalls, summaryCalls], [2, 1], "poll never invokes summary or gh");

    await render(session("primary", null, "running"));
    assert.equal(clock.pending(), 0, "active output cancels the idle timeout");
    await clock.advance(GIT_STATUS_POLL_MS * 2);
    assert.deepEqual([statusCalls, summaryCalls], [2, 1]);

    await render(session("primary", null, "idle"));
    assert.deepEqual([statusCalls, summaryCalls], [3, 2], "active-to-idle refreshes both once");

    await clock.advance(GIT_STATUS_POLL_MS / 2);
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    assert.deepEqual([statusCalls, summaryCalls], [3, 2], "within-window visibility changes do not read early");
    await clock.advance(GIT_STATUS_POLL_MS / 2 - 1);
    assert.deepEqual([statusCalls, summaryCalls], [3, 2]);
    await clock.advance(1);
    assert.deepEqual([statusCalls, summaryCalls], [4, 2], "the preserved deadline still triggers exactly once");

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(clock.pending(), 0);
    await clock.advance(GIT_STATUS_POLL_MS + 1);
    assert.deepEqual([statusCalls, summaryCalls], [4, 2]);
    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    assert.deepEqual([statusCalls, summaryCalls], [5, 2], "overdue foreground reads status only");

    await render(session("primary", null), true, 1);
    assert.deepEqual([statusCalls, summaryCalls], [6, 3], "snapshot reconnect refreshes both");

    await render(session("primary", null), false, 1);
    assert.equal(state.status.busy, false);
    assert.equal(clock.pending(), 0);
    await clock.advance(GIT_STATUS_POLL_MS * 2);
    assert.deepEqual([statusCalls, summaryCalls], [6, 3]);
    await render(session("primary", null), true, 1);
    assert.deepEqual([statusCalls, summaryCalls], [7, 4], "runner recovery refreshes both");

    await render(session("legacy-linked", "/repo/wt"), true, 1, false);
    assert.deepEqual([statusCalls, summaryCalls], [8, 5]);
    assert.equal(clock.pending(), 0, "pre-v76 linked rendering keeps lifecycle reads but never polls");
    await clock.advance(GIT_STATUS_POLL_MS * 2);
    assert.deepEqual([statusCalls, summaryCalls], [8, 5]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clock.restore();
    if (ownVisibilityDescriptor) Object.defineProperty(document, "visibilityState", ownVisibilityDescriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("terminal no-repository and archived sessions do not own cadence timers", async () => {
  const clock = fakeClock(15_000);
  const ownVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  let statusCalls = 0;
  const callsBySession = new Map<string, number>();
  const client = {
    git: async (id: string) => {
      statusCalls += 1;
      const calls = (callsBySession.get(id) ?? 0) + 1;
      callsBySession.set(id, calls);
      if (id === "linked-cadence" && calls === 1) {
        return { status: status("confirmed") };
      }
      if (id === "linked-cadence") {
        throw new Error("worktree is missing or no longer a git repository");
      }
      if (id === "linked-gone") {
        throw new Error("the session's worktree is gone — it resolved to a different repository");
      }
      throw new ApiError("not a repository", 409, "GIT_NO_REPOSITORY");
    },
    gitSummary: async () => ({ summary: summary("none") }),
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={session("gone", null)} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.equal(statusCalls, 1);
    assert.equal(state.status.errorCode, "GIT_NO_REPOSITORY");
    assert.equal(clock.pending(), 0);
    await clock.advance(GIT_STATUS_POLL_MS * 3);
    assert.equal(statusCalls, 1, "a terminal no-repository result is not retried by cadence");

    await act(async () => { await state.status.refresh(); });
    assert.equal(statusCalls, 2, "explicit refresh remains available for recovery");
    assert.equal(clock.pending(), 0);

    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness
          value={session("linked-gone", "/repo/wt")}
          online
          rich
          onState={(next) => { state = next; }}
        />
      </ApiProvider>,
    ));
    assert.equal(statusCalls, 3);
    assert.equal(state.status.errorCode, null);
    assert.match(state.status.error ?? "", /worktree is gone/i);
    assert.equal(clock.pending(), 0, "linked no-repository messages stop cadence too");
    await clock.advance(GIT_STATUS_POLL_MS * 3);
    assert.equal(statusCalls, 3);

    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness
          value={session("linked-cadence", "/repo/wt")}
          online
          rich
          onState={(next) => { state = next; }}
        />
      </ApiProvider>,
    ));
    assert.equal(statusCalls, 4);
    assert.equal(clock.pending(), 1, "a successful linked read owns one cadence timer");
    await clock.advance(GIT_STATUS_POLL_MS);
    assert.equal(statusCalls, 5);
    assert.match(state.status.error ?? "", /no longer a git repository/i);
    assert.equal(clock.pending(), 0, "a background linked terminal result stops cadence");
    await clock.advance(GIT_STATUS_POLL_MS * 3);
    assert.equal(statusCalls, 5);
    await act(async () => { await state.status.refresh(); });
    assert.equal(statusCalls, 6, "manual recovery remains available after background terminal failure");
    assert.equal(clock.pending(), 0);

    const archived = { ...session("archived", null), archived: true };
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness value={archived} online rich onState={(next) => { state = next; }} />
      </ApiProvider>,
    ));
    assert.equal(statusCalls, 7, "archived sessions retain one lifecycle read");
    assert.equal(clock.pending(), 0, "archived sessions never arm cadence");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clock.restore();
    if (ownVisibilityDescriptor) Object.defineProperty(document, "visibilityState", ownVisibilityDescriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("StrictMode transfers one cadence timer between sessions", async () => {
  const clock = fakeClock(18_000);
  const ownVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const calls = new Map<string, { status: number; summary: number }>();
  const counts = (id: string) => calls.get(id) ?? { status: 0, summary: 0 };
  const client = {
    git: async (id: string) => {
      const current = counts(id);
      calls.set(id, { ...current, status: current.status + 1 });
      return { status: status(id) };
    },
    gitSummary: async (id: string) => {
      const current = counts(id);
      calls.set(id, { ...current, summary: current.summary + 1 });
      return { summary: summary(id) };
    },
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  const render = async (id: string) => act(async () => root.render(
    <React.StrictMode>
      <ApiProvider client={client}>
        <Harness value={session(id, null)} online rich onState={(next) => { state = next; }} />
      </ApiProvider>
    </React.StrictMode>,
  ));
  try {
    await render("a");
    assert.equal(clock.pending(), 1, "StrictMode leaves exactly one cadence timer");
    await clock.advance(GIT_STATUS_POLL_MS / 2);
    await render("b");
    assert.equal(clock.pending(), 1, "the replacement session owns exactly one timer");
    const aAfterSwitch = { ...counts("a") };
    const bBeforePoll = { ...counts("b") };
    await clock.advance(GIT_STATUS_POLL_MS);
    assert.deepEqual(counts("a"), aAfterSwitch, "the old session timer is cancelled");
    assert.equal(counts("b").status, bBeforePoll.status + 1);
    assert.equal(counts("b").summary, bBeforePoll.summary, "the replacement cadence remains status-only");
    assert.equal(state.status.status?.branch, "b");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clock.restore();
    if (ownVisibilityDescriptor) Object.defineProperty(document, "visibilityState", ownVisibilityDescriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("busy status reads coalesce lifecycle and manual triggers into at most one trailing read", async () => {
  const clock = fakeClock(20_000);
  const ownVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  let statusCalls = 0;
  let summaryCalls = 0;
  const settlements: Array<{
    resolve: (value: { status: GitStatusInfo }) => void;
    reject: (error: Error) => void;
  }> = [];
  const client = {
    git: () => {
      statusCalls += 1;
      return new Promise<{ status: GitStatusInfo }>((resolve, reject) => {
        settlements.push({ resolve, reject });
      });
    },
    gitSummary: async () => ({ summary: summary(`summary-${++summaryCalls}`) }),
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: HarnessState;
  const render = async (reconnect: number) => {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <Harness
          value={session("primary", null)}
          online
          rich
          reconnect={reconnect}
          onState={(next) => { state = next; }}
        />
      </ApiProvider>,
    ));
  };
  const settle = async (branch: string) => {
    const settlement = settlements.shift();
    assert.ok(settlement, "one status request is awaiting settlement");
    await act(async () => {
      settlement.resolve({ status: status(branch) });
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  try {
    await render(0);
    assert.equal(statusCalls, 1);
    assert.equal(summaryCalls, 1);
    assert.equal(state.status.busy, true);

    await act(async () => {
      void state.status.refresh();
      void state.status.refresh();
      await Promise.resolve();
    });
    await render(1);
    assert.equal(statusCalls, 1, "busy manual and reconnect triggers do not overlap");
    assert.equal(summaryCalls, 2);

    await settle("confirmed-1");
    assert.equal(statusCalls, 2, "all queued triggers collapse into one trailing status read");
    assert.equal(state.status.busy, true);
    await settle("confirmed-2");
    assert.equal(state.status.status?.branch, "confirmed-2");
    assert.equal(state.status.busy, false);

    await clock.advance(GIT_STATUS_POLL_MS);
    assert.equal(statusCalls, 3);
    assert.equal(summaryCalls, 3, "manual status completion refreshes summary, but the poll does not");
    assert.equal(state.status.busy, false, "a background poll does not raise foreground busy state");
    assert.equal(state.status.status?.branch, "confirmed-2", "poll preserves last-confirmed facts while busy");
    await clock.advance(GIT_STATUS_POLL_MS * 2);
    assert.equal(statusCalls, 3, "a busy poll owns no overlapping timer");

    await act(async () => {
      void state.status.refresh();
      void state.status.refresh();
      await Promise.resolve();
    });
    await render(2);
    assert.equal(statusCalls, 3);
    assert.equal(summaryCalls, 4);
    await settle("polled");
    assert.equal(statusCalls, 4, "manual and lifecycle triggers during poll share one trailing read");
    let postMutationResolved = false;
    let postMutationRefresh!: Promise<void>;
    await act(async () => {
      postMutationRefresh = state.status.refresh().then(() => { postMutationResolved = true; });
      void state.status.refresh();
      await Promise.resolve();
    });
    assert.equal(state.status.busy, true, "a foreground refresh remains visibly busy");
    await render(3);
    assert.equal(statusCalls, 4, "foreground triggers do not overlap the running tail");
    await settle("trailing");
    assert.equal(statusCalls, 5, "a foreground trigger during the tail earns one post-trigger read");
    assert.equal(postMutationResolved, false, "foreground refresh waits for its post-trigger read");
    assert.equal(state.status.busy, true);
    await settle("post-trigger");
    await act(async () => { await postMutationRefresh; });
    assert.equal(postMutationResolved, true);
    assert.equal(statusCalls, 5);
    assert.equal(state.status.status?.branch, "post-trigger");
    assert.equal(state.status.busy, false);

    const confirmedAt = state.status.observedAt;
    await clock.advance(GIT_STATUS_POLL_MS);
    assert.equal(statusCalls, 6);
    const failedPoll = settlements.shift();
    assert.ok(failedPoll);
    await act(async () => {
      failedPoll.reject(new Error("status transport failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(state.status.status?.branch, "post-trigger");
    assert.equal(state.status.observedAt, confirmedAt, "a failed poll preserves confirmation time");
    assert.equal(state.status.error, null, "a background transport failure does not announce foreground error state");
    assert.equal(state.status.busy, false);
    assert.equal(summaryCalls, 6, "reconnect and the coalesced manual completion each refresh summary once");

    await clock.advance(GIT_STATUS_POLL_MS - 1);
    assert.equal(statusCalls, 6);
    await clock.advance(1);
    assert.equal(statusCalls, 7, "a transiently failed poll starts a fresh bounded window");
    await settle("recovered");
    assert.equal(state.status.status?.branch, "recovered");
    assert.equal(state.status.error, null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clock.restore();
    if (ownVisibilityDescriptor) Object.defineProperty(document, "visibilityState", ownVisibilityDescriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});
