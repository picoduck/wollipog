import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type GitStatusInfo,
  type SessionFileEntry,
  type SessionView,
  type SourceLocation,
  type WorkspaceReferenceCandidate,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { matchesShortcut } from "../shortcuts.js";
import { GO_TO_FILE_DEBOUNCE_MS } from "./FilesPanel.js";
import { RightPanel, openGoToFile, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Files (#2852): Go to File at the top, focused by Ctrl/⌘+P, and the folder as dense rows with file
 * icons, git markers and real states. Driven through the real side panel, with the shortcut wired
 * the way App.tsx wires it.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
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

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const connection: UiConnectionRuntime = {
  instanceId: "files-panel-test", runtimeKey: "files-panel-test",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

const session = {
  id: "files-session",
  runnerId: "runner-1",
  title: "Files Fixture",
  status: "idle",
  driver: "claude-code",
  useWorktree: true,
  worktreePath: "/home/me/.agent-worktrees/wollipog-fix",
  workspaceName: "Wollipog",
  eventEpoch: 0,
  adopted: false,
} as SessionView;

let tree: Record<string, SessionFileEntry[]>;
let searchResults: WorkspaceReferenceCandidate[];
let searchTruncated: boolean;
let searches: string[];
let reads: string[];
let heldListing: (() => void) | null;
let holdListings: boolean;
let changedFiles: GitStatusInfo["files"];
/** When set, answers each search instead of the fixed results: to hold, vary or fail one. */
let searchAnswer: ((query: string) => Promise<{ results: WorkspaceReferenceCandidate[]; truncated: boolean }>) | null;

beforeEach(() => {
  domWindow.localStorage.clear();
  clearPanelScratch();
  tree = {
    "": [
      { name: "src", path: "src", isDir: true },
      { name: "empty", path: "empty", isDir: true },
      { name: "README.md", path: "README.md", isDir: false, size: 1_200 },
      { name: "logo.png", path: "logo.png", isDir: false, size: 3_000 },
      { name: "notes.txt", path: "notes.txt", isDir: false, size: 40 },
    ],
    src: [
      { name: "checkout.ts", path: "src/checkout.ts", isDir: false, size: 900 },
      { name: "session.ts", path: "src/session.ts", isDir: false, size: 700 },
    ],
    empty: [],
  };
  // The runner's order is breadth-first; the changed file is last of the files.
  searchResults = [
    { path: "checks", isDirectory: true },
    { path: "src/checkout.ts", isDirectory: false },
    { path: "docs/check-list.md", isDirectory: false },
    { path: "checks/run.ts", isDirectory: false },
    { path: "src/precheck.ts", isDirectory: false },
  ];
  searchTruncated = false;
  searches = [];
  reads = [];
  heldListing = null;
  holdListings = false;
  searchAnswer = null;
  changedFiles = [
    { status: "M", path: "src/precheck.ts" },
    { status: "M", path: "README.md" },
    { status: "??", path: "notes.txt" },
  ];
});

const client = {
  ...api,
  listSessionFiles: async (_id: string, dir: string) => {
    if (holdListings) await new Promise<void>((resolve) => { heldListing = resolve; });
    const entries = tree[dir];
    if (!entries) throw new Error(`no such directory: ${dir}`);
    return { path: dir, entries };
  },
  readSessionFile: async (_id: string, path: string) => {
    reads.push(path);
    return { path, content: `// ${path}\n`, size: 12 };
  },
  searchWorkspaceReferences: async (_id: string, query: string) => {
    searches.push(query);
    if (searchAnswer) return searchAnswer(query);
    return { results: searchResults, truncated: searchTruncated };
  },
  sessionWorkflowArtifacts: async () => ({ artifacts: [] }),
} as unknown as ApiClient;

function gitStatus(): GitStatus {
  return {
    status: { branch: "fix", files: changedFiles, hasChanges: true, ahead: 0, remoteUrl: null } as GitStatusInfo,
    observation: 1,
    observedAt: 1,
    settled: true,
    busy: false,
    error: null,
    errorCode: null,
    refresh: async () => {},
    refreshStatusOnly: async () => {},
    install: () => {},
    mutationRevision: 0,
  };
}

interface Controls {
  state: RightPanelState;
  setOnline: (online: boolean) => void;
  setProtocol: (version: number) => void;
}

function Harness({ onControls }: { onControls: (controls: Controls) => void }) {
  const state = useRightPanelState();
  const [location, setLocation] = useState<SourceLocation | undefined>(undefined);
  const [online, setOnline] = useState(true);
  const [protocol, setProtocol] = useState(PROTOCOL_VERSION);
  onControls({ state, setOnline, setProtocol });
  // The shortcut as App.tsx registers it: on the window, for the session view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShortcut(event, "open-files")) return;
      event.preventDefault();
      openGoToFile(state);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <ApiProvider client={client}><StoreProvider connection={connection}><RightPanel
      state={state}
      session={session}
      runnerOnline={online}
      runnerProtocolVersion={protocol}
      git={gitStatus()}
      items={[]}
      sourceLocation={location}
      onOpenSourceLocation={setLocation}
      onClearSourceLocation={() => setLocation(undefined)}
      onOpenTerminal={() => {}}
      onInsertSideChatDraft={() => {}}
    /></StoreProvider></ApiProvider>
  );
}

interface Mounted {
  container: HTMLElement;
  controls: Controls;
  dispose: () => Promise<void>;
}

async function mount(): Promise<Mounted> {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLElement;
  const root = createRoot(container as unknown as Element);
  let controls!: Controls;
  await act(async () => root.render(<Harness onControls={(next) => { controls = next; }} />));
  return {
    container,
    get controls() { return controls; },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Ctrl+P, from whatever has focus, as the browser delivers it. */
async function pressGoToFile(): Promise<void> {
  const target = (document.activeElement ?? document.body) as unknown as Element;
  await act(async () => fireDomEvent.keyDown(target, { key: "p", ctrlKey: true }));
  await settle();
}

/** Lets listings, reads and focus effects land. */
async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

const goToFile = (mounted: Mounted) =>
  mounted.container.querySelector<HTMLInputElement>('input[aria-label="Go to File"]');

const focused = (element: Element | null) =>
  element !== null && (document.activeElement as unknown as Element | null) === element;

async function typeQuery(mounted: Mounted, text: string): Promise<void> {
  await act(async () => fireDomEvent.change(goToFile(mounted)!, { target: { value: text } }));
  await settle(GO_TO_FILE_DEBOUNCE_MS + 30);
}

async function key(mounted: Mounted, name: string): Promise<void> {
  await act(async () => fireDomEvent.keyDown(goToFile(mounted)!, { key: name }));
  await settle();
}

const options = (mounted: Mounted) =>
  [...mounted.container.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];

const crumbTexts = (mounted: Mounted) =>
  [...mounted.container.querySelectorAll(".crumbs .crumb")].map((crumb) => crumb.textContent);

const text = (mounted: Mounted) => mounted.container.textContent ?? "";

async function showFiles(mounted: Mounted): Promise<void> {
  await act(async () => mounted.controls.state.show("files"));
  await settle();
}

test("Ctrl+P opens the panel on Files with focus in Go to File, and pressing it again keeps both", async () => {
  const mounted = await mount();
  try {
    assertNoDomNode(mounted.container.querySelector(".rpanel"), "the panel starts closed");
    await pressGoToFile();
    assert.equal(mounted.controls.state.open, true);
    assert.equal(mounted.controls.state.mode, "files");
    assert.ok(focused(goToFile(mounted)), "focus is in Go to File");

    await pressGoToFile();
    assert.equal(mounted.controls.state.open, true, "a second press never closes the panel");
    assert.equal(mounted.controls.state.mode, "files");
    assert.ok(focused(goToFile(mounted)), "and focus stays in the field");

    // From another tool it switches to Files rather than closing.
    await act(async () => mounted.controls.state.setMode("browser"));
    await pressGoToFile();
    assert.equal(mounted.controls.state.mode, "files");
    assert.ok(focused(goToFile(mounted)));
  } finally {
    await mounted.dispose();
  }
});

test("Files chosen from the switcher by keyboard focuses Go to File; by pointer it does not", async () => {
  const mounted = await mount();
  try {
    await act(async () => mounted.controls.state.show("browser"));
    const chooseFiles = async (detail: number) => {
      await act(async () => fireDomEvent.click(mounted.container.querySelector(".rpanel-switcher")!));
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        .find((candidate) => candidate.querySelector(".menu-text")?.textContent === "Files")!;
      // A click from Enter or Space has no press count; a pointer's has one.
      await act(async () => fireDomEvent.click(item, { detail }));
      await settle(5);
    };
    await chooseFiles(1);
    assert.equal(mounted.controls.state.mode, "files");
    assert.ok(!focused(goToFile(mounted)), "a pointer choice leaves focus alone");

    await act(async () => mounted.controls.state.setMode("browser"));
    await chooseFiles(0);
    assert.equal(mounted.controls.state.mode, "files");
    assert.ok(focused(goToFile(mounted)), "a keyboard choice lands in Go to File");

    // Choosing Files again while it is the tool lands there too.
    await act(async () => mounted.container.querySelector<HTMLButtonElement>(".rpanel-switcher")!.focus());
    assert.ok(!focused(goToFile(mounted)));
    await chooseFiles(0);
    assert.ok(focused(goToFile(mounted)), "the current tool chosen by keyboard focuses the field");
  } finally {
    await mounted.dispose();
  }
});

test("typing lists matching files, changed ones first; Down then Enter opens the second; Escape clears", async () => {
  const mounted = await mount();
  try {
    await pressGoToFile();
    await typeQuery(mounted, "check");
    assert.deepEqual(searches, ["check"], "one search once typing pauses");
    const field = goToFile(mounted)!;
    assert.equal(field.getAttribute("role"), "combobox");
    assert.equal(field.getAttribute("aria-expanded"), "true");
    const listbox = mounted.container.querySelector('[role="listbox"]')!;
    assert.equal(field.getAttribute("aria-controls"), listbox.id);
    assertNoDomNode(mounted.container.querySelector(".crumbs"), "the folder view gives way to the results");
    // Files only, the changed one first, then name matches before the path match.
    assert.deepEqual(options(mounted).map((option) => option.getAttribute("title")), [
      "src/precheck.ts", "src/checkout.ts", "docs/check-list.md", "checks/run.ts",
    ]);
    assert.equal(mounted.container.querySelector(".files-goto-count")?.textContent, "4 matches in wollipog-fix");
    assert.equal(options(mounted)[0]!.querySelector(".files-goto-match")?.textContent, "check", "the match is marked");
    assert.equal(options(mounted)[0]!.querySelector(".files-git-marker")?.textContent, "MModified");
    assert.equal(options(mounted)[0]!.getAttribute("aria-selected"), "true", "the first result starts active");

    await key(mounted, "ArrowDown");
    assert.equal(options(mounted)[1]!.getAttribute("aria-selected"), "true");
    assert.equal(field.getAttribute("aria-activedescendant"), options(mounted)[1]!.id);
    await key(mounted, "Enter");
    await settle();
    assert.deepEqual(reads, ["src/checkout.ts"], "Enter opens the second result");
    assert.equal(field.value, "", "and clears the field");
    assert.ok(mounted.container.querySelector(".files-viewer"), "the viewer shows it");
    assert.deepEqual(crumbTexts(mounted), ["wollipog-fix", "src", "checkout.ts"]);

    await typeQuery(mounted, "check");
    assert.ok(options(mounted).length > 0);
    await key(mounted, "Escape");
    assert.equal(goToFile(mounted)!.value, "", "Escape clears the field");
    assert.equal(mounted.controls.state.open, true, "and leaves the panel open");
    assertNoDomNode(mounted.container.querySelector('[role="listbox"]'));
    assert.ok(mounted.container.querySelector(".crumbs"), "the folder view is back");

    await key(mounted, "Escape");
    assert.equal(mounted.controls.state.open, false, "a second Escape follows the panel's ladder and closes it");
  } finally {
    await mounted.dispose();
  }
});

test("Enter opens only what answers the typed text: never an earlier query's rows or a failed search's", async () => {
  const pending = new Map<string, (results: WorkspaceReferenceCandidate[]) => void>();
  searchAnswer = (query) => new Promise((resolve) => {
    pending.set(query, (results) => resolve({ results, truncated: false }));
  });
  const mounted = await mount();
  try {
    await pressGoToFile();
    await typeQuery(mounted, "old");
    await act(async () => pending.get("old")!([{ path: "old.ts", isDirectory: false }]));
    assert.deepEqual(options(mounted).map((option) => option.getAttribute("title")), ["old.ts"]);

    // A new query: the old rows stay on screen while its answer is pending, but are not choosable.
    await act(async () => fireDomEvent.change(goToFile(mounted)!, { target: { value: "new" } }));
    assert.deepEqual(options(mounted).map((option) => option.getAttribute("title")), ["old.ts"]);
    assert.equal(goToFile(mounted)!.getAttribute("aria-activedescendant"), null, "no stale row is active");
    await key(mounted, "ArrowDown");
    await key(mounted, "Enter");
    assert.deepEqual(reads, [], "Enter does not open the earlier query's row");
    await act(async () => fireDomEvent.click(options(mounted)[0]!));
    await settle();
    assert.deepEqual(reads, [], "nor does a click on it");
    assert.equal(goToFile(mounted)!.value, "new", "and the query stays");
    await settle(GO_TO_FILE_DEBOUNCE_MS + 30);
    await act(async () => pending.get("new")!([{ path: "src/new.ts", isDirectory: false }]));
    await settle();
    assert.deepEqual(reads, ["src/new.ts"], "it opens the first match for what was typed once that arrives");
    assert.equal(goToFile(mounted)!.value, "");

    // A failed search leaves nothing to open and names no row.
    searchAnswer = async () => { throw new Error("search failed: 503"); };
    await typeQuery(mounted, "gone");
    assert.match(mounted.container.querySelector(".notice")?.textContent ?? "", /search failed: 503/u);
    assertNoDomNode(mounted.container.querySelector('[role="listbox"]'));
    assert.equal(goToFile(mounted)!.getAttribute("aria-expanded"), "false");
    assert.equal(goToFile(mounted)!.getAttribute("aria-activedescendant"), null);
    await key(mounted, "Enter");
    assert.deepEqual(reads, ["src/new.ts"], "Enter after a failure opens nothing");
  } finally {
    await mounted.dispose();
  }
});

test("a truncated search says only the first matches show", async () => {
  searchTruncated = true;
  const mounted = await mount();
  try {
    await pressGoToFile();
    await typeQuery(mounted, "check");
    assert.equal(
      mounted.container.querySelector(".files-goto-count")?.textContent,
      "Showing the first matches only. Type more to narrow them.",
    );
  } finally {
    await mounted.dispose();
  }
});

test("no matching files is a no-results state whose Clear Filter returns to the folder", async () => {
  searchResults = [{ path: "checks", isDirectory: true }];
  const mounted = await mount();
  try {
    await pressGoToFile();
    await typeQuery(mounted, "checks");
    const state = mounted.container.querySelector(".state.no-results")!;
    assert.equal(state.querySelector(".state-title")?.textContent, "No Matching Files");
    assert.equal(state.querySelector(".state-body")?.textContent, "Nothing in wollipog-fix matches that name.");
    const clear = [...state.querySelectorAll("button")].find((button) => button.textContent === "Clear Filter")!;
    await act(async () => fireDomEvent.click(clear));
    await settle();
    assert.equal(goToFile(mounted)!.value, "");
    assert.ok(focused(goToFile(mounted)), "focus goes back to the field");
    assert.ok(mounted.container.querySelector(".crumbs"));
  } finally {
    await mounted.dispose();
  }
});

test("the folder: crumbs start at the folder's name, icons not emoji, changed files marked, Refresh in the header", async () => {
  const mounted = await mount();
  try {
    await showFiles(mounted);
    assert.deepEqual(crumbTexts(mounted), ["wollipog-fix"], "the first crumb is the workspace folder's name");
    const rows = [...mounted.container.querySelectorAll<HTMLButtonElement>(".files-list .row.dense")];
    assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.textContent),
      ["src", "empty", "README.md", "logo.png", "notes.txt"]);
    assert.ok(rows.every((row) => row.querySelector(".row-icon svg")), "every row has an icon");
    assert.doesNotMatch(text(mounted), /\p{Extended_Pictographic}/u, "no emoji renders");
    assert.doesNotMatch(text(mounted), /↻/u);
    const marker = (name: string) => rows.find((row) => row.querySelector(".row-title")?.textContent === name)
      ?.querySelector(".files-git-marker");
    assert.equal(marker("README.md")?.querySelector('[aria-hidden="true"]')?.textContent, "M");
    assert.equal(marker("notes.txt")?.querySelector('[aria-hidden="true"]')?.textContent, "U");
    assertNoDomNode(marker("logo.png") ?? null, "an unchanged file has no marker");
    assert.equal(rows[2]!.querySelector(".row-trail")?.textContent, "1.2 KB");

    const actions = mounted.container.querySelector(".rpanel-actions")!;
    assert.ok(actions.querySelector('button[aria-label="Refresh Files"]'), "Refresh lives in the header's action slot");
    assert.equal(mounted.container.querySelectorAll(".rpanel-body button").length > 0, true);
    assert.ok(![...mounted.container.querySelectorAll(".rpanel-body button")].some((button) => /refresh/iu.test(button.textContent ?? "")),
      "and nowhere in the body");
    // Files has one scroller: the toolbar holds Go to File, the scroller everything else.
    assert.ok(mounted.container.querySelector(".rpanel-toolbar input[aria-label=\"Go to File\"]"));
    assert.equal(mounted.container.querySelectorAll(".rpanel-scroll").length, 1);

    const up = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Up One Folder"]')!;
    assert.equal(up.disabled, true, "nothing is above the root");
    await act(async () => fireDomEvent.click(rows[0]!));
    await settle();
    assert.deepEqual(crumbTexts(mounted), ["wollipog-fix", "src"]);
    await act(async () => fireDomEvent.click(up));
    await settle();
    assert.deepEqual(crumbTexts(mounted), ["wollipog-fix"], "Up One Folder goes to the parent");
  } finally {
    await mounted.dispose();
  }
});

test("an empty folder is a compact state that offers the way up", async () => {
  const mounted = await mount();
  try {
    await showFiles(mounted);
    const empty = [...mounted.container.querySelectorAll<HTMLButtonElement>(".files-list .row")]
      .find((row) => row.querySelector(".row-title")?.textContent === "empty")!;
    await act(async () => fireDomEvent.click(empty));
    await settle();
    const state = mounted.container.querySelector(".state.compact")!;
    assert.equal(state.querySelector(".state-title")?.textContent, "Empty Folder");
    assert.equal(state.querySelector(".state-body")?.textContent, "empty has no files yet.");
    const up = [...state.querySelectorAll("button")].find((button) => button.textContent === "Up to wollipog-fix")!;
    await act(async () => fireDomEvent.click(up));
    await settle();
    assert.deepEqual(crumbTexts(mounted), ["wollipog-fix"]);
  } finally {
    await mounted.dispose();
  }
});

test("a first listing shows skeleton dense rows, not a sentence", async () => {
  holdListings = true;
  const mounted = await mount();
  try {
    await showFiles(mounted);
    const skeleton = mounted.container.querySelector(".skeleton.files-skeleton")!;
    assert.equal(skeleton.getAttribute("role"), "status");
    assert.ok(skeleton.querySelectorAll(".row.dense").length >= 3);
    assert.doesNotMatch(text(mounted), /Loading…/u);
    await act(async () => heldListing?.());
    await settle();
    assertNoDomNode(mounted.container.querySelector(".files-skeleton"));
  } finally {
    holdListings = false;
    await mounted.dispose();
  }
});

test("offline keeps the last-known rows, dimmed, under a warning that says how old they are", async () => {
  const mounted = await mount();
  try {
    await showFiles(mounted);
    await act(async () => mounted.controls.setOnline(false));
    const notice = mounted.container.querySelector(".notice")!;
    assert.match(notice.textContent ?? "", /is offline\. This list is from a moment ago\.$/u);
    const stale = mounted.container.querySelector(".is-stale")!;
    assert.equal(stale.querySelectorAll(".files-list .row").length, 5, "the rows stay on screen");
    assert.ok(!stale.contains(notice), "the warning itself is not dimmed");
  } finally {
    await mounted.dispose();
  }
});

test("an older runner shows Files' reason as a compact neutral notice", async () => {
  const mounted = await mount();
  try {
    await act(async () => mounted.controls.setProtocol(15));
    await showFiles(mounted);
    const notice = mounted.container.querySelector(".rpanel-body .notice")!;
    assert.match(notice.className, /\bneutral\b/u);
    assert.match(notice.className, /\bcompact\b/u);
    assert.match(notice.textContent ?? "", /needs a newer runner for session file browsing/u);
  } finally {
    await mounted.dispose();
  }
});
