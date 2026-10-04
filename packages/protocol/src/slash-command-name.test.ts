import assert from "node:assert/strict";
import { test } from "node:test";
import { isSlashCommandName, isSlashCommandNameCharacter } from "./index.js";

test("a command name starts with a letter, digit or underscore in any script and continues with `.:@-` too", () => {
  for (const name of ["compact", "mcp__docs__summarize@latest", "plugin:skill", "_x", "9lives", "résumé", "日本語", "𝒜"]) {
    assert.equal(isSlashCommandName(name), true, name);
  }
  for (const name of ["", "/compact", "@scope", "-x", ".x", ":x", "a b", "a+b", "a/b", "a\tb", "🎉", "é"]) {
    assert.equal(isSlashCommandName(name), false, JSON.stringify(name));
  }
});

test("a continuing character is one the grammar allows after the first", () => {
  for (const character of ["a", "é", "語", "7", "_", ".", ":", "@", "-", "𝒜"]) {
    assert.equal(isSlashCommandNameCharacter(character), true, character);
  }
  for (const character of ["", " ", "/", "$", "+", "🎉", "ab", "\uD835"]) {
    assert.equal(isSlashCommandNameCharacter(character), false, JSON.stringify(character));
  }
});
