import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { focusComposerAtEnd, placeComposerCaretAtEnd } from "./composer-focus.js";

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
