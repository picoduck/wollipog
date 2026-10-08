import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

/**
 * Panel scratch is mirrored to storage after a pause, not on every keystroke (#2764).
 *
 * Each keystroke in a panel draft used to read, merge and rewrite the scope's record and then read
 * every scratch record on the origin to check the bounds. These cases pin the replacement: a burst
 * of keystrokes becomes one write, that write reads and writes its own key only, and nothing typed
 * is left behind when the page is hidden or unloaded or a value is removed.
 */

const RECORD_PREFIX = "wollipog.right-panel-scratch.v2:";

const backing = new Map<string, string>();
let reads: string[] = [];
let writes: string[] = [];
let enumerations = 0;
(globalThis as { localStorage?: unknown }).localStorage = {
  get length(): number {
    return backing.size;
  },
  key: (index: number): string | null => {
    enumerations += 1;
    return [...backing.keys()][index] ?? null;
  },
  getItem: (key: string): string | null => {
    reads.push(key);
    return backing.get(key) ?? null;
  },
  setItem: (key: string, value: string): void => {
    writes.push(key);
    backing.set(key, value);
  },
  removeItem: (key: string): void => {
    backing.delete(key);
  },
};

// The page-hide and visibility flushes need a window to listen on; this one is just the events.
const page = new EventTarget();
const pageDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
Object.assign(page, { document: pageDocument });
(globalThis as { window?: unknown }).window = page;

const {
  PANEL_SCRATCH_PERSIST_DELAY_MS,
  PANEL_SCRATCH_PERSIST_MAX_DELAY_MS,
  clearPanelScratch,
  clearPanelScratchIf,
  dropPanelScratchMemory,
  panelScratchRevision,
  panelScratchScopeKey,
  readPanelScratch,
  writePanelScratch,
} = await import("./right-panel-scratch.js");

function stored(scope: string, key: string): string | undefined {
  const raw = backing.get(`${RECORD_PREFIX}${scope}`);
  if (raw === undefined) return undefined;
  return (JSON.parse(raw) as { values: Record<string, { value: string }> }).values[key]?.value;
}

function resetCounters(): void {
  reads = [];
  writes = [];
  enumerations = 0;
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  clearPanelScratch();
  backing.clear();
  resetCounters();
});

afterEach(() => {
  clearPanelScratch();
  mock.timers.reset();
});

test("a burst of keystrokes is one write, made once typing pauses", () => {
  const scope = panelScratchScopeKey("session-1");
  let draft = "";
  for (const character of "a pull request description") {
    draft += character;
    writePanelScratch(scope, "review.requestBody", draft, "draft");
    mock.timers.tick(20);
  }
  assert.equal(writes.length, 0, "nothing is written while the keystrokes keep coming");
  assert.equal(readPanelScratch(scope, "review.requestBody"), draft, "memory has every keystroke");

  mock.timers.tick(PANEL_SCRATCH_PERSIST_DELAY_MS);
  assert.deepEqual(writes, [`${RECORD_PREFIX}${scope}`], "the pause writes the scope once");
  assert.equal(stored(scope, "review.requestBody"), draft);
});

test("steady typing still reaches storage within the longest delay", () => {
  const scope = panelScratchScopeKey("session-1");
  let draft = "";
  let elapsed = 0;
  while (writes.length === 0 && elapsed < 10_000) {
    draft += "x";
    writePanelScratch(scope, "sidechat.draft", draft, "draft");
    mock.timers.tick(100);
    elapsed += 100;
  }
  assert.ok(elapsed <= PANEL_SCRATCH_PERSIST_MAX_DELAY_MS,
    `a keystroke every 100ms was first written after ${elapsed}ms`);
});

test("a write to an existing record reads and writes only its own key", () => {
  const scope = panelScratchScopeKey("session-1");
  // Other sessions' records, which a sweep would have to read.
  for (let index = 0; index < 5; index += 1) {
    writePanelScratch(panelScratchScopeKey(`other-${index}`), "files.directory", `dir-${index}`);
  }
  writePanelScratch(scope, "review.requestBody", "first", "draft");
  mock.timers.tick(PANEL_SCRATCH_PERSIST_DELAY_MS);
  resetCounters();

  writePanelScratch(scope, "review.requestBody", "first words", "draft");
  mock.timers.tick(PANEL_SCRATCH_PERSIST_DELAY_MS);

  const own = `${RECORD_PREFIX}${scope}`;
  assert.deepEqual(writes, [own]);
  assert.deepEqual([...new Set(reads)], [own], "no other record is read");
  assert.equal(enumerations, 0, "and the origin's keys are not enumerated");
  assert.equal(stored(scope, "review.requestBody"), "first words");
});

test("a new record still runs the sweep that holds the scope bound", () => {
  writePanelScratch(panelScratchScopeKey("session-1"), "files.directory", "apps/web");
  mock.timers.tick(PANEL_SCRATCH_PERSIST_DELAY_MS);
  assert.ok(enumerations > 0, "creating a record enumerates the origin to keep the bounds");
});

test("hiding or leaving the page writes what is still waiting", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "typed just before switching apps", "draft");
  assert.equal(stored(scope, "sidechat.draft"), undefined);
  pageDocument.visibilityState = "hidden";
  pageDocument.dispatchEvent(new Event("visibilitychange"));
  pageDocument.visibilityState = "visible";
  assert.equal(stored(scope, "sidechat.draft"), "typed just before switching apps");

  writePanelScratch(scope, "sidechat.draft", "typed just before closing the tab", "draft");
  page.dispatchEvent(new Event("pagehide"));
  assert.equal(stored(scope, "sidechat.draft"), "typed just before closing the tab");

  dropPanelScratchMemory();
  assert.equal(readPanelScratch(scope, "sidechat.draft"), "typed just before closing the tab",
    "a reload restores the last keystroke");
});

test("a removal is written at once, together with what the scope still owed", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  writePanelScratch(scope, "files.directory", "apps/web");
  assert.equal(writes.length, 0);

  clearPanelScratchIf(scope, "sidechat.draft", "on its way", panelScratchRevision(scope, "sidechat.draft"));

  assert.equal(stored(scope, "sidechat.draft"), undefined, "the sent draft is not stored");
  assert.equal(stored(scope, "files.directory"), "apps/web", "the pending write went with the removal");
  const record = JSON.parse(backing.get(`${RECORD_PREFIX}${scope}`)!) as { cleared: Record<string, number> };
  assert.ok(record.cleared["sidechat.draft"], "and the marker that keeps other tabs from resurrecting it");
  writes = [];
  mock.timers.tick(PANEL_SCRATCH_PERSIST_MAX_DELAY_MS);
  assert.equal(writes.length, 0, "nothing is left on the timer to write the scope again");
});
