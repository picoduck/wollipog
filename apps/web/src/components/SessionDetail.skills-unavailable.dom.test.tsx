import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, ProjectView, RunnerView, SessionView, SessionWorktreeView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { staticPinnedSummary } from "./pinned-summary-state.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 72, width: 800, height: 72, toJSON: () => ({}) }),
});
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-skills", hostname: "runner-host", displayName: "Build Box", os: "linux", version: "1", status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 146,
} as RunnerView;

const project = {
  id: "payments", name: "Payments Service", hidden: false, locations: [], activeSessionCount: 0,
  unarchivedSessionCount: 1, totalSessionCount: 1, createdAt: 1, updatedAt: 1,
} as ProjectView;

interface Scenario {
  adapter: "host" | "container";
  /** The session is its Project's first, and its worktree has no setup file. */
  setupEligible?: boolean;
  /** A second worktree whose setup failed: a danger condition. */
  failedSetup?: boolean;
}

function targetSession({ adapter, setupEligible = false, failedSetup = false }: Scenario): SessionView {
  const worktrees: SessionWorktreeView[] = [];
  if (setupEligible) {
    worktrees.push({ id: "wt-1", path: "/worktrees/one", branch: "agent/one", source: "created", setupConfig: { status: "absent" } });
  }
  if (failedSetup) {
    worktrees.push({
      id: "wt-2", path: "/worktrees/two", branch: "agent/two", source: "created",
      setup: { status: "failed", configHash: "h", attemptId: "a", environmentKeys: [], copies: [], steps: [], error: "npm ci failed" },
    });
  }
  return {
    // Its own id when eligible: the slot keeps info dismissals for the life of the page, per session.
    id: `skills-${adapter}${setupEligible ? "-setup" : ""}`, runnerId: runner.runnerId, workspaceId: null, workspaceName: null,
    projectId: setupEligible ? project.id : null,
    agentId: "codex", agentName: "Codex", title: "Target Session", status: "idle", column: "review",
    runId: null, useWorktree: setupEligible, worktreePath: setupEligible ? "/worktrees/one" : null,
    ...(worktrees.length > 0 ? { worktrees } : {}),
    archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "codex", model: "gpt-5.6-sol", effort: "high", permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    executionTarget: {
      id: adapter, runnerId: runner.runnerId, kind: adapter === "host" ? "local" : "container",
      workspaceStrategy: "worktree", adapter,
      boundaries: { filesystem: adapter === "host" ? "worktree" : "container", network: "deny", secrets: "none", billing: "none" },
    },
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

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function withSession(
  scenario: Scenario,
  options: { mode?: "expanded" | "preview"; pinnedOpen?: boolean },
  run: (view: { container: HTMLDivElement; calls: string[]; pushed: unknown[] }) => Promise<void>,
) {
  const current = targetSession(scenario);
  const socket = new FakeSocket();
  const calls: string[] = [];
  const pushed: unknown[] = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    git: () => new Promise<never>(() => {}),
    gitSummary: () => new Promise<never>(() => {}),
    runnerSkills: async () => ({
      desired: [
        { name: "review", versionDigest: "a", targets: [{ agentId: "codex", invocation: "agent" }] },
        { name: "deploy", versionDigest: "b", targets: [{ agentId: "codex", invocation: "agent" }] },
      ],
      reported: null,
    }),
    dismissWorktreeSetupNotice: async (projectId: string) => {
      calls.push(`dismiss:${projectId}`);
      socket.push({ type: "worktree_setup_notice_dismissed", projectId } as ControlPlaneToUi);
      return { dismissed: true };
    },
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: "skills-test", runtimeKey: "skills-test:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: current.id }), push: (view) => void pushed.push(view), listen: () => () => {},
  };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{ confirm: async () => true, showToast: () => 0, dismissToast: () => {} } as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <SessionDetail sessionId={current.id} mode={options.mode ?? "expanded"} rightPanel={rightPanel}
              onOpenTerminal={() => {}} pinnedSummary={staticPinnedSummary(options.pinnedOpen ?? false)} composerDraftLoader={async () => null} />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true,
        worktreeSetupConfig: true,
      },
      runners: [runner], boxes: [], projects: [project], sessions: [current], runs: [], pods: [],
      worktreeSetupNoticeDismissals: [],
    } as ControlPlaneToUi));
    await settle();
    await run({ container, calls, pushed });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const slot = (container: HTMLDivElement) => container.querySelector<HTMLElement>(".session-notice-slot");
const buttonIn = (scope: Element, label: string) => {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label);
  assert.ok(match, `missing ${label}`);
  return match;
};

const SENTENCE = "Skills from Build Box aren’t available in container sessions, so deploy and review can’t be used here.";

test("a container session's slot shows the skills notice, naming both skills and the machine", async () => {
  domWindow.localStorage.clear();
  await withSession({ adapter: "container" }, {}, async ({ container, pushed }) => {
    const notice = slot(container)?.querySelector('[aria-label="Skills Unavailable"]');
    assert.ok(notice, "the notice is in the slot above the composer");
    assert.equal(notice.querySelector(".notice-body")?.textContent, SENTENCE);
    assert.match(notice.className, /\bt-info\b/u);
    await act(async () => buttonIn(notice, "Open Agent Skills").click());
    assert.deepEqual(pushed.at(-1), { name: "skills" });
    assert.equal(container.querySelectorAll('[aria-label="Skills Unavailable"], [aria-label="Skills Unavailable on This Target"]').length, 1,
      "nothing under the session header");
  });
});

test("a host session shows no skills notice", async () => {
  await withSession({ adapter: "host" }, {}, async ({ container }) => {
    assertNoDomNode(container.querySelector('[aria-label="Skills Unavailable"]'));
  });
});

test("the preview pane's header no longer carries the skills notice", async () => {
  await withSession({ adapter: "container" }, { mode: "preview" }, async ({ container }) => {
    assertNoDomNode(container.querySelector('[aria-label="Skills Unavailable"], [aria-label="Skills Unavailable on This Target"]'));
  });
});

test("a dismissed skills notice stays dismissed for the session on reload, and the Pinned Summary keeps the fact", async () => {
  domWindow.localStorage.clear();
  await withSession({ adapter: "container" }, { pinnedOpen: true }, async ({ container }) => {
    const notice = slot(container)!.querySelector('[aria-label="Skills Unavailable"]')!;
    await act(async () => buttonIn(notice, "Dismiss Notice").click());
    assertNoDomNode(container.querySelector('[aria-label="Skills Unavailable"]'));
  });
  await withSession({ adapter: "container" }, { pinnedOpen: true }, async ({ container }) => {
    assertNoDomNode(container.querySelector('[aria-label="Skills Unavailable"]'), "it does not return on reload");
    const summary = container.querySelector('[aria-label="Pinned Summary"]');
    assert.ok(summary, "the Pinned Summary is open");
    const row = [...summary.querySelectorAll(".ps-row")].find((candidate) => candidate.textContent?.startsWith("Skills"));
    assert.ok(row, "the Environment section has a Skills row");
    assert.equal(row.querySelector(".ps-detail")?.textContent, "Not Available");
    assert.equal(row.querySelector(".ps-note")?.textContent, "Skills from Build Box aren’t available in container sessions.");
  });
  domWindow.localStorage.clear();
});

test("the setup suggestion is an info condition in the slot, below every more severe one, and dismissible (#1977)", async () => {
  domWindow.localStorage.clear();
  await withSession({ adapter: "host", setupEligible: true }, {}, async ({ container, calls }) => {
    const notice = slot(container)?.querySelector('[aria-label="Set Up Payments Service"]');
    assert.ok(notice, "the suggestion is in the slot");
    assert.match(notice.className, /\bcompact\b/u);
    assert.ok(buttonIn(notice, "Generate Setup File"));
    await act(async () => buttonIn(notice, "Dismiss Setup Notice").click());
    await settle();
    assert.deepEqual(calls, ["dismiss:payments"], "dismissed for the Project on the server");
    assertNoDomNode(container.querySelector('[aria-label="Set Up Payments Service"]'));
  });

  await withSession({ adapter: "container", setupEligible: true, failedSetup: true }, {}, async ({ container }) => {
    const shown = slot(container)!;
    assert.equal(shown.dataset.noticeKey, "worktree-setup-failed:/worktrees/two", "the danger condition shows first");
    assert.ok(buttonIn(shown, "+2 More"));
    assertNoDomNode(container.querySelector('[aria-label="Set Up Payments Service"]'), "the suggestion waits behind it");
    await act(async () => buttonIn(shown, "+2 More").click());
    const items = [...domWindow.document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    assert.deepEqual(items, ["Skills Unavailable", "Set Up Payments Service"], "skills (rank 8) before the setup suggestion (rank 9)");
  });
  domWindow.localStorage.clear();
});
