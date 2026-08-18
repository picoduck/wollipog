import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  captureComposerFocus,
  focusComposerAtEnd,
  placeComposerCaretAtEnd,
  rememberComposerFocusForRemount,
  restoreComposerFocus,
  restoreRememberedComposerFocus,
} from "./composer-focus.js";

function setup(value: string) {
  const window = new Window();
  const transcript = window.document.createElement("div");
  transcript.tabIndex = 0;
  const composer = window.document.createElement("textarea");
  composer.value = value;
  window.document.body.append(transcript, composer);
  Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 320 });
  return { transcript, composer };
}

test("reply focus appends typing to an existing multiline draft and reveals its end", () => {
  const { transcript, composer } = setup("first line\npartial reply");
  composer.focus();
  transcript.focus(); // The Escape ladder returns focus to the transcript before R is pressed.

  assert.equal(focusComposerAtEnd(composer), true);
  assert.equal(composer.ownerDocument.activeElement, composer);
  assert.equal(composer.selectionStart, composer.value.length);
  assert.equal(composer.selectionEnd, composer.value.length);
  assert.equal(composer.scrollTop, composer.scrollHeight);

  composer.setRangeText(" continued", composer.selectionStart, composer.selectionEnd, "end");
  assert.equal(composer.value, "first line\npartial reply continued");
});

test("reply focus preserves a selection in an already-active composer", () => {
  const { composer } = setup("keep this selection");
  composer.focus();
  composer.setSelectionRange(5, 9);

  assert.equal(focusComposerAtEnd(composer), false);
  assert.deepEqual([composer.selectionStart, composer.selectionEnd], [5, 9]);
});

test("composition prevents selection changes during focus and hydration restoration", () => {
  const { transcript, composer } = setup("composing");
  let selectionChanges = 0;
  const setSelectionRange = composer.setSelectionRange.bind(composer);
  composer.setSelectionRange = (...args) => {
    selectionChanges += 1;
    setSelectionRange(...args);
  };
  transcript.focus();

  assert.equal(focusComposerAtEnd(composer, true), false);
  assert.equal(composer.ownerDocument.activeElement, composer);
  assert.equal(placeComposerCaretAtEnd(composer, true), false);
  assert.equal(selectionChanges, 0);
});

test("exact focus restoration rejects value drift and preserves saved geometry", () => {
  const { transcript, composer } = setup("focus geometry");
  composer.focus();
  composer.setSelectionRange(2, 8, "backward");
  composer.scrollTop = 41;
  const snapshot = captureComposerFocus(composer);
  transcript.focus();

  assert.equal(restoreComposerFocus(composer, snapshot), false, "an active control owns focus");
  assert.equal(restoreComposerFocus(composer, snapshot, true), true);
  assert.deepEqual(
    [composer.selectionStart, composer.selectionEnd, composer.selectionDirection, composer.scrollTop],
    [2, 8, "backward", 41],
  );

  composer.value = "short";
  assert.equal(restoreComposerFocus(composer, snapshot, true), false, "value drift invalidates the snapshot");
});

test("remount memory is one-shot, same-key, and evicts a different session", () => {
  const first = setup("first").composer;
  const replacement = setup("first").composer;
  rememberComposerFocusForRemount("scope\u0000first", first);
  assert.ok(restoreRememberedComposerFocus("scope\u0000first", replacement));
  assert.equal(restoreRememberedComposerFocus("scope\u0000first", replacement), null);

  rememberComposerFocusForRemount("scope\u0000first", first);
  assert.equal(restoreRememberedComposerFocus("scope\u0000second", replacement), null);
  assert.equal(restoreRememberedComposerFocus("scope\u0000first", replacement), null);
});
