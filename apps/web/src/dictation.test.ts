import assert from "node:assert/strict";
import { test } from "node:test";
import { appendTranscript, finalTranscripts } from "./dictation.js";

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
