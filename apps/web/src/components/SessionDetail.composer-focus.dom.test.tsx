import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
  MAX_PROMPT_IMAGES,
  WORKSPACE_REFERENCE_MIME_TYPE,
  type ControlPlaneToUi,
  type RunnerView,
  type SessionEvent,
  type SessionView,
  type SideChatView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { COMPOSER_FOCUS_DIAGNOSTIC_EVENT } from "../composer-focus.js";
import { ENTER_KEY_STORAGE_KEY } from "../enter-key.js";
import { LOCAL_INSTANCE_SCOPE } from "../instance-storage.js";
import { KEYBOARD_DISMISS_BLUR_EVENT, TOUCH_PHONE_MEDIA } from "../mobile-viewport.js";
import { setQuestionResponseStyle } from "../question-response-style.js";
import {
  deleteComposerDraftIfMatches,
  loadComposerDraft,
  type ComposerDraft,
} from "../composer-drafts.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import {
  QUEUED_EDIT_RECOVERY_MAX_BYTES,
  clearDurableQueuedEditRecovery,
  loadDurableQueuedEditRecovery,
  loadRuntimeQueuedEditRecovery,
  queuedEditRecoveryAccountKey,
  saveDurableQueuedEditRecovery,
} from "../queued-edit-recovery.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { clearSessionDetailComposerRuntimeForInstance, SessionDetail } from "./SessionDetail.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { loadComposerEditCopy, saveComposerEditCopy } from "../composer-edit-copy.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { withCapturedAnimationFrames, withScopedClockOverrides } from "./test-clock-overrides.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
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
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  File: domWindow.File,
  FileReader: domWindow.FileReader,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
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
  mountPoint: HTMLDivElement;
  root: Root;
  rerenderWithDraftLoader: (loader: ComposerDraftLoader) => Promise<void>;
  rerenderSessionWithDraftLoader: (sessionId: string, loader: ComposerDraftLoader) => Promise<void>;
  remountWithDraftLoader: (loader: ComposerDraftLoader) => Promise<HTMLTextAreaElement>;
  fullReloadWithDraftLoader: (loader: ComposerDraftLoader) => Promise<HTMLTextAreaElement>;
  sessionId: string;
  alternateSessionId: string;
  instanceScope: string;
  pushSession: (patch: Partial<SessionView>) => Promise<void>;
  pushSessionSync: (patch: Partial<SessionView>) => void;
  pushEvent: (payload: SessionEvent["payload"]) => Promise<void>;
  closeSocket: (code: number) => Promise<void>;
}

type ComposerDraftLoader = (sessionId: string, instanceScope: string) => Promise<ComposerDraft | null>;

interface FixtureOptions {
  client?: Partial<ApiClient>;
  mainEventPayloads?: SessionEvent["payload"][];
  rightPanelMode?: "launcher" | "sidechat" | "background";
  composerDraftCleanup?: typeof deleteComposerDraftIfMatches;
  sessionCapabilities?: SessionView["agentCapabilities"];
  sessionPatch?: Partial<SessionView>;
  runnerProtocolVersion?: number;
  strictMode?: boolean;
  composerFocusIntent?: "message" | "reply" | null;
  onComposerFocusConsumed?: () => void;
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
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  let detailMount = 0;
  const renderWithDraftLoader = (
    loader: ComposerDraftLoader,
    sessionId = currentSession.id,
    showDetail = true,
  ) => {
    const content = (
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <FeedbackProvider>
            {options.mainEventPayloads && (
              <EventSeeder sessionId={currentSession.id} payloads={options.mainEventPayloads} />
            )}
            {showDetail && (
              <SessionDetail
                key={detailMount}
                sessionId={sessionId}
                rightPanel={rightPanel}
                onOpenTerminal={() => {}}
                composerFocusIntent={options.composerFocusIntent ?? "message"}
                onComposerFocusConsumed={options.onComposerFocusConsumed}
                composerDraftLoader={loader}
                composerDraftCleanup={options.composerDraftCleanup}
              />
            )}
          </FeedbackProvider>
        </StoreProvider>
      </ApiProvider>
    );
    root.render(options.strictMode ? <React.StrictMode>{content}</React.StrictMode> : content);
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
  const pushSessionSync = (patch: Partial<SessionView>) => {
    Object.assign(currentSession, patch);
    socket.push({ type: "session_upsert", session: { ...currentSession } });
  };
  return {
    composer,
    container,
    mountPoint,
    root,
    rerenderWithDraftLoader,
    rerenderSessionWithDraftLoader,
    remountWithDraftLoader,
    fullReloadWithDraftLoader,
    sessionId: currentSession.id,
    alternateSessionId: alternateSession.id,
    instanceScope: LOCAL_INSTANCE_SCOPE,
    pushSession: async (patch) => {
      await act(async () => { pushSessionSync(patch); });
    },
    pushSessionSync,
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
  fixture.mountPoint.remove();
  frames = [];
}

test("a failed account switch notice can be dismissed to edit and retry the current session", async () => {
  const draft = deferred<ComposerDraft | null>();
  const failure = {
    providerAccountId: "other-account",
    providerAccountLabel: "Other Account",
    reason: "the provider conversation cannot be resumed under another account",
    detectedAt: 5,
  };
  const fixture = await mountFixture(draft, {
    sessionPatch: { providerAccountSwitchFailure: failure },
  });
  try {
    assert.equal(fixture.composer.disabled, true);
    const banner = fixture.container.querySelector('[aria-label="Account Switch Failed"]');
    assert.ok(banner);
    const dismiss = [...banner.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label") === "Dismiss Notice");
    assert.ok(dismiss);
    await act(async () => { dismiss.click(); });
    assertNoDomNode(fixture.container.querySelector('[aria-label="Account Switch Failed"]'));
    assert.equal(fixture.composer.disabled, false);
    await act(async () => fireDomEvent.change(fixture.composer, { target: { value: "Continue" } }));
    assert.equal(fixture.composer.value, "Continue");

    await fixture.pushSession({ providerAccountSwitchFailure: { ...failure, detectedAt: 6 } });
    assert.ok(fixture.container.querySelector('[aria-label="Account Switch Failed"]'));
    assert.equal(fixture.composer.disabled, true, "a new failure still requires acknowledgement");
  } finally {
    await unmountFixture(fixture);
  }
});

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

test("Session Detail schedules its initial reader and composer focus before either frame runs", async () => {
  const draft = deferred<ComposerDraft | null>();
  await withCapturedAnimationFrames(domWindow, async (frames) => {
    const fixture = await mountFixture(draft);
    try {
      assert.ok(frames.pending() >= 2, "reader and message-intent focus each schedule a frame");
      assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer);
      await act(async () => { frames.flush(); });
      assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    } finally {
      await unmountFixture(fixture);
    }
  });
});

test("a collapsed phone composer retries focus on the following captured frame", async () => {
  const priorMatchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px"), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  const prototype = domWindow.HTMLTextAreaElement.prototype;
  const originalFocus = prototype.focus;
  let attempts = 0;
  prototype.focus = function() {
    attempts += 1;
    if (attempts > 1) originalFocus.call(this);
  };
  try {
    await withCapturedAnimationFrames(domWindow, async (frames) => {
      const fixture = await mountFixture(deferred<ComposerDraft | null>());
      try {
        assert.ok(frames.pending() > 0);
        await act(async () => { frames.flush(); });
        assert.ok(attempts > 0, "the immediate phone focus attempt ran");
        assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer);
        assert.ok(frames.pending() > 0, "failed immediate focus schedules a retry");
        await act(async () => { frames.flush(); });
        assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
      } finally {
        await unmountFixture(fixture);
      }
    });
  } finally {
    prototype.focus = originalFocus;
    domWindow.matchMedia = priorMatchMedia;
  }
});

test("Inbox Reply consumes its focus request in a captured frame", async () => {
  const draft = deferred<ComposerDraft | null>();
  let consumed = 0;
  await withCapturedAnimationFrames(domWindow, async (frames) => {
    const fixture = await mountFixture(draft, {
      composerFocusIntent: "reply",
      onComposerFocusConsumed: () => { consumed += 1; },
    });
    try {
      assert.ok(frames.pending() > 0);
      assert.equal(consumed, 0);
      await act(async () => { frames.flush(); });
      assert.equal(consumed, 1);
    } finally {
      await unmountFixture(fixture);
    }
  });
});

test("selecting a slash command restores the composer caret in its captured frame", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await focusRequestedComposer(fixture);
    await act(async () => {
      fixture.composer.value = "/ren";
      fixture.composer.setSelectionRange(4, 4);
      fireDomEvent.change(fixture.composer);
    });
    assert.ok(fixture.container.querySelector('[role="listbox"][aria-label="Slash Commands"]'));
    const option = fixture.container.querySelector<HTMLButtonElement>(
      '[role="listbox"][aria-label="Slash Commands"] [role="option"]:not([aria-disabled="true"])',
    );
    assert.ok(option, "a matching slash command is available");
    await withCapturedAnimationFrames(domWindow, async (frames) => {
      await act(async () => {
        fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }) as never);
      });
      assert.ok(frames.pending() > 0, "command replacement defers its caret restore");
      const other = domWindow.document.createElement("button");
      domWindow.document.body.append(other);
      await act(async () => { other.focus(); });
      assert.equal(fixture.composer.ownerDocument.activeElement, other);
      await act(async () => { frames.flush(); });
      assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
      assert.equal(fixture.composer.selectionStart, fixture.composer.value.length);
      other.remove();
    });
  } finally {
    await unmountFixture(fixture);
  }
});

test("attaching a workspace result restores composer focus in its captured frame", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 106,
    client: {
      searchWorkspaceReferences: async () => ({
        results: [{ path: "src/index.ts", isDirectory: false }], truncated: false,
      }),
      createWorkspaceReference: async () => ({ reference: {
        ...workspaceReference, artifactId: "workspace:whole-file", kind: "file",
        path: "src/index.ts",
      } }),
    },
  });
  try {
    await resolveDraft(draft, "");
    await focusRequestedComposer(fixture);
    const originalSetTimeout = domWindow.setTimeout;
    let runSearch: (() => void) | undefined;
    await withScopedClockOverrides(domWindow, {
      setTimeout: ((handler: () => void, delay?: number) => {
        if (delay === 150) {
          runSearch = handler;
          return 777 as unknown as ReturnType<typeof domWindow.setTimeout>;
        }
        return originalSetTimeout.call(domWindow, handler, delay);
      }) as typeof domWindow.setTimeout,
    }, async () => {
      await act(async () => {
        fixture.composer.value = "@index";
        fireDomEvent.change(fixture.composer);
        fixture.composer.setSelectionRange(6, 6);
        fireDomEvent.select(fixture.composer);
      });
      assert.ok(runSearch, "workspace search is scheduled");
      await act(async () => { runSearch?.(); });
    });
    const option = fixture.container.querySelector<HTMLButtonElement>(
      '[role="listbox"][aria-label="Workspace Paths"] [role="option"]',
    );
    assert.ok(option);
    await withCapturedAnimationFrames(domWindow, async (frames) => {
      await act(async () => {
        fireDomEvent.pointerDown(option);
        option.focus();
      });
      assert.equal(frames.pending(), 0, "deliberate picker focus does not queue blur recovery");
      await act(async () => { option.click(); });
      await Promise.resolve();
      assert.equal(frames.pending(), 1, "attachment creation schedules its own composer focus");
      assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer);
      await act(async () => { frames.flush(); });
      assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    });
  } finally {
    await unmountFixture(fixture);
  }
});

/** Opens + and activates Reference a File… (#2203). */
async function referenceAFile(fixture: Fixture) {
  const plus = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Attach and Settings"]');
  assert.ok(plus, "the + button is mounted");
  await act(async () => fireDomEvent.click(plus));
  const row = ([...domWindow.document.querySelectorAll('[role="menu"] [role="menuitem"]')] as unknown as HTMLButtonElement[])
    .find((item) => item.querySelector(".menu-text")?.textContent === "Reference a File…");
  assert.ok(row, "the menu offers Reference a File…");
  await act(async () => {
    fireDomEvent.click(row);
    await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
  });
}

function workspacePickerShown(fixture: Fixture): boolean {
  const listboxId = fixture.composer.getAttribute("aria-controls");
  return fixture.composer.getAttribute("aria-expanded") === "true" && Boolean(listboxId) &&
    domWindow.document.getElementById(listboxId!) !== null &&
    fixture.container.querySelector('[role="listbox"][aria-label="Workspace Paths"]') !== null;
}

for (const { name, draftText, caret, expected, expectedCaret } of [
  { name: "an empty draft", draftText: "", caret: 0, expected: "@", expectedCaret: 1 },
  { name: "the end of a word", draftText: "look at", caret: 7, expected: "look at @", expectedCaret: 9 },
  { name: "after a space mid-draft", draftText: "see  please", caret: 4, expected: "see @ please", expectedCaret: 5 },
]) {
  test(`Reference a File… inserts @ at the caret in ${name} and opens the @ picker with the composer focused (#2203)`, async () => {
    const draft = deferred<ComposerDraft | null>();
    const fixture = await mountFixture(draft, {
      runnerProtocolVersion: 106,
      client: { searchWorkspaceReferences: async () => ({ results: [], truncated: false }) },
    });
    try {
      await resolveDraft(draft, draftText);
      await focusRequestedComposer(fixture);
      await act(async () => {
        fixture.composer.setSelectionRange(caret, caret);
        fireDomEvent.select(fixture.composer);
      });
      assert.equal(workspacePickerShown(fixture), false, "no picker before the row");
      await referenceAFile(fixture);
      assert.equal(fixture.composer.value, expected);
      assert.equal(fixture.composer.selectionStart, expectedCaret, "the caret follows the @");
      assert.equal(domWindow.document.activeElement, fixture.composer, "the composer has focus");
      assert.ok(workspacePickerShown(fixture), "the @ picker is open");
      assertNoDomNode(domWindow.document.querySelector('[role="menu"][aria-label="Attach and Settings"]'),
        "the menu closed");
    } finally {
      await unmountFixture(fixture);
    }
  });
}

test("Reference a File… on a recalled prompt exits history browsing, so ArrowDown keeps the edited draft (#2203)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 106,
    mainEventPayloads: [{ kind: "user_message", text: "history prompt", images: [] }],
    client: { searchWorkspaceReferences: async () => ({ results: [], truncated: false }) },
  });
  const press = async (key: string) => {
    await act(async () => {
      fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as never);
      await Promise.resolve();
    });
  };
  try {
    await resolveDraft(draft, "");
    await focusRequestedComposer(fixture);
    await press("ArrowUp");
    assert.equal(fixture.composer.value, "history prompt", "ArrowUp recalls the last prompt");
    await referenceAFile(fixture);
    assert.equal(fixture.composer.value, "history prompt @");
    await press("Escape");
    assert.equal(workspacePickerShown(fixture), false, "Escape dismisses the @ picker");
    await press("ArrowDown");
    assert.equal(fixture.composer.value, "history prompt @", "the edited draft is not replaced by history");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a runner without workspace references has no Reference a File… row (#2203)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    const plus = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Attach and Settings"]')!;
    await act(async () => fireDomEvent.click(plus));
    const labels = [...domWindow.document.querySelectorAll('[role="menu"] .menu-text')].map((node) => node.textContent);
    assert.ok(labels.includes("Guardrails…"), "the menu opened");
    assert.equal(labels.includes("Reference a File…"), false);
  } finally {
    await unmountFixture(fixture);
  }
});

test("one tap on Reference a File… expands a collapsed phone composer and focuses it inside the tap (#2203)", async () => {
  const priorMatchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px") || query.includes("pointer: coarse"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 106,
    client: { searchWorkspaceReferences: async () => ({ results: [], truncated: false }) },
  });
  try {
    await resolveDraft(draft, "");
    const box = () => fixture.container.querySelector(".composer-box");
    assert.equal(box()?.classList.contains("idle-collapsed"), true, "the phone composer starts as the capsule");
    // No animation frame runs: iOS opens the keyboard only for focus inside the activating gesture.
    await withCapturedAnimationFrames(domWindow, async () => {
      await referenceAFile(fixture);
      assert.equal(box()?.classList.contains("idle-collapsed"), false, "the composer expanded");
      assert.equal(domWindow.document.activeElement, fixture.composer, "and has focus without waiting a frame");
      assert.equal(fixture.composer.value, "@");
      assert.ok(workspacePickerShown(fixture), "the @ picker is open");
    });
  } finally {
    domWindow.matchMedia = priorMatchMedia;
    await unmountFixture(fixture);
  }
});

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

function detailedBackgroundSession(id: string): SessionView {
  return {
    ...session(id),
    backgroundWorkTracking: "managed",
    backgroundJobsAvailable: true,
    backgroundJobs: [{
      id: "managed-job",
      parentTurnId: "parent-turn",
      launchType: "agent",
      registeredAt: 1_000,
      lastObservedAt: 2_000,
      sourcePresent: true,
      terminalStatus: "completed",
      terminalObservedAt: 2_000,
      continuationRequired: false,
    }],
  };
}

test("same-session replacement preserves one in-flight background inventory load", async () => {
  const draft = deferred<ComposerDraft | null>();
  const requests: Array<Deferred<{ session: SessionView }>> = [];
  const fixture = await mountFixture(draft, {
    rightPanelMode: "background",
    runnerProtocolVersion: 99,
    sessionPatch: {
      backgroundWorkTracking: "managed",
      backgroundJobsAvailable: true,
    },
    client: {
      session: async () => {
        const request = deferred<{ session: SessionView }>();
        requests.push(request);
        return request.promise;
      },
    },
  });
  try {
    await flushAsyncWork();
    assert.match(fixture.container.textContent ?? "", /Loading Background Work/);
    const requestsBeforeReplacement = requests.length;
    assert.ok(requestsBeforeReplacement >= 1, "the lazy inventory request is in flight");

    await fixture.pushSession({ updatedAt: 2 });
    await flushAsyncWork();
    assert.equal(requests.length, requestsBeforeReplacement,
      "an unrelated same-session replacement does not start a concurrent request");

    await act(async () => {
      for (const request of requests) request.resolve({ session: detailedBackgroundSession(fixture.sessionId) });
      await Promise.all(requests.map((request) => request.promise));
    });
    await flushAsyncWork();
    assert.match(fixture.container.textContent ?? "", /Agent Job 1/);
    assert.doesNotMatch(fixture.container.textContent ?? "", /Loading Background Work/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("failed background inventory loads expose a working retry", async () => {
  const draft = deferred<ComposerDraft | null>();
  const requests: Array<Deferred<{ session: SessionView }>> = [];
  const fixture = await mountFixture(draft, {
    rightPanelMode: "background",
    runnerProtocolVersion: 99,
    sessionPatch: {
      backgroundWorkTracking: "managed",
      backgroundJobsAvailable: true,
    },
    client: {
      session: async () => {
        const request = deferred<{ session: SessionView }>();
        requests.push(request);
        return request.promise;
      },
    },
  });
  try {
    await flushAsyncWork();
    const initialRequests = [...requests];
    assert.ok(initialRequests.length >= 1);
    await act(async () => {
      for (const request of initialRequests) request.reject(new Error("inventory unavailable"));
      await Promise.allSettled(initialRequests.map((request) => request.promise));
    });
    await flushAsyncWork();
    assert.match(fixture.container.textContent ?? "", /Background Work Unavailable/);
    const retry = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry Loading") as HTMLButtonElement | undefined;
    assert.ok(retry, "the failed inventory load exposes an accessible button");

    await act(async () => retry.click());
    await flushAsyncWork();
    assert.equal(requests.length, initialRequests.length + 1);
    const retried = requests.at(-1)!;
    await act(async () => {
      retried.resolve({ session: detailedBackgroundSession(fixture.sessionId) });
      await retried.promise;
    });
    await flushAsyncWork();
    assert.match(fixture.container.textContent ?? "", /Agent Job 1/);
    assert.doesNotMatch(fixture.container.textContent ?? "", /Background Work Unavailable/);
  } finally {
    await unmountFixture(fixture);
  }
});

const submittedImage = { mimeType: "image/png", data: "aW1hZ2U=" } as const;
const displacedDraftImage = { mimeType: "image/jpeg", data: `/9j/${"A".repeat(1_100_000)}` } as const;
const preparedImageReference = {
  artifactId: "art-prepared-image",
  mimeType: "image/png",
  sizeBytes: 5,
  sha256: "a".repeat(64),
} as const;
const materializedImageReference = {
  artifactId: "art-materialized-image",
  mimeType: "image/png",
  sizeBytes: 5,
  sha256: "6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d",
} as const;
const workspaceReference = {
  artifactId: "workspace:source-lines",
  mimeType: WORKSPACE_REFERENCE_MIME_TYPE,
  sizeBytes: 0,
  sha256: "a".repeat(64),
  referenceVersion: 1,
  kind: "lines",
  path: "src/index.ts",
  rootFingerprint: "b".repeat(64),
  targetFingerprint: "a".repeat(64),
  startLine: 4,
  endLine: 8,
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
    await withCapturedAnimationFrames(domWindow, async (frames) => {
      await act(async () => { edit.focus(); edit.click(); });
      await flushAsyncWork();
      assert.ok(frames.pending() > 0, "loading a queued edit schedules composer focus");
      assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer);
      await act(async () => { frames.flush(); });
      assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    });

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
    await withCapturedAnimationFrames(domWindow, async (frames) => {
      await act(async () => {
        fireDomEvent.pointerDown(cancel);
        cancel.focus();
      });
      assert.equal(frames.pending(), 0, "deliberate Cancel focus does not queue blur recovery");
      await act(async () => { cancel.click(); });
      assert.equal(frames.pending(), 1, "leaving queued edit queues its ordinary composer restore");
      assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer);
      await act(async () => { frames.flush(); });
      assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    });
    await flushAsyncWork(450);
    assert.equal(fixture.composer.value, "Unsent local draft");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("saving a queued edit restores the displaced composer only after its captured frame", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: { queued: [{
      id: "queue-1", text: "Queued projection", liveQueueObserved: true,
      editable: true, editRevision: "qer_exact",
    }] },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({ prompt: {
        promptId, text: "Queued exact content", images: [], editRevision: "qer_exact",
      } }),
      editQueuedPrompt: async (_sessionId, promptId) => ({ prompt: {
        promptId, text: "Queued exact content", images: [], editRevision: "qer_saved",
      } }),
    },
  });
  try {
    await resolveDraft(draft, "Displaced draft");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    assert.ok(save);
    await withCapturedAnimationFrames(domWindow, async (frames) => {
      await act(async () => { save.focus(); save.click(); });
      await flushAsyncWork();
      assert.ok(frames.pending() > 0, "successful save defers focus until the draft is restored");
      assert.equal(fixture.composer.value, "Displaced draft");
      assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer);
      await act(async () => { frames.flush(); });
      assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
      assert.equal(fixture.composer.selectionStart, fixture.composer.value.length);
    });
  } finally {
    await unmountFixture(fixture);
  }
});

test("a queued edit opened before the person lost queue management is not saved (#1857)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const saved: string[] = [];
  const reason = "Your Viewer role is read-only.";
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: { queued: [{
      id: "queue-1", text: "Queued projection", liveQueueObserved: true,
      editable: true, editRevision: "qer_exact",
    }] },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({ prompt: {
        promptId, text: "Queued exact content", images: [], editRevision: "qer_exact",
      } }),
      editQueuedPrompt: async (_sessionId, promptId) => {
        saved.push(promptId);
        return { prompt: { promptId, text: "Queued exact content", images: [], editRevision: "qer_saved" } };
      },
    },
  });
  try {
    await resolveDraft(draft, "Displaced draft");
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector('button[aria-label="Save Queued Message"]'), "the edit is open");
    const refused = { allowed: false as const, reason };
    await fixture.pushSession({ commandPermissions: {
      stop: refused, restart: refused, stopBackgroundJob: refused, manageQueue: refused, prompt: refused,
    } });
    await act(async () => {
      fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as never);
    });
    await flushAsyncWork();
    assert.deepEqual(saved, [], "the open edit is not sent once queue management is refused");
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
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"),
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
    assertNoDomNode(fixture.container.querySelector('button[aria-label="Save Queued Message"] .spinner'));
    assert.match(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "",
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
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));

    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "Displaced local draft");
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"),
      "explicit cancellation must retire the failed edit recovery");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a live queue revision change disables recovered retry while preserving content for a new message", async () => {
  const draft = deferred<ComposerDraft | null>();
  const edits: Array<Parameters<ApiClient["editQueuedPrompt"]>[2]> = [];
  const prompts: Array<{ text: string; images: Parameters<ApiClient["prompt"]>[2] }> = [];
  const exportedArtifacts: string[] = [];
  let exportFailure: Error | null = null;
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
      preparePromptImages: async (_sessionId, images) => images.map(() => materializedImageReference),
      artifactExport: async (artifactId) => {
        exportedArtifacts.push(artifactId);
        if (exportFailure) throw exportFailure;
        return new Blob([Buffer.from("image")], { type: "image/png" });
      },
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
      prompt: async (_sessionId, text, images) => {
        prompts.push({ text, images });
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
    exportFailure = new Error("The retained attachment is unavailable.");
    await act(async () => { reuse.click(); });
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector(".queued-edit-banner"),
      "a failed materialization must keep the recovery available");
    assert.equal(fixture.composer.value, "Recovered revision for reuse");
    assert.match(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "", /attachment could not be retained/i);

    exportFailure = null;
    await withCapturedAnimationFrames(domWindow, async (frames) => {
      await act(async () => {
        fireDomEvent.pointerDown(reuse);
        reuse.focus();
      });
      assert.equal(frames.pending(), 0, "deliberate Reuse focus does not queue blur recovery");
      await act(async () => { reuse.click(); });
      await flushAsyncWork(450);
      assert.equal(frames.pending(), 2,
        "recovered conversion queues final focus separately from its initial reveal");
      assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer);
      await act(async () => { frames.flush(); });
      assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    });
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));
    assert.equal(fixture.composer.value, "Recovered revision for reuse");
    assert.ok(exportedArtifacts.includes(materializedImageReference.artifactId));

    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "Recovered revision for reuse");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assert.deepEqual((await loadComposerDraft(fixture.sessionId, fixture.instanceScope))?.images, [submittedImage],
      "ordinary draft storage retains raw bytes instead of an expiring preparation reference");

    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();
    assert.deepEqual(prompts, [{ text: "Recovered revision for reuse", images: [submittedImage] }],
      "the later ordinary send re-prepares its retained raw image bytes");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Use as New Message preserves workspace references while materializing recovered images", async () => {
  const draft = deferred<ComposerDraft | null>();
  const exportedArtifacts: string[] = [];
  let exportFailure: Error | null = new Error("The retained image is unavailable.");
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 106,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Changed on another client",
        hasImages: true,
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_newer",
      }],
    },
    client: {
      artifactExport: async (artifactId) => {
        exportedArtifacts.push(artifactId);
        if (exportFailure) throw exportFailure;
        return new Blob([Buffer.from("image")], { type: "image/png" });
      },
    },
  });
  const recoveryScope = {
    instanceScope: fixture.instanceScope,
    accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
    sessionId: fixture.sessionId,
  };
  try {
    await resolveDraft(draft, "Ordinary draft");
    assert.equal(saveDurableQueuedEditRecovery(recoveryScope, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "Ordinary draft", images: [] },
      },
      draft: {
        text: "Recovered mixed attachments",
        images: [workspaceReference, materializedImageReference],
      },
      error: "Queued message edit was not confirmed.",
    }), true);

    await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    const reuse = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use as New Message") as HTMLButtonElement | undefined;
    assert.ok(reuse);

    await act(async () => { reuse.click(); });
    await flushAsyncWork();
    assert.ok(exportedArtifacts.length > 0);
    assert.ok(exportedArtifacts.every((artifactId) => artifactId === materializedImageReference.artifactId),
      "workspace references must never be sent to artifact export, including preview exports");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));
    assert.deepEqual(loadDurableQueuedEditRecovery(recoveryScope)?.draft.images,
      [workspaceReference, materializedImageReference],
      "a failed image export must retain the full mixed recovery");

    exportFailure = null;
    await act(async () => { reuse.click(); });
    await flushAsyncWork(450);
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));
    assert.ok(exportedArtifacts.every((artifactId) => artifactId === materializedImageReference.artifactId));
    assert.deepEqual((await loadComposerDraft(fixture.sessionId, fixture.instanceScope))?.images,
      [workspaceReference, submittedImage],
      "conversion must structurally preserve the workspace reference and embed only the image");
  } finally {
    await unmountFixture(fixture);
  }
});

test("malformed recovered image collections stay recoverable without starting exports", async () => {
  const draft = deferred<ComposerDraft | null>();
  let exports = 0;
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-1",
        text: "Changed on another client",
        hasImages: true,
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_newer",
      }],
    },
    client: {
      artifactExport: async () => {
        exports += 1;
        return new Blob([Buffer.from("image")], { type: "image/png" });
      },
    },
  });
  try {
    await resolveDraft(draft, "Ordinary draft");
    assert.equal(saveDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.sessionId,
    }, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "Ordinary draft", images: [] },
      },
      draft: {
        text: "Recovered queued edit",
        images: Array.from({ length: MAX_PROMPT_IMAGES + 1 }, (_, index) => ({
          ...materializedImageReference,
          artifactId: `oversized-recovery-${index}`,
        })),
      },
      error: "Queued message edit was not confirmed.",
    }), true);

    await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    const reuse = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use as New Message") as HTMLButtonElement | undefined;
    assert.ok(reuse);
    const previewExports = exports;
    await act(async () => { reuse.click(); });
    await flushAsyncWork();

    assert.equal(exports, previewExports,
      "materialization validation must fail before starting any additional artifact exports");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"),
      "invalid retained attachments must leave recovery available");
    assert.match(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "",
      new RegExp(`at most ${MAX_PROMPT_IMAGES} images`, "i"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("mount hydration cannot restore a recovery cleared while its displaced draft loads", async () => {
  const draft = deferred<ComposerDraft | null>();
  const delayedDraft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, { runnerProtocolVersion: 99 });
  const recoveryScope = {
    instanceScope: fixture.instanceScope,
    accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
    sessionId: fixture.sessionId,
  };
  try {
    await resolveDraft(draft, "Ordinary draft");
    assert.equal(saveDurableQueuedEditRecovery(recoveryScope, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "Compact ordinary draft", images: [] },
        displacedDraftStoredSeparately: true,
      },
      draft: { text: "Recovered queued edit", images: [] },
      error: "Queued message edit was not confirmed.",
    }), true);

    await fixture.fullReloadWithDraftLoader(() => delayedDraft.promise);
    assert.equal(clearDurableQueuedEditRecovery(recoveryScope), true);
    delayedDraft.resolve({ text: "Hydrated ordinary draft", images: [submittedImage], updatedAt: 2 });
    await flushAsyncWork();

    assert.equal(loadDurableQueuedEditRecovery(recoveryScope), undefined);
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"),
      "a delayed mount result must not restore recovery cleared elsewhere");
    const currentComposer = fixture.container.querySelector(".composer-input") as HTMLTextAreaElement;
    assert.equal(currentComposer.value, "Hydrated ordinary draft",
      "the same mount must reveal the ordinary draft after definitive cleanup wins");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("mount hydration reconciles a newer recovery saved while its displaced draft loads", async () => {
  const draft = deferred<ComposerDraft | null>();
  const delayedDraft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionCapabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      supportsSteering: true,
    },
  });
  const recoveryScope = {
    instanceScope: fixture.instanceScope,
    accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
    sessionId: fixture.sessionId,
  };
  try {
    await resolveDraft(draft, "Ordinary draft");
    assert.equal(saveDurableQueuedEditRecovery(recoveryScope, {
      edit: {
        promptId: "queue-1",
        text: "Older queued content",
        images: [],
        editRevision: "qer_older",
        displacedDraft: { text: "Compact ordinary draft", images: [] },
        displacedDraftStoredSeparately: true,
      },
      draft: { text: "Older recovered edit", images: [] },
      error: "Older recovery",
    }), true);

    await fixture.fullReloadWithDraftLoader(() => delayedDraft.promise);
    const localComposer = fixture.container.querySelector(".composer-input") as HTMLTextAreaElement;
    await act(async () => {
      localComposer.value = "Local work entered while hydration waits";
      fireDomEvent.change(localComposer);
    });
    const attachmentInput = fixture.container.querySelector(".composer-attach-input") as HTMLInputElement;
    Object.defineProperty(attachmentInput, "files", {
      configurable: true,
      value: [new domWindow.File([Buffer.from("local image")], "local.png", { type: "image/png" })],
    });
    await act(async () => {
      attachmentInput.dispatchEvent(
        new domWindow.Event("change", { bubbles: true }) as unknown as Event,
      );
    });
    await flushAsyncWork(25);
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    const newerRecovery = {
      edit: {
        promptId: "queue-1",
        text: "Newer queued content",
        images: [],
        editRevision: "qer_newer",
        displacedDraft: { text: "Compact ordinary draft", images: [] },
        displacedDraftStoredSeparately: true as const,
      },
      draft: { text: "Newer recovered edit", images: [] },
      error: "Newer recovery",
    };
    assert.equal(saveDurableQueuedEditRecovery(recoveryScope, newerRecovery), true);
    delayedDraft.resolve({ text: "Hydrated ordinary draft", images: [submittedImage], updatedAt: 2 });
    await flushAsyncWork();

    const currentComposer = fixture.container.querySelector(".composer-input") as HTMLTextAreaElement;
    assert.equal(currentComposer.value, "Newer recovered edit");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));
    assert.match(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "", /Newer recovery/);
    await flushAsyncWork(450);
    const reconciled = loadDurableQueuedEditRecovery(recoveryScope);
    assert.equal(reconciled?.edit.editRevision, "qer_newer");
    assert.equal(reconciled?.draft.text, "Newer recovered edit");
    assert.equal(reconciled?.error, "Newer recovery");
    assert.equal(reconciled?.edit.displacedDraft.text, "Local work entered while hydration waits");
    assert.equal(reconciled?.edit.displacedDraft.images.length, 1,
      "settled reconciliation must preserve the winner and its displaced local attachment");

    const dismiss = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Dismiss Recovery") as HTMLButtonElement | undefined;
    assert.ok(dismiss);
    await act(async () => { dismiss.click(); });
    await flushAsyncWork();
    assert.equal(currentComposer.value, "Local work entered while hydration waits",
      "the competing recovery must retain locally entered text as the displaced ordinary draft");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1,
      "the competing recovery must retain locally attached images as the displaced ordinary draft");
  } finally {
    await unmountFixture(fixture);
  }
});

test("recovery cleanup cannot resurrect an ordinary draft reserved by an in-flight send", async () => {
  const draft = deferred<ComposerDraft | null>();
  const delayedDraft = deferred<ComposerDraft | null>();
  const prompt = deferred<never>();
  const fixture = await mountFixture(draft, {
    client: { prompt: () => prompt.promise },
    runnerProtocolVersion: 99,
  });
  const recoveryScope = {
    instanceScope: fixture.instanceScope,
    accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
    sessionId: fixture.sessionId,
  };
  try {
    await resolveDraft(draft, "Submitted ordinary draft");
    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();
    assert.ok(sendButton(fixture).querySelector(".spinner"));
    assert.equal(saveDurableQueuedEditRecovery(recoveryScope, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "Submitted ordinary draft", images: [] },
        displacedDraftStoredSeparately: true,
      },
      draft: { text: "Recovered queued edit", images: [] },
      error: "Queued message edit was not confirmed.",
    }), true);

    const remounted = await fixture.remountWithDraftLoader(() => delayedDraft.promise);
    assert.equal(clearDurableQueuedEditRecovery(recoveryScope), true);
    delayedDraft.resolve({ text: "Submitted ordinary draft", images: [], updatedAt: 2 });
    await flushAsyncWork();

    assert.equal(remounted.value, "",
      "cleanup must not reveal an ordinary draft still owned by an in-flight send");
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("a failed queued edit survives a simulated full runtime reload with its exact retry identity", async () => {
  const draft = deferred<ComposerDraft | null>();
  const edits: Array<Parameters<ApiClient["editQueuedPrompt"]>[2]> = [];
  const prepared: Array<Parameters<ApiClient["preparePromptImages"]>[1]> = [];
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
      preparePromptImages: async (_sessionId, images) => {
        prepared.push(images);
        return images.map(() => preparedImageReference);
      },
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
    await resolveComposerDraft(draft, {
      text: "Displaced local draft",
      images: [displacedDraftImage],
      updatedAt: 1,
    });
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
    assert.deepEqual(prepared[0], [submittedImage, submittedImage],
      "saving a queued edit must not upload the ordinary draft's attachment");

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
    assert.deepEqual(prepared[1], [preparedImageReference, preparedImageReference],
      "an exact retry reuses the prepared queued attachment only");

    const retained = loadDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.sessionId,
    });
    assert.deepEqual(retained?.edit.displacedDraft, {
      text: "Displaced local draft",
      images: [],
    }, "large displaced attachments stay out of the bounded localStorage recovery");
    assert.equal(retained?.edit.displacedDraftStoredSeparately, true);
    const retainedDraft = await loadComposerDraft(fixture.sessionId, fixture.instanceScope);
    assert.equal(retainedDraft?.text, "Displaced local draft");
    assert.deepEqual(retainedDraft?.images, [displacedDraftImage],
      "the full ordinary draft remains recoverable from draft storage without uploading its attachment");

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
    assert.match(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "", /could not be saved safely/i);

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

test("late identity hydration with durable recovery cannot replace a modified local queued edit", async () => {
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
        prompt: { promptId, text: "Original exact content", images: [submittedImage], editRevision: "qer_exact" },
      }),
      editQueuedPrompt: async (_sessionId, _promptId, request) => {
        edits.push(request);
        throw new Error("The request timed out before confirmation.");
      },
    },
  });
  try {
    assert.equal(saveDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.sessionId,
    }, {
      edit: {
        promptId: "queue-1",
        text: "Older queued content",
        images: [],
        editRevision: "older-revision",
        displacedDraft: { text: "Older displaced draft", images: [] },
      },
      draft: { text: "Older recovered edit", images: [] },
      error: "Older recovery",
    }), true);
    await resolveDraft(draft, "Displaced local draft");
    await flushAsyncWork();
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    await act(async () => {
      fixture.composer.value = "Locally revised content";
      fireDomEvent.change(fixture.composer);
    });

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
    assert.equal(fixture.composer.value, "Locally revised content");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));

    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.equal(edits[0]?.text, "Locally revised content");
    assert.equal(edits[0]?.expectedRevision, "qer_exact");
    assert.deepEqual(edits[0]?.images, [submittedImage]);
  } finally {
    await unmountFixture(fixture);
  }
});

test("switching Sessions restores the destination recovery instead of retaining the prior local edit", async () => {
  const draft = deferred<ComposerDraft | null>();
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
        prompt: { promptId, text: "Current Session edit", images: [], editRevision: "qer_exact" },
      }),
    },
  });
  try {
    await resolveDraft(draft, "Current Session draft");
    await flushAsyncWork();
    const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "Current Session edit");

    assert.equal(saveDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.alternateSessionId,
    }, {
      edit: {
        promptId: "queue-destination",
        text: "Destination original",
        images: [],
        editRevision: "destination-revision",
        displacedDraft: { text: "Destination displaced draft", images: [] },
      },
      draft: { text: "Destination recovered edit", images: [] },
      error: "Destination recovery",
    }), true);

    await fixture.rerenderSessionWithDraftLoader(fixture.alternateSessionId, async () => null);
    await flushAsyncWork();
    const destinationComposer = fixture.container.querySelector(".composer-input") as HTMLTextAreaElement;
    assert.equal(destinationComposer.value, "Destination recovered edit");
    assert.match(fixture.container.querySelector(".queued-edit-banner")?.textContent ?? "",
      /Recovered Queued Message/);
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
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));
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

test("late queued-edit recovery exits Answer Mode and reveals the recovered editor", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const delayedIdentity = deferred<Awaited<ReturnType<ApiClient["getIdentity"]>>>();
  const fixture = await mountFixture(draft, {
    sessionPatch: {
      pendingApproval: {
        requestId: "ask-late-recovery",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    },
    client: { getIdentity: async () => delayedIdentity.promise },
  });
  try {
    assert.equal(saveDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.sessionId,
    }, {
      edit: {
        promptId: "queue-recovered-answer-mode",
        text: "Original queued content",
        images: [],
        editRevision: "qer_answer_mode",
        displacedDraft: { text: "", images: [] },
      },
      draft: { text: "Recovered queued edit", images: [] },
      error: "Queued message edit was not confirmed.",
    }), true);
    await act(async () => { fixture.composer.focus(); });
    await resolveDraft(draft, "");
    await act(async () => { flushFrames(); });
    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(answer);
    await act(async () => { answer.focus(); });

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
    await act(async () => { flushFrames(); });

    assertNoDomNode(fixture.container.querySelector(".composer-answer-input"));
    const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.equal(ordinary?.value, "Recovered queued edit");
    assert.equal(ordinary?.ownerDocument.activeElement, ordinary);
    assert.match(fixture.container.querySelector(".queued-edit-banner")?.textContent ?? "", /Recovered Queued Message/);
    assert.ok(fixture.container.querySelector('button[aria-label="Save Queued Message"]'));
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("recovery appearing after mutation release preserves the dirty ordinary draft it displaces", async () => {
  const draft = deferred<ComposerDraft | null>();
  const prompt = deferred<never>();
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
    client: { prompt: () => prompt.promise },
    composerDraftCleanup: async () => false,
  });
  try {
    await resolveComposerDraft(draft, {
      text: "Submitted ordinary draft",
      images: [submittedImage],
      updatedAt: 1,
    });
    await act(async () => { sendButton(fixture).click(); });
    await act(async () => {
      fixture.composer.value = "New ordinary draft from this tab";
      fireDomEvent.change(fixture.composer);
    });
    assert.equal(saveDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.sessionId,
    }, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "Draft from the other tab", images: [] },
      },
      draft: { text: "Recovered queued edit", images: [] },
      error: "Queued message edit was not confirmed.",
    }), true);

    await act(async () => { prompt.resolve(undefined as never); });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "Recovered queued edit");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));

    const dismiss = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Dismiss Recovery") as HTMLButtonElement | undefined;
    assert.ok(dismiss);
    await act(async () => { dismiss.click(); });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "New ordinary draft from this tab");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);

    const reloaded = await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(reloaded.value, "New ordinary draft from this tab");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("post-mutation recovery preserves ordinary typing that arrives during displaced-draft hydration", async () => {
  const draft = deferred<ComposerDraft | null>();
  const steering = deferred<Awaited<ReturnType<ApiClient["steer"]>>>();
  const delayedRecoveryDraft = deferred<ComposerDraft | null>();
  let delayedRecoveryReads = 0;
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionCapabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      supportsSteering: true,
    },
    sessionPatch: {
      status: "running",
      activeTurnId: "turn-active",
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        steerable: true,
        editRevision: "qer_exact",
      }],
    },
    client: { steer: () => steering.promise },
  });
  try {
    await resolveComposerDraft(draft, {
      text: "Ordinary draft before recovery",
      images: [submittedImage],
      updatedAt: 1,
    });
    await fixture.rerenderWithDraftLoader(async () => {
      delayedRecoveryReads += 1;
      return delayedRecoveryDraft.promise;
    });

    const promote = fixture.container.querySelector(
      'button[aria-label="Steer Queued Message"]',
    ) as HTMLButtonElement;
    await act(async () => { promote.click(); });
    assert.equal(saveDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.sessionId,
    }, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "Compact displaced draft", images: [] },
        displacedDraftStoredSeparately: true,
      },
      draft: { text: "Recovered queued edit", images: [] },
      error: "Queued message edit was not confirmed.",
    }), true);

    await act(async () => {
      steering.resolve({
        submissionId: "steer-1",
        turnId: "turn-active",
        source: "queued",
        sourceQueueId: "queue-1",
        text: "Queued projection",
        state: "accepted",
        reason: "accepted",
        createdAt: 1,
        updatedAt: 1,
      });
      await steering.promise;
    });
    await flushAsyncWork();
    assert.equal(delayedRecoveryReads, 1);

    await act(async () => {
      fixture.composer.value = "Ordinary typing while recovery storage is pending";
      fireDomEvent.change(fixture.composer);
    });
    delayedRecoveryDraft.resolve({
      text: "Older ordinary draft from storage",
      images: [submittedImage],
      updatedAt: 2,
    });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "Recovered queued edit");
    assert.ok(fixture.container.querySelector(".queued-edit-banner"));

    const dismiss = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Dismiss Recovery") as HTMLButtonElement | undefined;
    assert.ok(dismiss);
    await act(async () => { dismiss.click(); });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "Ordinary typing while recovery storage is pending");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);

    const reloaded = await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(reloaded.value, "Ordinary typing while recovery storage is pending");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a clear that wins during delayed displaced-draft hydration is not resurrected", async () => {
  const draft = deferred<ComposerDraft | null>();
  const steering = deferred<Awaited<ReturnType<ApiClient["steer"]>>>();
  const delayedRecoveryDraft = deferred<ComposerDraft | null>();
  let delayedRecoveryReads = 0;
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionCapabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      supportsSteering: true,
    },
    sessionPatch: {
      status: "running",
      activeTurnId: "turn-active",
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        steerable: true,
        editRevision: "qer_exact",
      }],
    },
    client: { steer: () => steering.promise },
  });
  const recoveryScope = {
    instanceScope: fixture.instanceScope,
    accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
    sessionId: fixture.sessionId,
  };
  try {
    await resolveComposerDraft(draft, {
      text: "Ordinary draft before recovery",
      images: [submittedImage],
      updatedAt: 1,
    });
    await fixture.rerenderWithDraftLoader(async () => {
      delayedRecoveryReads += 1;
      return delayedRecoveryDraft.promise;
    });

    const promote = fixture.container.querySelector(
      'button[aria-label="Steer Queued Message"]',
    ) as HTMLButtonElement;
    await act(async () => { promote.click(); });
    assert.equal(saveDurableQueuedEditRecovery(recoveryScope, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "Compact displaced draft", images: [] },
        displacedDraftStoredSeparately: true,
      },
      draft: { text: "Recovered queued edit", images: [] },
      error: "Queued message edit was not confirmed.",
    }), true);

    await act(async () => {
      steering.resolve({
        submissionId: "steer-1",
        turnId: "turn-active",
        source: "queued",
        sourceQueueId: "queue-1",
        text: "Queued projection",
        state: "accepted",
        reason: "accepted",
        createdAt: 1,
        updatedAt: 1,
      });
      await steering.promise;
    });
    await flushAsyncWork();
    assert.equal(delayedRecoveryReads, 1);

    assert.equal(clearDurableQueuedEditRecovery(recoveryScope), true);
    delayedRecoveryDraft.resolve({
      text: "Older ordinary draft from storage",
      images: [submittedImage],
      updatedAt: 2,
    });
    await flushAsyncWork();

    assert.equal(loadDurableQueuedEditRecovery(recoveryScope), undefined);
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"),
      "a delayed hydration result must not restore a recovery cleared elsewhere");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a recovered edit completed after delayed hydration restores the latest ordinary draft", async () => {
  const draft = deferred<ComposerDraft | null>();
  const steering = deferred<Awaited<ReturnType<ApiClient["steer"]>>>();
  const delayedRecoveryDraft = deferred<ComposerDraft | null>();
  let delayedRecoveryReads = 0;
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionCapabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      supportsSteering: true,
    },
    sessionPatch: {
      status: "running",
      activeTurnId: "turn-active",
      queued: [{
        id: "queue-1",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        steerable: true,
        editRevision: "qer_exact",
      }],
    },
    client: {
      steer: () => steering.promise,
      editQueuedPrompt: async (_sessionId, promptId, request) => ({
        prompt: {
          promptId,
          text: request.text,
          images: request.images,
          editRevision: "qer_applied",
        },
      }),
    },
  });
  try {
    await resolveComposerDraft(draft, {
      text: "Ordinary draft before recovery",
      images: [submittedImage],
      updatedAt: 1,
    });
    await fixture.rerenderWithDraftLoader(async () => {
      delayedRecoveryReads += 1;
      return delayedRecoveryDraft.promise;
    });

    const promote = fixture.container.querySelector(
      'button[aria-label="Steer Queued Message"]',
    ) as HTMLButtonElement;
    await act(async () => { promote.click(); });
    assert.equal(saveDurableQueuedEditRecovery({
      instanceScope: fixture.instanceScope,
      accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
      sessionId: fixture.sessionId,
    }, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "Compact displaced draft", images: [] },
        displacedDraftStoredSeparately: true,
      },
      draft: { text: "Recovered queued edit", images: [] },
      error: "Queued message edit was not confirmed.",
    }), true);

    await act(async () => {
      steering.resolve({
        submissionId: "steer-1",
        turnId: "turn-active",
        source: "queued",
        sourceQueueId: "queue-1",
        text: "Queued projection",
        state: "accepted",
        reason: "accepted",
        createdAt: 1,
        updatedAt: 1,
      });
      await steering.promise;
    });
    await flushAsyncWork();
    assert.equal(delayedRecoveryReads, 1);

    await act(async () => {
      fixture.composer.value = "Latest ordinary draft before recovery completion";
      fireDomEvent.change(fixture.composer);
    });
    delayedRecoveryDraft.resolve({
      text: "Older ordinary draft from storage",
      images: [submittedImage],
      updatedAt: 2,
    });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "Recovered queued edit");

    const save = fixture.container.querySelector('button[aria-label="Save Queued Message"]') as HTMLButtonElement;
    await act(async () => { save.click(); });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "Latest ordinary draft before recovery completion");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));

    const reloaded = await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(reloaded.value, "Latest ordinary draft before recovery completion");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
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
    assertNoDomNode(fixture.container.querySelector('button[aria-label="Save Queued Message"] .spinner'));
    assert.match(
      fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "",
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
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));
    assertNoDomNode(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)"));

    clearSessionDetailComposerRuntimeForInstance(fixture.instanceScope);
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "Displaced local draft");
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"),
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
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));

    clearSessionDetailComposerRuntimeForInstance(fixture.instanceScope);
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "");
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));
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
    assert.match(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "", /not confirmed/i);
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
    assert.match(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "", /timed out/i);

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

    assertNoDomNode(fixture.container.querySelector('[role="alert"]'), "cleanup is not reported as a send rejection");
    const remounted = await fixture.remountWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assert.equal(remounted.value, "");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
  } finally {
    await unmountFixture(fixture);
  }
});

test("direct steering follows the queue-management verdict even when prompting is allowed (#1857)", async () => {
  const reason = "Session credentials cannot use this command.";
  for (const manageQueue of [{ allowed: false as const, reason }, { allowed: true as const }]) {
    const draft = deferred<ComposerDraft | null>();
    const calls: string[] = [];
    const fixture = await mountFixture(draft, {
      runnerProtocolVersion: 73,
      sessionPatch: {
        status: "running",
        activeTurnId: "turn-1",
        commandPermissions: {
          stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true },
          prompt: { allowed: true }, manageQueue,
        },
      },
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
            submissionId: request.submissionId, turnId: request.turnId, source: "direct",
            text: request.text ?? "", state: "accepted", reason: "accepted", createdAt: 1, updatedAt: 1,
          };
        },
      },
    });
    try {
      await resolveDraft(draft, "steer once");
      await act(async () => {
        fireDomEvent.keyDown(fixture.composer, { key: "Enter", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false });
      });
      await flushAsyncWork();
      assert.deepEqual(calls, manageQueue.allowed ? ["steer once"] : [],
        manageQueue.allowed ? "an allowed person steers as before" : "a refused steer is not sent");
    } finally {
      await unmountFixture(fixture);
    }
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
      fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)")?.textContent ?? "steering was not invoked",
    );
    assertNoDomNode(fixture.container.querySelector(".notice.t-danger[role=\"alert\"]:not(.state-error)"));
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

    await withCapturedAnimationFrames(domWindow, async (frames) => {
      await act(async () => { fixture.composer.blur(); });
      assert.ok(frames.pending() > 0, "background blur defers its restore");
      assert.notEqual(fixture.composer.ownerDocument.activeElement, fixture.composer);
      await act(async () => { frames.flush(); });
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

test("phone composer controls survive a pointer click when the browser does not focus buttons", async () => {
  const priorMatchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);
    const plusTrigger = fixture.container.querySelector(
      'button[aria-label="Attach and Settings"]',
    ) as HTMLButtonElement | null;
    assert.ok(plusTrigger);

    await act(async () => {
      fireDomEvent.pointerDown(plusTrigger, { pointerType: "mouse" });
      // Safari and Firefox on macOS blur the textarea without focusing the button.
      fixture.composer.blur();
      fireDomEvent.click(plusTrigger);
    });

    assert.equal(fixture.container.querySelector(".composer-box")?.classList.contains("idle-collapsed"), false);
    assert.ok(domWindow.document.querySelector('.menu[aria-label="Attach and Settings"]'),
      "the original pointer activation must still open the composer menu (portalled to <body>)");
  } finally {
    domWindow.matchMedia = priorMatchMedia;
    await unmountFixture(fixture);
  }
});

test("a keyboard-opened composer menu keeps the phone composer expanded around it", async () => {
  const priorMatchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "", images: [], updatedAt: 1 });
    await focusRequestedComposer(fixture);
    const plusTrigger = fixture.container.querySelector(
      'button[aria-label="Attach and Settings"]',
    ) as HTMLButtonElement | null;
    assert.ok(plusTrigger);
    await act(async () => { plusTrigger.focus(); });
    // The menu is portalled to <body>, so opening it from the keyboard moves focus out of the
    // composer box: that is still the composer's own control, not leaving the composer.
    await act(async () => {
      plusTrigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });
    const menu = domWindow.document.querySelector('.menu[aria-label="Attach and Settings"]');
    assert.ok(menu, "ArrowDown opens the composer menu");
    assert.ok(menu.contains(domWindow.document.activeElement), "the menu takes focus");
    assert.equal(fixture.container.querySelector(".composer-box")?.classList.contains("idle-collapsed"), false,
      "focus in a composer menu keeps the phone composer expanded");
    await act(async () => {
      domWindow.document.activeElement?.dispatchEvent(
        new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never,
      );
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });
    assert.equal(domWindow.document.activeElement, plusTrigger, "Escape returns focus to a trigger that is still shown");
    assert.equal(fixture.container.querySelector(".composer-box")?.classList.contains("idle-collapsed"), false);
  } finally {
    domWindow.matchMedia = priorMatchMedia;
    await unmountFixture(fixture);
  }
});

test("a phone queue tap cannot collapse while WebKit retains textarea focus", async () => {
  const priorMatchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "preserved mobile draft", images: [], updatedAt: 1 });
    await fixture.pushSession({
      queued: [{ id: "queued-1", text: "Queued message", hasImages: false, steerable: true }],
    });
    await focusRequestedComposer(fixture);
    const queuedText = fixture.container.querySelector(".queue-text") as HTMLElement | null;
    assert.ok(queuedText);

    await act(async () => {
      fireDomEvent.pointerDown(queuedText, { pointerType: "touch" });
      // iOS WebKit can retain textarea focus when the tapped target is non-focusable.
      fireDomEvent.click(queuedText);
    });

    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
    assert.equal(fixture.container.querySelector(".composer-box")?.classList.contains("idle-collapsed"), false,
      "the composer must stay expanded while its textarea still owns focus");
  } finally {
    domWindow.matchMedia = priorMatchMedia;
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
    const sendButton = fixture.container.querySelector(".composer-btn.primary") as HTMLElement;
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
    assertNoDomNode(fixture.container.querySelector('button[aria-label="Send"]'));

    await act(async () => { restart.click(); });
    assert.equal(restarted.length, 1);
    assert.match(restarted[0]!, /^composer-focus-/);
    assert.ok(fixture.container.querySelector('button[aria-label="Restarting Session"] .spinner'));

    restartResult.resolve({ ...session(restarted[0]!), status: "starting" });
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector('button[aria-label="Send"]'),
      "the restart response immediately restores the ordinary Send action");
    assertNoDomNode(fixture.container.querySelector('button[aria-label="Restart Session"]'));
  } finally {
    await unmountFixture(fixture);
  }
});

test("a stopped Session shows the composer's Restart disabled with the reason to a person the server would refuse (#1843)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const restarted: string[] = [];
  const reason = "Your Viewer role is read-only.";
  const fixture = await mountFixture(draft, {
    sessionPatch: {
      status: "stopped",
      commandPermissions: {
        stop: { allowed: false, reason },
        restart: { allowed: false, reason },
        stopBackgroundJob: { allowed: false, reason },
      },
    },
    client: {
      restart: async (sessionId) => {
        restarted.push(sessionId);
        return session(sessionId);
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    const restart = fixture.container.querySelector(
      'button[aria-label="Restart Session"]',
    ) as HTMLButtonElement | null;
    assert.ok(restart, "the action stays in place so the person can see why it is unavailable");
    assert.equal(restart.disabled, true);
    assert.equal(restart.title, reason);
    await act(async () => { restart.click(); });
    await flushAsyncWork();
    assert.deepEqual(restarted, [], "no request is sent");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a person the server refuses a prompt gets a read-only composer that says why, and nothing is sent", async () => {
  const reason = "Your Viewer role is read-only.";
  const refused = { allowed: false as const, reason };
  for (const commandPermissions of [
    { stop: refused, restart: refused, stopBackgroundJob: refused, archive: refused, unarchive: refused, prompt: refused, delete: refused },
    undefined,
  ]) {
    const draft = deferred<ComposerDraft | null>();
    const prompted: string[] = [];
    const fixture = await mountFixture(draft, {
      sessionPatch: commandPermissions ? { commandPermissions } : {},
      client: {
        prompt: async (_sessionId, text) => {
          prompted.push(text);
          return undefined as never;
        },
      },
    });
    try {
      await resolveDraft(draft, "Hello");
      if (!commandPermissions) {
        assert.equal(fixture.composer.disabled, false, "a control plane without permissions keeps the composer as before");
        assert.notEqual(fixture.composer.placeholder, reason);
        continue;
      }
      assert.equal(fixture.composer.disabled, true);
      assert.equal(fixture.composer.placeholder, reason, "the composer states why it is read-only");
      assert.equal(sendButton(fixture).disabled, true);
      await act(async () => {
        fireDomEvent.keyDown(fixture.composer, { key: "Enter" });
        sendButton(fixture).click();
      });
      await flushAsyncWork();
      assert.deepEqual(prompted, [], "no prompt is sent");
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("a Viewer's Stop Turn, queued-message actions and Plan control are disabled with the reason and send nothing (#1857)", async () => {
  const reason = "Your Viewer role is read-only.";
  const refused = { allowed: false as const, reason };
  const allowed = { allowed: true as const };
  const everything = (permission: typeof refused | typeof allowed) => ({
    stop: permission, restart: permission, stopBackgroundJob: permission, archive: permission,
    unarchive: permission, prompt: permission, delete: permission, cancelTurn: permission,
    manageQueue: permission, rename: permission, configure: permission, respond: permission,
  });
  for (const commandPermissions of [everything(refused), everything(allowed), undefined]) {
    const draft = deferred<ComposerDraft | null>();
    const calls: string[] = [];
    const fixture = await mountFixture(draft, {
      runnerProtocolVersion: 99,
      sessionPatch: {
        status: "running",
        activeTurnId: "turn-1",
        permissionMode: "plan",
        queued: [{ id: "queue-1", text: "Queued message", liveQueueObserved: true, editable: true, editRevision: "qer_1" }],
        ...(commandPermissions ? { commandPermissions } : {}),
      },
      client: {
        cancelTurn: async (sessionId) => { calls.push("cancelTurn"); return session(sessionId); },
        steer: async () => { calls.push("steer"); return new Promise<never>(() => {}); },
        cancelQueuedPrompt: async () => { calls.push("cancelQueuedPrompt"); },
        readQueuedPrompt: async () => { calls.push("readQueuedPrompt"); return new Promise<never>(() => {}); },
        setConfig: async (sessionId) => { calls.push("setConfig"); return session(sessionId); },
      },
    });
    const label = commandPermissions === undefined ? "without permissions" : commandPermissions.cancelTurn === refused ? "refused" : "allowed";
    try {
      await resolveComposerDraft(draft, { text: "", images: [], updatedAt: 1 });
      const stopTurn = fixture.container.querySelector(".stop-turn-btn") as HTMLButtonElement;
      // Steer shows only where steering works for the row (#2178); this agent has not said it steers.
      assertNoDomNode(fixture.container.querySelector('button[aria-label="Steer Queued Message"]'));
      const edit = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
      const cancel = fixture.container.querySelector('button[aria-label="Cancel Queued Message"]') as HTMLButtonElement;
      const plan = fixture.container.querySelector(".plan-toggle") as HTMLButtonElement;
      for (const [name, control] of Object.entries({ stopTurn, edit, cancel, plan })) {
        assert.ok(control, `${label}: ${name} stays in place`);
      }
      if (commandPermissions?.cancelTurn !== refused) {
        assert.equal(stopTurn.disabled, false, `${label}: Stop Turn is offered as before`);
        assert.equal(edit.disabled, false, `${label}: Edit is offered as before`);
        assert.equal(cancel.disabled, false, `${label}: Cancel is offered as before`);
        assert.equal(plan.disabled, false, `${label}: Plan is offered as before`);
        assert.notEqual(stopTurn.title, reason);
        continue;
      }
      // The refusal is visible once, in the queue tray's header, and every queue action references it.
      const header = fixture.container.querySelector(".queue-head");
      assert.ok([...header!.querySelectorAll(".queue-note")].some((note) => note.textContent === reason));
      for (const [name, control] of Object.entries({ stopTurn, edit, cancel, plan })) {
        assert.equal(control.disabled, true, `${name} is disabled for a Viewer`);
        const described = control.getAttribute("aria-describedby");
        assert.ok(described, `${name} carries its reason as a description`);
        assert.equal(fixture.container.ownerDocument.getElementById(described!)?.textContent, reason,
          `${name}'s description is the refusal`);
      }
      assert.equal(stopTurn.title, reason, "Stop Turn says why");
      assert.equal(cancel.title, reason);
      await act(async () => {
        for (const control of [stopTurn, edit, cancel, plan]) control.click();
        domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", shiftKey: true, bubbles: true }) as never);
        fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", shiftKey: true, bubbles: true }) as never);
      });
      await flushAsyncWork();
      assert.deepEqual(calls, [], "neither the controls nor the Stop Turn shortcut send anything");
    } finally {
      await unmountFixture(fixture);
    }
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
    assertNoDomNode(fixture.container.querySelector('button[aria-label="Restart Session"]'),
      "the composer mirrors the Runtime menu's failed-Stop restart fence");
  } finally {
    await unmountFixture(fixture);
  }
});

// #2301: the control plane refuses to restart an archived session, so the composer offers none.
test("an archived stopped Session offers no composer Restart, and unarchiving brings a working one back", async () => {
  const draft = deferred<ComposerDraft | null>();
  const restarted: string[] = [];
  const prompted: string[] = [];
  const fixture = await mountFixture(draft, {
    sessionPatch: { status: "stopped", archived: true },
    client: {
      restart: async (sessionId) => {
        restarted.push(sessionId);
        return { ...session(sessionId), status: "starting" };
      },
      prompt: async (sessionId) => {
        prompted.push(sessionId);
        throw new Error("an archived session takes no prompt");
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    assertNoDomNode(fixture.container.querySelector('button[aria-label="Restart Session"]'),
      "an archived session's composer offers no Restart the control plane would refuse");
    const send = fixture.container.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null;
    assert.ok(send, "the action slot keeps the ordinary Send action");
    assert.equal(send.disabled, true);
    assert.equal(fixture.composer.placeholder, "Unarchive the session to send a message.");
    await act(async () => {
      send.click();
      fixture.composer.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
        key: "Enter", bubbles: true, cancelable: true,
      }) as never);
    });
    await flushAsyncWork();
    assert.deepEqual(restarted, [], "no restart request is sent");
    assert.deepEqual(prompted, [], "no prompt is sent");

    await fixture.pushSession({ archived: false, updatedAt: 2 });
    const restart = fixture.container.querySelector(
      'button[aria-label="Restart Session"]',
    ) as HTMLButtonElement | null;
    assert.ok(restart, "a stopped session that is not archived keeps Restart Session");
    assert.equal(restart.disabled, false);
    await act(async () => { restart.click(); });
    await flushAsyncWork();
    assert.deepEqual(restarted, [fixture.sessionId], "the unarchived session restarts");
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
      assert.equal(fixture.container.querySelector(".composer-btn.primary")?.getAttribute("title"), "Send",
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
    assert.equal(fixture.container.querySelector(".composer-btn.primary")?.getAttribute("title"), "Send (Enter)",
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
      assert.equal(storedFixture.container.querySelector(".composer-btn.primary")?.getAttribute("title"), "Send (Shift+Enter)",
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
    assert.equal(remounted.ownerDocument.activeElement, remounted,
      "the replacement textarea must own focus while its persisted draft is still loading");
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

test("an immediate phone remount reveals the idle textarea before restoring its focus", async () => {
  const priorMatchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  const textareaPrototype = domWindow.HTMLTextAreaElement.prototype;
  const originalFocus = textareaPrototype.focus;
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveComposerDraft(draft, { text: "phone remount draft", images: [], updatedAt: 1 });
    await act(async () => {
      fixture.composer.focus();
      fixture.composer.setSelectionRange(2, 8, "backward");
      fireDomEvent.select(fixture.composer);
    });
    textareaPrototype.focus = function() {
      if (this.closest(".composer-box.idle-collapsed")) return;
      originalFocus.call(this);
    };

    const persisted = deferred<ComposerDraft | null>();
    const remounted = await fixture.remountWithDraftLoader(() => persisted.promise);
    assert.equal(fixture.container.querySelector(".composer-box")?.classList.contains("idle-collapsed"), false,
      "the remount must commit its expanded state before attempting to restore the hidden textarea");
    assert.equal(remounted.ownerDocument.activeElement, remounted,
      "the revealed phone textarea must own focus while its persisted draft is still loading");
    await resolveComposerDraft(persisted, { text: "phone remount draft", images: [], updatedAt: 2 });
    await flushAsyncWork();

    assert.equal(remounted.ownerDocument.activeElement, remounted);
    assert.deepEqual(
      [remounted.selectionStart, remounted.selectionEnd, remounted.selectionDirection],
      [2, 8, "backward"],
    );
  } finally {
    textareaPrototype.focus = originalFocus;
    domWindow.matchMedia = priorMatchMedia;
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

test("inserting a side-chat response exits Answer Mode and reveals the ordinary draft", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const child = session("side-chat-answer-mode-child");
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
    await resolveDraft(draft, "");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-side-chat-insert",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    await act(async () => { flushFrames(); });
    assert.ok(fixture.container.querySelector(".composer-answer-input"));

    const insert = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Insert Latest Response into Primary Draft") as HTMLButtonElement;
    assert.ok(insert);
    await act(async () => {
      insert.focus();
      insert.click();
    });
    await act(async () => { flushFrames(); });

    assertNoDomNode(fixture.container.querySelector(".composer-answer-input"));
    const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.equal(ordinary?.value, "side-chat answer");
    assert.equal(ordinary?.ownerDocument.activeElement, ordinary);
    assert.match(fixture.container.querySelector(".composer-question-waiting")?.textContent ?? "", /Question Waiting/);
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("an ordinary-composer handoff does not arm focus theft for a later question", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    mainEventPayloads: [{ kind: "user_message", text: "original prompt", images: [] }],
  });
  try {
    await resolveDraft(draft, "existing draft");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const edit = fixture.container.querySelector(
      'button[aria-label="Edit as a New Turn"]',
    ) as HTMLButtonElement | null;
    assert.ok(edit);
    await act(async () => { edit.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const replaceDraft = dialogButton("Replace Draft", "Replace Draft");
    assert.ok(replaceDraft);
    await act(async () => {
      replaceDraft.focus();
      replaceDraft.click();
    });
    await act(async () => {
      flushFrames();
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushFrames();
    });
    const reader = fixture.container.querySelector<HTMLElement>(".detail-scroll");
    assert.ok(reader);
    await act(async () => {
      reader.dispatchEvent(new domWindow.PointerEvent("pointerdown", { bubbles: true }) as never);
      reader.focus();
    });

    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-after-side-chat-insert",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    await act(async () => { flushFrames(); });

    assert.ok(reader.ownerDocument.activeElement === reader,
      "a completed ordinary handoff must not remain armed and steal deliberately transferred reader focus");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

/** The footer button labelled `label` in the open dialog titled `title`. */
function dialogButton(title: string, label: string): HTMLButtonElement | undefined {
  const dialog = [...domWindow.document.querySelectorAll('[role="dialog"]')]
    .find((candidate) => candidate.querySelector(".modal-title")?.textContent === title);
  return [...dialog?.querySelectorAll(".modal-foot button") ?? []]
    .find((button) => button.textContent === label) as HTMLButtonElement | undefined;
}

function editingCopyNotice(fixture: Fixture): Element | null {
  return fixture.container.querySelector('.session-notice-slot[data-notice-key="editing-copy"] .notice');
}

const EDITABLE_TURN: SessionEvent["payload"][] = [
  { kind: "user_message", text: "original prompt", images: [submittedImage] },
  { kind: "agent_message", text: "done", final: true },
  { kind: "conversation_checkpoint", turn: 3 },
];

test("Edit as a New Turn loads an empty composer without a dialog, names the turn, and sending the copy ends the edit (#2185)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const prompts: Array<{ text: string; images: unknown[] }> = [];
  const fixture = await mountFixture(draft, {
    mainEventPayloads: EDITABLE_TURN,
    client: {
      prompt: async (_sessionId, text, images) => {
        prompts.push({ text, images: images ?? [] });
        return undefined as never;
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const edit = fixture.container.querySelector('button[aria-label="Edit as a New Turn"]') as HTMLButtonElement | null;
    assert.ok(edit);
    await act(async () => {
      edit.focus();
      edit.click();
    });
    await act(async () => {
      flushFrames();
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushFrames();
    });

    assertNoDomNode(domWindow.document.querySelector('[role="dialog"]'), "an empty composer needs no confirmation");
    assert.equal(fixture.composer.value, "original prompt");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1, "the message's attachments come with it");
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer, "the composer has focus");
    assert.deepEqual(
      [fixture.composer.selectionStart, fixture.composer.selectionEnd],
      [fixture.composer.value.length, fixture.composer.value.length],
    );
    const notice = editingCopyNotice(fixture);
    assert.ok(notice, "the notice slot says a copy is being edited");
    assert.ok(notice.classList.contains("compact") && notice.classList.contains("t-info"));
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Editing a copy of your Turn 3 message. Earlier turns stay as they are.");
    assert.ok([...notice.querySelectorAll("button")].some((button) => button.textContent === "Discard Edit"));

    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();
    assert.deepEqual(prompts, [{ text: "original prompt", images: [submittedImage] }]);
    assertNoDomNode(editingCopyNotice(fixture), "sending the copy removes the notice");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Edit as a New Turn over a draft asks Replace Draft first, and Discard Edit restores the draft exactly (#2185)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, { mainEventPayloads: EDITABLE_TURN });
  try {
    await resolveComposerDraft(draft, { text: "my own draft\nwith two lines", images: [{ mimeType: "image/png", data: "bWluZQ==" }], updatedAt: 1 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const thumbs = () => [...fixture.container.querySelectorAll(".image-thumb")].map((thumb) => thumb.outerHTML);
    const draftThumbs = thumbs();
    assert.equal(draftThumbs.length, 1);

    const edit = fixture.container.querySelector('button[aria-label="Edit as a New Turn"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = domWindow.document.querySelector('[role="dialog"]');
    assert.equal(dialog?.querySelector(".modal-title")?.textContent, "Replace Draft");
    assert.equal(dialog?.querySelector(".confirmation-message")?.textContent,
      "Your current draft is replaced by this message. You can restore it with Discard Edit.");
    assert.equal(fixture.composer.value, "my own draft\nwith two lines", "nothing changes before confirming");

    const cancel = dialogButton("Replace Draft", "Cancel");
    assert.ok(cancel);
    await act(async () => { cancel.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(fixture.composer.value, "my own draft\nwith two lines", "Cancel keeps the draft");
    assertNoDomNode(editingCopyNotice(fixture));

    await act(async () => { edit.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { dialogButton("Replace Draft", "Replace Draft")?.click(); });
    await act(async () => {
      flushFrames();
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushFrames();
    });
    assert.equal(fixture.composer.value, "original prompt");
    assert.notDeepEqual(thumbs(), draftThumbs, "the copy's attachment replaces the draft's");
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);

    // Editing the copy, then a second Edit, still leaves the person's own draft to come back to.
    await act(async () => {
      fixture.composer.value = "original prompt, revised";
      fireDomEvent.change(fixture.composer);
    });
    await act(async () => { edit.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { dialogButton("Replace Draft", "Replace Draft")?.click(); });
    await act(async () => { flushFrames(); });
    assert.equal(fixture.composer.value, "original prompt");

    const discard = [...editingCopyNotice(fixture)?.querySelectorAll("button") ?? []]
      .find((button) => button.textContent === "Discard Edit") as HTMLButtonElement | undefined;
    assert.ok(discard);
    await act(async () => { discard.click(); });
    await act(async () => { flushFrames(); });
    assert.equal(fixture.composer.value, "my own draft\nwith two lines", "Discard Edit restores the draft's text");
    assert.deepEqual(thumbs(), draftThumbs, "and its attachments");
    assertNoDomNode(editingCopyNotice(fixture));
    assert.equal(fixture.composer.ownerDocument.activeElement, fixture.composer);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Discard Edit over an empty composer clears it, and Send stays disabled without a validation message (#2185)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, { mainEventPayloads: EDITABLE_TURN });
  try {
    await resolveDraft(draft, "");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const edit = fixture.container.querySelector('button[aria-label="Edit as a New Turn"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    await act(async () => { flushFrames(); });
    assert.equal(fixture.composer.value, "original prompt");
    const discard = [...editingCopyNotice(fixture)?.querySelectorAll("button") ?? []]
      .find((button) => button.textContent === "Discard Edit") as HTMLButtonElement | undefined;
    await act(async () => { discard?.click(); });
    await act(async () => { flushFrames(); });
    assert.equal(fixture.composer.value, "");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 0);
    assert.equal(sendButton(fixture).disabled, true, "an empty composer cannot send");
    assertNoDomNode(fixture.container.querySelector('.session-notice-slot [role="alert"]'), "and says nothing more about it");
    assertNoDomNode(fixture.container.querySelector(".form-error"));
  } finally {
    await unmountFixture(fixture);
  }
});

async function clickEdit(fixture: Fixture) {
  const edit = fixture.container.querySelector('button[aria-label="Edit as a New Turn"]') as HTMLButtonElement | null;
  assert.ok(edit, "Edit as a New Turn is offered");
  await act(async () => { edit.click(); });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushFrames();
  });
}

async function replaceDraft() {
  const confirm = dialogButton("Replace Draft", "Replace Draft");
  assert.ok(confirm, "Replace Draft asks first");
  await act(async () => { confirm.click(); });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushFrames();
  });
}

function discardEditButton(fixture: Fixture): HTMLButtonElement | undefined {
  return [...editingCopyNotice(fixture)?.querySelectorAll("button") ?? []]
    .find((button) => button.textContent === "Discard Edit") as HTMLButtonElement | undefined;
}

test("a reload keeps Discard Edit and the draft it puts back (#2185)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const ownImage = { mimeType: "image/png", data: "bWluZQ==" } as const;
  const fixture = await mountFixture(draft, { mainEventPayloads: EDITABLE_TURN });
  try {
    await resolveComposerDraft(draft, { text: "my own draft", images: [ownImage], updatedAt: 1 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    await clickEdit(fixture);
    await replaceDraft();
    assert.equal(fixture.composer.value, "original prompt");

    // The copy was saved as the draft; the page's memory goes, as on a reload.
    const reloaded = await fixture.fullReloadWithDraftLoader(async () => ({
      text: "original prompt", images: [submittedImage], updatedAt: 2,
    }));
    await flushAsyncWork();
    assert.equal(reloaded.value, "original prompt");
    assert.equal(editingCopyNotice(fixture)?.querySelector(".notice-body")?.textContent,
      "Editing a copy of your Turn 3 message. Earlier turns stay as they are.");
    const discard = discardEditButton(fixture);
    assert.ok(discard, "Discard Edit survives the reload");
    await act(async () => { discard.click(); });
    await act(async () => { flushFrames(); });
    const composer = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input")!;
    assert.equal(composer.value, "my own draft");
    assert.equal(fixture.container.querySelectorAll(".image-thumb").length, 1);
    assertNoDomNode(editingCopyNotice(fixture));
  } finally {
    await unmountFixture(fixture);
  }
});

test("while a queued message is edited, Discard Edit waits and cannot overwrite it (#2185)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    mainEventPayloads: EDITABLE_TURN,
    sessionPatch: {
      queued: [{ id: "queue-1", text: "queued projection", liveQueueObserved: true, editable: true, editRevision: "qer_1" }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: { promptId, text: "Queued exact content", images: [], editRevision: "qer_1" },
      }),
    },
  });
  try {
    await resolveDraft(draft, "");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    await clickEdit(fixture);
    assert.equal(fixture.composer.value, "original prompt");
    assert.ok(discardEditButton(fixture));

    const editQueued = fixture.container.querySelector('button[aria-label="Edit Queued Message"]') as HTMLButtonElement;
    assert.ok(editQueued);
    await act(async () => { editQueued.click(); });
    await flushAsyncWork();
    await act(async () => { flushFrames(); });
    assert.equal(fixture.composer.value, "Queued exact content");
    assertNoDomNode(editingCopyNotice(fixture), "the queued edit owns the composer, so Discard Edit is not offered");

    const cancel = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel Edit") as HTMLButtonElement | undefined;
    assert.ok(cancel);
    await act(async () => { cancel.click(); });
    await flushAsyncWork();
    await act(async () => { flushFrames(); });
    assert.equal(fixture.composer.value, "original prompt", "the copy comes back as the displaced draft");
    assert.ok(discardEditButton(fixture), "and so does its Discard Edit");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a send still in flight does not end an edit made after it, and a failed send gives the edit back (#2185)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const sends: Array<Deferred<void>> = [];
  const fixture = await mountFixture(draft, {
    mainEventPayloads: EDITABLE_TURN,
    client: {
      prompt: async () => {
        const pending = deferred<void>();
        sends.push(pending);
        await pending.promise;
        return undefined as never;
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    await clickEdit(fixture);
    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();
    assert.equal(sends.length, 1);
    assert.ok(discardEditButton(fixture), "the edit holds until the send is accepted");

    // The send fails: the copy is still in the composer, so its edit comes back.
    await act(async () => { sends[0]!.reject(new Error("transport rejected")); });
    await flushAsyncWork();
    assert.equal(fixture.composer.value, "original prompt");
    // The failure is the more severe notice; the edit waits behind it in "+1 More".
    const slot = fixture.container.querySelector(".session-notice-slot");
    assert.match(slot?.textContent ?? "", /Message Not Sent/);
    assert.ok([...slot?.querySelectorAll("button") ?? []].some((button) => button.textContent === "+1 More"));
    const dismiss = slot?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    assert.ok(dismiss);
    await act(async () => { dismiss.click(); });
    assert.ok(discardEditButton(fixture), "a send that did not land gives the edit back");

    // Sent again, and while it is in flight the person writes a new draft and edits over it.
    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();
    assert.equal(sends.length, 2);
    await act(async () => {
      fixture.composer.value = "a newer draft";
      fireDomEvent.change(fixture.composer);
    });
    await clickEdit(fixture);
    await replaceDraft();
    assert.equal(fixture.composer.value, "original prompt");
    assert.ok(discardEditButton(fixture));

    await act(async () => { sends[1]!.resolve(); });
    await flushAsyncWork();
    const discard = discardEditButton(fixture);
    assert.ok(discard, "the earlier send landing does not end the newer edit");
    await act(async () => { discard.click(); });
    await act(async () => { flushFrames(); });
    assert.equal(fixture.composer.value, "a newer draft", "Discard Edit puts back the draft written during the send");
  } finally {
    await unmountFixture(fixture);
  }
});

for (const outcome of ["fails", "lands"] as const) {
  test(`a send that ${outcome} after the view remounts settles the edit it sent (#2185)`, async () => {
    const draft = deferred<ComposerDraft | null>();
    const sends: Array<Deferred<void>> = [];
    const fixture = await mountFixture(draft, {
      mainEventPayloads: EDITABLE_TURN,
      client: {
        prompt: async () => {
          const pending = deferred<void>();
          sends.push(pending);
          await pending.promise;
          return undefined as never;
        },
      },
    });
    try {
      await resolveDraft(draft, "my own draft");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
      await clickEdit(fixture);
      await replaceDraft();
      await act(async () => { sendButton(fixture).click(); });
      await flushAsyncWork();
      assert.equal(sends.length, 1);

      await fixture.remountWithDraftLoader(async () => ({ text: "original prompt", images: [submittedImage], updatedAt: 2 }));
      await flushAsyncWork();
      if (outcome === "fails") {
        await act(async () => { sends[0]!.reject(new Error("transport rejected")); });
        await flushAsyncWork();
        await act(async () => { flushFrames(); });
        assert.ok(loadComposerEditCopy(fixture.sessionId, fixture.instanceScope), "the edit stays stored");
        const dismiss = fixture.container.querySelector<HTMLButtonElement>('.session-notice-slot button[aria-label="Dismiss"]');
        if (dismiss) await act(async () => { dismiss.click(); });
        const discard = discardEditButton(fixture);
        assert.ok(discard, "the remounted view still offers Discard Edit");
        await act(async () => { discard.click(); });
        await act(async () => { flushFrames(); });
        assert.equal(fixture.container.querySelector<HTMLTextAreaElement>(".composer-input")?.value, "my own draft");
      } else {
        await act(async () => { sends[0]!.resolve(); });
        await flushAsyncWork();
        assert.equal(loadComposerEditCopy(fixture.sessionId, fixture.instanceScope), null, "the accepted send ends the edit");
        assertNoDomNode(editingCopyNotice(fixture), "and the remounted view follows");
      }
    } finally {
      await unmountFixture(fixture);
    }
  });
}

test("an older send landing after a remount keeps a newer copy loaded in the new view (#2185)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const sends: Array<Deferred<void>> = [];
  const fixture = await mountFixture(draft, {
    mainEventPayloads: EDITABLE_TURN,
    client: {
      prompt: async () => {
        const pending = deferred<void>();
        sends.push(pending);
        await pending.promise;
        return undefined as never;
      },
    },
  });
  try {
    await resolveDraft(draft, "my own draft");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    await clickEdit(fixture);
    await replaceDraft();
    await act(async () => { sendButton(fixture).click(); });
    await flushAsyncWork();
    assert.equal(sends.length, 1);

    // The view remounts while the copy is in flight; there the person writes a new draft and edits
    // over it.
    const composer = await fixture.remountWithDraftLoader(async () => ({ text: "original prompt", images: [submittedImage], updatedAt: 2 }));
    await flushAsyncWork();
    await act(async () => {
      composer.value = "written in the new view";
      fireDomEvent.change(composer);
    });
    await clickEdit(fixture);
    await replaceDraft();
    const newer = loadComposerEditCopy(fixture.sessionId, fixture.instanceScope);
    assert.equal(newer?.previous?.text, "written in the new view");

    await act(async () => { sends[0]!.resolve(); });
    await flushAsyncWork();
    assert.deepEqual(loadComposerEditCopy(fixture.sessionId, fixture.instanceScope), newer,
      "the older send landing leaves the newer copy stored");
    const discard = discardEditButton(fixture);
    assert.ok(discard, "and its Discard Edit");
    await act(async () => { discard.click(); });
    await act(async () => { flushFrames(); });
    assert.equal(fixture.container.querySelector<HTMLTextAreaElement>(".composer-input")?.value, "written in the new view");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Use as New Message for a recovered queued edit ends the copy it displaced (#2185)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 106,
    mainEventPayloads: EDITABLE_TURN,
    sessionPatch: {
      queued: [{ id: "queue-1", text: "Changed on another client", liveQueueObserved: true, editable: true, editRevision: "qer_newer" }],
    },
  });
  const recoveryScope = {
    instanceScope: fixture.instanceScope,
    accountKey: queuedEditRecoveryAccountKey("org-1", "user-1"),
    sessionId: fixture.sessionId,
  };
  try {
    await resolveDraft(draft, "original prompt");
    // A loaded copy was the ordinary draft when a queued edit displaced it, and that edit failed.
    saveComposerEditCopy(fixture.sessionId, {
      id: "copy-1", turn: 3, previous: { text: "my own draft", images: [] },
    }, fixture.instanceScope);
    assert.equal(saveDurableQueuedEditRecovery(recoveryScope, {
      edit: {
        promptId: "queue-1",
        text: "Original queued content",
        images: [],
        editRevision: "qer_exact",
        displacedDraft: { text: "original prompt", images: [] },
      },
      draft: { text: "Recovered queued content", images: [] },
      error: "Queued message edit was not confirmed.",
    }), true);
    await fixture.fullReloadWithDraftLoader(loadComposerDraft);
    await flushAsyncWork();
    assertNoDomNode(editingCopyNotice(fixture), "the recovered queued edit owns the composer");

    const reuse = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use as New Message") as HTMLButtonElement | undefined;
    assert.ok(reuse);
    await act(async () => { reuse.click(); });
    await flushAsyncWork(450);
    assertNoDomNode(fixture.container.querySelector(".queued-edit-banner"));
    assert.equal(fixture.container.querySelector<HTMLTextAreaElement>(".composer-input")?.value, "Recovered queued content");
    assertNoDomNode(editingCopyNotice(fixture), "no Editing a Copy notice for a message that is not the copy");
    assert.equal(loadComposerEditCopy(fixture.sessionId, fixture.instanceScope), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Edit as a New Turn exits Answer Mode and reveals the copied message", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    mainEventPayloads: [{ kind: "user_message", text: "original prompt", images: [] }],
  });
  try {
    await resolveDraft(draft, "");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-resend",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    await act(async () => { flushFrames(); });
    assert.ok(fixture.container.querySelector(".composer-answer-input"));

    const edit = fixture.container.querySelector(
      'button[aria-label="Edit as a New Turn"]',
    ) as HTMLButtonElement | null;
    assert.ok(edit);
    await act(async () => {
      edit.focus();
      edit.click();
    });
    await flushAsyncWork();
    await act(async () => { flushFrames(); });

    assertNoDomNode(fixture.container.querySelector(".composer-answer-input"));
    const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.equal(ordinary?.value, "original prompt");
    assert.equal(ordinary?.ownerDocument.activeElement, ordinary);
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("a pending Composer Response preserves an ordinary draft and R enters and exits Answer Mode", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "ordinary message draft");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushFrames();
    });
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-r",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{
          id: "target",
          question: "Choose a target",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    await act(async () => { flushFrames(); });

    const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.ok(ordinary);
    assert.equal(ordinary.value, "ordinary message draft");
    assert.match(fixture.container.querySelector(".composer-question-waiting")?.textContent ?? "", /Question Waiting/);
    assertNoDomNode(fixture.container.querySelector(".composer-answer-input"));

    const reader = fixture.container.querySelector<HTMLElement>(".detail-scroll");
    assert.ok(reader);
    reader.focus();
    await act(async () => {
      reader.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "r", bubbles: true }) as never);
      flushFrames();
    });
    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(answer);
    assert.equal(answer.ownerDocument.activeElement, answer);
    assert.match(fixture.container.querySelector(".composer-answer")?.textContent ?? "", /Answering Question 1 of 1/);
    assertNoDomNode(fixture.container.querySelector(".composer-input"));

    await act(async () => {
      answer.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
      flushFrames();
    });
    const restored = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.ok(restored);
    assert.equal(restored.value, "ordinary message draft");
    assert.equal(restored.ownerDocument.activeElement, restored);
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("an empty pending question payload never blanks the ordinary composer", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-empty",
        title: "Question details are loading",
        options: [],
        kind: "question",
        questions: [],
      },
    });
    await act(async () => { flushFrames(); });

    assert.ok(fixture.container.querySelector(".composer-input"),
      "an unanswerable approval keeps ordinary message composition available");
    assertNoDomNode(fixture.container.querySelector(".composer-answer-input"));
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("Composer Response recovers an omitted approval schema from the matching timeline question", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await fixture.pushEvent({
      kind: "question_request",
      requestId: "ask-timeline-schema",
      questions: [{
        id: "target",
        question: "Choose a target",
        options: [{ label: "Staging" }, { label: "Production" }],
      }],
    });
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-timeline-schema",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [],
      },
    });
    await act(async () => { flushFrames(); });

    assert.match(fixture.container.querySelector(".composer-answer")?.textContent ?? "", /Choose a target/);
    assert.ok(fixture.container.querySelector(".composer-answer-input"));
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("automatic Answer Mode transfers existing composer focus into the answer field", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await act(async () => { fixture.composer.focus(); });
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-focused-arrival",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{
          id: "target",
          question: "Choose a target",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    await act(async () => { flushFrames(); });

    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(answer);
    assert.equal(answer.ownerDocument.activeElement, answer,
      "unmounting the focused ordinary composer must not leave document.body owning keystrokes");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("StrictMode retains deferred automatic Answer Mode entry", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    strictMode: true,
    sessionPatch: {
      pendingApproval: {
        requestId: "ask-strict-arrival",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    await act(async () => { flushFrames(); });
    assert.ok(fixture.container.querySelector(".composer-answer-input"),
      "StrictMode's effect cleanup cannot consume the only arrival decision");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("R focuses the answer field when automatic Answer Mode is already active", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-active-r",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{
          id: "target",
          question: "Choose a target",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    await act(async () => { flushFrames(); });

    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    const reader = fixture.container.querySelector<HTMLElement>(".detail-scroll");
    assert.ok(answer);
    assert.ok(reader);
    await act(async () => { reader.focus(); });
    assert.notEqual(answer.ownerDocument.activeElement, answer);

    await act(async () => {
      reader.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "r", bubbles: true }) as never);
      flushFrames();
    });
    assert.equal(answer.ownerDocument.activeElement, answer,
      "R must disarm bare reading shortcuts even when Answer Mode does not need a state transition");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("R focuses a read-only answer field for an unsupported question", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-unsupported-r",
        title: "Legacy question",
        options: [],
        kind: "question",
        questions: [{
          id: "legacy",
          question: "Legacy question without a response schema",
          options: [],
        }],
      },
    });
    await act(async () => { flushFrames(); });

    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    const reader = fixture.container.querySelector<HTMLElement>(".detail-scroll");
    assert.ok(answer);
    assert.ok(reader);
    assert.equal(answer.readOnly, true);
    assert.equal(answer.getAttribute("aria-disabled"), "true");
    await act(async () => { reader.focus(); });

    await act(async () => {
      reader.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "r", bubbles: true }) as never);
      flushFrames();
    });
    assert.equal(answer.ownerDocument.activeElement, answer,
      "the defensive unsupported state must own the keyboard instead of leaking bare shortcuts");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("external question resolution returns Answer Mode focus to ordinary composition", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await act(async () => { fixture.composer.focus(); });
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-external-resolution",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    await act(async () => { flushFrames(); });
    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(answer);
    await act(async () => { answer.focus(); });

    await fixture.pushSession({ pendingApproval: null });
    await act(async () => { flushFrames(); });
    const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.ok(ordinary);
    assert.equal(ordinary.ownerDocument.activeElement, ordinary,
      "external resolution must not leave Session Reading shortcuts armed on document.body");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("external question resolution returns focus from every Answer Mode control", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    const focusSelectors = [".composer-answer-choice", ".composer-answer-heading button"];
    for (const [index, selector] of focusSelectors.entries()) {
      await fixture.pushSession({
        pendingApproval: {
          requestId: `ask-external-control-${index}`,
          title: "Choose a target",
          options: [],
          kind: "question",
          questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
        },
      });
      await act(async () => { flushFrames(); });
      const control = fixture.container.querySelector<HTMLElement>(selector);
      assert.ok(control);
      await act(async () => { control.focus(); });

      await fixture.pushSession({ pendingApproval: null });
      await act(async () => { flushFrames(); });
      const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
      assert.ok(ordinary);
      assert.equal(ordinary.ownerDocument.activeElement, ordinary,
        `${selector} focus must return to ordinary composition when the request resolves`);
    }
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("external question resolution does not steal focus moved outside Answer Mode", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-external-unowned",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    await act(async () => { flushFrames(); });
    const reader = fixture.container.querySelector<HTMLElement>(".detail-scroll");
    assert.ok(reader);
    await act(async () => { reader.focus(); });

    await fixture.pushSession({ pendingApproval: null });
    await act(async () => { flushFrames(); });
    assert.equal(reader.ownerDocument.activeElement, reader);
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("a delayed answer completion cannot arm focus theft after external resolution", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const answerResult = deferred<SessionView>();
  const fixture = await mountFixture(draft, {
    client: {
      answerQuestion: async () => answerResult.promise,
    },
  });
  try {
    await resolveDraft(draft, "");
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-delayed-completion",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    await act(async () => { flushFrames(); });
    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(answer);
    await act(async () => {
      answer.value = "1";
      fireDomEvent.change(answer);
      answer.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
    });

    await fixture.pushSession({ pendingApproval: null });
    await act(async () => { flushFrames(); });
    const reader = fixture.container.querySelector<HTMLElement>(".detail-scroll");
    assert.ok(reader);
    await act(async () => {
      reader.dispatchEvent(new domWindow.PointerEvent("pointerdown", { bubbles: true }) as never);
      reader.focus();
      answerResult.resolve(session(fixture.sessionId));
      await answerResult.promise;
      await Promise.resolve();
      flushFrames();
    });

    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-after-delayed-completion",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Production" }] }],
      },
    });
    await act(async () => { flushFrames(); });

    assert.ok(reader.ownerDocument.activeElement === reader,
      "a stale answer completion must not leave a focus request for the next question");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("a superseded explicit entry cannot focus a later question", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await resolveDraft(draft, "");
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-superseded-entry",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    await act(async () => { flushFrames(); });
    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(answer);
    await act(async () => {
      answer.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
      flushFrames();
    });
    const reader = fixture.container.querySelector<HTMLElement>(".detail-scroll");
    assert.ok(reader);
    await act(async () => {
      reader.dispatchEvent(new domWindow.PointerEvent("pointerdown", { bubbles: true }) as never);
      reader.focus();
      reader.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "r", bubbles: true }) as never);
      fixture.pushSessionSync({ pendingApproval: null });
    });

    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-after-superseded-entry",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Production" }] }],
      },
    });
    await act(async () => { flushFrames(); });

    const laterAnswer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(laterAnswer, "the later empty-draft question still enters Answer Mode");
    assert.ok(reader.ownerDocument.activeElement === reader,
      "a focus request for a superseded question must not target a later question");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("explicit Answer Mode entry wins over delayed ordinary-draft hydration", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft);
  try {
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-explicit-before-hydration",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    const reader = fixture.container.querySelector<HTMLElement>(".detail-scroll");
    assert.ok(reader);
    await act(async () => {
      reader.focus();
      reader.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "r", bubbles: true }) as never);
    });
    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(answer);
    assert.equal(answer.ownerDocument.activeElement, answer);

    await resolveDraft(draft, "persisted ordinary draft");
    await act(async () => { flushFrames(); });

    const retainedAnswer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(retainedAnswer, "hydration cannot override explicit Answer Mode entry");
    assert.equal(retainedAnswer.ownerDocument.activeElement, retainedAnswer);
    await act(async () => {
      retainedAnswer.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
      flushFrames();
    });
    const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.equal(ordinary?.value, "persisted ordinary draft");
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("editing a queued message exits Answer Mode before loading the editor", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionPatch: {
      queued: [{
        id: "queue-answer-mode",
        text: "Queued projection",
        liveQueueObserved: true,
        editable: true,
        editRevision: "qer_answer_mode",
      }],
    },
    client: {
      readQueuedPrompt: async (_sessionId, promptId) => ({
        prompt: { promptId, text: "Exact queued content", images: [], editRevision: "qer_answer_mode" },
      }),
    },
  });
  try {
    await resolveDraft(draft, "");
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-queue-edit",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      },
    });
    await act(async () => { flushFrames(); });
    assert.ok(fixture.container.querySelector(".composer-answer-input"));

    const edit = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Edit Queued Message"]');
    assert.ok(edit);
    await act(async () => { edit.click(); });
    await flushAsyncWork();

    assertNoDomNode(fixture.container.querySelector(".composer-answer-input"));
    const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.equal(ordinary?.value, "Exact queued content");
    assert.match(fixture.container.querySelector(".queued-edit-banner")?.textContent ?? "", /Editing Queued Message/);
  } finally {
    await unmountFixture(fixture);
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("the /respond app command enters Answer Mode and submits without sending an ordinary prompt", { timeout: 5_000 }, async () => {
  setQuestionResponseStyle("interactive", domWindow as never);
  const draft = deferred<ComposerDraft | null>();
  const answers: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const prompts: unknown[] = [];
  const fixture = await mountFixture(draft, {
    client: {
      answerQuestion: async (sessionId, body) => {
        answers.push(structuredClone(body));
        return session(sessionId);
      },
      prompt: async (...args: unknown[]) => {
        prompts.push(args);
        return session("unexpected-prompt");
      },
    },
  });
  try {
    await resolveDraft(draft, "");
    await fixture.pushSession({
      pendingApproval: {
        requestId: "ask-command",
        title: "Choose a target",
        options: [],
        kind: "question",
        questions: [{
          id: "target",
          question: "Choose a target",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    const ordinary = fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.ok(ordinary);
    await act(async () => {
      ordinary.value = "/respond 2";
      fireDomEvent.change(ordinary);
      ordinary.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
    });
    assert.equal(ordinary.value, "/respond 2", "an unsupported direct answer remains available to edit");
    assert.match(fixture.container.textContent ?? "", /\/respond doesn't take an answer\. Send \/respond on its own to answer in Answer Mode\./);
    assert.equal(prompts.length, 0);
    await act(async () => {
      ordinary.value = "/respond";
      fireDomEvent.change(ordinary);
      ordinary.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
      flushFrames();
    });
    await act(async () => {
      ordinary.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
    });
    const answer = fixture.container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(answer);
    assert.equal(prompts.length, 0);
    await act(async () => {
      answer.value = "2";
      fireDomEvent.change(answer);
      answer.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushFrames();
    });
    assert.deepEqual(answers, [{
      requestId: "ask-command",
      answers: { target: "Production" },
      action: "submit",
    }]);
    assert.equal(prompts.length, 0);
  } finally {
    await unmountFixture(fixture);
  }
});

const PAUSED_LOOK_CAPABILITIES = {
  models: [{ id: "gpt-5.5", displayName: "GPT-5.5", efforts: ["low", "high"] }],
  effortLevels: ["low", "high"],
  permissionModes: ["default", "acceptEdits", "bypassPermissions"],
  slashCommands: [],
  supportsImages: true,
  supportsApprovals: true,
  supportsSteering: true,
} as unknown as SessionView["agentCapabilities"];

class FakeSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult = null;
  onerror = null;
  onend = null;
  start() {}
  stop() {}
  abort() {}
}

for (const [status, reason] of [
  ["failed", "This session failed and can't take new messages."],
  ["stopped", "This session is stopped. Restart it to send a message."],
] as const) {
  test(`a ${status} session's composer reads as paused: controls stay, disabled with the reason (#2154)`, async () => {
    const speech = domWindow as unknown as { SpeechRecognition?: unknown };
    speech.SpeechRecognition = FakeSpeechRecognition;
    const draft = deferred<ComposerDraft | null>();
    const fixture = await mountFixture(draft, {
      sessionCapabilities: PAUSED_LOOK_CAPABILITIES,
      sessionPatch: { status, model: "gpt-5.5", effort: "high", permissionMode: "default" },
    });
    try {
      const box = fixture.composer.closest(".composer-box");
      assert.ok(box?.classList.contains("is-disabled"), "the card takes the disabled fill");
      assert.equal(fixture.composer.disabled, true);
      assert.equal(fixture.composer.placeholder, reason);
      const described = (control: HTMLButtonElement | null | undefined, name: string) => {
        assert.ok(control, `${name} stays rendered`);
        assert.equal(control.disabled, true, `${name} is disabled`);
        const ids = control.getAttribute("aria-describedby")?.split(/\s+/u) ?? [];
        const text = ids.map((id: string) => domWindow.document.getElementById(id)?.textContent ?? "").join(" ");
        assert.ok(text.includes(reason), `${name} says why: ${text}`);
      };
      described(box?.querySelector<HTMLButtonElement>(".permission-mode-menu > .cbar-trigger"), "the permission control");
      described(box?.querySelector<HTMLButtonElement>(".model-settings-menu > .cbar-trigger"), "the model control");
      described(box?.querySelector<HTMLButtonElement>(".voice-btn"), "the mic");
      // + stays openable while paused (#2175), so Guardrails can be read and changed; the rows
      // that would act on the composer refuse with the same reason.
      const plus = box?.querySelector<HTMLButtonElement>(".plus-btn");
      assert.ok(plus);
      assert.equal(plus.disabled, false, "+ opens while the composer is paused");
      await act(async () => fireDomEvent.click(plus));
      const menu = domWindow.document.querySelector('.menu[aria-label="Attach and Settings"]');
      assert.ok(menu, "+ opens its menu on a paused composer");
      const row = (label: string) => ([...menu.querySelectorAll("button.menu-item")] as unknown as HTMLButtonElement[])
        .find((item) => item.querySelector(".menu-text")?.textContent === label);
      const attach = row("Attach Image…");
      assert.equal(attach?.disabled, true, "Attach Image refuses on a paused composer");
      assert.equal(attach?.querySelector(".menu-desc")?.textContent, reason, "Attach Image says why");
      const guardrails = row("Guardrails…");
      assert.equal(guardrails?.disabled, false, "Guardrails… stays available on a paused composer");
    } finally {
      await unmountFixture(fixture);
      delete speech.SpeechRecognition;
    }
  });
}

test("every composer bar control is a ComposerButton that keeps the composer focused on pointerdown (#2174)", async () => {
  const speech = domWindow as unknown as { SpeechRecognition?: unknown };
  speech.SpeechRecognition = FakeSpeechRecognition;
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    runnerProtocolVersion: 99,
    sessionCapabilities: {
      ...PAUSED_LOOK_CAPABILITIES,
      permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
    } as unknown as SessionView["agentCapabilities"],
    sessionPatch: { model: "gpt-5.5", effort: "high", permissionMode: "plan" },
  });
  try {
    await resolveComposerDraft(draft, { text: "", images: [], updatedAt: 1 });
    // A control that declared its own `onPointerDown` instead would either lose the
    // `preventDefault` (a first tap that only blurs the composer, #1797) or not be a ComposerButton.
    const expectComposerButtons = (state: string, expected: string[]) => {
      const bar = fixture.container.querySelector(".composer-bar");
      assert.ok(bar, `${state}: the bar renders`);
      const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button")];
      const nameOf = (button: HTMLButtonElement) => button.getAttribute("aria-label") ?? button.textContent ?? "";
      for (const name of expected) {
        assert.ok(buttons.some((button) => nameOf(button) === name), `${state}: ${name} renders in the bar`);
      }
      for (const button of buttons) {
        assert.ok(button.hasAttribute("data-composer-button"), `${state}: ${nameOf(button)} is a ComposerButton`);
        if (button.disabled) continue;
        const pointerDown = new domWindow.PointerEvent("pointerdown", { bubbles: true, cancelable: true }) as never;
        assert.equal(button.dispatchEvent(pointerDown), false, `${state}: ${nameOf(button)} keeps the composer focused`);
      }
    };

    expectComposerButtons("idle with Plan on", ["Attach and Settings", "Plan", "Hold to Dictate", "Send"]);
    const plan = fixture.container.querySelector<HTMLButtonElement>(".plan-toggle");
    assert.equal(plan?.getAttribute("aria-pressed"), "true", "Plan is a pressed toggle");
    assert.equal(plan?.textContent, "Plan", "Plan has an icon and a word, not a text glyph");
    const chip = fixture.container.querySelector(".model-chip");
    assert.equal(chip?.closest(".cbar-menu")?.nextElementSibling, plan, "Plan follows the model chip, which never moves");

    await fixture.pushSession({ status: "running", activeTurnId: "turn-1" });
    expectComposerButtons("during a turn", ["Stop Turn"]);
    const stop = fixture.container.querySelector<HTMLButtonElement>(".stop-turn-btn");
    assert.ok(stop?.classList.contains("composer-btn") && !stop.classList.contains("primary"),
      "Stop Turn is the neutral recipe, not an accent or a red fill");
  } finally {
    await unmountFixture(fixture);
    delete speech.SpeechRecognition;
  }
});

test("a composer that can send keeps its controls enabled and its card undimmed (#2154)", async () => {
  const draft = deferred<ComposerDraft | null>();
  const fixture = await mountFixture(draft, {
    sessionCapabilities: PAUSED_LOOK_CAPABILITIES,
    sessionPatch: { model: "gpt-5.5", effort: "high", permissionMode: "default" },
  });
  try {
    const box = fixture.composer.closest(".composer-box");
    assert.equal(box?.classList.contains("is-disabled"), false);
    // The fixture runner predates workspace references, so @ is not offered.
    assert.equal(fixture.composer.placeholder, "Message Codex. Type / for commands.");
    assert.equal(fixture.composer.getAttribute("rows"), "1", "the idle composer starts at one line");
    for (const selector of [".permission-mode-menu > .cbar-trigger", ".model-settings-menu > .cbar-trigger"]) {
      const control: HTMLButtonElement | null | undefined = box?.querySelector<HTMLButtonElement>(selector);
      assert.equal(control?.disabled, false, `${selector} is enabled`);
    }
    await fixture.pushSession({ status: "running", activeTurnId: "turn-1" });
    assert.equal(fixture.composer.placeholder, "Add a message. It sends when this turn ends.");
    await fixture.pushSession({
      status: "input_required",
      pendingApproval: { requestId: "approval-1", kind: "permission", title: "Run a Command", options: [] },
    } as Partial<SessionView>);
    assert.equal(fixture.composer.placeholder, "Messages you send now wait until you answer the request above.");
  } finally {
    await unmountFixture(fixture);
  }
});
