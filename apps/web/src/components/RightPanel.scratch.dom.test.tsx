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
  type SourceLocation,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { PANEL_SCRATCH_SESSION_LIMIT, clearPanelScratch } from "../right-panel-scratch.js";
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
  heldListing = false;
  releaseListing = null;
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
/** Set by the case that needs a directory listing still in flight when a source location arrives. */
let heldListing = false;
let releaseListing: (() => void) | null = null;

const client = {
  ...api,
  gitDiff: async () => ({ diff: emptyDiff }),
  reviewFindings: async () => ({
    findings: [],
    summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" },
  }),
  listSessionFiles: async (_id: string, dir: string) => {
    listed.push(dir);
    if (heldListing) await new Promise<void>((resolve) => { releaseListing = resolve; });
    const entries = tree[dir];
    if (!entries) throw new Error(`no such directory: ${dir}`);
    return { path: dir, entries };
  },
  readSessionFile: async (_id: string, path: string) => ({ path, content: "fixture\n", size: 8 }),
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

function PanelHarness({ onState, onSwitchSession, onRename, onLocate }: {
  onState: (state: RightPanelState) => void;
  onSwitchSession?: (switchTo: (id: string) => void) => void;
  onRename?: (rename: (title: string) => void) => void;
  onLocate?: (locate: (location: SourceLocation | undefined) => void) => void;
}) {
  const state = useRightPanelState();
  const [session, setSession] = useState(() => sessionOf("session-1"));
  const [location, setLocation] = useState<SourceLocation | undefined>(undefined);
  onState(state);
  onSwitchSession?.((id: string) => setSession(sessionOf(id)));
  onRename?.((title: string) => setSession((current) => ({ ...current, title })));
  onLocate?.(setLocation);
  return (
    <ApiProvider client={client}><StoreProvider connection={connection}><RightPanel
      state={state}
      session={session}
      runnerOnline
      runnerProtocolVersion={PROTOCOL_VERSION}
      git={git}
      items={[]}
      sourceLocation={location}
      onOpenSourceLocation={setLocation}
      onClearSourceLocation={() => setLocation(undefined)}
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
  locate: (location: SourceLocation | undefined) => Promise<void>;
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
  let locateAt!: (location: SourceLocation | undefined) => void;
  const harness = (
    <PanelHarness
      onState={(next) => { state = next; }}
      onSwitchSession={(next) => { switchTo = next; }}
      onRename={(next) => { renameTo = next; }}
      onLocate={(next) => { locateAt = next; }}
    />
  );
  await act(async () => root.render(options.strict ? <StrictMode>{harness}</StrictMode> : harness));
  return {
    container,
    get state() { return state; },
    async show(mode) { await act(async () => state.show(mode)); },
    async switchSession(id) { await act(async () => switchTo(id)); },
    async rename(title) { await act(async () => renameTo(title)); },
    async locate(location) { await act(async () => locateAt(location)); },
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

test("a draft that happens to read like a later title is not swallowed by the next rename", async () => {
  // Ownership is recorded, not inferred from `value !== fallback`. Inferred, a rename onto the
  // user's own text would mark it untouched and the rename after that would overwrite it.
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await type(commitInput(panel), "Renamed Later");
    await panel.rename("Renamed Later");
    await panel.show("files");
    await panel.show("review");
    assert.equal(commitInput(panel).value, "Renamed Later");

    await panel.rename("Renamed Again");
    await panel.show("files");
    await panel.show("review");
    assert.equal(commitInput(panel).value, "Renamed Later",
      "the title caught up with what the user wrote; that does not make it the app's to replace");
  } finally {
    await panel.dispose();
  }
});

test("a send that resolves behind a live composer leaves the draft in it alone", async () => {
  heldPrompt = true;
  const panel = await mountPanel();
  try {
    await panel.show("sidechat");
    await type(field(panel, "Side Chat Message") as HTMLTextAreaElement, "same message");
    await act(async () => fireDomEvent.click(
      [...panel.container.querySelectorAll<HTMLButtonElement>(".sidechat-composer button")]
        .find((button) => button.textContent === "Send")!,
    ));

    // Back before the send resolves, and the reviewer types the same bytes again. Reading alike is
    // not being the same draft: deleting this one would empty a composer nobody was watching.
    await panel.show("files");
    await panel.show("sidechat");
    await type(field(panel, "Side Chat Message") as HTMLTextAreaElement, "different");
    await type(field(panel, "Side Chat Message") as HTMLTextAreaElement, "same message");
    await act(async () => { releasePrompt?.(); });

    await panel.show("files");
    await panel.show("sidechat");
    assert.equal((field(panel, "Side Chat Message") as HTMLTextAreaElement).value, "same message",
      "the retyped draft belongs to the reviewer, not to the send that went before it");
  } finally {
    releasePrompt?.();
    await panel.dispose();
  }
});

test("a resumed listing superseded by an opened file is still owed its directory", async () => {
  const panel = await mountPanel();
  try {
    await panel.show("files");
    await act(async () => fireDomEvent.click(panel.container.querySelector<HTMLButtonElement>(".files-entry")!));
    assert.equal(crumbs(panel), "root/apps");

    await panel.show("review");
    heldListing = true;
    await panel.show("files");            // launches the resume listing for "apps", held open
    await panel.locate({ path: "README.md" });  // supersedes it before it can land
    await act(async () => { releaseListing?.(); });
    assert.match(panel.container.textContent ?? "", /README\.md/, "the file the route asked for is open");

    heldListing = false;
    listed.length = 0;
    await panel.locate(undefined);
    // Clearing the target drops the open file, which re-runs the effect — so the count is not the
    // assertion; the directory every one of those listings asked for is.
    assert.deepEqual([...new Set(listed)], ["apps"],
      "a listing that never landed did not spend the resume, so clearing the target returns to it");
    assert.equal(crumbs(panel), "root/apps");
  } finally {
    heldListing = false;
    releaseListing?.();
    await panel.dispose();
  }
});

test("merely opening Files in other sessions cannot evict a draft", async () => {
  // Scratch is bounded by scope, so anything that manufactures a scope spends that budget. A body
  // re-reporting the value it already holds — the Files loader announcing the root — must not.
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await type(field(panel, "PR Description")!, "the draft that must outlive the tour");

    await panel.show("files");
    for (let visit = 0; visit <= PANEL_SCRATCH_SESSION_LIMIT; visit += 1) {
      await panel.switchSession(`tour-session-${visit}`);
      assert.equal(crumbs(panel), "root", "each visited session lists its own root and nothing else");
    }

    await panel.switchSession("session-1");
    await panel.show("review");
    assert.equal(field(panel, "PR Description")!.value, "the draft that must outlive the tour",
      "sessions that were only looked at must not push a real draft out of the cache");
  } finally {
    await panel.dispose();
  }
});

test("a tour of sessions that each leave scratch behind still cannot evict a draft", async () => {
  // #1283: the scope bound used to spend the least recently used scope, and the session holding an
  // unsent description is exactly the one that has been idle longest. Every session on this tour
  // stores something real — a browsed directory — so the bound is genuinely reached, and the only
  // scope it must refuse to take is the one holding text nobody else has a copy of.
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await type(field(panel, "PR Description")!, "the description that outlives the bound");
    await type(field(panel, "Branch Name")!, "fix/issue-1283");

    for (let visit = 0; visit <= PANEL_SCRATCH_SESSION_LIMIT; visit += 1) {
      await panel.switchSession(`tour-session-${visit}`);
      await panel.show("files");
      await act(async () => fireDomEvent.click(panel.container.querySelector<HTMLButtonElement>(".files-entry")!));
      assert.equal(crumbs(panel), "root/apps", "each visited session leaves a directory behind");
      await panel.show("review");
    }

    await panel.switchSession("session-1");
    await panel.show("review");
    assert.equal(field(panel, "PR Description")!.value, "the description that outlives the bound");
    assert.equal(field(panel, "Branch Name")!.value, "fix/issue-1283");
  } finally {
    await panel.dispose();
  }
});

test("a session whose draft was left blank is evicted like any other", async () => {
  // The exemption is for text that exists. A description opened and then emptied is not a draft,
  // so it cannot pin a scope for the rest of the tab's life.
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await type(field(panel, "PR Description")!, "typed, then thought better of");
    await type(field(panel, "PR Description")!, "");

    for (let visit = 0; visit <= PANEL_SCRATCH_SESSION_LIMIT; visit += 1) {
      await panel.switchSession(`tour-session-${visit}`);
      await panel.show("files");
      await act(async () => fireDomEvent.click(panel.container.querySelector<HTMLButtonElement>(".files-entry")!));
      await panel.show("review");
    }

    await panel.switchSession("session-1");
    await panel.show("review");
    assert.equal(field(panel, "PR Description")!.value, "", "an emptied field has nothing to lose");
  } finally {
    await panel.dispose();
  }
});
