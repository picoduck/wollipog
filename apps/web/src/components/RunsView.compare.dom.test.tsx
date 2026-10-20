import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunView, SessionEvent, SessionEventsResponse, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { RunDetail } from "./RunsView.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { browserInstanceManager, InstancesContextProvider, type InstanceManager } from "../instances-context.js";

/** A dashboard connected to a remote Wollipog: a reachable run address, so Copy Link is offered. */
const remoteInstances: InstanceManager = {
  ...browserInstanceManager,
  activeProfile: {
    id: "remote", serverInstanceId: "remote", kind: "remote", label: "Team",
    origin: "https://wollipog.example.test", createdAt: "",
  },
};

/**
 * A comparison run's page (#2975): one detail bar with the run's badge and ⋯, the task strip, and
 * flush member columns whose heads name the agent, its status, Open Session and ⋯ and say what it
 * did; on a phone, one member at a time under member tabs that the URL remembers.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const NOW = Date.now();
const member = (id: string, agentName: string, driver: string, status: SessionView["status"]) => ({
  id, runnerId: "runner-1", agentId: agentName.toLowerCase(), agentName, driver, title: agentName, status,
  pendingApproval: null, archived: false, eventEpoch: 0, messageCount: 0, workspaceName: "Alpha",
}) as unknown as SessionView;
const claude = member("s_claude", "Claude Code", "claude-code", "idle");
const codex = member("s_codex", "Codex", "codex-app-server", "running");
const gemini = member("s_gemini", "Gemini CLI", "gemini", "idle");

const LONG_PROMPT = "Refactor the scheduler so a misfire never runs twice.\n\nKeep the stored spec unchanged, add tests for daylight saving, and explain every trade-off in the final answer.";
const run: RunView = {
  id: "run-cmp", title: "Refactor the Scheduler", prompt: LONG_PROMPT, workspaceId: "ws-alpha", workspaceName: "Alpha",
  createdAt: NOW, updatedAt: NOW, sessionIds: [claude.id, codex.id, gemini.id],
};

let seq = 0;
const event = (sessionId: string, payload: SessionEvent["payload"]): SessionEvent =>
  ({ id: ++seq, sessionId, seq, ts: NOW, payload }) as SessionEvent;
const page = (events: SessionEvent[]): SessionEventsResponse =>
  ({ events, eventEpoch: 0, nextAfter: events.at(-1)?.seq ?? 0, cacheComplete: true }) as SessionEventsResponse;
const pending = () => new Promise<never>(() => {});

/** Three commands and one edit, as Claude Code records them: the Edit's tool call and its file edit. */
function claudeTimeline(): SessionEvent[] {
  seq = 0;
  return [
    event(claude.id, { kind: "user_message", text: "Refactor the scheduler" }),
    ...["npm test", "git status", "npm run lint"].map((command, index) =>
      event(claude.id, { kind: "tool_call", toolCallId: `bash-${index}`, title: `$ ${command}`, toolKind: "execute", status: "completed" })),
    event(claude.id, { kind: "tool_call", toolCallId: "edit-1", title: "Edit: src/scheduler.ts", toolKind: "edit", status: "completed" }),
    event(claude.id, { kind: "file_edit", path: "src/scheduler.ts" }),
    event(claude.id, { kind: "agent_message", text: "Done.", final: true }),
  ] as SessionEvent[];
}

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function RunRoute() {
  const view = useStoreSelector((state) => state.view);
  return view.name === "run" ? <RunDetail runId={view.id} member={view.member} /> : null;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  /** Views the page replaced its history entry with. */
  replaced: View[];
}

async function setViewport(width: number, height: number) {
  await act(async () => {
    domWindow.happyDOM.setViewport({ width, height });
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
}

async function mount(client: Partial<ApiClient>, opening: View = { name: "run", id: run.id }): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  // StrictMode opens the store's socket twice; the snapshot goes to the one still open.
  let socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "runs-compare", runtimeKey: "runs-compare:1",
    createSocket: () => (socket = new FakeSocket()),
    close() {},
  };
  const replaced: View[] = [];
  let current = opening;
  const navigation: ViewNavigation = {
    current: () => current,
    push(view) { current = view; },
    replace(view) { current = view; replaced.push(view); },
    listen: () => () => {},
  };
  const apiClient = {
    ...api, workflowInstances: async () => [], runWorkflowArtifacts: async () => ({ artifacts: [] }),
    getSessionEventPage: pending, ...client,
  } as unknown as ApiClient;
  await act(async () => root.render(
    <StrictMode>
      <ApiProvider client={apiClient}>
        <InstancesContextProvider value={remoteInstances}>
          <StoreProvider connection={connection} navigation={navigation}>
            <FeedbackProvider>
              <RunRoute />
            </FeedbackProvider>
          </StoreProvider>
        </InstancesContextProvider>
      </ApiProvider>
    </StrictMode>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [], boxes: [], projects: [], sessions: [claude, codex, gemini], runs: [run], pods: [],
  } as UiSnapshotMessage));
  await settle();
  return { container, root, replaced };
}

async function settle() {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function unmount(fixture: Fixture) {
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
}

async function click(element: unknown) {
  assert.ok(element, "the element to click exists");
  await act(async () => { fireDomEvent.click(element as never); });
  await settle();
}

const column = (container: Element, agent: string) => container.querySelector(`section.compare-member[aria-label="${agent}"]`);
const menuItem = (label: string) => [...domWindow.document.querySelectorAll('[role="menuitem"]')]
  .find((item) => item.textContent?.startsWith(label)) ?? null;

describe("a comparison run's page (#2975)", () => {
  test("the bar shows the run's one badge, and the task is a two-line strip with Show Full Task in ⋯", async () => {
    await setViewport(1440, 900);
    const fixture = await mount({});
    try {
      const bar = fixture.container.querySelector(".detail-bar")!;
      const badges = bar.querySelectorAll(".status");
      assert.equal(badges.length, 1, "one badge in the bar");
      assert.equal(badges[0]!.textContent, "Running", "a running member makes the run Running");
      assert.equal(fixture.container.querySelector(".run-task-prompt")?.textContent, LONG_PROMPT);
      const meta = [...fixture.container.querySelectorAll(".run-task-meta > span")].map((span) => span.textContent);
      assert.equal(meta[0], "Comparison");
      assert.equal(meta[1], "Alpha");
      assert.match(meta[2] ?? "", /^Started Today, \d{1,2}:\d{2}/u);
      assert.equal(meta[3], "Each agent works in its own worktree");
      assertNoDomNode(fixture.container.querySelector(".detail-summary"), "the full prompt is no longer a paragraph under the bar");

      await click(bar.querySelector('button[aria-label="More Actions"]'));
      assert.ok(menuItem("Copy Link"), "Copy Link is in ⋯");
      await click(menuItem("Show Full Task"));
      const dialog = domWindow.document.querySelector('[role="dialog"]');
      assert.ok(dialog, "Show Full Task opens a dialog");
      assert.equal(dialog.querySelector(".run-task-full")?.textContent, LONG_PROMPT);
      await click([...dialog.querySelectorAll("button")].find((button) => button.textContent === "Done"));
      assertNoDomNode(domWindow.document.querySelector('[role="dialog"]'));
    } finally {
      await unmount(fixture);
    }
  });

  test("each head shows the agent, its status, a visible Open Session and ⋯, and no button spans the head", async () => {
    await setViewport(1440, 900);
    const fixture = await mount({});
    try {
      assertNoDomNode(fixture.container.querySelector(".compare-grid"), "no .compare-grid renders");
      assertNoDomNode(fixture.container.querySelector('[style*="grid-template-columns"]'), "no inline grid template");
      assertNoDomNode(fixture.container.querySelector("button.compare-head"));
      const heads = [...fixture.container.querySelectorAll(".compare > .compare-member > .compare-member-head")];
      assert.equal(heads.length, 3, "one flush column per member");
      for (const head of heads) {
        assert.notEqual(head.tagName, "BUTTON");
        assertNoDomNode(head.closest("button"), "the head is not inside a button");
        const buttons = [...head.querySelectorAll("button")];
        assert.ok(buttons.every((button) => !button.contains(head.querySelector(".compare-member-agent"))), "no button holds the agent's name");
        assert.ok(head.querySelector('button.icon-btn.sm[aria-label="Open Session"]'), "a visible Open Session icon button");
        assert.ok(head.querySelector('button[aria-label$=" Actions"]'), "the member's ⋯");
        assert.ok(head.querySelector(".session-status-indicators .status"), "its status");
      }
      assert.deepEqual(heads.map((head) => head.querySelector(".compare-member-agent")?.textContent), ["Claude Code", "Codex App Server", "Gemini CLI"]);

      await click(column(fixture.container, "Gemini CLI")?.querySelector('button[aria-label="Gemini CLI Actions"]'));
      assert.ok(menuItem("Open Session"), "Open Session is also in the member's ⋯");
    } finally {
      await unmount(fixture);
    }
  });

  test("a member that ran three commands and edited one file shows \"3 commands, 1 edit\"; a running one shows Working…", async () => {
    await setViewport(1440, 900);
    const timeline = claudeTimeline();
    const fixture = await mount({
      getSessionEventPage: (async (id: string) => page(id === claude.id ? timeline : [])) as ApiClient["getSessionEventPage"],
    });
    try {
      assert.equal(column(fixture.container, "Claude Code")?.querySelector(".compare-member-meta")?.textContent, "3 commands, 1 edit");
      assert.equal(column(fixture.container, "Codex App Server")?.querySelector(".compare-member-meta")?.textContent, "Working…");
      assert.equal(column(fixture.container, "Gemini CLI")?.querySelector(".compare-member-meta")?.textContent, "No commands, edits or files read");
    } finally {
      await unmount(fixture);
    }
  });

  test("a loading column shows skeleton turns, and a failed history shows the danger notice with Retry", async () => {
    await setViewport(1440, 900);
    const requests: string[] = [];
    let failGemini = true;
    const fixture = await mount({
      getSessionEventPage: (async (id: string) => {
        requests.push(id);
        if (id === gemini.id && failGemini) throw new Error("history unavailable");
        if (id === claude.id) return pending();
        return page([]);
      }) as ApiClient["getSessionEventPage"],
    });
    try {
      const loading = column(fixture.container, "Claude Code")!;
      assert.ok(loading.querySelector(".compare-member-body .transcript-skeleton"), "skeleton turns while loading");
      assertNoDomNode(loading.querySelector(".muted"), "not a muted sentence");

      const failed = column(fixture.container, "Gemini CLI")!;
      const notice = failed.querySelector('.compare-member-notice .transcript-history-notice[data-state="error"]');
      assert.ok(notice, "the danger notice heads the column");
      assert.match(notice.textContent ?? "", /Couldn't Load the Full Conversation/u);
      assertNoDomNode(failed.querySelector(".muted"), "not a muted sentence");

      const before = requests.filter((id) => id === gemini.id).length;
      failGemini = false;
      await click([...notice.querySelectorAll("button")].find((button) => button.textContent === "Retry"));
      assert.ok(requests.filter((id) => id === gemini.id).length > before, "Retry loads the history again");
      assertNoDomNode(column(fixture.container, "Gemini CLI")?.querySelector(".transcript-history-notice"), "the notice clears once it loads");
    } finally {
      await unmount(fixture);
    }
  });
});

describe("Copy Link's clipboard fallback (#2975)", () => {
  const toasts = () => [...domWindow.document.querySelectorAll(".toast")].map((toast) => toast.textContent ?? "");
  const moreActions = (container: Element) => container.querySelector('.detail-bar button[aria-label="More Actions"]');

  /** A Clipboard API whose writes stay pending until refused, and an execCommand that records fallbacks. */
  function stubClipboard(mode: "pending" | "refuse") {
    const refusals: Array<(error: Error) => void> = [];
    const fallbacks: string[] = [];
    const original = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
    Object.defineProperty(domWindow.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => mode === "refuse"
          ? Promise.reject(new Error("no clipboard on plain HTTP"))
          : new Promise<void>((_resolve, reject) => { refusals.push(reject); }),
      },
    });
    const doc = domWindow.document as unknown as { execCommand?: (command: string) => boolean };
    const originalExec = doc.execCommand;
    doc.execCommand = (command: string) => {
      fallbacks.push(command);
      // In a browser the selected field holds focus, and removing it leaves focus on <body>.
      (domWindow.document.activeElement as unknown as { blur?: () => void } | null)?.blur?.();
      return true;
    };
    return {
      fallbacks,
      refuse: async () => {
        await act(async () => { refusals.at(-1)!(new Error("denied")); });
        await settle();
      },
      restore: () => {
        if (originalExec) doc.execCommand = originalExec; else delete doc.execCommand;
        if (original) Object.defineProperty(domWindow.navigator, "clipboard", original);
        else delete (domWindow.navigator as unknown as { clipboard?: unknown }).clipboard;
      },
    };
  }

  async function startCopy(container: Element) {
    await click(moreActions(container));
    await click(menuItem("Copy Link"));
  }

  test("a late refusal after focus moved on runs no fallback and leaves focus where it is", async () => {
    await setViewport(1440, 900);
    const clipboard = stubClipboard("pending");
    const fixture = await mount({});
    const field = domWindow.document.createElement("input");
    domWindow.document.body.append(field);
    try {
      await startCopy(fixture.container);
      await act(async () => { field.focus(); });
      await clipboard.refuse();
      assert.deepEqual(clipboard.fallbacks, [], "no fallback copy");
      assert.ok(domWindow.document.activeElement === field, "focus stays in the field the person moved to");
      assert.deepEqual(toasts(), [], "nothing is reported");
    } finally {
      field.remove();
      await unmount(fixture);
      clipboard.restore();
    }
  });

  test("a late refusal after the run unmounted runs no fallback", async () => {
    await setViewport(1440, 900);
    const clipboard = stubClipboard("pending");
    const fixture = await mount({});
    try {
      await startCopy(fixture.container);
      await unmount(fixture);
      await clipboard.refuse();
      assert.deepEqual(clipboard.fallbacks, [], "no fallback copy");
    } finally {
      clipboard.restore();
    }
  });

  test("an immediate refusal while the run is current falls back, reports the copy and returns focus to ⋯", async () => {
    await setViewport(1440, 900);
    const clipboard = stubClipboard("refuse");
    const fixture = await mount({});
    try {
      await startCopy(fixture.container);
      assert.deepEqual(clipboard.fallbacks, ["copy"], "the fallback copies");
      assert.ok((domWindow.document.activeElement as unknown) === moreActions(fixture.container), "focus returns to More Actions");
      assert.deepEqual(toasts(), ["Link copied."]);
    } finally {
      await unmount(fixture);
      clipboard.restore();
    }
  });
});

describe("a comparison run on a phone (#2975)", () => {
  test("one column shows at a time under member tabs, a tab updates ?member=, and the URL's member opens selected", async () => {
    await setViewport(390, 844);
    const fixture = await mount({}, { name: "run", id: run.id, member: codex.id });
    try {
      const tabs = [...fixture.container.querySelectorAll('[role="tablist"] [role="tab"]')];
      assert.equal(tabs.length, 3, "one tab per member");
      assert.deepEqual(tabs.map((tab) => tab.textContent), ["Claude Code, Awaiting Prompt", "Codex App Server, Running", "Gemini CLI, Awaiting Prompt"], "each tab names its agent and status");
      assert.ok(tabs.every((tab) => tab.querySelector(".compare-tab-dot")), "each tab has its status dot");
      assert.equal(tabs[1]!.getAttribute("aria-selected"), "true", "the URL's member is selected");
      const panels = fixture.container.querySelectorAll(".compare-member");
      assert.equal(panels.length, 1, "one column at a time");
      assert.equal(panels[0]!.getAttribute("role"), "tabpanel");
      assert.equal(panels[0]!.querySelector(".compare-member-agent")?.textContent, "Codex App Server");
      assertNoDomNode(fixture.container.querySelector(".compare"), "no desktop row on a phone");

      await click(tabs[2]);
      assert.deepEqual(fixture.replaced.at(-1), { name: "run", id: run.id, member: gemini.id }, "the choice replaces the entry with ?member=");
      assert.equal(fixture.container.querySelector(".compare-member .compare-member-agent")?.textContent, "Gemini CLI");
      assert.equal(fixture.container.querySelectorAll('[role="tab"]')[2]!.getAttribute("aria-selected"), "true");

      // The member bar carries the same ⋯ as the desktop head.
      const memberBar = fixture.container.querySelector(".compare-member .compare-member-head")!;
      assert.ok(memberBar.querySelector('button[aria-label="Open Session"]'));
      await click(memberBar.querySelector('button[aria-label="Gemini CLI Actions"]'));
      assert.ok(menuItem("Open Session"), "every member action is reachable from the member bar");
    } finally {
      await unmount(fixture);
      await setViewport(1440, 900);
    }
  });

  test("arrow keys move between member tabs", async () => {
    await setViewport(390, 844);
    const fixture = await mount({});
    try {
      const first = fixture.container.querySelector<HTMLElement>('[role="tab"]')!;
      assert.equal(first.getAttribute("aria-selected"), "true", "the first member opens without ?member=");
      await act(async () => { fireDomEvent.keyDown(first as never, { key: "ArrowLeft" }); });
      await settle();
      assert.deepEqual(fixture.replaced.at(-1), { name: "run", id: run.id, member: gemini.id }, "Left from the first wraps to the last");
      assert.equal(domWindow.document.activeElement?.id, "run-member-tab-2");
    } finally {
      await unmount(fixture);
      await setViewport(1440, 900);
    }
  });
});
