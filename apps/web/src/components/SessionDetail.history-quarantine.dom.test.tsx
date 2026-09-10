/**
 * A quarantined provider conversation must not present a composer that invites retries which
 * cannot succeed. These tests pin the user-facing half of the loop: the composer is closed with an
 * explanation, and the only offered action recovers the session from its recorded safe checkpoint.
 */

import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { loadComposerDraft } from "../composer-drafts.js";
import { FeedbackContext, type ConfirmationOptions } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 72, width: 800, height: 72, toJSON: () => ({}) };
  },
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex", name: "Codex", command: "codex", args: [], env: {},
    driver: "codex-app-server", available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 126,
} as RunnerView;

function session(id: string, quarantine: SessionView["historyQuarantine"]): SessionView {
  return {
    id, runnerId: runner.runnerId, workspaceId: null, workspaceName: null, projectId: null,
    agentId: "codex", agentName: "Codex", title: "Quarantine Fixture", status: "idle",
    column: "review", runId: null, useWorktree: true, worktreePath: "/repos/demo/wt",
    archived: false, createdAt: 1, updatedAt: 1, lastEventAt: null, messageCount: 0,
    eventEpoch: 0, preview: null, pendingApproval: null, driver: "codex-app-server",
    model: "gpt-5.6-sol", effort: "high", permissionMode: null, tokensIn: 0, tokensOut: 0,
    costUsd: 0, adopted: false, ...(quarantine ? { historyQuarantine: quarantine } : {}),
  };
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

async function flushAsyncWork(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

let fixtureSequence = 0;

async function mount(
  quarantine: SessionView["historyQuarantine"],
  recover: ApiClient["recoverQuarantinedConversation"] =
    (async () => { throw new Error("recovery was not expected"); }) as never,
) {
  fixtureSequence += 1;
  const current = session(`quarantined-${fixtureSequence}`, quarantine);
  const socket = new FakeSocket();
  const navigated: string[] = [];
  const connection: UiConnectionRuntime = {
    instanceId: `quarantine-${fixtureSequence}`,
    runtimeKey: `quarantine-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: current.id }),
    push: (view) => { if (view.name === "session") navigated.push(view.id); },
    listen: () => () => {},
  };
  const confirmations: string[] = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    recoverQuarantinedConversation: recover,
  } as unknown as ApiClient;
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={{
        confirm: async (options: ConfirmationOptions) => { confirmations.push(options.title); return true; },
        showToast: () => 0,
        dismissToast: () => {},
      } as never}>
        <StoreProvider connection={connection} navigation={navigation}>
          <SessionDetail
            sessionId={current.id}
            mode="expanded"
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            pinnedOpen={false}
            composerDraftLoader={async () => null}
          />
        </StoreProvider>
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes: [], projects: [], sessions: [current], runs: [], pods: [],
    });
  });
  await flushAsyncWork();
  return {
    container, navigated, confirmations,
    banner: () => container.querySelector(".quarantine-banner") as HTMLElement | null,
    composer: () => container.querySelector(".composer-input") as HTMLTextAreaElement | null,
    unmount: async () => {
      await flushAsyncWork(1);
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a quarantined session closes the composer and explains why retrying cannot work", async () => {
  const fixture = await mount({
    reason: "oversized_tool_call", detectedAt: 5, recoveryTurn: 2, recovery: "fork", retainedPrompt: true,
  });
  try {
    const composer = fixture.composer();
    assert.ok(composer, "the composer stays mounted");
    assert.equal(composer.disabled, true, "the composer cannot accept another prompt");
    assert.match(composer.placeholder, /quarantined/i);

    const banner = fixture.banner();
    assert.ok(banner, "the quarantine is explained where the user would otherwise type");
    assert.match(banner.textContent ?? "", /cannot repair/i);
    assert.match(banner.textContent ?? "", /\/compact/);
    assert.match(banner.textContent ?? "", /turn 2/);
    assert.match(banner.textContent ?? "", /kept unsent/i);
    const action = banner.querySelector("button") as HTMLButtonElement | null;
    assert.ok(action, "recovery is offered as an explicit action");
    assert.equal(action.textContent, "Recover Session");
  } finally {
    await fixture.unmount();
  }
});

test("recovery asks the runner for the recorded safe checkpoint and opens the new session", async () => {
  const calls: Array<{ id: string; turn: number; handoff: unknown }> = [];
  const fixture = await mount(
    { reason: "oversized_tool_call", detectedAt: 5, recoveryTurn: 2, recovery: "fork" },
    (async (id: string, turn: number, handoff?: unknown) => {
      calls.push({ id, turn, handoff });
      return { ...session("s_recovered", undefined), retainedPrompt: { text: "kept for me", images: [] } };
    }) as never,
  );
  try {
    const action = fixture.banner()!.querySelector("button") as HTMLButtonElement;
    await act(async () => { action.click(); });
    await flushAsyncWork(5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.turn, 2, "recovery starts from the recorded safe checkpoint");
    assert.equal(calls[0]!.handoff, undefined, "a fork recovery never asks for a handoff destination");
    assert.deepEqual(fixture.navigated, ["s_recovered"], "the usable conversation is opened");
    assert.equal(fixture.confirmations.length, 1, "recovery is confirmed before it runs");
  } finally {
    await fixture.unmount();
  }
});

test("a fallback recovery hands the same provider a fresh conversation", async () => {
  const calls: Array<{ turn: number; handoff: unknown }> = [];
  const fixture = await mount(
    { reason: "oversized_tool_call", detectedAt: 5, recoveryTurn: 2, recovery: "handoff" },
    (async (_id: string, turn: number, handoff?: unknown) => {
      calls.push({ turn, handoff });
      return { ...session("s_fresh", undefined), handoffDraft: { text: "context", images: [], disclosure: "bounded" } };
    }) as never,
  );
  try {
    const action = fixture.banner()!.querySelector("button") as HTMLButtonElement;
    await act(async () => { action.click(); });
    await flushAsyncWork(5);
    assert.deepEqual(calls, [{
      turn: 2,
      handoff: { agentId: "codex", config: { model: "gpt-5.6-sol", effort: "high" } },
    }]);
    assert.deepEqual(fixture.navigated, ["s_fresh"]);
  } finally {
    await fixture.unmount();
  }
});

test("a fallback recovery keeps both the seeded context and the unsent prompt", async () => {
  const fixture = await mount(
    { reason: "oversized_tool_call", detectedAt: 5, recoveryTurn: 2, recovery: "handoff", retainedPrompt: true },
    (async () => ({
      ...session("s_both", undefined),
      handoffDraft: { text: "Checkpoint handoff. Historical context follows.", images: [], disclosure: "bounded" },
      retainedPrompt: { text: "Now scan every changed file.", images: [] },
    })) as never,
  );
  try {
    const action = fixture.banner()!.querySelector("button") as HTMLButtonElement;
    await act(async () => { action.click(); });
    await flushAsyncWork(5);
    const staged = (await loadComposerDraft("s_both"))!;
    assert.ok(staged, "the recovered session receives a composer draft");
    // Dropping either would break a promise the confirmation just made: the fresh thread is seeded
    // with the checkpoint dialogue, and the user's own unsent request is still there to send.
    assert.match(staged.text, /Historical context follows/);
    assert.match(staged.text, /Now scan every changed file\./);
    assert.ok(
      staged.text.indexOf("Historical context") < staged.text.indexOf("Now scan"),
      "context leads so the retained prompt reads as the instruction",
    );
  } finally {
    await fixture.unmount();
  }
});

test("a quarantine with no safe checkpoint offers no recovery it cannot perform", async () => {
  const fixture = await mount({ reason: "oversized_tool_call", detectedAt: 5 });
  try {
    const banner = fixture.banner();
    assert.ok(banner);
    assert.equal(banner.querySelector("button"), null, "no action is offered without a checkpoint");
    assert.match(banner.textContent ?? "", /no earlier checkpoint/i);
    assert.equal(fixture.composer()?.disabled, true);
  } finally {
    await fixture.unmount();
  }
});

test("a healthy session keeps its composer and shows no quarantine banner", async () => {
  const fixture = await mount(undefined);
  try {
    assert.equal(fixture.banner(), null);
    assert.equal(fixture.composer()?.disabled, false);
  } finally {
    await fixture.unmount();
  }
});
