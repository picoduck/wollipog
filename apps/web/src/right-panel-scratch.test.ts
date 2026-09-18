import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  PANEL_SCRATCH_SESSION_LIMIT,
  clearPanelScratch,
  clearPanelScratchIf,
  panelScratchRevision,
  panelScratchScopeCount,
  panelScratchScopeKey,
  readPanelScratch,
  restorePanelScratch,
  writePanelScratch,
} from "./right-panel-scratch.js";

beforeEach(() => clearPanelScratch());

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

  writePanelScratch(scopes[1]!, "sidechat.draft", null);
  assert.equal(panelScratchScopeCount(), scopes.length,
    "one send leaves nothing else evictable: every other scope is still holding text");

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
