import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import postcss from "postcss";
import {
  PROTOCOL_VERSION,
  type CreateWorkspaceReferenceRequest,
  type EditorInfo,
  type GitStatusInfo,
  type RunnerView,
  type SessionFileEntry,
  type SessionView,
  type SourceLocation,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { highlightDiffLine } from "../diff-view.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { FeedbackContext, type ToastOptions } from "./FeedbackProvider.js";
import { FilesBrowser } from "./FilesPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * The Files viewer (#2853): one toolbar row that never wraps, a meta line, source lines through the
 * diff's highlighter in a view that scrolls sideways only, Go to Symbol with its field error, the
 * File Actions menu and the binary, truncated and loading states.
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

/** A 74-line TypeScript file with keywords, strings, numbers and comments on its lines. */
const TAX_LINES = Array.from({ length: 74 }, (_, index) => {
  if (index === 0) return "// Totals for an order.";
  if (index === 1) return "export function calculateTotal(items: Item[]): number {";
  if (index % 7 === 0) return `  const label${index} = "line ${index}"; // ${index}`;
  if (index % 5 === 0) return "";
  return `  let value${index} = ${index} * 2;`;
});
const TAX = `${TAX_LINES.join("\n")}\n`;

interface FileFixture { content?: string; size: number; binary?: boolean; truncated?: boolean }
const files: Record<string, FileFixture> = {
  "src/tax.ts": { content: TAX, size: 2_765 },
  "README.md": { content: "# Wollipog\n\nRun coding agents.\n", size: 31 },
  "logo.png": { binary: true, size: 24_015 },
  "server.log": { content: "boot\nready\n", size: 2_202_009, truncated: true },
  "empty.txt": { content: "", size: 0 },
};

const tree: Record<string, SessionFileEntry[]> = {
  "": [
    { name: "src", path: "src", isDir: true },
    { name: "README.md", path: "README.md", isDir: false, size: 31 },
  ],
  src: [{ name: "tax.ts", path: "src/tax.ts", isDir: false, size: 2_765 }],
};

let heldRead: (() => void) | null;
let holdReads: boolean;
let hostActions: Parameters<ApiClient["hostAction"]>[1][];
let attached: CreateWorkspaceReferenceRequest[];
let reviewed: string[];
let toasts: { message: string; options?: ToastOptions }[];
let copied: string[];
let scrolled: Element[];

beforeEach(() => {
  domWindow.localStorage.clear();
  clearPanelScratch();
  heldRead = null;
  holdReads = false;
  hostActions = [];
  attached = [];
  reviewed = [];
  toasts = [];
  copied = [];
  scrolled = [];
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  (domWindow.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
});

const client = {
  ...api,
  listSessionFiles: async (_id: string, dir: string) => ({ path: dir, entries: tree[dir] ?? [] }),
  readSessionFile: async (_id: string, path: string) => {
    if (holdReads) await new Promise<void>((resolve) => { heldRead = resolve; });
    const file = files[path];
    if (!file) throw new Error(`no such file: ${path}`);
    return { path, ...file };
  },
  hostAction: async (_id: string, action: Parameters<ApiClient["hostAction"]>[1]) => {
    hostActions.push(action);
    return { ok: true as const };
  },
  sessionWorkflowArtifacts: async () => ({ artifacts: [] }),
} as unknown as ApiClient;

const session = {
  id: "files-viewer-session",
  runnerId: "runner-1",
  title: "Files Viewer Fixture",
  status: "idle",
  driver: "claude-code",
  useWorktree: true,
  worktreePath: "/home/me/.agent-worktrees/wollipog-fix",
  workspaceName: "Wollipog",
  eventEpoch: 0,
  adopted: false,
} as SessionView;

function runnerWith(editors: EditorInfo[]): RunnerView {
  return {
    runnerId: "runner-1", displayName: "Studio Mac", hostname: "studio", os: "macos", version: "1",
    status: "online", agents: [], workspaces: [], editors, connectedAt: 1, lastSeen: 1,
    protocolVersion: PROTOCOL_VERSION,
  } as RunnerView;
}

const git: GitStatus = {
  status: {
    branch: "fix", files: [{ status: "M", path: "src/tax.ts" }], hasChanges: true, ahead: 0, remoteUrl: null,
  } as GitStatusInfo,
  observation: 1, observedAt: 1, settled: true, busy: false, error: null, errorCode: null,
  refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
};

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push() {}, listen: () => () => {} };

let setLocation: (location: SourceLocation | undefined) => void = () => {};
let currentLocation: SourceLocation | undefined;

function Host({ initial }: { initial?: SourceLocation }) {
  const [location, set] = useState<SourceLocation | undefined>(initial);
  setLocation = set;
  currentLocation = location;
  return (
    <FilesBrowser
      session={session}
      runnerOnline
      runnerProtocolVersion={PROTOCOL_VERSION}
      location={location}
      git={git}
      onOpenLocation={set}
      onClearLocation={() => set(undefined)}
      onAttachWorkspaceReference={async (target) => { attached.push(target); }}
      onShowInReview={(path) => { reviewed.push(path); }}
    />
  );
}

interface Mounted {
  container: HTMLElement;
  dispose: () => Promise<void>;
}

async function mount(initial?: SourceLocation, editors: EditorInfo[] = []): Promise<Mounted> {
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container as unknown as Element);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "files-viewer", runtimeKey: "files-viewer:1", createSocket: () => socket, close() {},
  };
  const feedback = {
    confirm: async () => false,
    showToast: (message: string, options?: ToastOptions) => toasts.push({ message, options }),
    showUndo: () => -1,
    dismissToast: () => undefined,
  };
  await act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={feedback}>
        <StoreProvider connection={connection} navigation={navigation}>
          <div className="rpanel-body"><Host initial={initial} /></div>
        </StoreProvider>
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runnerWith(editors)], boxes: [], projects: [], sessions: [session], runs: [], pods: [],
  }));
  await settle();
  return {
    container,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function settle(ms = 20): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function go(location: SourceLocation | undefined): Promise<void> {
  await act(async () => setLocation(location));
  await settle();
}

const doc = () => domWindow.document as unknown as Document;
const symbolField = (mounted: Mounted) => mounted.container.querySelector<HTMLInputElement>('input[aria-label="Go to Symbol"]');
const button = (mounted: Mounted, name: string) => mounted.container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const lines = (mounted: Mounted) => [...mounted.container.querySelectorAll<HTMLElement>(".codeview .cl")];
const metaFacts = (mounted: Mounted) => [...mounted.container.querySelectorAll(".files-meta > span")].map((fact) => fact.textContent);
const menuItems = () => [...doc().querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];

async function searchSymbol(mounted: Mounted, symbol: string): Promise<void> {
  await act(async () => fireDomEvent.change(symbolField(mounted)!, { target: { value: symbol } }));
  await act(async () => fireDomEvent.keyDown(symbolField(mounted)!, { key: "Enter" }));
  await settle();
}

async function openFileActions(mounted: Mounted): Promise<void> {
  await act(async () => fireDomEvent.click(button(mounted, "File Actions")!));
  await settle();
}

test("a 74-line TypeScript file shows the diff's token classes, a meta line and one toolbar row", async () => {
  const mounted = await mount({ path: "src/tax.ts" });
  try {
    const rows = lines(mounted);
    assert.equal(rows.length, 74, "the final newline opens no 75th line");
    rows.forEach((row, index) => {
      const text = TAX_LINES[index]!;
      assert.equal(row.dataset.sourceLine, String(index + 1));
      assert.equal(row.querySelector(".ln")?.getAttribute("data-line-number"), String(index + 1));
      const expected = highlightDiffLine("src/tax.ts", text).filter((segment) => segment.text !== "")
        .map((segment) => `diff-syntax-${segment.kind}`);
      const actual = [...row.querySelectorAll(".tx > span")].map((token) => token.className);
      assert.deepEqual(actual, expected, `line ${index + 1} has the diff's classes`);
      if (text) assert.equal(row.querySelector(".tx")?.textContent, text);
    });
    for (const kind of ["keyword", "string", "number", "comment"]) {
      assert.ok(mounted.container.querySelector(`.codeview .diff-syntax-${kind}`), `a ${kind} token is highlighted`);
    }
    assert.deepEqual(metaFacts(mounted), ["TypeScript", "74 lines", "2.7 KB", "Modified"]);

    // The toolbar row: Go to Symbol, then Attach to Prompt, Copy Link and File Actions as icon buttons.
    const row = mounted.container.querySelector(".rpanel-toolbar .files-viewer-field > .toolbar")!;
    assert.ok(row.querySelector('input[aria-label="Go to Symbol"]'));
    assert.deepEqual([...row.querySelectorAll("button")].map((control) => control.getAttribute("aria-label")),
      ["Attach to Prompt", "Copy Link", "File Actions"]);
    for (const control of row.querySelectorAll("button")) {
      assert.equal(control.className, "icon-btn sm");
      assert.equal(control.getAttribute("title"), control.getAttribute("aria-label"), "its tooltip matches its name");
    }
    assertNoDomNode(button(mounted, "Clear Target"), "no target, so nothing to clear");
    for (const retired of [".source-location-bar", ".source-symbol-form", ".source-editor-select", ".source-file-size", ".hint", "select"]) {
      assertNoDomNode(mounted.container.querySelector(retired), `${retired} is gone`);
    }
  } finally {
    await mounted.dispose();
  }
});

test("a line target marks its line and scrolls it into view; Clear Target inside the field clears it", async () => {
  const mounted = await mount({ path: "src/tax.ts" });
  try {
    await go({ path: "src/tax.ts", line: 40 });
    await settle(40);
    const marked = mounted.container.querySelectorAll(".cl.is-target");
    assert.equal(marked.length, 1);
    assert.equal((marked[0] as HTMLElement).dataset.sourceLine, "40");
    assert.ok(scrolled.includes(marked[0]!.querySelector(".ln")!), "the target's sticky number scrolls into view, so the code never scrolls sideways");

    const clear = mounted.container.querySelector<HTMLButtonElement>('.files-symbol button[aria-label="Clear Target"]');
    assert.ok(clear, "Clear Target sits inside Go to Symbol");
    assert.equal(clear.className, "icon-btn sm");
    await act(async () => fireDomEvent.click(clear));
    await settle();
    assert.deepEqual(currentLocation, { path: "src/tax.ts" });
    assert.equal(mounted.container.querySelectorAll(".cl.is-target").length, 0);
    assertNoDomNode(button(mounted, "Clear Target"));
  } finally {
    await mounted.dispose();
  }
});

test("Go to Symbol marks the symbol; a miss is its field error, which clears as the field changes", async () => {
  const mounted = await mount({ path: "src/tax.ts" });
  try {
    await searchSymbol(mounted, "calculateTotal");
    assert.deepEqual(currentLocation, { path: "src/tax.ts", symbol: "calculateTotal" });
    const target = mounted.container.querySelector<HTMLElement>(".cl.is-target")!;
    assert.equal(target.dataset.sourceLine, "2");
    assert.equal(target.querySelector("mark")?.textContent, "calculateTotal");
    assertNoDomNode(mounted.container.querySelector(".field-error"));

    await searchSymbol(mounted, "calculateTax");
    const error = mounted.container.querySelector(".rpanel-toolbar .field-error")!;
    assert.equal(error.textContent, "No symbol named “calculateTax” in this file.");
    const field = symbolField(mounted)!;
    assert.equal(field.getAttribute("aria-invalid"), "true");
    assert.equal(field.getAttribute("aria-describedby"), error.id);
    assert.equal(mounted.container.querySelectorAll(".cl.is-target").length, 0, "a miss marks no line");

    await act(async () => fireDomEvent.change(symbolField(mounted)!, { target: { value: "calculate" } }));
    assertNoDomNode(mounted.container.querySelector(".field-error"), "the error clears as the field changes");
    assert.equal(symbolField(mounted)!.getAttribute("aria-invalid"), null);
  } finally {
    await mounted.dispose();
  }
});

test("rendered Markdown shows no symbol field; Source shows it, through a Preview and Source control", async () => {
  const mounted = await mount({ path: "README.md" });
  try {
    assert.equal(mounted.container.querySelector(".files-md h1")?.textContent, "Wollipog");
    assertNoDomNode(symbolField(mounted), "no symbol field on rendered Markdown");
    const views = [...mounted.container.querySelectorAll<HTMLElement>('.files-viewer-field .seg.sm [role="radio"]')];
    assert.deepEqual(views.map((view) => view.textContent), ["Preview", "Source"]);
    await act(async () => fireDomEvent.click(views[1]!));
    await settle();
    assert.ok(symbolField(mounted), "Source shows Go to Symbol");
    assert.ok(mounted.container.querySelector(".codeview"));
    assertNoDomNode(mounted.container.querySelector(".files-md"));
    assert.deepEqual(metaFacts(mounted), ["Markdown", "3 lines", "31 B"]);
  } finally {
    await mounted.dispose();
  }
});

test("with no editor found, Open in Editor… is unavailable with its reason as visible text", async () => {
  const mounted = await mount({ path: "src/tax.ts" });
  try {
    await openFileActions(mounted);
    const items = menuItems();
    assert.deepEqual(items.map((item) => item.querySelector(".menu-text")?.textContent),
      ["Open in Editor…", "Copy Path", "Show Changes in Review"]);
    assert.equal(items[0]!.getAttribute("aria-disabled"), "true");
    assert.equal(items[0]!.querySelector(".menu-desc")?.textContent, "No editor found on Studio Mac.");
    await act(async () => fireDomEvent.click(items[0]!));
    assert.equal(hostActions.length, 0, "an unavailable item does nothing");
    assert.ok(doc().querySelector('[role="menu"]'), "and leaves the menu open");

    await act(async () => fireDomEvent.click(menuItems()[2]!));
    await settle();
    assert.deepEqual(reviewed, ["src/tax.ts"]);
    assertNoDomNode(doc().querySelector('[role="menu"]'));

    await openFileActions(mounted);
    await act(async () => fireDomEvent.click(menuItems()[1]!));
    await settle();
    assert.deepEqual(copied, ["src/tax.ts"]);
    assert.deepEqual(toasts.map((toast) => toast.message), ["Copied the path."]);
  } finally {
    await mounted.dispose();
  }
});

test("several editors are File Actions items, the last used first, and open the target there", async () => {
  domWindow.localStorage.setItem("wollipog.editor.lastUsed", "cursor");
  const mounted = await mount({ path: "src/tax.ts", line: 3 }, [
    { id: "code", name: "VS Code", locations: { native: "column" } },
    { id: "cursor", name: "Cursor", locations: { native: "line" } },
  ]);
  try {
    await openFileActions(mounted);
    const labels = menuItems().map((item) => item.querySelector(".menu-text")?.textContent);
    assert.deepEqual(labels, ["Open in Cursor", "Open in VS Code", "Copy Path", "Show Changes in Review"]);
    assertNoDomNode(mounted.container.querySelector("select"), "no native select");
    const vsCode = menuItems().find((item) => item.querySelector(".menu-text")?.textContent === "Open in VS Code")!;
    assert.equal(vsCode.getAttribute("aria-disabled"), null);
    await act(async () => fireDomEvent.click(vsCode));
    await settle();
    assert.deepEqual(hostActions, [{ kind: "open_editor_location", editorId: "code", location: { path: "src/tax.ts", line: 3 } }]);
    assert.deepEqual(toasts.map((toast) => toast.message), ["Opened in VS Code."]);
  } finally {
    await mounted.dispose();
  }
});

test("Attach to Prompt attaches the open file", async () => {
  const mounted = await mount({ path: "src/tax.ts" });
  try {
    await act(async () => fireDomEvent.click(button(mounted, "Attach to Prompt")!));
    await settle();
    assert.deepEqual(attached, [{ path: "src/tax.ts", kind: "file" }]);
  } finally {
    await mounted.dispose();
  }
});

test("a binary file shows No Preview for This File with Copy Path; a truncated file says how much shows", async () => {
  const mounted = await mount({ path: "logo.png" });
  try {
    const state = mounted.container.querySelector(".files-viewer .state.compact")!;
    assert.equal(state.querySelector(".state-title")?.textContent, "No Preview for This File");
    assert.equal(state.querySelector(".state-body")?.textContent, "logo.png isn't text, so it can't be shown here.");
    assertNoDomNode(symbolField(mounted), "no symbol field for a binary file");
    assertNoDomNode(button(mounted, "Attach to Prompt"));
    assert.deepEqual(metaFacts(mounted), ["23.5 KB"]);
    const copy = [...state.querySelectorAll("button")].find((control) => control.textContent === "Copy Path")!;
    await act(async () => fireDomEvent.click(copy));
    await settle();
    assert.deepEqual(copied, ["logo.png"]);

    await go({ path: "server.log" });
    const notice = mounted.container.querySelector(".notice.compact")!;
    assert.equal(notice.textContent, "Showing the first 512 KB of 2.1 MB.");
    assert.deepEqual(metaFacts(mounted), ["Plain Text", "2.1 MB"], "no line count for a partial read");

    await go({ path: "empty.txt" });
    assert.deepEqual(metaFacts(mounted), ["Plain Text", "0 lines", "0 B"]);
    assert.equal(lines(mounted).length, 1, "an empty file still draws its first line");
  } finally {
    await mounted.dispose();
  }
});

test("a file being read shows code-line skeletons under its own path", async () => {
  holdReads = true;
  const mounted = await mount({ path: "src/tax.ts" });
  try {
    assert.ok(mounted.container.querySelector(".skeleton.files-code-skeleton"), "the read is pending");
    assert.equal(mounted.container.querySelector(".crumbs .crumb.is-current")?.textContent, "tax.ts");
    assertNoDomNode(mounted.container.querySelector(".files-viewer-field"));
    await act(async () => heldRead?.());
    await settle();
    assertNoDomNode(mounted.container.querySelector(".files-code-skeleton"));
    assert.equal(lines(mounted).length, 74);
  } finally {
    await mounted.dispose();
  }
});

test("nothing in Files scrolls vertically on its own: no max-height scroll box, and the code view scrolls sideways", () => {
  const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const files = /\.(?:files-|codeview|cl\b|ln\b|tx\b)/u;
  const offenders: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (!files.test(rule.selector)) return;
    const props = new Map<string, string>();
    rule.walkDecls((decl) => { props.set(decl.prop, decl.value); });
    const scrolls = ["overflow", "overflow-y"].some((prop) => /auto|scroll/u.test(props.get(prop) ?? ""));
    if (props.has("max-height") || (scrolls && rule.selector !== ".codeview")) offenders.push(rule.selector);
  });
  assert.deepEqual(offenders, []);
  const codeview = new Map<string, string>();
  postcss.parse(css).walkRules(".codeview", (rule) => rule.walkDecls((decl) => { codeview.set(decl.prop, decl.value); }));
  assert.equal(codeview.get("overflow-x"), "auto");
  assert.equal(codeview.get("overflow-y"), "hidden", "an auto x-overflow alone would make y auto too");
});
