import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionMeta } from "../session-store.js";
import {
  codexPromptBody,
  codexPromptCommand,
  discoverCodexPrompts,
  expandCodexPrompt,
  prepareCodexPromptCatalog,
  splitCodexPromptArguments,
} from "./codex-prompts.js";

function codexHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "codex-prompts-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "prompts"));
  return home;
}

test("expandCodexPrompt substitutes positional, all, named, and escaped placeholders", () => {
  assert.equal(expandCodexPrompt("Review $1 against $2.", "src/app.ts main"), "Review src/app.ts against main.");
  assert.equal(expandCodexPrompt("Fix: $ARGUMENTS", `"login page" crash`), "Fix: login page crash");
  assert.equal(expandCodexPrompt("Ticket $TICKET for $OWNER", "TICKET=ABC-1 OWNER='web team'"), "Ticket ABC-1 for web team");
  assert.equal(expandCodexPrompt("Costs $$5 and $9.", "one"), "Costs $5 and .");
  assert.equal(expandCodexPrompt("Keep $PATH literal.", ""), "Keep $PATH literal.");
  assert.equal(expandCodexPrompt("Summarize the diff.", "focus on tests"), "Summarize the diff.\n\nfocus on tests",
    "arguments to a prompt without placeholders are kept, not dropped");
  assert.equal(expandCodexPrompt("Summarize the diff.", "   "), "Summarize the diff.");
});

test("splitCodexPromptArguments groups quotes and collapses whitespace", () => {
  assert.deepEqual(splitCodexPromptArguments(`  a "b c"  'd e' f""  `), ["a", "b c", "d e", "f"]);
  assert.deepEqual(splitCodexPromptArguments(`""`), [""]);
  assert.deepEqual(splitCodexPromptArguments(""), []);
});

test("codexPromptBody drops a closed frontmatter block only", () => {
  assert.equal(codexPromptBody("---\ndescription: Review\n---\n\nReview $1\n"), "Review $1");
  assert.equal(codexPromptBody("﻿Just text\n"), "Just text");
  assert.equal(codexPromptBody("---\nunterminated: yes\nbody"), "---\nunterminated: yes\nbody");
});

test("discoverCodexPrompts reads top-level prompts with metadata from the session CODEX_HOME", async (t) => {
  const home = codexHome(t);
  writeFileSync(join(home, "prompts", "review.md"),
    "---\ndescription: Review a change\nargument-hint: <file> [base]\n---\nReview $1 against $2.\n");
  writeFileSync(join(home, "prompts", "plain.md"), "# Plain prompt\nDo the thing.\n");
  writeFileSync(join(home, "prompts", "notes.txt"), "not a prompt");
  mkdirSync(join(home, "prompts", "nested"));
  writeFileSync(join(home, "prompts", "nested", "deep.md"), "Codex reads only top-level prompts.");
  symlinkSync(join(home, "prompts", "review.md"), join(home, "prompts", "alias.md"));

  const inheritedHome = codexHome(t);
  writeFileSync(join(inheritedHome, "prompts", "inherited.md"), "From the runner's CODEX_HOME.");
  const result = await discoverCodexPrompts(
    { context: { kind: "native" }, codexHome: home },
    { inheritedCodexHome: () => inheritedHome },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.prompts, [
    { name: "plain", body: "# Plain prompt\nDo the thing." },
    { name: "review", description: "Review a change", argumentHint: "<file> [base]", body: "Review $1 against $2." },
  ]);
  assert.deepEqual(codexPromptCommand(result.ok ? result.prompts[1]! : { name: "", body: "" }), {
    name: "review", source: "user", description: "Review a change", argumentHint: "<file> [base]",
  });

  const inherited = await discoverCodexPrompts({ context: { kind: "native" } }, { inheritedCodexHome: () => inheritedHome });
  assert.deepEqual(inherited.ok && inherited.prompts.map((prompt) => prompt.name), ["inherited"]);
  const fallback = await discoverCodexPrompts(
    { context: { kind: "native" } },
    { inheritedCodexHome: () => undefined, nativeHome: () => join(home, "no-such-home") },
  );
  assert.deepEqual(fallback, { ok: true, prompts: [] }, "a missing prompts directory is an empty catalog");
});

test("prepareCodexPromptCatalog reads host prompts only and ignores other drivers", async (t) => {
  const home = codexHome(t);
  writeFileSync(join(home, "prompts", "ship.md"), "Ship it.");
  const meta = (overrides: Partial<SessionMeta>) => ({
    driver: "codex-app-server",
    context: { kind: "native" },
    env: { CODEX_HOME: home },
    ...overrides,
  }) as Pick<SessionMeta, "driver" | "context" | "env" | "executionTarget">;

  const host = await prepareCodexPromptCatalog(meta({}));
  assert.deepEqual(host.outcome === "prepared" && host.prompts.map((prompt) => prompt.name), ["ship"]);
  for (const adapter of ["container", "cloud"] as const) {
    assert.deepEqual(
      await prepareCodexPromptCatalog(meta({ executionTarget: { adapter, id: "target" } as SessionMeta["executionTarget"] })),
      { outcome: "prepared", prompts: [] },
      `${adapter} targets never read host prompts`,
    );
  }
  assert.deepEqual(await prepareCodexPromptCatalog(meta({ driver: "claude-code" })), { outcome: "not_applicable" });
});
