import assert from "node:assert/strict";
import { test } from "node:test";
import { appendTranscript, finalTranscripts, formatDictationElapsed, interimTranscripts } from "./dictation.js";

test("appendTranscript: joins with a single space and trims recognizer padding", () => {
  assert.equal(appendTranscript("", "  hello world "), "hello world");
  assert.equal(appendTranscript("fix the bug", " in GitPanel"), "fix the bug in GitPanel");
  assert.equal(appendTranscript("fix the bug   ", "in GitPanel"), "fix the bug in GitPanel");
});

test("appendTranscript: empty/whitespace phrases are no-ops; whitespace-only drafts are replaced", () => {
  assert.equal(appendTranscript("draft", "   "), "draft");
  assert.equal(appendTranscript("   ", "hello"), "hello");
});

test("finalTranscripts: collects only final results from resultIndex onward", () => {
  const results = [
    { isFinal: true, 0: { transcript: "already handled" } },
    { isFinal: true, 0: { transcript: " fix the " } },
    { isFinal: false, 0: { transcript: "interim noise" } },
    { isFinal: true, 0: { transcript: "sidebar " } },
  ];
  assert.equal(finalTranscripts(results, 1), "fix the sidebar");
  assert.equal(finalTranscripts(results, 4), "");
});

test("interimTranscripts: collects only the unsettled results from resultIndex onward (#2193)", () => {
  const results = [
    { isFinal: true, 0: { transcript: "already handled" } },
    { isFinal: true, 0: { transcript: "fix the" } },
    { isFinal: false, 0: { transcript: " side " } },
    { isFinal: false, 0: { transcript: "bar" } },
  ];
  assert.equal(interimTranscripts(results, 1), "side bar");
  assert.equal(interimTranscripts(results, 0), "side bar");
  assert.equal(interimTranscripts(results.slice(0, 2), 0), "");
});

test("formatDictationElapsed: mm:ss, rounding down to the whole second (#2193)", () => {
  assert.equal(formatDictationElapsed(0), "00:00");
  assert.equal(formatDictationElapsed(999), "00:00");
  assert.equal(formatDictationElapsed(7_400), "00:07");
  assert.equal(formatDictationElapsed(750_000), "12:30");
  assert.equal(formatDictationElapsed(4_500_000), "75:00");
  assert.equal(formatDictationElapsed(-5), "00:00");
});
