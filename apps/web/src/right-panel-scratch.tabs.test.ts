import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

/**
 * Two tabs of the same browser, sharing one origin's storage (#1391).
 *
 * The module is a page's memory, so two tabs are two module instances — separate maps, separate
 * writer identities, one `localStorage` between them. Loading it twice under different query
 * strings is what gives that honestly: a single instance cannot hold two tabs' memories at once,
 * and hand-writing the other tab's record would be testing this file's idea of the format rather
 * than the other tab's behaviour.
 *
 * Every case here is a two-tab acceptance criterion of #1391 — one tab's work surviving another's,
 * a send staying sent in the tab that never heard about it, the bounds holding over records neither
 * map contains in full, and a refused write correcting only the record it actually left.
 */

const RECORD_PREFIX = "wollipog.right-panel-scratch.v2:";

const backing = new Map<string, string>();
let denyWrites = false;
let denyRemovals = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  get length(): number {
    return backing.size;
  },
  key: (index: number): string | null => [...backing.keys()][index] ?? null,
  getItem: (key: string): string | null => backing.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    if (denyWrites) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    backing.set(key, value);
  },
  removeItem: (key: string): void => {
    if (denyRemovals) throw new DOMException("Storage is not available", "SecurityError");
    backing.delete(key);
  },
};

type PanelScratch = typeof import("./right-panel-scratch.js");

/** A second copy of the module, which is a second page holding its own memory. */
async function openTab(tab: string): Promise<PanelScratch> {
  return (await import(`./right-panel-scratch.js?tab=${tab}`)) as PanelScratch;
}

const tabA = await openTab("a");
const tabB = await openTab("b");

function storedRecordKeys(): string[] {
  return [...backing.keys()].filter((key) => key.startsWith(RECORD_PREFIX));
}

function storedChars(): number {
  return storedRecordKeys().reduce((total, key) => total + key.length + backing.get(key)!.length, 0);
}

/** A tab that has already been open on an empty origin, so it never saw what is written next. */
function openOnEmptyOrigin(tab: PanelScratch): void {
  tab.readPanelScratch(tab.panelScratchScopeKey("session-never-used"), "files.directory");
}

beforeEach(() => {
  denyWrites = false;
  denyRemovals = false;
  tabA.clearPanelScratch();
  tabB.clearPanelScratch();
  backing.clear();
});

test("an unsent draft survives a reload even though the other tab has written since", () => {
  // The #1391 walk. Two sessions, one open in each tab: under the whole-map record, tab B's write
  // serialized a map that had never contained session-a, and tab A's reload came back empty.
  const mine = tabA.panelScratchScopeKey("session-a");
  const theirs = tabB.panelScratchScopeKey("session-b");
  openOnEmptyOrigin(tabB);
  tabA.writePanelScratch(mine, "review.requestBody", "half a pull request description", "draft");

  tabB.writePanelScratch(theirs, "files.directory", "apps/web");
  tabB.writePanelScratch(theirs, "review.requestBody", "the other tab's description", "draft");

  tabA.dropPanelScratchMemory();

  assert.equal(tabA.readPanelScratch(mine, "review.requestBody"), "half a pull request description",
    "the tab that reloaded gets its own draft back");
  assert.equal(tabA.readPanelScratch(theirs, "review.requestBody"), "the other tab's description",
    "and the other tab's, which is now stored beside it rather than instead of it");
});

test("a draft one tab sends is not written back by the tab still holding it", () => {
  // Per-scope records alone would not do this: tab B's copy of the scope is live, it knows nothing
  // about the send, and its next write would put the message back. The deletion marker is what
  // outlives that copy.
  const scope = tabA.panelScratchScopeKey("session-1");
  tabA.writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  assert.equal(tabB.readPanelScratch(scope, "sidechat.draft"), "on its way",
    "both tabs are showing the same unsent message");

  tabA.clearPanelScratchIf(scope, "sidechat.draft", "on its way",
    tabA.panelScratchRevision(scope, "sidechat.draft"));

  // Tab B is never told — nothing crosses between pages — and goes on using that session.
  assert.equal(tabB.readPanelScratch(scope, "sidechat.draft"), "on its way",
    "which is exactly the copy this case is about");
  tabB.writePanelScratch(scope, "files.directory", "apps/web");

  tabA.dropPanelScratchMemory();
  tabB.dropPanelScratchMemory();

  assert.equal(tabA.readPanelScratch(scope, "sidechat.draft"), undefined);
  assert.equal(tabB.readPanelScratch(scope, "sidechat.draft"), undefined,
    "a sent message does not come back in the tab that was still holding it");
  assert.equal(tabB.readPanelScratch(scope, "files.directory"), "apps/web",
    "and the rest of that tab's scratch is untouched by the marker");
});

test("retyping after the other tab's send is kept, so a marker retires rather than sticking", () => {
  // A marker that outlived its own value would suppress everything written under that key for as
  // long as it lived, which would be a worse loss than the one it prevents.
  const scope = tabA.panelScratchScopeKey("session-1");
  tabA.writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  assert.equal(tabB.readPanelScratch(scope, "sidechat.draft"), "on its way");
  tabA.clearPanelScratchIf(scope, "sidechat.draft", "on its way",
    tabA.panelScratchRevision(scope, "sidechat.draft"));

  tabB.writePanelScratch(scope, "sidechat.draft", "a second thought", "draft");

  tabA.dropPanelScratchMemory();
  assert.equal(tabA.readPanelScratch(scope, "sidechat.draft"), "a second thought");
});

test("the scope bound holds over the records, not over either tab's map", () => {
  // Neither map is the bound any more: each tab knows only its own half, so the sweep has to be
  // over what is actually stored or two tabs would keep twice the limit between them.
  openOnEmptyOrigin(tabB);
  for (let index = 0; index < tabA.PANEL_SCRATCH_SESSION_LIMIT; index += 1) {
    tabA.writePanelScratch(tabA.panelScratchScopeKey(`session-a-${index}`), "files.directory", "apps/web");
  }
  for (let index = 0; index < tabB.PANEL_SCRATCH_SESSION_LIMIT; index += 1) {
    tabB.writePanelScratch(tabB.panelScratchScopeKey(`session-b-${index}`), "files.directory", "apps/web");
  }

  assert.equal(storedRecordKeys().length, tabA.PANEL_SCRATCH_SESSION_LIMIT,
    "sixteen scopes between two tabs still store eight");
  // Least recently used first, and every one of tab A's is older than every one of tab B's.
  assert.equal(backing.get(`${RECORD_PREFIX}${tabB.panelScratchScopeKey("session-b-7")}`) !== undefined,
    true, "the newest is kept");
  assert.equal(backing.get(`${RECORD_PREFIX}${tabA.panelScratchScopeKey("session-a-0")}`), undefined,
    "the oldest is what the bound spent, whichever tab wrote it");
});

test("the character ceiling holds over what both tabs stored together", () => {
  // Unsent text is exempt from the scope bound in both tabs, so the ceiling is the only thing
  // standing between two tabs of drafts and unbounded storage.
  const long = "x".repeat(50_000);
  openOnEmptyOrigin(tabB);
  for (let index = 0; index < 6; index += 1) {
    const scope = tabA.panelScratchScopeKey(`session-a-${index}`);
    tabA.writePanelScratch(scope, "review.requestBody", `a-${index}:${long}`, "draft");
  }
  for (let index = 0; index < 6; index += 1) {
    const scope = tabB.panelScratchScopeKey(`session-b-${index}`);
    tabB.writePanelScratch(scope, "review.requestBody", `b-${index}:${long}`, "draft");
  }

  assert.equal(tabA.panelScratchScopeCount(), 6, "tab A still holds every draft it was given");
  assert.ok(storedChars() <= tabA.PANEL_SCRATCH_PERSIST_CHAR_LIMIT,
    `stored ${storedChars()} characters, ceiling ${tabA.PANEL_SCRATCH_PERSIST_CHAR_LIMIT}`);

  tabB.dropPanelScratchMemory();
  assert.equal(tabB.readPanelScratch(tabB.panelScratchScopeKey("session-b-5"), "review.requestBody"),
    `b-5:${long}`, "the ceiling is spent on the freshest state");
});

test("a refused write never retracts the record the other tab has written since", () => {
  const scope = tabA.panelScratchScopeKey("session-1");
  tabA.writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  tabA.writePanelScratch(scope, "files.directory", "apps/web");
  assert.equal(tabB.readPanelScratch(scope, "sidechat.draft"), "on its way");

  // Tab B writes last, so what is in storage is its latest state rather than tab A's stale one.
  tabB.writePanelScratch(scope, "files.directory", "packages/protocol");
  const theirs = backing.get(`${RECORD_PREFIX}${scope}`);
  assert.ok(theirs, "the other tab's record is stored");

  denyWrites = true;
  tabA.writePanelScratch(scope, "files.directory", "apps");
  assert.equal(backing.get(`${RECORD_PREFIX}${scope}`), theirs,
    "a record this tab did not write is not this tab's to take back");

  denyWrites = false;
  tabB.dropPanelScratchMemory();
  assert.equal(tabB.readPanelScratch(scope, "files.directory"), "packages/protocol",
    "so the other tab still has the reload this module exists for");
});

test("a removal that failed leaves no claim on the record the other tab writes next", () => {
  // The residual risk #1383 accepted and this change closes. Ownership there was the exact bytes a
  // tab last wrote, and a removal that failed re-read whatever was in storage and called it its
  // own — so a removal that recovered later could retract a record another tab had written since.
  const scope = tabA.panelScratchScopeKey("session-1");
  tabA.writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  tabA.writePanelScratch(scope, "files.directory", "apps/web");
  assert.equal(tabB.readPanelScratch(scope, "sidechat.draft"), "on its way");

  // Tab A's send lands while storage refuses everything, so neither the write nor the retraction
  // it falls back to can take.
  denyWrites = true;
  denyRemovals = true;
  tabA.clearPanelScratchIf(scope, "sidechat.draft", "on its way",
    tabA.panelScratchRevision(scope, "sidechat.draft"));

  // Tab B's storage is fine, and its write makes the record tab B's.
  denyWrites = false;
  denyRemovals = false;
  tabB.writePanelScratch(scope, "files.directory", "packages/protocol");
  const theirs = backing.get(`${RECORD_PREFIX}${scope}`);
  assert.ok(theirs, "the other tab wrote while this one could not");

  // Removals come back for tab A while its writes are still refused: the exact recovery order that
  // used to hand it a claim on whatever it read back.
  denyWrites = true;
  tabA.writePanelScratch(scope, "files.directory", "apps");
  assert.equal(backing.get(`${RECORD_PREFIX}${scope}`), theirs,
    "the other tab's record survives the recovery");

  denyWrites = false;
  tabB.dropPanelScratchMemory();
  assert.equal(tabB.readPanelScratch(scope, "files.directory"), "packages/protocol");
});

test("a tab that can write again takes back only its own stale record", () => {
  // The other half of the same rule: when the stale record really is this tab's, leaving it there
  // would restore the message it just sent, in the box, inviting a second send.
  const mine = tabA.panelScratchScopeKey("session-a");
  const theirs = tabB.panelScratchScopeKey("session-b");
  openOnEmptyOrigin(tabB);
  tabA.writePanelScratch(mine, "sidechat.draft", "on its way", "draft");
  tabA.writePanelScratch(mine, "files.directory", "apps/web");
  tabB.writePanelScratch(theirs, "review.requestBody", "the other tab's draft", "draft");

  denyWrites = true;
  tabA.clearPanelScratchIf(mine, "sidechat.draft", "on its way",
    tabA.panelScratchRevision(mine, "sidechat.draft"));

  assert.equal(backing.get(`${RECORD_PREFIX}${mine}`), undefined,
    "the record that could only tell the older story is gone with it");
  assert.ok(backing.get(`${RECORD_PREFIX}${theirs}`), "and the other tab's is untouched");

  denyWrites = false;
  tabA.dropPanelScratchMemory();
  assert.equal(tabA.readPanelScratch(mine, "sidechat.draft"), undefined,
    "no restore, rather than a restore of the sent message");
  assert.equal(tabA.readPanelScratch(theirs, "review.requestBody"), "the other tab's draft");
});
