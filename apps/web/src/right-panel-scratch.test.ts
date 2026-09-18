import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  PANEL_SCRATCH_SESSION_LIMIT,
  clearPanelScratch,
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

test("a value equal to the body's own default is forgotten rather than pinned", () => {
  const scope = panelScratchScopeKey("session-1");
  writePanelScratch(scope, "review.commitMessage", "edited");
  writePanelScratch(scope, "review.commitMessage", null);
  assert.equal(readPanelScratch(scope, "review.commitMessage"), undefined);
  assert.equal(panelScratchScopeCount(), 0, "an emptied session leaves nothing behind");
  // Forgetting an absent key is not an error: a body mounts holding its default and says so.
  writePanelScratch(scope, "files.directory", null);
  assert.equal(panelScratchScopeCount(), 0);
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

test("the oldest session's scratch is evicted rather than growing without bound", () => {
  const scopes = Array.from({ length: PANEL_SCRATCH_SESSION_LIMIT + 1 },
    (_unused, index) => panelScratchScopeKey(`session-${index}`));
  for (const scope of scopes) writePanelScratch(scope, "review.requestBody", scope);
  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT);
  assert.equal(readPanelScratch(scopes[0]!, "review.requestBody"), undefined, "the idle session went first");
  assert.equal(readPanelScratch(scopes.at(-1)!, "review.requestBody"), scopes.at(-1));
});

test("eviction is least-recently-used, so a session being read stays", () => {
  const first = panelScratchScopeKey("session-first");
  writePanelScratch(first, "review.requestBody", "still writing this");
  for (let index = 0; index < PANEL_SCRATCH_SESSION_LIMIT - 1; index += 1) {
    writePanelScratch(panelScratchScopeKey(`session-${index}`), "review.requestBody", "other");
  }
  // Reading is how a mounting body restores, and it is exactly the signal that a session is still
  // in use — the draft being returned to must outlive the ones merely passed through.
  assert.equal(readPanelScratch(first, "review.requestBody"), "still writing this");
  writePanelScratch(panelScratchScopeKey("session-newest"), "review.requestBody", "newest");
  assert.equal(panelScratchScopeCount(), PANEL_SCRATCH_SESSION_LIMIT);
  assert.equal(readPanelScratch(first, "review.requestBody"), "still writing this");
  assert.equal(readPanelScratch(panelScratchScopeKey("session-0"), "review.requestBody"), undefined);
});
