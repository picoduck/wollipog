import assert from "node:assert/strict";
import test from "node:test";
import { newRowsLabel, notSentLabel, transcriptTailView } from "./TranscriptTailControl.js";

const idle = { hasTail: true, offscreenNotSent: 0, recovering: false, following: true, newRows: 0 };

test("the tail control says nothing at an idle tail or without a tail", () => {
  assert.equal(transcriptTailView(idle), null);
  for (const state of [
    { offscreenNotSent: 1 },
    { recovering: true },
    { following: false, newRows: 3 },
  ]) {
    assert.equal(transcriptTailView({ ...idle, ...state, hasTail: false }), null,
      "loading, empty and history-error transcripts have no tail to speak about");
  }
});

test("the tail control shows the highest-priority state only", () => {
  const everything = { ...idle, offscreenNotSent: 2, recovering: true, following: false, newRows: 3 };
  assert.deepEqual(transcriptTailView(everything), { kind: "not-sent", count: 2 });
  assert.deepEqual(transcriptTailView({ ...everything, offscreenNotSent: 0 }), { kind: "recovering" });
  assert.deepEqual(transcriptTailView({ ...everything, offscreenNotSent: 0, recovering: false }),
    { kind: "jump", newRows: 3 });
  assert.deepEqual(transcriptTailView({ ...idle, recovering: true }), { kind: "recovering" },
    "recovery speaks at the tail too");
});

test("tail control labels", () => {
  assert.equal(notSentLabel(1), "1 Message Not Sent");
  assert.equal(notSentLabel(2), "2 Messages Not Sent");
  assert.equal(newRowsLabel(3), "3 New");
});
