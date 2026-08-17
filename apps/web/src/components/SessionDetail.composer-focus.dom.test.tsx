import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionView, SideChatView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { COMPOSER_FOCUS_DIAGNOSTIC_EVENT } from "../composer-focus.js";
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
  pushSession: (patch: Partial<SessionView>) => Promise<void>;
  pushEvent: (payload: SessionEvent["payload"]) => Promise<void>;
}

type ComposerDraftLoader = (sessionId: string, instanceScope: string) => Promise<ComposerDraft | null>;

interface FixtureOptions {
  client?: Partial<ApiClient>;
  mainEventPayloads?: SessionEvent["payload"][];
  rightPanelMode?: "launcher" | "sidechat";
  composerDraftCleanup?: typeof deleteComposerDraftIfMatches;
  sessionCapabilities?: SessionView["agentCapabilities"];
  sessionPatch?: Partial<SessionView>;
  runnerProtocolVersion?: number;
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
  if (options.sessionPatch) Object.assign(currentSession, options.sessionPatch);
  if (options.sessionCapabilities) currentSession.agentCapabilities = options.sessionCapabilities;
  const fixtureRunner = options.sessionCapabilities && "models" in options.sessionCapabilities
    ? {
        ...runner,
        protocolVersion: options.runnerProtocolVersion ?? runner.protocolVersion,
        agents: runner.agents.map((agent) => ({ ...agent, capabilities: options.sessionCapabilities })),
      } as RunnerView
    : { ...runner, protocolVersion: options.runnerProtocolVersion ?? runner.protocolVersion };
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
    pushSession: async (patch) => {
      Object.assign(currentSession, patch);
      await act(async () => { socket.push({ type: "session_upsert", session: { ...currentSession } }); });
    },
    pushEvent: async (payload) => {
      currentSession.messageCount += 1;
      const seq = currentSession.messageCount;
      await act(async () => {
        socket.push({
          type: "session_event",
          event: { id: seq, sessionId: currentSession.id, seq, ts: seq + 1, payload },
        });
      });
    },
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

test("cleanup throwing after accepted steering cannot recover the accepted draft", async () => {
  const draft = deferred<ComposerDraft | null>();
  const calls: string[] = [];
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 73,
    sessionPatch: { status: "running", activeTurnId: "turn-1" },
    sessionCapabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: false,
      supportsSteering: true,
    },
    client: {
      steer: async (_sessionId, request) => {
        calls.push(request.text ?? "");
        return {
          submissionId: request.submissionId,
          turnId: request.turnId,
          source: "direct",
          text: request.text ?? "",
          state: "accepted",
          reason: "accepted",
          createdAt: 1,
          updatedAt: 1,
        };
      },
    },
    composerDraftCleanup: async () => { throw new Error("draft storage cleanup failed"); },
  });
  try {
    await resolveDraft(draft, "steer once");
    await act(async () => {
      Simulate.keyDown(fixture.composer, {
        key: "Enter",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });
    });
    await flushAsyncWork();

    assert.deepEqual(
      calls,
      ["steer once"],
      fixture.container.querySelector(".composer-error")?.textContent ?? "steering was not invoked",
    );
    assert.equal(fixture.container.querySelector(".composer-error"), null);
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "");
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

test("live turn updates preserve the focused composer, exact draft geometry, and content-free diagnostics", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    sessionPatch: { status: "running", activeTurnId: "turn-1" },
    runnerProtocolVersion: 72,
  });
  const diagnostics: unknown[] = [];
  const onDiagnostic = (event: unknown) => {
    diagnostics.push((event as { detail: unknown }).detail);
  };
  domWindow.addEventListener(COMPOSER_FOCUS_DIAGNOSTIC_EVENT, onDiagnostic);
  try {
    await resolveComposerDraft(draft, { text: "", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);
    assert.ok(fixture.container.querySelector('button[aria-label="Stop Turn"]'));
    await act(async () => {
      fixture.composer.value = "alpha\nbeta\ngamma";
      Simulate.change(fixture.composer);
    });
    fixture.composer.setSelectionRange(2, 11, "backward");
    fixture.composer.scrollTop = 47;
    await act(async () => { Simulate.select(fixture.composer); });
    const original = fixture.composer;

    assert.ok(fixture.container.querySelector('button[aria-label="Send"]'),
      "the first character swaps Stop for Send without replacing the composer");
    await act(async () => { Simulate.compositionStart(fixture.composer); });
    await fixture.pushEvent({ kind: "agent_message", text: "streamed update", messageId: "m-1" });
    await fixture.pushEvent({ kind: "tool_call", toolCallId: "tool-1", title: "Background Tool", status: "running" });
    await fixture.pushSession({ updatedAt: 5, status: "idle", activeTurnId: undefined });
    await act(async () => { Simulate.compositionEnd(fixture.composer); });

    assert.equal(fixture.container.querySelector(".composer-input"), original, "live updates must not remount the textarea");
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    assert.equal(fixture.composer.value, "alpha\nbeta\ngamma");
    assert.deepEqual(
      [fixture.composer.selectionStart, fixture.composer.selectionEnd, fixture.composer.selectionDirection],
      [2, 11, "backward"],
    );
    assert.equal(fixture.composer.scrollTop, 47);
    assert.ok(fixture.container.querySelector('button[aria-label="Send"]'), "Stop-to-Send transition keeps the composer");
    assert.ok(diagnostics.length > 0);
    assert.equal(JSON.stringify(diagnostics).includes("alpha"), false, "diagnostics must never include draft content");
  } finally {
    domWindow.removeEventListener(COMPOSER_FOCUS_DIAGNOSTIC_EVENT, onDiagnostic);
    await unmountFixture(fixture);
  }
});

test("focus recovery distinguishes background loss from explicit transfer and IME ownership", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "selection survives", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);
    fixture.composer.setSelectionRange(1, 9, "forward");
    fixture.composer.scrollTop = 23;

    await act(async () => {
      fixture.composer.blur();
      flushFrames();
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    assert.deepEqual([fixture.composer.selectionStart, fixture.composer.selectionEnd], [1, 9]);
    assert.equal(fixture.composer.scrollTop, 23);

    const transcript = fixture.container.querySelector('[aria-label="Session Activity"]') as HTMLElement;
    await act(async () => {
      transcript.focus();
      flushFrames();
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "background transcript focus must be reclaimed");

    await act(async () => {
      transcript.dispatchEvent(new domWindow.PointerEvent("pointerdown", { bubbles: true }) as never);
      transcript.focus();
      flushFrames();
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, transcript, "explicit control focus must not be reclaimed");

    await act(async () => {
      fixture.composer.focus();
      fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }) as never);
      fixture.composer.blur();
      transcript.focus();
      flushFrames();
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, transcript,
      "the shell Escape ladder must be allowed to transfer focus to the transcript");

    await act(async () => {
      fixture.composer.focus();
      fixture.composer.blur();
      domWindow.dispatchEvent(new domWindow.Event("blur"));
      flushFrames();
    });
    assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "window deactivation after focusout must cancel queued recovery");
    domWindow.dispatchEvent(new domWindow.Event("focus"));

    await act(async () => {
      fixture.composer.focus();
      transcript.dispatchEvent(new domWindow.PointerEvent("pointerdown", { bubbles: true }) as never);
    });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.blur();
      flushFrames();
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "an old pointer intent must not suppress a later background-loss recovery");

    await act(async () => {
      fixture.composer.focus();
      Simulate.compositionStart(fixture.composer);
      fixture.composer.blur();
      flushFrames();
      Simulate.compositionEnd(fixture.composer);
      flushFrames();
    });
    assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "focus recovery must not interrupt or resurrect an ended IME composition");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an immediate same-session remount restores exact selection direction and textarea scroll after hydration", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await act(async () => {
      draft.resolve(null);
      await draft.promise;
      fixture.composer.value = "multiline remount draft";
      Simulate.change(fixture.composer);
    });
    await act(async () => {
      fixture.composer.focus();
      fixture.composer.setSelectionRange(3, 16, "backward");
      fixture.composer.scrollTop = 61;
      Simulate.select(fixture.composer);
    });

    const persisted = deferred<ComposerDraft | null>();
    const remounted = await fixture.remountWithDraftLoader(() => persisted.promise);
    await resolveComposerDraft(persisted, {
      text: "multiline remount draft",
      images: [],
      updatedAt: 2,
    });
    await flushAsyncWork();
    await act(async () => { flushFrames(); });

    assert.equal(remounted.ownerDocument.activeElement, remounted);
    assert.deepEqual(
      [remounted.selectionStart, remounted.selectionEnd, remounted.selectionDirection],
      [3, 16, "backward"],
    );
    assert.equal(remounted.scrollTop, 61);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a mismatched hydration expires the remount lease before programmatic history recall", async () => {
  const draft = deferred<ComposerDraft | null>();
  const rememberedText = "history prompt";
  const fixture = await mountFixture(draft, {
    mainEventPayloads: [{ kind: "user_message", text: rememberedText, images: [] }],
  });
  try {
    await act(async () => {
      draft.resolve(null);
      await draft.promise;
      fixture.composer.value = rememberedText;
      Simulate.change(fixture.composer);
      fixture.composer.focus();
      fixture.composer.setSelectionRange(2, 5, "backward");
      fixture.composer.scrollTop = 37;
      Simulate.select(fixture.composer);
    });

    const persisted = deferred<ComposerDraft | null>();
    const remounted = await fixture.remountWithDraftLoader(() => persisted.promise);
    await resolveComposerDraft(persisted, { text: "", images: [], updatedAt: 2 });
    await flushAsyncWork();
    await act(async () => {
      remounted.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      }) as never);
      await Promise.resolve();
    });

    assert.equal(remounted.value, rememberedText);
    assert.deepEqual(
      [remounted.selectionStart, remounted.selectionEnd],
      [rememberedText.length, rememberedText.length],
      "history recall must keep its end caret instead of reviving stale remount geometry",
    );
    assert.notEqual(remounted.scrollTop, 37);
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
