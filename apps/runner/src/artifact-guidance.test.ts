import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactGuidance, appendArtifactSystemPrompt } from "./artifact-guidance.js";
import type { SessionMeta } from "./session-store.js";

const meta = { driver: "codex-app-server" as const, env: { WOLLIPOG_CLI: "/private/cli", SECRET: "never-print-me" },
  context: { kind: "native" as const }, artifactUploads: "manual" as const };

test("ordinary, Orchestrator and child guidance is Manual without adding skill or upload authority", () => {
  for (const role of [undefined, { strictProjectIsolation: false }, { strictProjectIsolation: true }]) {
    const note = artifactGuidance({ ...meta, orchestrator: role }, 198);
    assert.match(note, /Manual \(default\)/); assert.match(note, /Awareness alone does not authorize/);
    assert.match(note, /private control-plane storage/); assert.match(note, /8 MiB/); assert.match(note, /32 MiB/);
    assert.doesNotMatch(note, /never-print-me|\/private\/cli|SKILL.md/);
  }
});

test("hosting choices constrain task evidence and respect explicit hosting and approval rules", () => {
  const automatic = artifactGuidance({ ...meta, artifactUploads: "wollipog_automatic" }, 198);
  assert.match(automatic, /relevant task evidence/); assert.match(automatic, /never arbitrary filesystem files/);
  const external = artifactGuidance({ ...meta, artifactUploads: "external_hosting" }, 198);
  assert.match(external, /Do not silently fall back to Wollipog/); assert.match(external, /invent a destination/);
  for (const note of [automatic, external]) {
    assert.match(note, /Explicit task and project hosting requirements take precedence/);
    assert.match(note, /does not grant evidence-review or merge authority/);
  }
  assert.match(artifactGuidance({ ...meta, artifactUploads: "wollipog_automatic" }, 197), /Manual/);
});

test("commands match provisioned MCP, CLI, context and peer capabilities", () => {
  assert.doesNotMatch(artifactGuidance(meta, 198), /attach_session_artifact/);
  assert.match(artifactGuidance({ ...meta, driver: "claude-code" }, 198), /attach_session_artifact/);
  assert.match(artifactGuidance(meta, 198, "win32"), /ConvertFrom-Json/);
  assert.match(artifactGuidance(meta, 169), /does not support video/);
  for (const unsupported of [{ ...meta, env: {} }, { ...meta, context: { kind: "wsl" as const, distro: "Ubuntu" } },
    { ...meta, executionTarget: { adapter: "container" } as unknown as SessionMeta["executionTarget"] }]) {
    const note = artifactGuidance(unsupported, 198);
    assert.match(note, /file attachment is unavailable/); assert.doesNotMatch(note, /artifact attach|attach_session_artifact/);
  }
  assert.doesNotMatch(artifactGuidance(meta, 168), /artifact attach|attach_session_artifact/);
});

test("append instructions retain user and Orchestrator instructions without changing permission flags", () => {
  for (const args of [["--append-system-prompt", "user instructions", "--permission-mode", "default"],
    ["--append-system-prompt=user instructions", "--permission-mode", "default"]]) {
    const result = appendArtifactSystemPrompt(args, "artifact guidance");
    assert.deepEqual(result, ["--permission-mode", "default", "--append-system-prompt", "user instructions\n\nartifact guidance"]);
    assert.equal(args.length > 0, true);
  }
});


test("Pi file-based append prompts remain instructions after artifact guidance is added", () => {
  const directory = mkdtempSync(join(tmpdir(), "artifact-pi-prompt-"));
  try {
    writeFileSync(join(directory, "user-prompt.txt"), "user instructions from file");
    const args = appendArtifactSystemPrompt(["--append-system-prompt", "user-prompt.txt"], "artifact guidance", { cwd: directory });
    assert.equal(args.at(-1), "user instructions from file\n\nartifact guidance");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
