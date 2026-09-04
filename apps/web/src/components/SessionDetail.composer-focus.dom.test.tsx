import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionView, SideChatView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { COMPOSER_FOCUS_DIAGNOSTIC_EVENT } from "../composer-focus.js";
import { ENTER_KEY_STORAGE_KEY } from "../enter-key.js";
import { LOCAL_INSTANCE_SCOPE } from "../instance-storage.js";
import { KEYBOARD_DISMISS_BLUR_EVENT, TOUCH_PHONE_MEDIA } from "../mobile-viewport.js";
import {
  deleteComposerDraftIfMatches,
  loadComposerDraft,
  type ComposerDraft,
} from "../composer-drafts.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import {
  QUEUED_EDIT_RECOVERY_MAX_BYTES,
  loadDurableQueuedEditRecovery,
  loadRuntimeQueuedEditRecovery,
  queuedEditRecoveryAccountKey,
} from "../queued-edit-recovery.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { clearSessionDetailComposerRuntimeForInstance, SessionDetail } from "./SessionDetail.js";

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
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface Fixture {
  composer: HTMLTextAreaElement;
  container: HTMLDivElement;
  root: Root;
  rerenderWithDraftLoader: (loader: ComposerDraftLoader) => Promise<void>;
  rerenderSessionWithDraftLoader: (sessionId: string, loader: ComposerDraftLoader) => Promise<void>;
  remountWithDraftLoader: (loader: ComposerDraftLoader) => Promise<HTMLTextAreaElement>;
  fullReloadWithDraftLoader: (loader: ComposerDraftLoader) => Promise<HTMLTextAreaElement>;
  sessionId: string;
  alternateSessionId: string;
  instanceScope: string;
  pushSession: (patch: Partial<SessionView>) => Promise<void>;
  pushEvent: (payload: SessionEvent["payload"]) => Promise<void>;
  closeSocket: (code: number) => Promise<void>;
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
    getIdentity: async () => ({
      context: {
        userId: "user-1",
        userName: "Test User",
        organizationId: "org-1",
        organizationName: "Test Organization",
        role: "owner" as const,
        deviceId: "device-1",
        localBootstrap: false,
      },
      organizations: [],
      memberships: [],
      teams: [],
    }),
    preparePromptImages: async (
      _sessionId: string,
      images: Parameters<ApiClient["preparePromptImages"]>[1],
    ) => images,
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
  const renderWithDraftLoader = (
    loader: ComposerDraftLoader,
    sessionId = currentSession.id,
    showDetail = true,
  ) => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          {options.mainEventPayloads && (
            <EventSeeder sessionId={currentSession.id} payloads={options.mainEventPayloads} />
          )}
          {showDetail && (
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
          )}
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
  const fullReloadWithDraftLoader = async (loader: ComposerDraftLoader) => {
    await act(async () => renderWithDraftLoader(loader, currentSession.id, false));
    clearSessionDetailComposerRuntimeForInstance(LOCAL_INSTANCE_SCOPE);
    detailMount += 1;
    await act(async () => {
      renderWithDraftLoader(loader);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const reloaded = container.querySelector(".composer-input") as HTMLTextAreaElement | null;
    assert.ok(reloaded, "the fully reloaded SessionDetail composer is available");
    return reloaded;
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
    fullReloadWithDraftLoader,
    sessionId: currentSession.id,
    alternateSessionId: alternateSession.id,
    instanceScope: LOCAL_INSTANCE_SCOPE,
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
    closeSocket: async (code) => {
      await act(async () => { socket.onclose?.({ code }); });
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

async function waitForComposerSendToSettle(fixture: Fixture, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sendButton(fixture).querySelector(".spinner")) {
    assert.ok(
      Date.now() < deadline,
      "the composer send request did not settle within the bounded test deadline",
    );
    await flushAsyncWork(10);
  }
}

const submittedImage = { mimeType: "image/png", data: "aW1hZ2U=" } as const;
const preparedImageReference = {
  artifactId: "art-prepared-image",
  mimeType: "image/png",
  sizeBytes: 5,
  sha256: "a".repeat(64),
} as const;

test("queued message editing loads exact content and Cancel Edit restores the displaced draft", async () => {
  const draft = deferred<ComposerDraft | null>();
  const reads: Array<{ sessionId: string; promptId: string }> = [];
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "bounded projection",
        hasImages: true,
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_projection",
      }, {
        id: "queue-2",
        text: "Another queued message",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_other",
      }],
    },
    client: {
      readQueuedPrompt: async (sessionId, promptId) => {
        reads.push({ sessionId, promptId });
        return {
          prompt: {
            promptId,
            text: "Exact queued content",
            images: [submittedImage],
            editRevision: "qer_exact",
          },
        };
      },
    },
  });
  try {
    await resolveDraft(draft, "Unsent local draft");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    assert.ok(edit);
    await act(async () => { edit.click(); });
    await flushAsyncWork();

    assert.equal(reads.length, 1);
    assert.equal(reads[0]?.promptId, "queue-1");
    assert.equal(fixture.composer.value, "Exact queued content");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assert.match(fixture.container.querySelector(".queued-edit-banner")?.textContent ?? "", /Editing Queued Message/);
    assert.ok(fixture.container.querySelector('button[aria-label="Save Queued Message"]'));
    const selectedRow = fixture.container.querySelector('[data-testid="queued-prompt-queue-1"]') as HTMLElement;
    const otherRow = fixture.container.querySelector('[data-testid="queued-prompt-queue-2"]') as HTMLElement;
    assert.equal(selectedRow.classList.contains("is-editing"), true);
    assert.equal(selectedRow.getAttribute("aria-current"), "true");
    assert.equal(otherRow.classList.contains("is-editing"), false);
    assert.equal(otherRow.hasAttribute("aria-current"), false);

    const cancel = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel Edit") as HTMLButtonElement | undefined;
    assert.ok(cancel);
    await act(async () => { cancel.click(); });
    await flushAsyncWork(450);
    assert.equal(fixture.composer.value, "Unsent local draft");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("navigating away mid-edit preserves the displaced session draft instead of queued content", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_projection",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Queued content must not become a draft",
          images: [],
          editRevision: "qer_exact",
        },
      }),
    },
  });
  try {
    await resolveComposerDraft(draft, { text: "Original local draft", images: [submittedImage], updatedAt: 1 });
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork(450);
    assert.equal(fixture.composer.value, "Queued content must not become a draft");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);

    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "Original local draft");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a queued edit that fails after navigation restores its exact retry and keeps the displaced draft separate", async () => {
  const draft = deferred<ComposerDraft | null>();
  const editResult = deferred<Awaited<ReturnType<ApiClient["editQueuedPrompt"]>>>();
  const edits: Array<Parameters<ApiClient["editQueuedPrompt"]>[2]> = [];
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        hasImages: true,
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [submittedImage],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async (_sessionId, _promptId, request) => {
        edits.push(request);
        return editResult.promise;
      },
    },
  });
  try {
    await resolveDraft(draft, "Displaced local draft");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Revised content awaiting confirmation";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();

    await fixture.rerenderSessionWithDraftLoader(fixture.alternateSessionId, async () => null);
    await flushAsyncWork();
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null,
      "the in-flight edit must not leak into another Session");

    const pending = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(pending.value, "Revised content awaiting confirmation");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));
    assert.ok(fixture.container.querySelector('button[aria-label="Save Queued Message"] .spinner'));

    await act(async () => {
      editResult.reject(new Error("The queued message changed before this edit was saved."));
      await Promise.resolve();
    });
    await flushAsyncWork();
    const recovered = fixture.container.querySelector(".composer-input") as HTMLTextAreaElement;
    assert.equal(recovered.value, "Revised content awaiting confirmation");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assert.equal(fixture.container.querySelector('button[aria-label="Save Queued Message"] .spinner'), null);
    assert.match(fixture.container.querySelector(".composer-error")?.textContent ?? "",
      /edit was not confirmed.*changed before/i);
    assert.equal(edits.length, 1);

    const retry = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { retry.click(); });
    await flushAsyncWork();
    assert.equal(edits.length, 2);
    assert.equal(edits[1]?.submissionId, edits[0]?.submissionId,
      "the recovered byte-identical edit must preserve its idempotency identity");

    const cancel = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Dismiss Recovery") as HTMLButtonElement | undefined;
    assert.ok(cancel);
    await act(async () => { cancel.click(); });
    await flushAsyncWork();
    assert.equal(recovered.value, "Displaced local draft");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null);

    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "Displaced local draft");
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null,
      "explicit cancellation must retire the failed edit recovery");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a live queue revision change disables recovered retry while preserving content for a new message", async () => {
  const draft = deferred<ComposerDraft | null>();
  const edits: Array<Parameters<ApiClient["editQueuedPrompt"]>[2]> = [];
  const prompts: string[] = [];
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        hasImages: true,
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [submittedImage],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async (_sessionId, _promptId, request) => {
        edits.push(request);
        throw new Error("The request timed out before confirmation.");
      },
      prompt: async (_sessionId, text) => {
        prompts.push(text);
        return undefined as never;
      },
    },
  });
  try {
    await resolveDraft(draft, "Displaced local draft");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Recovered revision for reuse";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.equal(edits.length, 1);
    assert.equal(save.disabled, false, "the unchanged authoritative target remains retryable");

    await fixture.pushSession({
      queued: [{
        id: "queue-1",
        text: "Changed on another client",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_newer",
      }],
    });
    assert.equal(save.disabled, true);
    assert.match(fixture.container.querySelector(".queued-edit-reason")?.textContent ?? "", /changed elsewhere/i);
    assert.equal(fixture.composer.value, "Recovered revision for reuse");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);

    await act(async () => {
      fireDomEvent.keyDown(fixture.composer, {
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });
    });
    await flushAsyncWork();
    assert.deepEqual(prompts, [], "Enter must not send a stale recovered edit as a new turn");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));
    assert.equal(fixture.composer.value, "Recovered revision for reuse");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);

    const reuse = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use as New Message") as HTMLButtonElement | undefined;
    assert.ok(reuse);
    await act(async () => { reuse.click(); });
    await flushAsyncWork(450);
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null);
    assert.equal(fixture.composer.value, "Recovered revision for reuse");

    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "Recovered revision for reuse");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a failed queued edit survives a simulated full runtime reload with its exact retry identity", async () => {
  const draft = deferred<ComposerDraft | null>();
  const edits: Array<Parameters<ApiClient["editQueuedPrompt"]>[2]> = [];
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      preparePromptImages: async (_sessionId, images) => images.map(() => preparedImageReference),
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [submittedImage],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async (_sessionId, _promptId, request) => {
        edits.push(request);
        throw new Error("The request timed out before confirmation.");
      },
    },
  });
  try {
    await resolveDraft(draft, "Displaced local draft");
    await flushAsyncWork();
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Durable recovered content";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.equal(edits.length, 1);

    const reloaded = await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(reloaded.value, "Durable recovered content");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assert.match(fixture.container.querySelector(".queued-edit-banner")?.textContent ?? "", /Recovered Queued Message/);

    const retry = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { retry.click(); });
    await flushAsyncWork();
    assert.equal(edits.length, 2);
    assert.equal(edits[1]?.submissionId, edits[0]?.submissionId);
    assert.equal(edits[1]?.expectedRevision, "qer_exact");
    assert.deepEqual(edits[1]?.images, [preparedImageReference]);

    await fixture.closeSocket(1008);
    await flushAsyncWork();
    assert.match(fixture.container.querySelector(".queued-edit-banner")?.textContent ?? "", /Recovered Queued Message/);
    assert.ok(loadDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.sessionId,
    }), "a temporary re-pairing state must not erase durable recovery");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a recovery persistence refusal blocks submission and releases the edit lock", async () => {
  const draft = deferred<ComposerDraft | null>();
  const edits: Array<Parameters<ApiClient["editQueuedPrompt"]>[2]> = [];
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: { promptId, text: "Original exact content", images: [], editRevision: "qer_exact" },
      }),
      editQueuedPrompt: async (_sessionId, _promptId, request) => {
        edits.push(request);
        throw new Error("The request timed out before confirmation.");
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    await flushAsyncWork();
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "x".repeat(QUEUED_EDIT_RECOVERY_MAX_BYTES);
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.deepEqual(edits, []);
    assert.match(fixture.container.querySelector(".composer-error")?.textContent ?? "", /could not be saved safely/i);

    await act(async () => {
      fixture.composer.value = "Small retry after storage refusal";
      fireDomEvent.change(fixture.composer);
    });
    await flushAsyncWork();
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.equal(edits.length, 1, "the failed persistence reservation must not wedge later saves");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a transient identity failure retries without remounting the Session", async () => {
  const draft = deferred<ComposerDraft | null>();
  let identityCalls = 0;
  const fixture = await mountFixture(draft, {
    client: {
      getIdentity: async () => {
        identityCalls += 1;
        if (identityCalls === 1) throw new Error("temporary identity failure");
        return {
          context: {
            userId: "user-1",
            userName: "Test User",
            organizationId: "org-1",
            organizationName: "Test Organization",
            role: "owner" as const,
            deviceId: "device-1",
            localBootstrap: false,
          },
          organizations: [],
          memberships: [],
          teams: [],
        };
      },
    },
  });
  try {
    await resolveDraft(draft, "Ordinary draft");
    await flushAsyncWork(1_100);
    assert.equal(identityCalls, 2);
  } finally {
    await unmountFixture(fixture);
  }
});

test("late identity hydration cannot replace an open unsent queued edit", async () => {
  const draft = deferred<ComposerDraft | null>();
  const delayedIdentity = deferred<Awaited<ReturnType<ApiClient["getIdentity"]>>>();
  const edits: Array<Parameters<ApiClient["editQueuedPrompt"]>[2]> = [];
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      getIdentity: async () => delayedIdentity.promise,
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: { promptId, text: "Original exact content", images: [], editRevision: "qer_exact" },
      }),
      editQueuedPrompt: async (_sessionId, _promptId, request) => {
        edits.push(request);
        throw new Error("The request timed out before confirmation.");
      },
    },
  });
  try {
    await resolveDraft(draft, "Displaced local draft");
    await flushAsyncWork();
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "Original exact content");

    await act(async () => {
      delayedIdentity.resolve({
        context: {
          userId: "user-1",
          userName: "Test User",
          organizationId: "org-1",
          organizationName: "Test Organization",
          role: "owner",
          deviceId: "device-1",
          localBootstrap: false,
        },
        organizations: [],
        memberships: [],
        teams: [],
      });
      await delayedIdentity.promise;
    });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "Original exact content");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));

    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.equal(edits[0]?.text, "Original exact content");
  } finally {
    await unmountFixture(fixture);
  }
});

test("identity hydration preserves an ordinary draft typed before durable recovery appears", async () => {
  const draft = deferred<ComposerDraft | null>();
  const delayedIdentity = deferred<Awaited<ReturnType<ApiClient["getIdentity"]>>>();
  const identity = {
    context: {
      userId: "user-1",
      userName: "Test User",
      organizationId: "org-1",
      organizationName: "Test Organization",
      role: "owner" as const,
      deviceId: "device-1",
      localBootstrap: false,
    },
    organizations: [],
    memberships: [],
    teams: [],
  };
  let identityCalls = 0;
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      getIdentity: async () => {
        identityCalls += 1;
        return identityCalls === 1 ? identity : delayedIdentity.promise;
      },
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async () => {
        throw new Error("The request timed out before confirmation.");
      },
    },
  });
  try {
    await resolveDraft(draft, "Earlier displaced draft");
    await flushAsyncWork();
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Recovered queued edit";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();

    const reloaded = await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null);
    await act(async () => {
      reloaded.value = "New ordinary draft typed during sign-in";
      fireDomEvent.change(reloaded);
    });
    assert.equal(loadRuntimeQueuedEditRecovery(
      `${fixture.instanceScope}\u0000${fixture.sessionId}`,
      queuedEditRecoveryAccountKey("org-1", "user-1"),
    ), undefined);

    await act(async () => {
      delayedIdentity.resolve(identity);
      await delayedIdentity.promise;
    });
    await flushAsyncWork();
    assert.equal(reloaded.value, "Recovered queued edit");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));

    const dismiss = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Dismiss Recovery") as HTMLButtonElement | undefined;
    assert.ok(dismiss);
    await act(async () => { dismiss.click(); });
    await flushAsyncWork();
    assert.equal(reloaded.value, "New ordinary draft typed during sign-in");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a queued edit interrupted by runtime reload returns as unconfirmed recovery", async () => {
  const draft = deferred<ComposerDraft | null>();
  const editResult = deferred<Awaited<ReturnType<ApiClient["editQueuedPrompt"]>>>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async () => editResult.promise,
    },
  });
  try {
    await resolveDraft(draft, "Displaced local draft");
    await flushAsyncWork();
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Indeterminate submission";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.ok(save.querySelector(".spinner"));

    const reloaded = await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    editResult.reject(new Error("The reloaded page interrupted the request."));
    await flushAsyncWork();
    assert.equal(reloaded.value, "Indeterminate submission");
    assert.equal(fixture.container.querySelector('button[aria-label="Save Queued Message"] .spinner'), null);
    assert.match(
      fixture.container.querySelector(".composer-error")?.textContent ?? "",
      /outcome was not recorded/i,
    );
  } finally {
    await unmountFixture(fixture);
  }
});

test("a queued edit accepted after navigation restores only the displaced draft", async () => {
  const draft = deferred<ComposerDraft | null>();
  const editResult = deferred<Awaited<ReturnType<ApiClient["editQueuedPrompt"]>>>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_projection",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async () => editResult.promise,
    },
  });
  try {
    await resolveDraft(draft, "Displaced local draft");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Successfully revised content";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();

    await fixture.rerenderSessionWithDraftLoader(fixture.alternateSessionId, async () => null);
    const pending = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(pending.value, "Successfully revised content");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));

    await act(async () => {
      editResult.resolve({
        prompt: {
          promptId: "queue-1",
          text: "Successfully revised content",
          images: [],
          editRevision: "qer_applied",
        },
      });
      await editResult.promise;
    });
    await flushAsyncWork();
    assert.equal(pending.value, "Displaced local draft");
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null);
    assert.equal(fixture.container.querySelector(".composer-error"), null);

    clearSessionDetailComposerRuntimeForInstance(fixture.instanceScope);
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "Displaced local draft");
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null,
      "a successful edit must never resurrect as failed recovery");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a queued edit accepted after navigation clears the composer when its displaced draft was empty", async () => {
  const draft = deferred<ComposerDraft | null>();
  const editResult = deferred<Awaited<ReturnType<ApiClient["editQueuedPrompt"]>>>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_projection",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async () => editResult.promise,
    },
  });
  try {
    await resolveDraft(draft, "");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Successfully revised content";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await fixture.rerenderSessionWithDraftLoader(fixture.alternateSessionId, async () => null);
    const pending = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(pending.value, "Successfully revised content");

    await act(async () => {
      editResult.resolve({
        prompt: {
          promptId: "queue-1",
          text: "Successfully revised content",
          images: [],
          editRevision: "qer_applied",
        },
      });
      await editResult.promise;
    });
    await flushAsyncWork();
    assert.equal(pending.value, "");
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null);

    clearSessionDetailComposerRuntimeForInstance(fixture.instanceScope);
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "");
    assert.equal(fixture.container.querySelector(".queued-edit-banner"), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("typing during a failing queued edit request keeps the latest composer content", async () => {
  const draft = deferred<ComposerDraft | null>();
  const editResult = deferred<Awaited<ReturnType<ApiClient["editQueuedPrompt"]>>>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_projection",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async () => editResult.promise,
    },
  });
  try {
    await resolveDraft(draft, "Displaced local draft");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Submitted revision";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await act(async () => {
      fixture.composer.value = "Submitted revision plus late typing";
      fireDomEvent.change(fixture.composer);
    });
    await fixture.rerenderSessionWithDraftLoader(fixture.alternateSessionId, async () => null);
    const recovered = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(recovered.value, "Submitted revision plus late typing");

    await act(async () => {
      editResult.reject(new Error("The queued message changed before this edit was saved."));
      await Promise.resolve();
    });
    await flushAsyncWork();

    assert.equal(recovered.value, "Submitted revision plus late typing");
    assert.match(fixture.container.querySelector(".composer-error")?.textContent ?? "", /not confirmed/i);
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("a failed queued edit keeps its draft and uses idempotency only for byte-identical retries", async () => {
  const draft = deferred<ComposerDraft | null>();
  const edits: unknown[] = [];
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Queued",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: {
          promptId,
          text: "Original exact content",
          images: [submittedImage],
          editRevision: "qer_exact",
        },
      }),
      editQueuedPrompt: async (_sessionId, _promptId, request) => {
        edits.push(request);
        throw new Error("The request timed out before confirmation.");
      },
    },
  });
  try {
    await resolveDraft(draft, "Displaced draft");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Revised exact content";
      fireDomEvent.change(fixture.composer);
    });
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    assert.ok(save);
    await act(async () => { save.click(); });
    await flushAsyncWork();

    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0], {
      submissionId: (edits[0] as { submissionId: string }).submissionId,
      expectedRevision: "qer_exact",
      text: "Revised exact content",
      images: [submittedImage],
    });
    assert.match((edits[0] as { submissionId: string }).submissionId, /.+/);
    assert.equal(fixture.composer.value, "Revised exact content");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));
    assert.match(fixture.container.querySelector(".composer-error")?.textContent ?? "", /timed out/i);

    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.equal(edits.length, 2);
    assert.equal(
      (edits[1] as { submissionId: string }).submissionId,
      (edits[0] as { submissionId: string }).submissionId,
      "an unchanged timeout retry must replay the same idempotency receipt",
    );

    await act(async () => {
      fixture.composer.value = "Corrected exact content";
      fireDomEvent.change(fixture.composer);
    });
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.equal(edits.length, 3);
    assert.notEqual(
      (edits[2] as { submissionId: string }).submissionId,
      (edits[1] as { submissionId: string }).submissionId,
      "changed content must use a fresh idempotency key",
    );
    assert.equal((edits[2] as { text: string }).text, "Corrected exact content");
  } finally {
    await unmountFixture(fixture);
  }
});

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
      fireDomEvent.keyDown(fixture.composer, {
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
      fireDomEvent.change(fixture.composer);
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
      fireDomEvent.change(fixture.composer);
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
      fireDomEvent.change(fixture.composer);
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
    await act(async () => { fireDomEvent.compositionStart(fixture.composer); });

    await resolveDraft(draft, "saved during composition");

    assert.equal(fixture.composer.value, "saved during composition");
    assert.equal(selections.length, selectionCount);
    await act(async () => { fireDomEvent.compositionEnd(fixture.composer); });
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
    await act(async () => { fireDomEvent.pointerDown(fixture.composer); });

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
      fireDomEvent.change(fixture.composer);
    });
    fixture.composer.setSelectionRange(2, 11, "backward");
    fixture.composer.scrollTop = 47;
    await act(async () => { fireDomEvent.select(fixture.composer); });
    assert.ok(
      diagnostics.some((detail) => (detail as { kind?: unknown }).kind === "selection"),
      "the browser event reaches the composer's React onSelect handler",
    );
    const original = fixture.composer;

    assert.ok(fixture.container.querySelector('button[aria-label="Send"]'),
      "the first character swaps Stop for Send without replacing the composer");
    await act(async () => { fireDomEvent.compositionStart(fixture.composer); });
    await fixture.pushEvent({ kind: "agent_message", text: "streamed update", messageId: "m-1" });
    await fixture.pushEvent({ kind: "tool_call", toolCallId: "tool-1", title: "Background Tool", status: "running" });
    await fixture.pushSession({ updatedAt: 5, status: "idle", activeTurnId: undefined });
    await act(async () => { fireDomEvent.compositionEnd(fixture.composer); });

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
      fixture.container.dispatchEvent(new domWindow.PointerEvent("pointerdown", { bubbles: true }) as never);
    });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.blur();
      flushFrames();
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "an old pointer intent outside the reader must not suppress a later background-loss recovery");

    await act(async () => {
      fixture.composer.focus();
      fireDomEvent.compositionStart(fixture.composer);
      fixture.composer.blur();
      flushFrames();
      fireDomEvent.compositionEnd(fixture.composer);
      flushFrames();
    });
    assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "focus recovery must not interrupt or resurrect an ended IME composition");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a delayed mobile transcript gesture relinquishes composer focus through selection and copy", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "preserved mobile draft", images: [], updatedAt: 1 });
    await fixture.pushEvent({ kind: "agent_message", text: "Selectable transcript prose", final: true });
    await focusRequestedComposer(fixture);

    const transcript = fixture.container.querySelector('[aria-label="Session Activity"]') as HTMLElement;
    await act(async () => {
      assert.equal(transcript.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
      }) as never), true, "the transcript touch gesture must remain uncanceled");
    });
    assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "touching transcript prose must dismiss composer focus before mobile gesture recognition");

    await flushAsyncWork();
    await act(async () => {
      transcript.dispatchEvent(new domWindow.Event("selectionchange", { bubbles: true }) as never);
      transcript.dispatchEvent(new domWindow.Event("copy", { bubbles: true }) as never);
      transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
      transcript.dispatchEvent(new domWindow.PointerEvent("pointerup", {
        bubbles: true,
        pointerType: "touch",
      }) as never);
      flushFrames();
    });
    await fixture.pushEvent({ kind: "agent_message", text: "Live update during selection", final: true });
    await act(async () => { flushFrames(); });
    assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "selection, copy, scrolling, and live updates must not reclaim composer focus");

    await act(async () => { fixture.composer.focus(); });
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    assert.equal(fixture.composer.value, "preserved mobile draft");

    await act(async () => {
      transcript.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
      }) as never);
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "desktop mouse gestures must retain the browser's native focus behavior");
  } finally {
    await unmountFixture(fixture);
  }
});

test("the keyboard-dismissal blur is announced and allowed to stand", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "dismissed by the detector", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);

    // mobile-viewport.ts announces its programmatic blur with this event so the recovery
    // machinery treats it like any user-initiated transfer. Unannounced, the blur reads as
    // background loss, the composer is refocused a frame later, and on Android that refocus
    // re-summons the keyboard the user just collapsed — an instant reopen loop.
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.Event(KEYBOARD_DISMISS_BLUR_EVENT));
      fixture.composer.blur();
      flushFrames();
    });
    assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "the detector's announced blur must stand");

    // The mark is consumed by the blur it announced: an ordinary background loss afterwards is
    // still recovered, so the announcement cannot latch recovery off.
    await act(async () => { fixture.composer.focus(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.blur();
      flushFrames();
    });
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "a later unannounced background loss must still be recovered");
  } finally {
    await unmountFixture(fixture);
  }
});

test("the send button's press keeps focus in the composer", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "ready to send", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);
    const sendButton = fixture.container.querySelector(".send-btn") as HTMLElement;
    assert.ok(sendButton, "the composer must render its send button");
    // Cancelling the press's default is what stops the tap from blurring the textarea. On a
    // phone that blur closed the keyboard and brought the bottom rail back BETWEEN touchstart
    // and click, moving this button out from under the finger — so the first tap collapsed the
    // keyboard instead of sending. The dictation button already presses this way.
    const uncanceled = sendButton.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    }) as never);
    assert.equal(uncanceled, false, "the send press must cancel the focus-stealing default");
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "the composer keeps focus through the press");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a stopped Session replaces Send with an accessible restart action until restart begins", async () => {
  const draft = deferred<ComposerDraft | null>();
  const restartResult = deferred<SessionView>();
  const restarted: string[] = [];
  const fixture = await mountFixture(draft, {
    sessionPatch: { status: "stopped" },
    client: {
      restart: async (sessionId) => {
        restarted.push(sessionId);
        return restartResult.promise;
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    const restart = fixture.container.querySelector(
      'button[aria-label="Restart Session"]',
    ) as HTMLButtonElement | null;
    assert.ok(restart, "a stopped Session exposes Restart Session in the composer action slot");
    assert.equal(restart.tagName, "BUTTON", "the restart action keeps native keyboard activation");
    assert.equal(restart.disabled, false);
    assert.equal(fixture.container.querySelector('button[aria-label="Send"]'), null);

    await act(async () => { restart.click(); });
    assert.equal(restarted.length, 1);
    assert.match(restarted[0]!, /^composer-focus-/);
    assert.ok(fixture.container.querySelector('button[aria-label="Restarting Session"] .spinner'));

    restartResult.resolve({ ...session(restarted[0]!), status: "starting" });
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector('button[aria-label="Send"]'),
      "the restart response immediately restores the ordinary Send action");
    assert.equal(fixture.container.querySelector('button[aria-label="Restart Session"]'), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a stopped Session with a failed Stop does not offer Restart in the composer", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    sessionPatch: {
      status: "stopped",
      stopOperation: {
        operationId: "stop-operation-composer",
        status: "stop_failed",
        requestedAt: 1,
        lastAttemptAt: 2,
        attemptCount: 1,
        capacityReleased: false,
        failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    assert.equal(fixture.container.querySelector('button[aria-label="Restart Session"]'), null,
      "the composer mirrors the Runtime menu's failed-Stop restart fence");
  } finally {
    await unmountFixture(fixture);
  }
});

test("the stop-turn button's press keeps focus in the composer", async () => {
  const draft = deferred<ComposerDraft | null>();
  // An active turn with an EMPTY composer is what renders Stop Turn in the send slot — the state
  // the send-button case never reaches, so reverting only this branch's cancellation left every
  // other test green.
  const fixture = await mountFixture(draft, {
    // turnInterruptionAck arrived at protocol 72; the fixture's default runner predates it.
    runnerProtocolVersion: 73,
    sessionPatch: { status: "running", activeTurnId: "turn-1" },
  });
  try {
    await resolveComposerDraft(draft, { text: "", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);
    const stopButton = fixture.container.querySelector(".stop-turn-btn") as HTMLElement;
    assert.ok(stopButton, "an active turn with an empty composer must render Stop Turn");
    const uncanceled = stopButton.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    }) as never);
    assert.equal(uncanceled, false, "the stop-turn press must cancel the focus-stealing default");
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer,
      "the composer keeps focus through the press");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Enter falls through to a newline on the touch-phone layout and still sends elsewhere", async () => {
  const draft = deferred<ComposerDraft | null>();
  const calls: string[] = [];
  const fixture = await mountFixture(draft, {
    client: {
      prompt: async (_sessionId, text) => {
        calls.push(text);
        return undefined as never;
      },
    },
  });
  try {
    await resolveComposerDraft(draft, { text: "line one", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);

    // The touch-phone layout, by the same shared media string the rail hiding and the dismissal
    // blur are gated on. A software keyboard offers no held Shift, so send-on-Enter made a
    // multi-line draft unwritable on a phone; Enter must reach the textarea's native newline.
    const priorMatchMedia = domWindow.matchMedia;
    domWindow.matchMedia = ((query: string) => ({
      matches: query === TOUCH_PHONE_MEDIA,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as never;
    let uncanceled = false;
    try {
      await act(async () => {
        uncanceled = fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }) as never);
      });
    } finally {
      domWindow.matchMedia = priorMatchMedia;
    }
    await flushAsyncWork();
    assert.equal(uncanceled, true, "Enter must fall through to the textarea's native newline");
    assert.deepEqual(calls, [], "Enter must not send on the touch-phone layout");

    // Elsewhere the contract is unchanged: plain Enter is claimed and sends.
    let canceled = false;
    await act(async () => {
      canceled = !fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }) as never);
    });
    await flushAsyncWork();
    assert.equal(canceled, true, "Enter must still be claimed for send off the phone layout");
    assert.deepEqual(calls, ["line one"], "Enter must still send off the phone layout");
  } finally {
    await unmountFixture(fixture);
  }
});

test("the Enter pair swaps as a unit and a stored choice beats the device class", async () => {
  const draft = deferred<ComposerDraft | null>();
  const calls: string[] = [];
  const fixture = await mountFixture(draft, {
    client: {
      prompt: async (_sessionId, text) => {
        calls.push(text);
        return undefined as never;
      },
    },
  });
  const phoneMatchMedia = ((query: string) => ({
    matches: query === TOUCH_PHONE_MEDIA,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  const pressEnter = async (shiftKey: boolean) => {
    let uncanceled = true;
    await act(async () => {
      uncanceled = fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey,
        bubbles: true,
        cancelable: true,
      }) as never);
    });
    await waitForComposerSendToSettle(fixture);
    return !uncanceled;
  };
  const seed = async (text: string) => {
    await act(async () => {
      fixture.composer.value = text;
      fireDomEvent.change(fixture.composer);
    });
  };
  const priorMatchMedia = domWindow.matchMedia;
  try {
    await resolveComposerDraft(draft, { text: "swap draft", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);
    domWindow.matchMedia = phoneMatchMedia;

    // Newline mode (the phone default): Shift+Enter is the SEND half of the swapped pair. This is
    // also what a hardware keyboard on a phone uses, which no detection could rescue.
    assert.equal(await pressEnter(true), true, "newline mode: Shift+Enter must be claimed for send");
    assert.deepEqual(calls, ["swap draft"], "newline mode: Shift+Enter must send");

    // A stored "send" beats the phone's derived default — the setting is the escape hatch.
    domWindow.localStorage.setItem(ENTER_KEY_STORAGE_KEY, "send");
    await seed("stored send on a phone");
    assert.equal(await pressEnter(false), true, "a stored send must reclaim plain Enter on a phone");
    assert.deepEqual(calls.at(-1), "stored send on a phone");
    assert.equal(await pressEnter(true), false, "and Shift+Enter goes back to being the newline");

    // A stored "newline" beats the desktop's derived default, and the swap holds there too.
    domWindow.matchMedia = priorMatchMedia;
    domWindow.localStorage.setItem(ENTER_KEY_STORAGE_KEY, "newline");
    await seed("stored newline on a desktop");
    assert.equal(await pressEnter(false), false, "a stored newline must release plain Enter off the phone");
    assert.equal(calls.length, 2, "plain Enter must not send in stored newline mode");
    assert.equal(await pressEnter(true), true, "Shift+Enter must send in stored newline mode");
    assert.deepEqual(calls.at(-1), "stored newline on a desktop");
  } finally {
    domWindow.matchMedia = priorMatchMedia;
    domWindow.localStorage.removeItem(ENTER_KEY_STORAGE_KEY);
    await unmountFixture(fixture);
  }
});

test("the send tooltip stops advertising Enter on the touch-phone layout", async () => {
  // Stubbed BEFORE mount: the tooltip is render-time copy, not a keydown-time read.
  const priorMatchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query === TOUCH_PHONE_MEDIA,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  try {
    const draft = deferred<ComposerDraft | null>();
    const fixture = await mountFixture(draft);
    try {
      await resolveComposerDraft(draft, { text: "draft", images: [], updatedAt: 1 });
      assert.equal(fixture.container.querySelector(".send-btn")?.getAttribute("title"), "Send",
        "the tooltip must not advertise an Enter that inserts a newline here");
    } finally {
      await unmountFixture(fixture);
    }
  } finally {
    domWindow.matchMedia = priorMatchMedia;
  }

  // And elsewhere the shortcut is real, so it stays advertised.
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "draft", images: [], updatedAt: 1 });
    assert.equal(fixture.container.querySelector(".send-btn")?.getAttribute("title"), "Send (Enter)",
      "off the phone layout the Enter shortcut exists and stays advertised");
  } finally {
    await unmountFixture(fixture);
  }

  // Stored newline off the phone: Shift+Enter is the live send binding, and a hover surface
  // exists there, so it is advertised rather than suppressed.
  domWindow.localStorage.setItem(ENTER_KEY_STORAGE_KEY, "newline");
  try {
    const storedDraft = deferred<ComposerDraft | null>();
    const storedFixture = await mountFixture(storedDraft);
    try {
      await resolveComposerDraft(storedDraft, { text: "draft", images: [], updatedAt: 1 });
      assert.equal(storedFixture.container.querySelector(".send-btn")?.getAttribute("title"), "Send (Shift+Enter)",
        "the tooltip must advertise the binding that actually sends");
    } finally {
      await unmountFixture(storedFixture);
    }
  } finally {
    domWindow.localStorage.removeItem(ENTER_KEY_STORAGE_KEY);
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
      fireDomEvent.change(fixture.composer);
    });
    await act(async () => {
      fixture.composer.focus();
      fixture.composer.setSelectionRange(3, 16, "backward");
      fixture.composer.scrollTop = 61;
      fireDomEvent.select(fixture.composer);
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
      fireDomEvent.change(fixture.composer);
      fixture.composer.focus();
      fixture.composer.setSelectionRange(2, 5, "backward");
      fixture.composer.scrollTop = 37;
      fireDomEvent.select(fixture.composer);
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
  const focusTransitions: unknown[] = [];
  const onFocusIn = (event: unknown) => {
    const target = (event as { target?: unknown }).target;
    if (target) focusTransitions.push(target);
  };
  domWindow.document.addEventListener("focusin", onFocusIn);
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
      fireDomEvent.change(dialogInput);
    });
    const load = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Load into Composer") as HTMLButtonElement | undefined;
    assert.ok(load, "the dialog exposes its explicit load action");
    await act(async () => {
      load.focus();
      load.click();
    });
    // Exercise the ordering that used to lose: a frame can run before Modal's zero-delay
    // restoration timer. The explicit return-focus owner must make either ordering converge.
    await act(async () => { flushFrames(); });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushFrames();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(fixture.container.querySelector(".message-action-input"), null);
    assert.equal(fixture.composer.value, "edited prompt");
    assert.equal(
      fixture.composer.ownerDocument.activeElement,
      fixture.composer,
      "loading the edited message leaves final focus in the composer",
    );
    assert.equal(
      focusTransitions.at(-1) === fixture.composer,
      true,
      "loading the edited message leaves focus in the composer",
    );
    assert.deepEqual(
      [fixture.composer.selectionStart, fixture.composer.selectionEnd],
      [fixture.composer.value.length, fixture.composer.value.length],
    );
  } finally {
    domWindow.document.removeEventListener("focusin", onFocusIn);
    await unmountFixture(fixture);
  }
});
