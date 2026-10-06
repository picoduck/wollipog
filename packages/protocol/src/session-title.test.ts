import assert from "node:assert/strict";
import { test } from "node:test";
import { PROMPT_TITLE_MAX, titleFromPrompt } from "./session-title.js";

test("a short one-line prompt is its own title", () => {
  assert.equal(titleFromPrompt("  Fix   the login   bug  "), "Fix the login bug");
  assert.equal(titleFromPrompt(""), "");
  assert.equal(titleFromPrompt("\n \r\n\t"), "");
});

test("a multi-line prompt takes its first non-empty line (#2209)", () => {
  assert.equal(titleFromPrompt("\n\nRequirements:\r\n- one\n- two"), "Requirements:");
  assert.equal(titleFromPrompt("Ship it\r\rnow"), "Ship it");
});

test("a long line is cut at a word boundary, at most the limit with its ellipsis", () => {
  const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
  const title = titleFromPrompt(words);
  assert.ok(title.length <= PROMPT_TITLE_MAX, `${title.length}`);
  assert.ok(title.endsWith("…"));
  assert.ok(words.startsWith(title.slice(0, -1)), "the title is a prefix of the line");
  assert.equal(words[title.length - 1], " ", "the cut lands on a word boundary");
});

test("a line of exactly the limit stays whole, and one character more is cut", () => {
  const exact = `${"a".repeat(PROMPT_TITLE_MAX - 6)} bcdef`;
  assert.equal(exact.length, PROMPT_TITLE_MAX);
  assert.equal(titleFromPrompt(exact), exact);
  assert.equal(titleFromPrompt(`${exact}g`), `${"a".repeat(PROMPT_TITLE_MAX - 6)}…`);
});

test("trailing punctuation before the cut is dropped, and a word with no boundary is cut mid-word", () => {
  const punctuated = `${"alpha ".repeat(18)}omega, ${"z".repeat(40)}`;
  assert.match(titleFromPrompt(punctuated), /omega…$/);
  assert.equal(titleFromPrompt("x".repeat(200)), `${"x".repeat(PROMPT_TITLE_MAX - 1)}…`);
});
