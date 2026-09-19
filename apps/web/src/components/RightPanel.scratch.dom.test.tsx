import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { StrictMode, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type GitDiffInfo,
  type GitPrInfo,
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
import {
  PANEL_SCRATCH_SESSION_LIMIT,
  clearPanelScratch,
  dropPanelScratchMemory,
  panelScratchScopeCount,
} from "../right-panel-scratch.js";
import { RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Switching right panel modes destroyed everything the mode body was holding: a mode change and a
 * panel close both unmount it (#1202). These cases drive the real panel through the transitions
 * the issue describes and assert the round trips its acceptance criteria name — the Review drafts
 * and view choices, and the Files directory — plus the boundary that makes the feature safe: one
 * session never shows another session's drafts.
 *
 * A page reload destroyed them too, until scratch was mirrored into browser storage (#1282). A
 * reload is driven here by unmounting the panel and dropping the module's memory: that is exactly
 * what a browser does to a tab, and it leaves the stored record as the only thing to resume from.
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
  heldGit = false;
  releaseGit = null;
  requestCreated = true;
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
/** Set by the case that needs a submit still in flight while the panel unmounts. */
let heldGit = false;
let releaseGit: (() => void) | null = null;
/** Whether Push & Open really opens a request, or only returns the prefilled-link fallback. */
let requestCreated = true;

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
  git: async (_id: string, request: { action: string; message?: string }) => {
    if (heldGit) await new Promise<void>((resolve) => { releaseGit = resolve; });
    if (request.action === "commit") {
      return { commit: { sha: "abc1234", message: request.message ?? "", filesChanged: 1 } };
    }
    const pr: GitPrInfo = requestCreated
      ? { url: "https://github.com/acme/app/pull/7", branch: "fix/issue-1375", pushed: true,
          createdWithGh: true, created: true, kind: "pull_request" }
      : { url: "https://github.com/acme/app/compare/main...fix/issue-1375?expand=1", branch: "fix/issue-1375",
          pushed: true, createdWithGh: false, created: false, kind: "pull_request" };
    return { pr };
  },
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

/** Everything the browser keeps survives; everything the page held in memory does not. */
async function reload(panel: Panel): Promise<void> {
  await panel.dispose();
  dropPanelScratchMemory();
}

test("every mode resumes where it was left after a page reload", async () => {
  const before = await mountPanel();
  await before.show("review");
  await type(commitInput(before), "fix: keep the panel's drafts");
  await type(field(before, "PR Title")!, "Persist right panel scratch");
  await type(field(before, "PR Description")!, "Written over an hour, not to be spent on a reload.");
  await type(field(before, "Branch Name")!, "fix/issue-1282");
  await act(async () => fireDomEvent.click(choice(before, "Diff Layout", "Side by Side")));

  await before.show("files");
  await act(async () => fireDomEvent.click(before.container.querySelector<HTMLButtonElement>(".files-entry")!));
  assert.equal(crumbs(before), "root/apps");

  await before.show("browser");
  await act(async () => fireDomEvent.click(choice(before, "Browser Content", "Web URL")));
  await type(addressBar(before), "http://localhost:4174/preview");
  await act(async () => fireDomEvent.submit(before.container.querySelector(".browser-address")!));

  await before.show("sidechat");
  await type(field(before, "Side Chat Message") as HTMLTextAreaElement, "unsent when the tab went");

  await reload(before);

  const after = await mountPanel();
  try {
    await after.show("review");
    assert.equal(commitInput(after).value, "fix: keep the panel's drafts");
    assert.equal(field(after, "PR Title")!.value, "Persist right panel scratch");
    assert.equal(field(after, "PR Description")!.value,
      "Written over an hour, not to be spent on a reload.");
    assert.equal(field(after, "Branch Name")!.value, "fix/issue-1282");
    assert.equal(choice(after, "Diff Layout", "Side by Side").getAttribute("aria-checked"), "true",
      "the view choices come back with the drafts they were made beside");

    await after.show("files");
    assert.equal(crumbs(after), "root/apps");

    await after.show("browser");
    assert.equal(choice(after, "Browser Content", "Web URL").getAttribute("aria-checked"), "true");
    assert.equal(addressBar(after).value, "http://localhost:4174/preview");
    assert.equal(after.container.querySelector(".browser-web-frame")?.getAttribute("src"),
      "http://localhost:4174/preview", "the page it had open is open again");

    await after.show("sidechat");
    assert.equal((field(after, "Side Chat Message") as HTMLTextAreaElement).value,
      "unsent when the tab went", "the message nobody else has a copy of is the point of all this");
  } finally {
    await after.dispose();
  }
});

test("a reload restores each session only under itself", async () => {
  const before = await mountPanel();
  await before.show("review");
  await type(field(before, "PR Description")!, "session one only");
  await before.switchSession("session-2");
  await type(field(before, "PR Description")!, "session two only");

  await reload(before);

  const after = await mountPanel();
  try {
    await after.show("review");
    assert.equal(field(after, "PR Description")!.value, "session one only");
    await after.switchSession("session-2");
    assert.equal(field(after, "PR Description")!.value, "session two only");
    await after.switchSession("session-3");
    assert.equal(field(after, "PR Description")!.value, "",
      "a session that was never written to has nothing restored to it");
  } finally {
    await after.dispose();
  }
});

test("a reload with nothing stored is the ordinary first visit", async () => {
  // The panel has to open on a browser that refuses storage, or has none yet, exactly as it did
  // before any of this: with its defaults, not with an error.
  dropPanelScratchMemory();
  domWindow.localStorage.clear();
  const panel = await mountPanel();
  try {
    await panel.show("review");
    assert.equal(commitInput(panel).value, "Panel Scratch Fixture", "the default is the session title");
    assert.equal(field(panel, "PR Description")!.value, "");
    await panel.show("files");
    assert.equal(crumbs(panel), "root");
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

const button = (panel: Panel, name: string) =>
  [...panel.container.querySelectorAll<HTMLButtonElement>(".git-action button")]
    .find((candidate) => candidate.textContent === name)!;

async function writeRequest(panel: Panel): Promise<void> {
  await type(commitInput(panel), "fix: release submitted review drafts");
  await type(field(panel, "PR Title")!, "Release Submitted Review Drafts");
  await type(field(panel, "PR Description")!, "Already on the forge once this is opened.");
  await type(field(panel, "Branch Name")!, "fix/issue-1375");
}

/** Leave a browsed directory behind in the current session: real scratch that eviction can take. */
async function browseIntoApps(panel: Panel): Promise<void> {
  await panel.show("files");
  await act(async () => fireDomEvent.click(panel.container.querySelector<HTMLButtonElement>(".files-entry")!));
  assert.equal(crumbs(panel), "root/apps");
}

test("an opened pull request releases its session: a reload restores none of it and the bound evicts it", async () => {
  // #1375: the four Review fields are drafts, exempt from eviction while they hold text. Left filled
  // after the request was opened, they pinned the session for the life of the tab and — persisted —
  // came back after a reload, inviting the same request to be opened twice.
  const before = await mountPanel();
  await browseIntoApps(before);
  await before.show("review");
  await writeRequest(before);
  await act(async () => fireDomEvent.click(button(before, "Push & Open Pull Request")));

  assert.match(before.container.textContent ?? "", /Pull Request opened/, "the result line stays");
  assert.equal(before.container.querySelector<HTMLAnchorElement>(".git-ok a")?.href,
    "https://github.com/acme/app/pull/7", "and so does its link");
  assert.equal(field(before, "PR Title")!.value, "Panel Scratch Fixture", "the title is back to its default");
  assert.equal(field(before, "PR Description")!.value, "");
  assert.equal(field(before, "Branch Name")!.value, "");
  assert.equal(commitInput(before).value, "fix: release submitted review drafts",
    "the commit message stays on screen for the next commit");

  await reload(before);

  const after = await mountPanel();
  try {
    await after.show("review");
    assert.equal(field(after, "PR Title")!.value, "Panel Scratch Fixture");
    assert.equal(field(after, "PR Description")!.value, "", "submitted text is not restored by a reload");
    assert.equal(field(after, "Branch Name")!.value, "");
    assert.equal(commitInput(after).value, "Panel Scratch Fixture", "nor is the committed message");
    await after.show("files");
    assert.equal(crumbs(after), "root/apps", "what was not submitted still survives the reload");

    // Past the bound. Every session on the tour leaves a directory, so the scope count genuinely
    // exceeds the limit and something has to go — and the completed session is the idle one.
    for (let visit = 0; visit <= PANEL_SCRATCH_SESSION_LIMIT; visit += 1) {
      await after.switchSession(`tour-session-${visit}`);
      await browseIntoApps(after);
    }
    assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT, "nothing is exempt, so the bound holds");

    await after.switchSession("session-1");
    assert.equal(crumbs(after), "root", "the completed session was evictable again, and was evicted");
  } finally {
    await after.dispose();
  }
});

test("a commit releases the message it committed but leaves it on screen", async () => {
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await type(commitInput(panel), "fix: committed once");
    await type(field(panel, "PR Description")!, "not submitted yet");
    await act(async () => fireDomEvent.click(button(panel, "Commit")));

    assert.match(panel.container.textContent ?? "", /Committed abc1234/);
    assert.equal(commitInput(panel).value, "fix: committed once", "a second commit usually reuses it");

    await panel.show("files");
    await panel.show("review");
    assert.equal(commitInput(panel).value, "Panel Scratch Fixture",
      "git holds the message now, so the panel no longer keeps a copy of its own");
    assert.equal(field(panel, "PR Description")!.value, "not submitted yet",
      "a commit submits nothing of the pull request form");
  } finally {
    await panel.dispose();
  }
});

test("a pull request that only got a prefilled link keeps its fields", async () => {
  // The GitHub fallback link carries neither title nor description, so the reviewer still needs both
  // for the page it opens: nothing was submitted anywhere yet.
  requestCreated = false;
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await writeRequest(panel);
    await act(async () => fireDomEvent.click(button(panel, "Push & Open Pull Request")));
    assert.match(panel.container.textContent ?? "", /Branch pushed/);

    await panel.show("files");
    await panel.show("review");
    assert.equal(field(panel, "PR Title")!.value, "Release Submitted Review Drafts");
    assert.equal(field(panel, "PR Description")!.value, "Already on the forge once this is opened.");
    assert.equal(field(panel, "Branch Name")!.value, "fix/issue-1375");
    assert.equal(commitInput(panel).value, "fix: release submitted review drafts");
  } finally {
    await panel.dispose();
  }
});

test("a pull request that opens after the panel remounted empties the remounted form", async () => {
  heldGit = true;
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await writeRequest(panel);
    await act(async () => fireDomEvent.click(button(panel, "Push & Open Pull Request")));

    // The reviewer glances at Files while the push runs and comes back before it lands, so the
    // body showing the fields is not the one that submitted them.
    await panel.show("files");
    await panel.show("review");
    assert.equal(field(panel, "PR Description")!.value, "Already on the forge once this is opened.");
    await act(async () => { releaseGit?.(); });

    assert.equal(field(panel, "PR Title")!.value, "Panel Scratch Fixture");
    assert.equal(field(panel, "PR Description")!.value, "",
      "a request that was already opened must not stay filled in and invite a second one");
    assert.equal(field(panel, "Branch Name")!.value, "");

    await panel.show("files");
    await panel.show("review");
    assert.equal(field(panel, "PR Description")!.value, "", "nor come back on the next mount");
    assert.equal(commitInput(panel).value, "Panel Scratch Fixture");
  } finally {
    releaseGit?.();
    await panel.dispose();
  }
});

test("text typed while the request is in flight is a new draft and survives it", async () => {
  heldGit = true;
  const panel = await mountPanel();
  try {
    await panel.show("review");
    await writeRequest(panel);
    await act(async () => fireDomEvent.click(button(panel, "Push & Open Pull Request")));
    await type(field(panel, "PR Description")!, "a follow-up note written during the push");
    await act(async () => { releaseGit?.(); });

    assert.equal(field(panel, "PR Title")!.value, "Panel Scratch Fixture", "the submitted title is spent");
    assert.equal(field(panel, "PR Description")!.value, "a follow-up note written during the push",
      "what was typed after the submit went out is the reviewer's");
    await panel.show("files");
    await panel.show("review");
    assert.equal(field(panel, "PR Description")!.value, "a follow-up note written during the push");
  } finally {
    releaseGit?.();
    await panel.dispose();
  }
});
