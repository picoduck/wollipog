import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Window } from "happy-dom";
import type { XtermModules } from "./shell-terminal-instance.js";
import { ShellTerminalInstance, provideXterm } from "./shell-terminal-instance.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";

/**
 * A terminal moved to another host (#2868) lands on its last line and stays there while it settles,
 * until the person scrolls or a search moves it to a match. xterm itself is a stand-in here: its
 * scroller lag after a move (a sync that lands on the first line) is what the test plays out, which a
 * layoutless DOM cannot produce.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);

/** The size each host's fit gives the terminal, by host id. */
const hostSizes = new Map<string, { cols: number; rows: number }>();

class FakeTerminal {
  static last: FakeTerminal | null = null;
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  readonly buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorY: 0 } };
  readonly resizes: Array<[number, number]> = [];
  private readonly renderListeners = new Set<() => void>();
  private readonly resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();
  element: HTMLElement | null = null;
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    FakeTerminal.last = this;
  }
  loadAddon(addon: { activate(term: FakeTerminal): void }) { addon.activate(this); }
  open(element: HTMLElement) { this.element = element; }
  onData() { return { dispose() {} }; }
  onSelectionChange() { return { dispose() {} }; }
  onResize(listener: (size: { cols: number; rows: number }) => void) {
    this.resizeListeners.add(listener);
    return { dispose: () => this.resizeListeners.delete(listener) };
  }
  onRender(listener: () => void) {
    this.renderListeners.add(listener);
    return { dispose: () => this.renderListeners.delete(listener) };
  }
  /** xterm drew a frame. */
  render() { for (const listener of [...this.renderListeners]) listener(); }
  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.resizes.push([cols, rows]);
    for (const listener of this.resizeListeners) listener({ cols, rows });
  }
  refresh() {}
  write(_data: string, done?: () => void) { done?.(); }
  scrollToTop() { this.buffer.active.viewportY = 0; }
  scrollToBottom() { this.buffer.active.viewportY = this.buffer.active.baseY; }
  scrollToLine(line: number) { this.buffer.active.viewportY = line; }
  focus() {}
  clearSelection() {}
  getSelection() { return ""; }
  getSelectionPosition() { return undefined; }
  registerMarker() { return undefined; }
  registerDecoration() { return undefined; }
  dispose() {}
}

class FakeFitAddon {
  private term: FakeTerminal | null = null;
  activate(term: FakeTerminal) { this.term = term; }
  fit() {
    const host = this.term?.element?.parentElement as HTMLElement | null | undefined;
    const size = hostSizes.get(host?.id ?? "");
    if (size) this.term!.resize(size.cols, size.rows);
  }
  dispose() {}
}

/** A match is found 30 lines up: the search scrolls there. */
const MATCH_LINE = 10;
class FakeSearchAddon {
  private term: FakeTerminal | null = null;
  activate(term: FakeTerminal) { this.term = term; }
  onDidChangeResults() { return { dispose() {} }; }
  findNext() { this.term!.buffer.active.viewportY = MATCH_LINE; }
  findPrevious() { this.term!.buffer.active.viewportY = MATCH_LINE; }
  clearDecorations() {}
  dispose() {}
}

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  ResizeObserver: StubResizeObserver,
};
const prior = Object.fromEntries(Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
const clientWidth = Object.getOwnPropertyDescriptor(domWindow.HTMLElement.prototype, "clientWidth");

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(domWindow.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  provideXterm({ Terminal: FakeTerminal, FitAddon: FakeFitAddon, SearchAddon: FakeSearchAddon } as unknown as XtermModules);
});

after(() => {
  if (clientWidth) Object.defineProperty(domWindow.HTMLElement.prototype, "clientWidth", clientWidth);
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const frame = () => new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve()));

function host(id: string, size: { cols: number; rows: number }): HTMLElement {
  hostSizes.set(id, size);
  const element = domWindow.document.createElement("div") as unknown as HTMLElement;
  element.id = id;
  domWindow.document.body.append(element as never);
  return element;
}

/** A terminal following 60 lines of output in the side panel, then moved to the shorter dock. */
async function movedToDock() {
  const instance = new ShellTerminalInstance({
    text: "", total: 0, revision: 0, historyExpired: false, interactive: true, pty: true,
    searchTerm: "", theme: "dark", scheme: "",
  }, domWindow.document as unknown as Document);
  const panel = host("panel", { cols: 51, rows: 46 });
  const dock = host("dock", { cols: 167, rows: 12 });
  instance.attach(panel, {});
  for (let attempt = 0; attempt < 50 && !instance.terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const term = instance.terminal as unknown as FakeTerminal;
  assert.ok(term, "the terminal opened");
  term.buffer.active.baseY = 60;
  term.buffer.active.viewportY = 60;
  instance.detach(panel);
  instance.attach(dock, {});
  return { instance, term, dock };
}

test("a terminal following its output lands on its last line in a shorter host, and stays there while it settles", async () => {
  const { instance, term } = await movedToDock();
  try {
    assert.deepEqual([term.cols, term.rows], [167, 12], "fitted to the dock");
    // xterm's scroller still has the panel's height and sends the terminal to its first line.
    term.buffer.active.viewportY = 0;
    term.render();
    assert.equal(term.buffer.active.viewportY, 60, "back on the last line");
    // Once it has drawn there, a row more and back makes xterm apply the dock's size whole.
    assert.deepEqual(term.resizes.slice(-2), [[167, 13], [167, 12]]);
    term.buffer.active.viewportY = 0;
    await frame();
    assert.equal(term.buffer.active.viewportY, 60, "and once more after the scroller has taken the size");
  } finally {
    instance.dispose();
  }
});

test("Next or Previous Match, or a new search term, moves a just-moved terminal to its match and nothing pulls it back", async () => {
  for (const search of ["next", "previous", "term"] as const) {
    const { instance, term } = await movedToDock();
    try {
      if (search === "next") instance.findNext("needle");
      else if (search === "previous") instance.findPrevious("needle");
      else instance.update({
        text: "", total: 0, revision: 0, historyExpired: false, interactive: true, pty: true,
        searchTerm: "needle", theme: "dark", scheme: "",
      });
      assert.equal(term.buffer.active.viewportY, MATCH_LINE, `${search}: on the match`);
      term.render();
      await frame();
      term.render();
      assert.equal(term.buffer.active.viewportY, MATCH_LINE, `${search}: still on the match`);
    } finally {
      instance.dispose();
    }
  }
});

test("scrolling by hand, with the wheel, the scrollbar or a key such as Shift+PageUp, ends the hold at once", async () => {
  const inputs = {
    wheel: () => new domWindow.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
    pointer: () => new domWindow.PointerEvent("pointerdown", { bubbles: true }),
    key: () => new domWindow.KeyboardEvent("keydown", { key: "PageUp", shiftKey: true, bubbles: true }),
  };
  for (const [name, input] of Object.entries(inputs)) {
    const { instance, term } = await movedToDock();
    try {
      // On the element xterm listens on, which stops what it handles.
      const target = domWindow.document.createElement("textarea");
      (instance.surface as unknown as { append(node: unknown): void }).append(target);
      target.addEventListener(name === "wheel" ? "wheel" : name === "pointer" ? "pointerdown" : "keydown", (event) => event.stopPropagation());
      target.dispatchEvent(input());
      term.buffer.active.viewportY = 20;
      term.render();
      await frame();
      term.render();
      assert.equal(term.buffer.active.viewportY, 20, `${name}: the person's scroll stays`);
    } finally {
      instance.dispose();
    }
  }
});
