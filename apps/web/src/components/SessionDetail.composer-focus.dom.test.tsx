import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionView, SideChatView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import {
  deleteComposerDraftIfMatches,
  loadComposerDraft,
  type ComposerDraft,
} from "../composer-drafts.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "./SessionDetail.js";

const domWindow = new Window({ url: "http://localhost/" });
const VIEWPORT_HEIGHT = 1_200;
const ROW_HEIGHT = 72;
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: ROW_HEIGHT,
      width: 800,
      height: ROW_HEIGHT,
      toJSON: () => ({}),
    };
  },
});
for (const [name, value] of [["clientHeight", VIEWPORT_HEIGHT], ["offsetHeight", ROW_HEIGHT]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
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
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

type FrameRequest = { id: number; callback: FrameRequestCallback };
let nextFrameId = 1;
let frames: FrameRequest[] = [];
domWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  const id = nextFrameId++;
  frames.push({ id, callback });
  return id;
}) as unknown as typeof domWindow.requestAnimationFrame;
domWindow.cancelAnimationFrame = ((id: number) => {
  frames = frames.filter((frame) => frame.id !== id);
}) as unknown as typeof domWindow.cancelAnimationFrame;

function flushFrames() {
  const queued = frames;
  frames = [];
  for (const frame of queued) frame.callback(0);
}

const runner = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 67,
} as RunnerView;

function session(id: string): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: null,
    workspaceName: null,
    projectId: null,
    agentId: "codex",
    agentName: "Codex",
    title: "Composer Focus Fixture",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: 0,
    eventEpoch: 0,
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

interface Fixture {
  composer: HTMLTextAreaElement;
  container: HTMLDivElement;
  root: Root;
  rerenderWithDraftLoader: (loader: ComposerDraftLoader) => Promise<void>;
  rerenderSessionWithDraftLoader: (sessionId: string, loader: ComposerDraftLoader) => Promise<void>;
  remountWithDraftLoader: (loader: ComposerDraftLoader) => Promise<HTMLTextAreaElement>;
  alternateSessionId: string;
}

type ComposerDraftLoader = (sessionId: string, instanceScope: string) => Promise<ComposerDraft | null>;

interface FixtureOptions {
  client?: Partial<ApiClient>;
  mainEventPayloads?: SessionEvent["payload"][];
  rightPanelMode?: "launcher" | "sidechat";
  composerDraftCleanup?: typeof deleteComposerDraftIfMatches;
  sessionCapabilities?: SessionView["agentCapabilities"];
}

function EventSeeder({ sessionId, payloads }: { sessionId: string; payloads: SessionEvent["payload"][] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload, index) => {
      dispatch({
        type: "msg",
        msg: {
          type: "session_event",
          event: {
            id: index + 1,
            sessionId,
            seq: index + 1,
            ts: index + 1,
            payload,
          },
        },
      });
    });
  }, [dispatch, payloads, ready, sessionId]);
  return null;
}

let fixtureSequence = 0;

async function mountFixture(draft: Deferred<ComposerDraft | null>, options: FixtureOptions = {}): Promise<Fixture> {
  fixtureSequence += 1;
  frames = [];
  const currentSession = session(`composer-focus-${fixtureSequence}`);
  const alternateSession = session(`composer-focus-${fixtureSequence}-alternate`);
  if (options.sessionCapabilities) currentSession.agentCapabilities = options.sessionCapabilities;
  const fixtureRunner = options.sessionCapabilities && "models" in options.sessionCapabilities
    ? {
        ...runner,
        agents: runner.agents.map((agent) => ({ ...agent, capabilities: options.sessionCapabilities })),
      } as RunnerView
    : runner;
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: `composer-focus-${fixtureSequence}`,
    runtimeKey: `composer-focus-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: currentSession.id }),
    push() {},
    listen: () => () => {},
  };
  const client = {
    ...api,
    // The authoritative snapshot below wins before the routed-session fallback needs to settle.
    session: () => new Promise<never>(() => {}),
    ...options.client,
  } as unknown as ApiClient;
  const rightPanel = {
    open: options.rightPanelMode != null,
    mode: options.rightPanelMode ?? "launcher",
    width: 360,
    dragging: false,
    subagentTarget: null,
    toggle() {},
    openMode() {},
    show() {},
    setMode() {},
    setWidth() {},
    setDragging() {},
    close() {},
    selectSubagent() {},
    showSubagent() {},
    consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let detailMount = 0;
  const renderWithDraftLoader = (loader: ComposerDraftLoader, sessionId = currentSession.id) => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          {options.mainEventPayloads && (
            <EventSeeder sessionId={currentSession.id} payloads={options.mainEventPayloads} />
          )}
          <SessionDetail
            key={detailMount}
            sessionId={sessionId}
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            pinnedOpen={false}
            focusComposer
            composerDraftLoader={loader}
            composerDraftCleanup={options.composerDraftCleanup}
          />
        </StoreProvider>
      </ApiProvider>,
    );
  };
  const rerenderWithDraftLoader = async (loader: ComposerDraftLoader) => {
    await act(async () => renderWithDraftLoader(loader));
  };
  const rerenderSessionWithDraftLoader = async (sessionId: string, loader: ComposerDraftLoader) => {
    await act(async () => renderWithDraftLoader(loader, sessionId));
  };
  const remountWithDraftLoader = async (loader: ComposerDraftLoader) => {
    detailMount += 1;
    await act(async () => {
      renderWithDraftLoader(loader);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const remounted = container.querySelector(".composer-input") as HTMLTextAreaElement | null;
    assert.ok(remounted, "the remounted SessionDetail composer is available");
    return remounted;
  };
  await act(async () => {
    renderWithDraftLoader(() => draft.promise);
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false,
        boundedDelivery: false,
        paginatedSessionHistory: false,
        projects: true,
      },
      runners: [fixtureRunner],
      boxes: [],
      projects: [],
      sessions: [currentSession, alternateSession],
      runs: [],
      pods: [],
    });
  });
  const composer = container.querySelector(".composer-input") as HTMLTextAreaElement | null;
  assert.ok(composer, "the real SessionDetail composer is mounted");
  return {
    composer,
    container,
    root,
    rerenderWithDraftLoader,
    rerenderSessionWithDraftLoader,
    remountWithDraftLoader,
    alternateSessionId: alternateSession.id,
  };
}

async function unmountFixture(fixture: Fixture) {
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
  frames = [];
}

function recordSelections(composer: HTMLTextAreaElement) {
  const calls: Array<{ value: string; start: number | null; end: number | null }> = [];
  const original = composer.setSelectionRange.bind(composer);
  composer.setSelectionRange = (start, end, direction) => {
    calls.push({ value: composer.value, start, end });
    original(start, end, direction);
  };
  return calls;
}

async function focusRequestedComposer(fixture: Fixture) {
  await act(async () => { flushFrames(); });
  assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
}

async function resolveDraft(draft: Deferred<ComposerDraft | null>, text: string) {
  await act(async () => {
    draft.resolve({ text, images: [], updatedAt: 1 });
    await draft.promise;
  });
}

async function resolveComposerDraft(draft: Deferred<ComposerDraft | null>, value: ComposerDraft) {
  await act(async () => {
    draft.resolve(value);
    await draft.promise;
  });
}

async function flushAsyncWork(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

function sendButton(fixture: Fixture): HTMLButtonElement {
  const button = fixture.container.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null;
  assert.ok(button, "the composer Send button is mounted");
  return button;
}

const submittedImage = { mimeType: "image/png", data: "aW1hZ2U=" } as const;

test("an accepted text-and-image submission stays cleared after SessionDetail remount", async () => {
  const draft = deferred<ComposerDraft | null>();
  const calls: Array<{ text: string; images: unknown[] }> = [];
  const fixture = await mountFixture(draft, {
    client: {
      prompt: async (_sessionId, text, images) => {
        calls.push({ text, images: images ?? [] });
        return undefined as never;
      },
    },
  });
  try {
    await resolveComposerDraft(draft, { text: "inspect this", images: [submittedImage], updatedAt: 1 });
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);

    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();

    assert.deepEqual(calls, [{ text: "inspect this", images: [submittedImage] }]);
    assert.equal(fixture.composer.value, "");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
  } finally {
    await unmountFixture(fixture);
  }
});

test("conditional cleanup returning false cannot restore an accepted submission", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    client: { prompt: async () => undefined as never },
    composerDraftCleanup: async () => false,
  });
  try {
    await resolveComposerDraft(draft, { text: "accepted once", images: [submittedImage], updatedAt: 1 });
    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();

    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
  } finally {
    await unmountFixture(fixture);
  }
});

test("cleanup throwing after provider acceptance cannot recover the accepted draft", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    client: { prompt: async () => undefined as never },
    composerDraftCleanup: async () => { throw new Error("draft storage cleanup failed"); },
  });
  try {
    await resolveComposerDraft(draft, { text: "already accepted", images: [submittedImage], updatedAt: 1 });
    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();

    assert.equal(fixture.container.querySelector('[role="alert"]'), null, "cleanup is not reported as a send rejection");
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a genuine prompt rejection restores the exact text and attachment after remount", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    client: { prompt: async () => { throw new Error("transport rejected"); } },
  });
  try {
    await resolveComposerDraft(draft, { text: "please retry", images: [submittedImage], updatedAt: 1 });
    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();

    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "please retry");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("an accepted submission marker preserves a newer edit made while the prompt is in flight", async () => {
  const draft = deferred<ComposerDraft | null>();
  const prompt = deferred<never>();
  const fixture = await mountFixture(draft, {
    client: { prompt: () => prompt.promise },
    composerDraftCleanup: async () => false,
  });
  try {
    await resolveComposerDraft(draft, { text: "submitted text", images: [submittedImage], updatedAt: 1 });
    await act(async () => { sendButton(fixture).click(); });
    await act(async () => {
      fixture.composer.value = "newer local edit";
      Simulate.change(fixture.composer);
    });
    await flushAsyncWork(450);
    await act(async () => { prompt.resolve(undefined as never); });
    await flushAsyncWork();

    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "newer local edit");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("an accepted provider command keeps its preserved attachment when cleanup is inconclusive", async () => {
  const draft = deferred<ComposerDraft | null>();
  const invocations: unknown[] = [];
  const fixture = await mountFixture(draft, {
    client: {
      invokeSessionCommand: async (_sessionId, request) => {
        invocations.push(request);
        return undefined as never;
      },
    },
    composerDraftCleanup: async () => false,
    sessionCapabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [{
        name: "Review",
        source: "project",
        invocation: {
          id: "review-command",
          catalogRevision: "catalog-1",
          executionMode: "structured",
        },
      }],
      supportsImages: true,
      supportsApprovals: false,
    },
  });
  try {
    await resolveComposerDraft(draft, { text: "/review focus", images: [submittedImage], updatedAt: 1 });
    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();

    assert.equal(invocations.length, 1);
    assert.equal(fixture.composer.value, "");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail restores a deferred hydrated draft caret only after the text commits", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    const selections = recordSelections(fixture.composer);
    await focusRequestedComposer(fixture);
    assert.deepEqual(selections, [{ value: "", start: 0, end: 0 }]);

    await resolveDraft(draft, "saved multiline\ndraft");

    assert.equal(fixture.composer.value, "saved multiline\ndraft");
    assert.deepEqual(selections.at(-1), {
      value: "saved multiline\ndraft",
      start: fixture.composer.value.length,
      end: fixture.composer.value.length,
    });
    assert.equal(fixture.composer.selectionStart, fixture.composer.value.length);
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail suppresses deferred hydration after a dirty edit", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    const selections = recordSelections(fixture.composer);
    await focusRequestedComposer(fixture);
    await act(async () => {
      fixture.composer.value = "newer local typing";
      Simulate.change(fixture.composer);
    });
    const selectionCount = selections.length;

    await resolveDraft(draft, "stale saved draft");

    assert.equal(fixture.composer.value, "newer local typing");
    assert.equal(selections.length, selectionCount);
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail does not restart hydration when a fresh draft-loader identity arrives while typing", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await act(async () => {
      draft.resolve(null);
      await draft.promise;
    });
    await act(async () => {
      fixture.composer.value = "typing must survive parent renders";
      Simulate.change(fixture.composer);
    });

    let replacementLoaderCalls = 0;
    for (let render = 0; render < 6; render += 1) {
      await fixture.rerenderWithDraftLoader(async () => {
        replacementLoaderCalls += 1;
        return { text: `stale draft ${render}`, images: [], updatedAt: render + 2 };
      });
      assert.equal(fixture.composer.value, "typing must survive parent renders");
    }
    await act(async () => { await Promise.resolve(); });

    assert.equal(replacementLoaderCalls, 0, "loader identity churn must not start another hydration loop");
    assert.equal(fixture.composer.value, "typing must survive parent renders");

    let deliberateLoaderCalls = 0;
    await fixture.rerenderSessionWithDraftLoader(fixture.alternateSessionId, async (sessionId) => {
      deliberateLoaderCalls += 1;
      assert.equal(sessionId, fixture.alternateSessionId);
      return { text: "the next session's saved draft", images: [], updatedAt: 20 };
    });
    await act(async () => { await Promise.resolve(); });
    assert.equal(deliberateLoaderCalls, 1, "the next session must capture the latest deliberate loader");
    assert.equal(fixture.composer.value, "the next session's saved draft");
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail hydrates without restoring the caret after blur", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    const selections = recordSelections(fixture.composer);
    await focusRequestedComposer(fixture);
    const selectionCount = selections.length;
    const transcript = fixture.container.querySelector('[aria-label="Session Activity"]') as HTMLElement;
    await act(async () => { transcript.focus(); });

    await resolveDraft(draft, "saved after blur");

    assert.equal(fixture.composer.value, "saved after blur");
    assert.equal(fixture.composer.ownerDocument.activeElement, transcript);
    assert.equal(selections.length, selectionCount);
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail suppresses deferred caret restoration during IME composition", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    const selections = recordSelections(fixture.composer);
    await focusRequestedComposer(fixture);
    const selectionCount = selections.length;
    await act(async () => { Simulate.compositionStart(fixture.composer); });

    await resolveDraft(draft, "saved during composition");

    assert.equal(fixture.composer.value, "saved during composition");
    assert.equal(selections.length, selectionCount);
    await act(async () => { Simulate.compositionEnd(fixture.composer); });
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail invalidates deferred caret restoration after pointer interaction", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    const selections = recordSelections(fixture.composer);
    await focusRequestedComposer(fixture);
    const selectionCount = selections.length;
    await act(async () => { Simulate.pointerDown(fixture.composer); });

    await resolveDraft(draft, "saved after pointer interaction");

    assert.equal(fixture.composer.value, "saved after pointer interaction");
    assert.equal(selections.length, selectionCount);
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail inserts a side-chat response with the shared end-safe focus path", async () => {
  const draft = deferred<ComposerDraft | null>();
  const child = session("side-chat-child");
  const relation: SideChatView = {
    parentSessionId: "unused-by-panel",
    session: child,
    createdAt: 1,
  };
  const response: SessionEvent = {
    id: 1,
    sessionId: child.id,
    seq: 1,
    ts: 2,
    payload: { kind: "agent_message", text: "side-chat answer", final: true },
  };
  const fixture = await mountFixture(draft, {
    rightPanelMode: "sidechat",
    client: {
      sideChat: async () => ({ sideChat: relation }),
      session: async (id: string) => ({ session: id === child.id ? child : session(id) }),
      getSessionEventPage: async () => ({ events: [response], eventEpoch: 0, nextAfter: 1, cacheComplete: true }),
    },
  });
  try {
    const selections = recordSelections(fixture.composer);
    await focusRequestedComposer(fixture);
    await resolveDraft(draft, "existing draft");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const insert = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Insert Latest Response into Primary Draft") as HTMLButtonElement;
    assert.ok(insert, "the real Side Chat panel exposes its explicit draft insertion action");
    await act(async () => {
      insert.focus();
      insert.click();
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, insert);

    await act(async () => { flushFrames(); });

    assert.equal(fixture.composer.value, "existing draft side-chat answer");
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    assert.deepEqual(selections.at(-1), {
      value: "existing draft side-chat answer",
      start: fixture.composer.value.length,
      end: fixture.composer.value.length,
    });
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail prepares Edit & Resend text with accessible focus and an end selection", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    mainEventPayloads: [{ kind: "user_message", text: "original prompt", images: [] }],
  });
  try {
    await focusRequestedComposer(fixture);
    await resolveDraft(draft, "draft to replace");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

    const edit = fixture.container.querySelector(
      'button[aria-label="Edit User Message as a New Turn"]',
    ) as HTMLButtonElement | null;
    assert.ok(edit, "the real timeline exposes Edit & Resend with an accessible name");
    await act(async () => {
      edit.focus();
      edit.click();
    });

    const dialogInput = fixture.container.querySelector(".message-action-input") as HTMLTextAreaElement | null;
    assert.ok(dialogInput, "Edit & Resend opens its real dialog");
    assert.equal(dialogInput.labels?.[0]?.textContent, "Message");
    await act(async () => {
      dialogInput.value = "edited prompt";
      Simulate.change(dialogInput);
    });
    const load = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Load into Composer") as HTMLButtonElement | undefined;
    assert.ok(load, "the dialog exposes its explicit load action");
    await act(async () => {
      load.focus();
      load.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(fixture.container.querySelector(".message-action-input"), null);
    assert.equal(fixture.composer.value, "edited prompt");
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    assert.deepEqual(
      [fixture.composer.selectionStart, fixture.composer.selectionEnd],
      [fixture.composer.value.length, fixture.composer.value.length],
    );
  } finally {
    await unmountFixture(fixture);
  }
});
