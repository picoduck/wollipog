import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { StrictMode, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type GitDiffInfo,
  type SessionFileEntry,
  type SessionView,
  type SideChatView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Switching right panel modes destroyed everything the mode body was holding: a mode change and a
 * panel close both unmount it (#1202). These cases drive the real panel through the transitions
 * the issue describes and assert the round trips its acceptance criteria name — the Review drafts
 * and view choices, and the Files directory — plus the boundary that makes the feature safe: one
 * session never shows another session's drafts.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  ResizeObserver: domWindow.ResizeObserver,
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

beforeEach(() => {
  domWindow.localStorage.clear();
  clearPanelScratch();
  listed.length = 0;
  heldPrompt = false;
  releasePrompt = null;
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const connection: UiConnectionRuntime = {
  instanceId: "panel-scratch-test", runtimeKey: "panel-scratch-test",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

function sessionOf(id: string): SessionView {
  return {
    id,
    runnerId: "runner-1",
    title: "Panel Scratch Fixture",
    status: "idle",
    driver: "claude-code",
    useWorktree: true,
    worktreePath: `/repo/.agent-worktrees/${id}`,
    eventEpoch: 0,
    adopted: false,
  } as SessionView;
}

const git: GitStatus = {
  status: null,
  observation: 0,
  observedAt: null,
  settled: false,
  busy: false,
  error: null,
  errorCode: null,
  refresh: async () => {},
  refreshStatusOnly: async () => {},
  install: () => {},
  mutationRevision: 0,
};

const emptyDiff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash: "a".repeat(64),
  stats: { filesChanged: 0, insertions: 0, deletions: 0 },
  files: [],
};

/** A two-level tree, so a directory round trip has somewhere to be wrong about. */
const tree: Record<string, SessionFileEntry[]> = {
  "": [{ name: "apps", path: "apps", isDir: true }],
  apps: [{ name: "web", path: "apps/web", isDir: true }],
  "apps/web": [{ name: "index.ts", path: "apps/web/index.ts", isDir: false, size: 12 }],
};

/** Every directory the panel asked the runner for, in order. */
const listed: string[] = [];

/** Set by the case that needs a side chat send still in flight while the panel unmounts. */
let heldPrompt = false;
let releasePrompt: (() => void) | null = null;

const client = {
  ...api,
  gitDiff: async () => ({ diff: emptyDiff }),
  reviewFindings: async () => ({
    findings: [],
    summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" },
  }),
  listSessionFiles: async (_id: string, dir: string) => {
    listed.push(dir);
    const entries = tree[dir];
    if (!entries) throw new Error(`no such directory: ${dir}`);
    return { path: dir, entries };
  },
  sessionWorkflowArtifacts: async () => ({ artifacts: [] }),
  sideChat: async (parentSessionId: string) => ({
    sideChat: {
      parentSessionId,
      createdAt: 1,
      session: { ...sessionOf(`${parentSessionId}-side`), title: "Side chat" },
    } satisfies SideChatView,
  }),
  getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
  prompt: async (id: string) => {
    if (heldPrompt) await new Promise<void>((resolve) => { releasePrompt = resolve; });
    return sessionOf(id);
  },
  childSessions: async () => { throw new Error("this fixture has no durable child-session registry"); },
} as unknown as ApiClient;

function PanelHarness({ onState, onSwitchSession, onRename }: {
  onState: (state: RightPanelState) => void;
  onSwitchSession?: (switchTo: (id: string) => void) => void;
  onRename?: (rename: (title: string) => void) => void;
}) {
  const state = useRightPanelState();
  const [session, setSession] = useState(() => sessionOf("session-1"));
  onState(state);
  onSwitchSession?.((id: string) => setSession(sessionOf(id)));
  onRename?.((title: string) => setSession((current) => ({ ...current, title })));
  return (
    <ApiProvider client={client}><StoreProvider connection={connection}><RightPanel
      state={state}
      session={session}
      runnerOnline
      runnerProtocolVersion={PROTOCOL_VERSION}
      git={git}
      items={[]}
      onOpenSourceLocation={() => {}}
      onClearSourceLocation={() => {}}
      onOpenTerminal={() => {}}
      onInsertSideChatDraft={() => {}}
    /></StoreProvider></ApiProvider>
  );
}

interface Panel {
  container: HTMLElement;
  state: RightPanelState;
  show: (mode: "review" | "files" | "browser" | "sidechat") => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  rename: (title: string) => Promise<void>;
  dispose: () => Promise<void>;
}

/** `strict` mounts under StrictMode, whose doubled mount effects are their own regression surface. */
async function mountPanel(options: { strict?: boolean } = {}): Promise<Panel> {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLElement;
  const root = createRoot(container as unknown as Element);
  let state!: RightPanelState;
  let switchTo!: (id: string) => void;
  let renameTo!: (title: string) => void;
  const harness = (
    <PanelHarness
      onState={(next) => { state = next; }}
      onSwitchSession={(next) => { switchTo = next; }}
      onRename={(next) => { renameTo = next; }}
    />
  );
  await act(async () => root.render(options.strict ? <StrictMode>{harness}</StrictMode> : harness));
  return {
    container,
    get state() { return state; },
    async show(mode) { await act(async () => state.show(mode)); },
    async switchSession(id) { await act(async () => switchTo(id)); },
    async rename(title) { await act(async () => renameTo(title)); },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const field = (panel: Panel, label: string) =>
  panel.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);

const commitInput = (panel: Panel) =>
  panel.container.querySelector<HTMLInputElement>(".git-action input")!;

const choice = (panel: Panel, group: string, name: string) =>
  [...panel.container.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] [role="radio"]`)]
    .find((button) => button.textContent === name)!;

/** The visible directory, read the way the user reads it: the crumb trail. */
/** The Browser's address bar is labelled by a visually hidden <label>, so it is found by id. */
const addressBar = (panel: Panel) => panel.container.querySelector<HTMLInputElement>("#browser-url")!;

const crumbs = (panel: Panel) =>
  [...panel.container.querySelectorAll(".files-crumbs .files-crumb")].map((crumb) => crumb.textContent).join("/");

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => fireDomEvent.change(element, { target: { value } }));
}

test("Review drafts and view choices survive a mode switch and a panel close", async () => {
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await type(commitInput(panel), "fix: keep the panel's drafts");
    await type(field(panel, "PR Title")!, "Preserve right panel state");
    await type(field(panel, "PR Description")!, "Round-tripping the whole body.");
    await type(field(panel, "Branch Name")!, "fix/issue-1202");
    await act(async () => fireDomEvent.click(choice(panel, "Diff Scope", "Branch")));
    await act(async () => fireDomEvent.click(choice(panel, "Diff Layout", "Side by Side")));

    await panel.show("files");
    assert.equal(field(panel, "PR Description"), null, "the Review body is unmounted, not hidden");

    await panel.show("review");
    assert.equal(commitInput(panel).value, "fix: keep the panel's drafts");
    assert.equal(field(panel, "PR Title")!.value, "Preserve right panel state");
    assert.equal(field(panel, "PR Description")!.value, "Round-tripping the whole body.");
    assert.equal(field(panel, "Branch Name")!.value, "fix/issue-1202");
    assert.equal(choice(panel, "Diff Scope", "Branch").getAttribute("aria-checked"), "true");
    assert.equal(choice(panel, "Diff Layout", "Side by Side").getAttribute("aria-checked"), "true");

    await act(async () => panel.state.close());
    assert.equal(panel.container.querySelector(".right-panel"), null, "a closed panel renders nothing");
    await panel.show("review");
    assert.equal(field(panel, "PR Description")!.value, "Round-tripping the whole body.",
      "closing and reopening the panel is the same unmount");
    assert.equal(choice(panel, "Diff Layout", "Side by Side").getAttribute("aria-checked"), "true");
  } finally {
    await panel.dispose();
  }
});

test("the Files directory survives a mode switch", async () => {
  const panel = await mountPanel();
  try {
    await panel.show("files");
    assert.equal(crumbs(panel), "root");
    await act(async () => fireDomEvent.click(panel.container.querySelector<HTMLButtonElement>(".files-entry")!));
    await act(async () => fireDomEvent.click(panel.container.querySelector<HTMLButtonElement>(".files-entry")!));
    assert.equal(crumbs(panel), "root/apps/web");

    await panel.show("review");
    await panel.show("files");
    assert.equal(crumbs(panel), "root/apps/web", "the browser resumes two directories deep");
    assert.equal(
      panel.container.querySelector(".files-entry .files-name")?.textContent,
      "index.ts",
      "and it listed that directory rather than the root",
    );
  } finally {
    await panel.dispose();
  }
});

test("a remembered directory that no longer exists falls back to the root listing", async () => {
  const panel = await mountPanel();
  try {
    await panel.show("files");
    await act(async () => fireDomEvent.click(panel.container.querySelector<HTMLButtonElement>(".files-entry")!));
    assert.equal(crumbs(panel), "root/apps");
    delete tree.apps;
    try {
      await panel.show("review");
      listed.length = 0;
      await panel.show("files");
      assert.deepEqual(listed, ["apps", ""], "it resumes the remembered directory, then falls back");
      assert.equal(crumbs(panel), "root", "a gone directory cannot strand the browser on an error");
      assert.equal(panel.container.querySelector(".composer-error"), null);
      assert.equal(panel.container.querySelector(".files-entry .files-name")?.textContent, "apps");
    } finally {
      tree.apps = [{ name: "web", path: "apps/web", isDir: true }];
    }
  } finally {
    await panel.dispose();
  }
});

test("state is scoped per session: another session never shows the first one's drafts", async () => {
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await type(field(panel, "PR Description")!, "session one only");
    await panel.show("files");
    await act(async () => fireDomEvent.click(panel.container.querySelector<HTMLButtonElement>(".files-entry")!));
    assert.equal(crumbs(panel), "root/apps");

    await panel.switchSession("session-2");
    assert.equal(crumbs(panel), "root", "the incoming session browses from its own root");
    await panel.show("review");
    assert.equal(field(panel, "PR Description")!.value, "", "and starts with no draft of its own");
    await type(field(panel, "PR Description")!, "session two only");

    await panel.switchSession("session-1");
    assert.equal(field(panel, "PR Description")!.value, "session one only", "returning restores the original");
    await panel.show("files");
    assert.equal(crumbs(panel), "root/apps");
  } finally {
    await panel.dispose();
  }
});

test("the Side Chat draft and the Browser address survive a mode switch", async () => {
  const panel = await mountPanel();
  try {
    await panel.show("sidechat");
    await type(field(panel, "Side Chat Message") as HTMLTextAreaElement, "does this survive?");

    await panel.show("browser");
    await act(async () => fireDomEvent.click(choice(panel, "Browser Content", "Web URL")));
    await type(addressBar(panel), "http://localhost:4174/preview");
    await act(async () => fireDomEvent.submit(panel.container.querySelector(".browser-address")!));
    assert.equal(panel.container.querySelector(".browser-web-frame")?.getAttribute("src"),
      "http://localhost:4174/preview");

    await panel.show("sidechat");
    assert.equal((field(panel, "Side Chat Message") as HTMLTextAreaElement).value, "does this survive?",
      "an unsent side chat message is the reviewer's, not the mode's");

    await panel.show("browser");
    assert.equal(choice(panel, "Browser Content", "Web URL").getAttribute("aria-checked"), "true");
    assert.equal(addressBar(panel).value, "http://localhost:4174/preview");
    assert.equal(panel.container.querySelector(".browser-web-frame")?.getAttribute("src"),
      "http://localhost:4174/preview", "the page it had open is still open");
  } finally {
    await panel.dispose();
  }
});

test("StrictMode's doubled mount effect still resumes the remembered directory", async () => {
  // React invokes a mount effect, its cleanup, and the effect again in development. A resume that
  // is retired by the first pass rather than by a listing is silently lost in every dev build.
  const first = await mountPanel();
  try {
    await first.show("files");
    await act(async () => fireDomEvent.click(first.container.querySelector<HTMLButtonElement>(".files-entry")!));
    assert.equal(crumbs(first), "root/apps");
  } finally {
    await first.dispose();
  }

  const strict = await mountPanel({ strict: true });
  try {
    await strict.show("files");
    assert.equal(crumbs(strict), "root/apps");
  } finally {
    await strict.dispose();
  }
});

test("an untouched Review default follows a renamed session; an edited one does not", async () => {
  const panel = await mountPanel();
  try {
    await panel.show("review");
    assert.equal(commitInput(panel).value, "Panel Scratch Fixture", "the commit message defaults to the title");

    await panel.rename("Renamed While Open");
    await panel.show("files");
    await panel.show("review");
    assert.equal(commitInput(panel).value, "Renamed While Open",
      "a default nobody edited is not a draft, and must not pin the old title");
    assert.equal(field(panel, "PR Title")!.value, "Renamed While Open");

    await type(commitInput(panel), "fix: something the user wrote");
    await panel.rename("Renamed Again");
    await panel.show("files");
    await panel.show("review");
    assert.equal(commitInput(panel).value, "fix: something the user wrote",
      "what the user typed is theirs and survives the rename");
  } finally {
    await panel.dispose();
  }
});

test("a Side Chat send that lands after the panel closes does not restore the sent message", async () => {
  heldPrompt = true;
  const panel = await mountPanel();
  try {
    await panel.show("sidechat");
    const composer = field(panel, "Side Chat Message") as HTMLTextAreaElement;
    await type(composer, "already on its way");
    await act(async () => fireDomEvent.click(
      [...panel.container.querySelectorAll<HTMLButtonElement>(".sidechat-composer button")]
        .find((button) => button.textContent === "Send")!,
    ));

    // The reviewer switches away while the prompt is still in flight, so the panel is unmounted
    // when the send succeeds and never gets to clear its own composer.
    await panel.show("files");
    await act(async () => { releasePrompt?.(); });

    await panel.show("sidechat");
    assert.equal((field(panel, "Side Chat Message") as HTMLTextAreaElement).value, "",
      "a message that was already sent must not come back and invite a second send");
  } finally {
    releasePrompt?.();
    await panel.dispose();
  }
});
