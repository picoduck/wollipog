import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionDisplayTitle } from "./session-title.js";

test("a generated multi-line title shows only its first line, without the trailing period", () => {
  assert.equal(
    sessionDisplayTitle("Add a dark mode toggle to the site header.\n\nRequirements:\n- x"),
    "Add a dark mode toggle to the site header",
  );
});

test("blank and whitespace-only leading lines are skipped", () => {
  assert.equal(sessionDisplayTitle("\n   \n\t\nFix the login flow\nmore"), "Fix the login flow");
  assert.equal(sessionDisplayTitle("\r\n\r\nWindows line endings\r\nsecond"), "Windows line endings");
});

test("whitespace runs collapse to one space and the ends are trimmed", () => {
  assert.equal(sessionDisplayTitle("  Refactor \t the   session bar  "), "Refactor the session bar");
});

test("a single-line title is unchanged", () => {
  assert.equal(sessionDisplayTitle("Payments Service Migration"), "Payments Service Migration");
});

test("only one trailing period is dropped; an ellipsis and other punctuation stay", () => {
  assert.equal(sessionDisplayTitle("Ship it."), "Ship it");
  assert.equal(sessionDisplayTitle("Wait for it..."), "Wait for it...");
  assert.equal(sessionDisplayTitle("Why does this fail?"), "Why does this fail?");
  assert.equal(sessionDisplayTitle("Ends with a space . "), "Ends with a space");
});

test("an empty or blank title stays empty, so callers choose the fallback", () => {
  assert.equal(sessionDisplayTitle(""), "");
  assert.equal(sessionDisplayTitle(" \n\t\n "), "");
  assert.equal(sessionDisplayTitle("."), ".");
});
