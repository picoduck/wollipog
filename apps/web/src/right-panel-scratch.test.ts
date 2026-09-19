import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  PANEL_SCRATCH_CLEARED_MARKER_TTL_MS,
  PANEL_SCRATCH_CLEARED_SCOPE_LIMIT,
  PANEL_SCRATCH_PERSIST_CHAR_LIMIT,
  PANEL_SCRATCH_SESSION_LIMIT,
  clearPanelScratch,
  clearPanelScratchIf,
  dropPanelScratchMemory,
  panelScratchRevision,
  panelScratchScopeCount,
  panelScratchScopeKey,
  readPanelScratch,
  restorePanelScratch,
  writePanelScratch,
} from "./right-panel-scratch.js";

/** Where one scope's record lives, spelled the way the module writes it. */
const RECORD_PREFIX = "wollipog.right-panel-scratch.v2:";

/** The single whole-map record #1282 wrote, which #1391 imports once and then retires. */
const WHOLE_MAP_KEY = "wollipog.right-panel-scratch.v1";

const backing = new Map<string, string>();
let denyWrites = false;
let denyRemovals = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  get length(): number {
    return backing.size;
  },
  key: (index: number): string | null => [...backing.keys()][index] ?? null,
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (denyWrites) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    backing.set(key, value);
  },
  removeItem: (key: string) => {
    if (denyRemovals) throw new DOMException("Storage is not available", "SecurityError");
    backing.delete(key);
  },
};

interface StoredRecord {
  version: number;
  writer: string;
  touchedAt: number;
  values: Record<string, { value: string; retention: string; updatedAt: number }>;
  cleared: Record<string, number>;
}

function storedRecordKeys(): string[] {
  return [...backing.keys()].filter((key) => key.startsWith(RECORD_PREFIX));
}

function storedRecord(scope: string): StoredRecord | null {
  const raw = backing.get(`${RECORD_PREFIX}${scope}`);
  return raw === undefined ? null : (JSON.parse(raw) as StoredRecord);
}

/** Everything the origin is spending on scratch, keys included: the ceiling covers the lot. */
function storedChars(): number {
  return storedRecordKeys().reduce((total, key) => total + key.length + backing.get(key)!.length, 0);
}

/** A page reload, as far as this module is concerned: memory goes, storage stays. */
function reload(): void {
  dropPanelScratchMemory();
}

beforeEach(() => {
  denyWrites = false;
  denyRemovals = false;
  clearPanelScratch();
  backing.clear();
});

test("scratch is keyed per session and per control-plane instance", () => {
  const local = panelScratchScopeKey("session-1");
  const other = panelScratchScopeKey("session-2");
  // A remote control plane can hand out the same session id as the local one, so the instance has
  // to be part of the identity or one instance's drafts would surface under the other's session.
  const remote = panelScratchScopeKey("session-1", "remote-alpha");
  assert.notEqual(local, other);
  assert.notEqual(local, remote);

  writePanelScratch(local, "review.requestBody", "local draft");
  assert.equal(readPanelScratch(local, "review.requestBody"), "local draft");
  assert.equal(readPanelScratch(other, "review.requestBody"), undefined);
  assert.equal(readPanelScratch(remote, "review.requestBody"), undefined);
});

test("a rewritten value gets a new revision even when the bytes are unchanged", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "review.requestBody", "same");
  const first = panelScratchRevision(scope, "review.requestBody");
  writePanelScratch(scope, "review.requestBody", "same");
  assert.ok(panelScratchRevision(scope, "review.requestBody") > first, "revisions are monotonic");
  writePanelScratch(scope, "review.requestBody", null);
  assert.equal(panelScratchRevision(scope, "review.requestBody"), 0, "nothing held has no revision");
});

test("a value the body never took ownership of is forgotten rather than pinned", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "review.commitMessage", "edited");
  writePanelScratch(scope, "review.commitMessage", null);
  assert.equal(readPanelScratch(scope, "review.commitMessage"), undefined);
  assert.equal(panelScratchScopeCount(), 0, "an emptied session leaves nothing behind");
  // Forgetting an absent key is not an error: a body mounts holding its default and says so.
  writePanelScratch(scope, "files.directory", null);
  assert.equal(panelScratchScopeCount(), 0);
});

test("a consumed draft is cleared only while it is still the one that was consumed", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "already on its way");
  const sent = panelScratchRevision(scope, "sidechat.draft");

  // The panel that sent this can be unmounted by the time the send succeeds, so the clear happens
  // outside it — and must not take a replacement the user typed after coming back.
  clearPanelScratchIf(scope, "sidechat.draft", "something else", sent);
  assert.equal(readPanelScratch(scope, "sidechat.draft"), "already on its way");

  // Retyping the same message after a remount reads identically, which is exactly why the value
  // compare alone is not the guard: the revision says a different draft is in the box now.
  writePanelScratch(scope, "sidechat.draft", "already on its way");
  assert.notEqual(panelScratchRevision(scope, "sidechat.draft"), sent);
  clearPanelScratchIf(scope, "sidechat.draft", "already on its way", sent);
  assert.equal(readPanelScratch(scope, "sidechat.draft"), "already on its way",
    "a retyped replacement is not the draft that was sent");

  clearPanelScratchIf(scope, "sidechat.draft", "already on its way",
    panelScratchRevision(scope, "sidechat.draft"));
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined);

  // Clearing what was never stored is the ordinary case for a body holding its default.
  clearPanelScratchIf(scope, "sidechat.draft", "", panelScratchRevision(scope, "sidechat.draft"));
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined);
});

test("restore falls back when the stored value is missing or refused", () => {
  const scope = panelScratchScopeKey("session-1");
  const known = (raw: string) => raw === "unified" || raw === "split";
  assert.equal(restorePanelScratch(scope, "review.diffLayout", "unified", known), "unified");

  writePanelScratch(scope, "review.diffLayout", "split");
  assert.equal(restorePanelScratch(scope, "review.diffLayout", "unified", known), "split");

  // A choice this build (or this session) can no longer honour degrades to the default instead of
  // wedging the panel on something it cannot render.
  writePanelScratch(scope, "review.diffLayout", "three-way");
  assert.equal(restorePanelScratch(scope, "review.diffLayout", "unified", known), "unified");

  // Free text has no closed set: whatever was typed comes back verbatim.
  writePanelScratch(scope, "review.requestBody", "  half a sentence");
  assert.equal(restorePanelScratch(scope, "review.requestBody", ""), "  half a sentence");
});

test("the oldest session's recreatable scratch is evicted rather than growing without bound", () => {
  const scopes = Array.from({ length: PANEL_SCRATCH_SESSION_LIMIT + 1 },
    (_unused, index) => panelScratchScopeKey(`session-${index}`));
  for (const scope of scopes) writePanelScratch(scope, "files.directory", scope);
  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT);
  assert.equal(readPanelScratch(scopes[0]!, "files.directory"), undefined, "the idle session went first");
  assert.equal(readPanelScratch(scopes.at(-1)!, "files.directory"), scopes.at(-1));
});

test("eviction is least-recently-used, so a session being read stays", () => {
  const first = panelScratchScopeKey("session-first");
  writePanelScratch(first, "files.directory", "apps/web");
  for (let index = 0; index < PANEL_SCRATCH_SESSION_LIMIT - 1; index += 1) {
    writePanelScratch(panelScratchScopeKey(`session-${index}`), "files.directory", "other");
  }
  // Reading is how a mounting body restores, and it is exactly the signal that a session is still
  // in use — the one being returned to must outlive the ones merely passed through.
  assert.equal(readPanelScratch(first, "files.directory"), "apps/web");
  writePanelScratch(panelScratchScopeKey("session-newest"), "files.directory", "newest");
  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT);
  assert.equal(readPanelScratch(first, "files.directory"), "apps/web");
  assert.equal(readPanelScratch(panelScratchScopeKey("session-0"), "files.directory"), undefined);
});

test("unsent text is exempt from eviction; the idle recreatable scope goes instead", () => {
  // The #1283 walk: a description is left unsent in the oldest scope, then more sessions than the
  // bound allows are opened. Under a plain least-recently-used bound the description is the first
  // thing destroyed, because being the oldest is exactly what it is.
  const writing = panelScratchScopeKey("session-writing");
  writePanelScratch(writing, "review.requestBody", "half a pull request description", "draft");
  const visited = Array.from({ length: PANEL_SCRATCH_SESSION_LIMIT },
    (_unused, index) => panelScratchScopeKey(`session-visited-${index}`));
  for (const scope of visited) writePanelScratch(scope, "files.directory", "apps/web");

  assert.equal(readPanelScratch(writing, "review.requestBody"), "half a pull request description",
    "the draft survives the tour that would have evicted it");
  assert.equal(readPanelScratch(visited[0]!, "files.directory"), undefined,
    "the oldest scope holding only a directory is what the bound spends instead");
  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT);
});

test("a draft's own scope keeps its recreatable values too", () => {
  // Eviction is per scope, so exempting the draft exempts the session holding it: coming back to
  // an unsent description and finding the diff layout reset would be the same surprise, smaller.
  const writing = panelScratchScopeKey("session-writing");
  writePanelScratch(writing, "review.requestBody", "half a description", "draft");
  writePanelScratch(writing, "review.diffLayout", "split");
  for (let index = 0; index < PANEL_SCRATCH_SESSION_LIMIT + 4; index += 1) {
    writePanelScratch(panelScratchScopeKey(`session-${index}`), "files.directory", "apps");
  }
  assert.equal(readPanelScratch(writing, "review.diffLayout"), "split");
});

test("when every scope holds unsent text nothing is discarded, and the bound returns with them", () => {
  // The bound cannot be honoured without destroying something nobody else has a copy of, so it is
  // not honoured: the map carries the drafts above the limit rather than silently eating one.
  const scopes = Array.from({ length: PANEL_SCRATCH_SESSION_LIMIT + 2 },
    (_unused, index) => panelScratchScopeKey(`session-${index}`));
  for (const scope of scopes) writePanelScratch(scope, "sidechat.draft", `unsent in ${scope}`, "draft");
  assert.equal(panelScratchScopeCount(), scopes.length, "every draft is still held");
  for (const scope of scopes) {
    assert.equal(readPanelScratch(scope, "sidechat.draft"), `unsent in ${scope}`);
  }

  // The overshoot lasts exactly as long as the text does. Sending the four oldest messages — one
  // cleared outright, one left as the empty string its composer was reset to — hands those scopes
  // back, and the next writes collect them until the map sits on the limit again.
  for (const scope of scopes.slice(0, 3)) writePanelScratch(scope, "sidechat.draft", null);
  writePanelScratch(scopes[3]!, "sidechat.draft", "", "draft");
  for (let index = 0; index < 4; index += 1) {
    writePanelScratch(panelScratchScopeKey(`session-visited-${index}`), "files.directory", "apps");
  }
  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT, "the bound reasserts itself");
  assert.equal(readPanelScratch(scopes[3]!, "sidechat.draft"), undefined,
    "a composer emptied after sending is not unsent text and pins nothing");
  for (const scope of scopes.slice(4)) {
    assert.equal(readPanelScratch(scope, "sidechat.draft"), `unsent in ${scope}`,
      "the messages still unsent were never candidates");
  }
});

test("a sent draft releases its scope to the bound on the spot", () => {
  // Eviction used to run only on writes, so a scope released by a send that still held a browsed
  // directory sat above the limit until some unrelated write happened to collect it. Removal is a
  // mutation like any other and reasserts the bound itself.
  const scopes = Array.from({ length: PANEL_SCRATCH_SESSION_LIMIT + 1 },
    (_unused, index) => panelScratchScopeKey(`session-${index}`));
  for (const scope of scopes) {
    writePanelScratch(scope, "sidechat.draft", "unsent", "draft");
    writePanelScratch(scope, "files.directory", "apps/web");
  }
  assert.equal(panelScratchScopeCount(), scopes.length, "every scope is holding a message");

  // The scope this send released is now the most recently used one, so it is not what a
  // least-recently-used bound takes: collecting it would discard the browsed directory of the
  // session the user is looking at while eight idle ones keep theirs. Every other scope is still
  // holding text, so this send deliberately leaves the map one over the bound.
  writePanelScratch(scopes[1]!, "sidechat.draft", null);
  assert.equal(panelScratchScopeCount(), scopes.length);
  assert.equal(readPanelScratch(scopes[1]!, "files.directory"), "apps/web",
    "the session being used keeps its directory");

  writePanelScratch(scopes[0]!, "sidechat.draft", null);
  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT,
    "the second send collects the scope released by the first, without waiting for a later write");
  assert.equal(readPanelScratch(scopes[1]!, "files.directory"), undefined,
    "the least recently used released scope is the one the bound takes");
  assert.equal(readPanelScratch(scopes[0]!, "files.directory"), "apps/web");
});

test("blank text is not a draft, so an untouched composer cannot pin a scope", () => {
  const blank = panelScratchScopeKey("session-blank");
  writePanelScratch(blank, "review.requestBody", "   \n  ", "draft");
  for (let index = 0; index < PANEL_SCRATCH_SESSION_LIMIT; index += 1) {
    writePanelScratch(panelScratchScopeKey(`session-${index}`), "files.directory", "apps");
  }
  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT);
  assert.equal(readPanelScratch(blank, "review.requestBody"), undefined,
    "whitespace is nothing to protect");
});

test("what the panel was holding comes back after a reload", () => {
  // The #1282 walk: everything the panel remembers across a mode switch has to survive the reload
  // that used to be the one thing guaranteed to destroy it.
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "review.requestBody", "half a pull request description", "draft");
  writePanelScratch(scope, "files.directory", "apps/web");
  writePanelScratch(scope, "browser.mode", "web");

  reload();

  assert.equal(readPanelScratch(scope, "review.requestBody"), "half a pull request description");
  assert.equal(readPanelScratch(scope, "files.directory"), "apps/web");
  assert.equal(restorePanelScratch(scope, "browser.mode", "artifacts",
    (raw) => raw === "artifacts" || raw === "web"), "web");
  // Another session is still another session: the record is flat, but its entries are not shared.
  assert.equal(readPanelScratch(panelScratchScopeKey("session-2"), "files.directory"), undefined);
  assert.equal(readPanelScratch(panelScratchScopeKey("session-1", "remote-alpha"), "files.directory"),
    undefined, "nor is one control-plane instance's session another's");
});

test("a restored draft is still a draft, so the reload does not cost it its exemption", () => {
  const writing = panelScratchScopeKey("session-writing");
  writePanelScratch(writing, "review.requestBody", "half a description", "draft");
  const browsing = panelScratchScopeKey("session-browsing");
  writePanelScratch(browsing, "files.directory", "apps/web");

  reload();

  // Retention is what the exemption reads, so a record that dropped it would hand back the text and
  // then let the next tour of other sessions destroy it — a slower version of the #1283 loss.
  for (let index = 0; index < PANEL_SCRATCH_SESSION_LIMIT; index += 1) {
    writePanelScratch(panelScratchScopeKey(`session-${index}`), "files.directory", "apps");
  }
  assert.equal(readPanelScratch(writing, "review.requestBody"), "half a description");
  assert.equal(readPanelScratch(browsing, "files.directory"), undefined,
    "the recreatable scope is what the bound spent");
});

test("a sent draft stays sent across a reload", () => {
  // Removal is mirrored like any other mutation. A record that only ever grew would hand back the
  // message the user already sent, in the box, as though it had not been.
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  clearPanelScratchIf(scope, "sidechat.draft", "on its way", panelScratchRevision(scope, "sidechat.draft"));

  reload();

  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined);
  const record = storedRecord(scope);
  assert.deepEqual(record?.values, {}, "nothing is left for a reload to restore");
  assert.ok(record?.cleared["sidechat.draft"], "only the marker that keeps it sent (#1391)");
});

test("a scope with nothing left to say is collected rather than kept as an empty record", () => {
  const scope = panelScratchScopeKey("session-1");
  // Never a value, so nothing about this deletion is worth a marker: a body reporting that it owns
  // no value under a key it never wrote must not spend the marker budget on saying so.
  writePanelScratch(scope, "files.directory", null);
  assert.equal(storedRecordKeys().length, 0);

  writePanelScratch(scope, "files.directory", "apps/web");
  assert.equal(storedRecordKeys().length, 1);
  writePanelScratch(scope, "files.directory", null);
  assert.deepEqual(storedRecord(scope)?.values, {}, "the value is gone");
  assert.ok(storedRecord(scope)?.cleared["files.directory"], "and a marker keeps it gone");
});

test("what the bound evicted does not come back on reload", () => {
  const scopes = Array.from({ length: PANEL_SCRATCH_SESSION_LIMIT + 1 },
    (_unused, index) => panelScratchScopeKey(`session-${index}`));
  for (const scope of scopes) writePanelScratch(scope, "files.directory", scope);

  assert.equal(storedRecordKeys().length, PANEL_SCRATCH_SESSION_LIMIT,
    "the sweep holds the records to the same bound the map holds");

  reload();

  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT);
  assert.equal(readPanelScratch(scopes[0]!, "files.directory"), undefined,
    "the scope the bound took is gone from storage too");
  assert.equal(readPanelScratch(scopes.at(-1)!, "files.directory"), scopes.at(-1));
});

test("what the whole-map record was holding is taken over and the record retired", () => {
  // #1282's record is where a user's unsent text actually is when this build first runs, so
  // ignoring it would destroy exactly what that change was for.
  const writing = panelScratchScopeKey("session-writing");
  const browsing = panelScratchScopeKey("session-browsing");
  backing.set(WHOLE_MAP_KEY, JSON.stringify({
    version: 1,
    scopes: [
      { scope: browsing, values: { "files.directory": { value: "apps/web", retention: "disposable" } } },
      { scope: writing, values: { "review.requestBody": { value: "half a description", retention: "draft" } } },
    ],
  }));

  reload();

  assert.equal(readPanelScratch(writing, "review.requestBody"), "half a description");
  assert.equal(readPanelScratch(browsing, "files.directory"), "apps/web");
  assert.equal(backing.get(WHOLE_MAP_KEY), undefined, "and the record it came from is retired");
  assert.equal(storedRecordKeys().length, 2, "as a record per scope");

  // Retention comes across with it, or the restored draft would lose the exemption that protects
  // it from the very next tour of other sessions.
  for (let index = 0; index < PANEL_SCRATCH_SESSION_LIMIT; index += 1) {
    writePanelScratch(panelScratchScopeKey(`session-${index}`), "files.directory", "apps");
  }
  reload();
  assert.equal(readPanelScratch(writing, "review.requestBody"), "half a description");
  assert.equal(readPanelScratch(browsing, "files.directory"), undefined);
});

test("a whole-map record that is unreadable is retired rather than retried forever", () => {
  backing.set(WHOLE_MAP_KEY, "{not json at all");
  reload();
  assert.equal(panelScratchScopeCount(), 0);
  assert.equal(backing.get(WHOLE_MAP_KEY), undefined);
});

test("a corrupt record degrades to no scratch rather than wedging the panel", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "files.directory", "apps/web");
  backing.set(`${RECORD_PREFIX}${scope}`, "{not json at all");

  reload();

  assert.equal(readPanelScratch(scope, "files.directory"), undefined);
  assert.equal(backing.get(`${RECORD_PREFIX}${scope}`), undefined,
    "unreadable bytes are not left paying rent");
  // And the panel goes on working: the next thing written is remembered, and survives the next one.
  writePanelScratch(scope, "files.directory", "apps");
  reload();
  assert.equal(readPanelScratch(scope, "files.directory"), "apps");
});

test("a record of the wrong shape or version is refused whole", () => {
  const scope = panelScratchScopeKey("session-1");
  const refused = [
    '{"version":1,"scopes":[]}',
    '{"version":2,"values":{}}',
    '{"version":2,"touchedAt":"soon","values":{}}',
    '{"version":2,"touchedAt":1,"values":[],"cleared":[]}',
    '"values"',
    "null",
  ];
  for (const raw of refused) {
    clearPanelScratch();
    backing.set(`${RECORD_PREFIX}${scope}`, raw);
    reload();
    assert.equal(panelScratchScopeCount(), 0, `refused: ${raw}`);
    assert.equal(backing.get(`${RECORD_PREFIX}${scope}`), undefined, `collected: ${raw}`);
  }
});

test("one corrupt entry costs only itself", () => {
  // A single hand-edited or stale value must not be able to wipe every other session's drafts on
  // every reload, so validation is per value and per record rather than all or nothing.
  const scope = panelScratchScopeKey("session-1");
  const other = panelScratchScopeKey("session-2");
  backing.set(`${RECORD_PREFIX}${other}`, "{ not a record");
  backing.set(`${RECORD_PREFIX}`, JSON.stringify({
    version: 2, writer: "another-page", touchedAt: 1,
    values: { "files.directory": { value: "no scope at all", retention: "disposable", updatedAt: 1 } },
    cleared: {},
  }));
  backing.set(`${RECORD_PREFIX}${scope}`, JSON.stringify({
    version: 2,
    writer: "another-page",
    touchedAt: 2,
    values: {
      "files.directory": { value: "apps/web", retention: "disposable", updatedAt: 1 },
      "review.requestBody": { value: "kept", retention: "draft", updatedAt: 1 },
      "review.branch": { value: 42, retention: "draft", updatedAt: 1 },
      "review.requestTitle": { value: "no retention", updatedAt: 1 },
      "browser.mode": { value: "web", retention: "sometimes", updatedAt: 1 },
      "browser.address": "a bare string",
      "review.diffLayout": { value: "split", retention: "disposable" },
    },
    cleared: { "sidechat.draft": "whenever" },
  }));

  reload();

  assert.equal(panelScratchScopeCount(), 1, "only the one usable record was restored");
  assert.equal(readPanelScratch(scope, "files.directory"), "apps/web");
  assert.equal(readPanelScratch(scope, "review.requestBody"), "kept");
  for (const key of ["review.branch", "review.requestTitle", "browser.mode", "browser.address",
    "review.diffLayout"]) {
    assert.equal(readPanelScratch(scope, key), undefined, `dropped: ${key}`);
  }
  assert.equal(backing.get(`${RECORD_PREFIX}${other}`), undefined, "and the unreadable one is collected");
});

test("storage that refuses every write leaves the panel exactly as it was", () => {
  // Private mode, a restricted webview, an exhausted quota. The map is authoritative while the page
  // lives, so the only thing a refusal costs is the reload after it.
  denyWrites = true;
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "review.requestBody", "half a description", "draft");
  assert.equal(readPanelScratch(scope, "review.requestBody"), "half a description");

  reload();

  assert.equal(readPanelScratch(scope, "review.requestBody"), undefined);
  denyWrites = false;
  writePanelScratch(scope, "review.requestBody", "typed again", "draft");
  reload();
  assert.equal(readPanelScratch(scope, "review.requestBody"), "typed again",
    "a storage that comes back is used again");
});

test("storage that cannot be enumerated degrades to no restore", () => {
  // The prefix is the index, so a storage without `key`/`length` has no records to find. That is
  // the same no-restore every other unusable storage degrades to, and it must not throw.
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "review.requestBody", "half a description", "draft");
  const enumerable = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
    removeItem: (key: string) => { backing.delete(key); },
  };
  try {
    reload();
    assert.equal(readPanelScratch(scope, "review.requestBody"), undefined);
    writePanelScratch(scope, "files.directory", "apps/web");
    assert.equal(readPanelScratch(scope, "files.directory"), "apps/web",
      "and the panel goes on working");
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = enumerable;
  }
});

test("a refused write leaves no older record behind to restore instead", () => {
  // A refusal after something was already stored is the dangerous one: the record left in place
  // describes a scope the page has moved past. Restoring it would hand back superseded text — and
  // in the worst case a message the user already sent, back in the box, inviting a second send.
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  // A second value, so the scope outlives the send and the mirror has a record to write rather than
  // an empty one to remove — the refusal has to be what clears it.
  writePanelScratch(scope, "files.directory", "apps/web");
  assert.ok(backing.get(`${RECORD_PREFIX}${scope}`), "the first writes were stored");

  denyWrites = true;
  clearPanelScratchIf(scope, "sidechat.draft", "on its way", panelScratchRevision(scope, "sidechat.draft"));
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined, "memory is right either way");
  assert.equal(backing.get(`${RECORD_PREFIX}${scope}`), undefined,
    "the record that could only tell the older story is gone with it");

  reload();
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined,
    "no restore, rather than a restore of the sent message");
  assert.equal(readPanelScratch(scope, "files.directory"), undefined,
    "this scope's record went, because that is the unit a page can speak for");

  // The next write that is allowed through puts the scope back, so the gap is one mutation wide.
  denyWrites = false;
  writePanelScratch(scope, "files.directory", "apps");
  reload();
  assert.equal(readPanelScratch(scope, "files.directory"), "apps");
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined);
});

test("a refused write takes back only this page's own records, never another's", () => {
  // Taking a record back is a correction of this page's own stale story. Another tab's record is
  // that tab's latest state, and deleting it would cost that tab exactly the reload this module
  // exists for — to fix a story it never told. See right-panel-scratch.tabs.test.ts for the same
  // rule driven through two real pages.
  const mine = panelScratchScopeKey("session-mine");
  const theirs = panelScratchScopeKey("session-theirs");
  writePanelScratch(mine, "review.requestBody", "my draft", "draft");
  const foreign = JSON.stringify({
    version: 2,
    writer: "another-page",
    touchedAt: Date.now(),
    values: {
      "review.requestBody": { value: "the other tab's unsent draft", retention: "draft", updatedAt: 1 },
    },
    cleared: {},
  });
  backing.set(`${RECORD_PREFIX}${theirs}`, foreign);

  denyWrites = true;
  writePanelScratch(mine, "review.requestBody", "my draft, longer", "draft");
  assert.equal(backing.get(`${RECORD_PREFIX}${theirs}`), foreign,
    "the record that is not ours is left where it is");
  assert.equal(backing.get(`${RECORD_PREFIX}${mine}`), undefined, "and ours is taken back");

  denyWrites = false;
  reload();
  assert.equal(readPanelScratch(theirs, "review.requestBody"), "the other tab's unsent draft",
    "and it is still there to be restored from");
});

test("a removal that did not take leaves the record still this page's to take back", () => {
  // Removal is best-effort and reports nothing, so a storage refusing writes can refuse the removal
  // too. Surrendering ownership then would leave the obsolete record with nobody entitled to
  // correct it, which is the whole reason the writer id is stored rather than inferred.
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  writePanelScratch(scope, "files.directory", "apps/web");
  const stale = backing.get(`${RECORD_PREFIX}${scope}`);

  denyWrites = true;
  denyRemovals = true;
  clearPanelScratchIf(scope, "sidechat.draft", "on its way", panelScratchRevision(scope, "sidechat.draft"));
  assert.equal(backing.get(`${RECORD_PREFIX}${scope}`), stale,
    "nothing could be written and nothing could be removed");

  // Removals come back while writes are still refused — a quota that eased, a permission that did
  // not. The record is still the one this page left, so this write is the one that retracts it.
  denyRemovals = false;
  writePanelScratch(scope, "files.directory", "apps");
  assert.equal(backing.get(`${RECORD_PREFIX}${scope}`), undefined,
    "taken back on the first chance to do it");

  reload();
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined,
    "the sent message never comes back");
});

test("what is stored is bounded even where the map deliberately is not", () => {
  // Unsent text is exempt from the scope bound, and a form that keeps its text after submitting
  // holds its scope for as long as it is mounted (#1375). In memory that overshoot ends with the
  // tab; persisted it would not, so storage has a ceiling that waits on nobody.
  const long = "x".repeat(50_000);
  const scopes = Array.from({ length: 12 }, (_unused, index) => panelScratchScopeKey(`session-${index}`));
  for (const scope of scopes) writePanelScratch(scope, "review.requestBody", `${scope}:${long}`, "draft");
  assert.equal(panelScratchScopeCount(), scopes.length, "memory still holds every draft");
  assert.ok(storedChars() <= PANEL_SCRATCH_PERSIST_CHAR_LIMIT,
    `stored ${storedChars()} characters, ceiling ${PANEL_SCRATCH_PERSIST_CHAR_LIMIT}`);

  reload();

  // The newest state is what a reload most wants back, so the ceiling is spent from that end.
  assert.equal(readPanelScratch(scopes.at(-1)!, "review.requestBody"), `${scopes.at(-1)}:${long}`);
  assert.equal(readPanelScratch(scopes[0]!, "review.requestBody"), undefined,
    "the oldest draft is the one the ceiling could not carry");
});

test("one outsized draft costs only its own scope its place", () => {
  const huge = panelScratchScopeKey("session-huge");
  const modest = panelScratchScopeKey("session-modest");
  writePanelScratch(modest, "review.requestBody", "a paragraph", "draft");
  writePanelScratch(huge, "review.requestBody", "y".repeat(PANEL_SCRATCH_PERSIST_CHAR_LIMIT + 1), "draft");

  reload();

  // Skipping rather than stopping at the first thing that does not fit: the giant is the most
  // recently used, and stopping there would have cost every older scope its persistence too.
  assert.equal(readPanelScratch(huge, "review.requestBody"), undefined);
  assert.equal(readPanelScratch(modest, "review.requestBody"), "a paragraph");
});

test("deletion markers are bounded too, and never at live scratch's expense", () => {
  // A marker outlives the value it retires, which is the point — but a marker per session ever sent
  // from would grow with the tracker, so the layer that keeps drafts from coming back has a bound
  // of its own, counted apart from the scopes still holding something.
  const marked = Array.from({ length: PANEL_SCRATCH_CLEARED_SCOPE_LIMIT + 4 },
    (_unused, index) => panelScratchScopeKey(`session-sent-${index}`));
  for (const scope of marked) {
    writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
    clearPanelScratchIf(scope, "sidechat.draft", "on its way", panelScratchRevision(scope, "sidechat.draft"));
  }
  const live = Array.from({ length: PANEL_SCRATCH_SESSION_LIMIT },
    (_unused, index) => panelScratchScopeKey(`session-live-${index}`));
  for (const scope of live) writePanelScratch(scope, "files.directory", "apps/web");

  const records = storedRecordKeys().map((key) => key.slice(RECORD_PREFIX.length));
  const markerOnly = records.filter((scope) => Object.keys(storedRecord(scope)!.values).length === 0);
  assert.equal(markerOnly.length, PANEL_SCRATCH_CLEARED_SCOPE_LIMIT,
    "the marker layer has its own bound");
  assert.equal(records.length - markerOnly.length, PANEL_SCRATCH_SESSION_LIMIT,
    "and it did not spend the budget live scratch needs");
  assert.equal(storedRecord(marked[0]!), null, "the oldest markers are what the bound took");
  assert.ok(storedRecord(marked.at(-1)!)?.cleared["sidechat.draft"], "the newest are kept");
});

test("a deletion marker is retired once it is older than any page still holding the draft", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  clearPanelScratchIf(scope, "sidechat.draft", "on its way", panelScratchRevision(scope, "sidechat.draft"));
  const record = storedRecord(scope)!;
  assert.ok(record.cleared["sidechat.draft"]);

  // Age it past the window. Nothing can still be holding the sent message by then, so the marker is
  // only costing storage.
  backing.set(`${RECORD_PREFIX}${scope}`, JSON.stringify({
    ...record,
    cleared: { "sidechat.draft": Date.now() - PANEL_SCRATCH_CLEARED_MARKER_TTL_MS - 1 },
  }));

  reload();

  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined);
  assert.equal(backing.get(`${RECORD_PREFIX}${scope}`), undefined,
    "an expired marker leaves nothing behind to pay for");
});
