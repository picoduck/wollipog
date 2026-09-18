import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
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

/** The record the map is mirrored into, spelled the way the module writes it. */
const PERSIST_KEY = "wollipog.right-panel-scratch.v1";

const backing = new Map<string, string>();
let denyWrites = false;
let denyRemovals = false;
(globalThis as { localStorage?: unknown }).localStorage = {
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
  assert.equal(backing.get(PERSIST_KEY), undefined, "an empty map leaves no record behind");
});

test("what the bound evicted does not come back on reload", () => {
  const scopes = Array.from({ length: PANEL_SCRATCH_SESSION_LIMIT + 1 },
    (_unused, index) => panelScratchScopeKey(`session-${index}`));
  for (const scope of scopes) writePanelScratch(scope, "files.directory", scope);

  reload();

  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT);
  assert.equal(readPanelScratch(scopes[0]!, "files.directory"), undefined,
    "the scope the bound took is gone from storage too");
  assert.equal(readPanelScratch(scopes.at(-1)!, "files.directory"), scopes.at(-1));
});

test("a corrupt record degrades to no scratch rather than wedging the panel", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "files.directory", "apps/web");
  backing.set(PERSIST_KEY, "{not json at all");

  reload();

  assert.equal(readPanelScratch(scope, "files.directory"), undefined);
  assert.equal(backing.get(PERSIST_KEY), undefined, "unreadable bytes are not left paying rent");
  // And the panel goes on working: the next thing written is remembered, and survives the next one.
  writePanelScratch(scope, "files.directory", "apps");
  reload();
  assert.equal(readPanelScratch(scope, "files.directory"), "apps");
});

test("a record of the wrong shape or version is refused whole", () => {
  for (const raw of ['{"version":2,"scopes":[]}', '{"version":1,"scopes":{}}', '"scopes"', "null"]) {
    clearPanelScratch();
    backing.set(PERSIST_KEY, raw);
    reload();
    assert.equal(panelScratchScopeCount(), 0, `refused: ${raw}`);
  }
});

test("one corrupt entry costs only itself", () => {
  // A single hand-edited or stale value must not be able to wipe every other session's drafts on
  // every reload, so validation is per value and per scope rather than all or nothing.
  const scope = panelScratchScopeKey("session-1");
  backing.set(PERSIST_KEY, JSON.stringify({
    version: 1,
    scopes: [
      "not a scope at all",
      { scope: "", values: { "files.directory": { value: "apps", retention: "disposable" } } },
      { scope: panelScratchScopeKey("session-empty"), values: null },
      {
        scope,
        values: {
          "files.directory": { value: "apps/web", retention: "disposable" },
          "review.requestBody": { value: "kept", retention: "draft" },
          "review.branch": { value: 42, retention: "draft" },
          "review.requestTitle": { value: "no retention" },
          "browser.mode": { value: "web", retention: "sometimes" },
          "browser.address": "a bare string",
        },
      },
    ],
  }));

  reload();

  assert.equal(panelScratchScopeCount(), 1, "only the one usable scope was restored");
  assert.equal(readPanelScratch(scope, "files.directory"), "apps/web");
  assert.equal(readPanelScratch(scope, "review.requestBody"), "kept");
  for (const key of ["review.branch", "review.requestTitle", "browser.mode", "browser.address"]) {
    assert.equal(readPanelScratch(scope, key), undefined, `dropped: ${key}`);
  }
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

test("a refused write leaves no older record behind to restore instead", () => {
  // A refusal after something was already stored is the dangerous one: the record left in place
  // describes a map the page has moved past. Restoring it would hand back superseded text — and in
  // the worst case a message the user already sent, back in the box, inviting a second send.
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  // A second value, so the scope outlives the send and the mirror has a record to write rather than
  // an empty map to remove — the refusal has to be what clears it.
  writePanelScratch(scope, "files.directory", "apps/web");
  assert.ok(backing.get(PERSIST_KEY), "the first writes were stored");

  denyWrites = true;
  clearPanelScratchIf(scope, "sidechat.draft", "on its way", panelScratchRevision(scope, "sidechat.draft"));
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined, "memory is right either way");
  assert.equal(backing.get(PERSIST_KEY), undefined,
    "the record that could only tell the older story is gone with it");

  reload();
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined,
    "no restore, rather than a restore of the sent message");
  assert.equal(readPanelScratch(scope, "files.directory"), undefined,
    "the whole record went, because the record is only ever written whole");

  // The next write that is allowed through puts the whole map back, so the gap is one mutation wide.
  denyWrites = false;
  writePanelScratch(scope, "files.directory", "apps");
  reload();
  assert.equal(readPanelScratch(scope, "files.directory"), "apps");
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined);
});

test("a refused write takes back only this tab's own record, never another's", () => {
  // Taking a record back is a correction of this tab's own stale story. Another tab writing since
  // makes the record that tab's latest state, and deleting it would cost that tab exactly the
  // reload this module exists for — to fix a lie it never told.
  const mine = panelScratchScopeKey("session-mine");
  writePanelScratch(mine, "review.requestBody", "my draft", "draft");
  const foreign = JSON.stringify({
    version: 1,
    scopes: [{
      scope: panelScratchScopeKey("session-theirs"),
      values: { "review.requestBody": { value: "the other tab's unsent draft", retention: "draft" } },
    }],
  });
  backing.set(PERSIST_KEY, foreign);

  denyWrites = true;
  writePanelScratch(mine, "review.requestBody", "my draft, longer", "draft");
  assert.equal(backing.get(PERSIST_KEY), foreign, "the record that is not ours is left where it is");

  denyWrites = false;
  reload();
  assert.equal(readPanelScratch(panelScratchScopeKey("session-theirs"), "review.requestBody"),
    "the other tab's unsent draft", "and it is still there to be restored from");
});

test("a removal that did not take leaves the record still this tab's to take back", () => {
  // Removal is best-effort and reports nothing, so a storage refusing writes can refuse the removal
  // too. Assuming it worked would hand back ownership of a record still sitting there, and the next
  // refused write would no longer recognise it — leaving the obsolete record to be restored.
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "sidechat.draft", "on its way", "draft");
  writePanelScratch(scope, "files.directory", "apps/web");
  const stale = backing.get(PERSIST_KEY);

  denyWrites = true;
  denyRemovals = true;
  clearPanelScratchIf(scope, "sidechat.draft", "on its way", panelScratchRevision(scope, "sidechat.draft"));
  assert.equal(backing.get(PERSIST_KEY), stale, "nothing could be written and nothing could be removed");

  // Removals come back while writes are still refused — a quota that eased, a permission that did
  // not. The record is still the one this tab left, so this write is the one that retracts it.
  denyRemovals = false;
  writePanelScratch(scope, "files.directory", "apps");
  assert.equal(backing.get(PERSIST_KEY), undefined, "taken back on the first chance to do it");

  reload();
  assert.equal(readPanelScratch(scope, "sidechat.draft"), undefined,
    "the sent message never comes back");
});

test("the stored record is bounded even where the map deliberately is not", () => {
  // Unsent text is exempt from the scope bound, and a form that keeps its text after submitting
  // holds its scope for as long as it is mounted (#1375). In memory that overshoot ends with the
  // tab; persisted it would not, so the record has a ceiling that waits on nobody.
  const long = "x".repeat(50_000);
  const scopes = Array.from({ length: 12 }, (_unused, index) => panelScratchScopeKey(`session-${index}`));
  for (const scope of scopes) writePanelScratch(scope, "review.requestBody", `${scope}:${long}`, "draft");
  assert.equal(panelScratchScopeCount(), scopes.length, "memory still holds every draft");
  assert.ok(backing.get(PERSIST_KEY)!.length <= PANEL_SCRATCH_PERSIST_CHAR_LIMIT,
    "the record stays under its ceiling");

  reload();

  // The newest state is what a reload most wants back, so the ceiling is spent from that end.
  assert.equal(readPanelScratch(scopes.at(-1)!, "review.requestBody"), `${scopes.at(-1)}:${long}`);
  assert.equal(readPanelScratch(scopes[0]!, "review.requestBody"), undefined,
    "the oldest draft is the one the ceiling could not carry");
});

test("one outsized draft costs only its own scope its place in the record", () => {
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
