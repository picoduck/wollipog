import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CLAUDE_INIT_CATALOG_LIMITS,
  claudeUnsupportedReason,
  mergeClaudeSessionCatalog,
  parseClaudeInitCatalog,
  sameClaudeInitCatalog,
  samePluginRoots,
  type ClaudeSkillMetadata,
} from "./claude-slash-catalog.js";

/** A sanitized `system/init` message in the shape Claude Code 2.1 sends. */
const INIT = JSON.parse(readFileSync(new URL("../drivers/fixtures/claude-init-catalog.json", import.meta.url), "utf8")) as
  Record<string, unknown>;

const DEPLOY_CHECK: ClaudeSkillMetadata = {
  name: "deploy-check",
  origin: "project",
  description: "Check a deploy before it ships.",
  argumentHint: "[environment]",
  userInvocable: true,
};

test("the init list parses into bounded, validated names, skills, terminal commands and plugin roots", () => {
  const catalog = parseClaudeInitCatalog(INIT);
  assert.ok(catalog);
  assert.equal(catalog.commands.length, 17);
  assert.deepEqual(catalog.skills, ["deploy-check", "brainstorming", "superpowers:writing-plans"]);
  assert.deepEqual(catalog.terminalCommands, ["doctor", "color"]);
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.name), ["superpowers", "code-review"]);

  // A Claude Code release without the list keeps the disk catalog.
  assert.equal(parseClaudeInitCatalog({ type: "system", subtype: "init" }), null);

  const messy = parseClaudeInitCatalog({
    slash_commands: ["ok", "/slashed", "OK", "has space", "", 7, "a".repeat(200), "x;rm"],
    plugins: [{ name: "fine", path: "/p" }, { name: "bad:name", path: "/q" }, { name: "nopath" }, "nope",
      { name: "FINE", path: "/dup" }],
  });
  assert.deepEqual(messy?.commands, ["ok", "slashed"], "invalid names drop out; duplicates compare case-insensitively");
  assert.deepEqual(messy?.plugins, [{ name: "fine", path: "/p" }]);

  const many = parseClaudeInitCatalog({ slash_commands: Array.from({ length: 900 }, (_, index) => `c${index}`) });
  assert.equal(many?.commands.length, CLAUDE_INIT_CATALOG_LIMITS.maxCommands);
});

test("the init list decides membership, and each command gets its source label", () => {
  const init = parseClaudeInitCatalog(INIT)!;
  const merged = mergeClaudeSessionCatalog({
    commands: [
      { name: "release", source: "project", description: "Cut a release.", argumentHint: "<version>" },
      { name: "not-listed", source: "user", description: "Claude Code doesn't list this one." },
      { name: "code-review:code-review", source: "plugin", description: "Review a pull request with agents." },
    ],
    skills: [DEPLOY_CHECK, { name: "superpowers:writing-plans", origin: "plugin", userInvocable: true,
      description: "Write an implementation plan." }],
    init,
  });
  assert.deepEqual(merged.commands, [
    { name: "brainstorming", source: "skill" },
    { name: "code-review:code-review", source: "plugin", description: "Review a pull request with agents." },
    { name: "compact", source: "builtin", description: "Summarize the conversation to free up context.",
      argumentHint: "[instructions]" },
    { name: "context", source: "builtin", description: "Show what is using the context window." },
    { name: "deploy-check", source: "skill", description: "Check a deploy before it ships.", argumentHint: "[environment]" },
    { name: "init", source: "builtin", description: "Write a CLAUDE.md that describes this project." },
    { name: "mcp__docs__summarize", source: "mcp" },
    { name: "model", source: "builtin", description: "Change the model.", argumentHint: "[model]" },
    { name: "release", source: "project", description: "Cut a release.", argumentHint: "<version>" },
    { name: "review", source: "builtin", description: "Review a pull request." },
    { name: "security-review", source: "builtin", description: "Review the pending changes for security issues." },
    { name: "superpowers:writing-plans", source: "skill", description: "Write an implementation plan." },
    { name: "usage", source: "builtin", description: "Show plan usage and limits." },
  ]);
  // Terminal-only commands, from the fixed list and from Claude Code's own list, are split out.
  assert.deepEqual(merged.unsupported, [
    { name: "color", reason: claudeUnsupportedReason("color") },
    { name: "doctor", reason: claudeUnsupportedReason("doctor") },
    { name: "exit", reason: claudeUnsupportedReason("exit") },
  ]);
  assert.equal(merged.unsupported[1]!.reason, "Claude Code's /doctor needs its own terminal, so Wollipog doesn't send it.");
  assert.ok(!merged.commands.some((command) => command.name.startsWith("__")), "internal plumbing never appears");
  assert.ok(merged.commands.some((command) => command.source === "builtin"),
    "a catalog with the init list has built-ins, which tells the composer it is complete (#2176)");
});

test("a skill marked user-invocable: false is never advertised", () => {
  const init = parseClaudeInitCatalog(INIT)!;
  const merged = mergeClaudeSessionCatalog({
    commands: [],
    skills: [{ ...DEPLOY_CHECK, userInvocable: false }],
    init,
  });
  assert.equal(merged.commands.find((command) => command.name === "deploy-check"), undefined);
  const withoutInit = mergeClaudeSessionCatalog({ commands: [], skills: [{ ...DEPLOY_CHECK, userInvocable: false }] });
  assert.deepEqual(withoutInit.commands, []);
});

test("names compare case-insensitively and a disk entry's metadata wins over a classification by name", () => {
  const merged = mergeClaudeSessionCatalog({
    commands: [{ name: "Compact", source: "user", description: "My own compact." }],
    skills: [],
    init: { commands: ["compact", "COMPACT"], skills: [], terminalCommands: [], plugins: [] },
  });
  assert.deepEqual(merged.commands, [{ name: "Compact", source: "user", description: "My own compact." }]);
});

test("without an init list the disk catalog stands, with personal and project skills and no built-ins", () => {
  const merged = mergeClaudeSessionCatalog({
    commands: [
      { name: "release", source: "project", description: "Cut a release." },
      { name: "exit", source: "user" },
    ],
    skills: [
      DEPLOY_CHECK,
      { name: "deploy-check", origin: "user", description: "My personal deploy check.", userInvocable: true },
      { name: "superpowers:writing-plans", origin: "plugin", userInvocable: true },
    ],
  });
  assert.deepEqual(merged.commands, [
    { name: "deploy-check", source: "skill", description: "My personal deploy check." },
    { name: "release", source: "project", description: "Cut a release." },
  ]);
  assert.deepEqual(merged.unsupported, []);
  assert.ok(!merged.commands.some((command) => command.source === "builtin"),
    "an older runner's catalog keeps the composer's plain-text fallback (#2176)");
});

test("init lists compare by content, and plugin roots by name and path", () => {
  const a = parseClaudeInitCatalog(INIT)!;
  const b = parseClaudeInitCatalog(JSON.parse(JSON.stringify(INIT)) as Record<string, unknown>)!;
  assert.equal(sameClaudeInitCatalog(a, b), true);
  assert.equal(sameClaudeInitCatalog(a, { ...b, commands: [...b.commands, "extra"] }), false);
  assert.equal(sameClaudeInitCatalog(undefined, a), false);
  assert.equal(samePluginRoots(a, { ...b, commands: [] }), true);
  assert.equal(samePluginRoots(a, { ...b, plugins: [{ name: "superpowers", path: "/elsewhere" }] }), false);
  assert.equal(samePluginRoots(undefined, { commands: [], skills: [], terminalCommands: [], plugins: [] }), true);
});
