import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactGuidance } from "./artifact-guidance.js";
import { makeDriver, type DriverOptions } from "./drivers/factory.js";
import { windowsCmdInvocationSpec } from "./windows-cmd.js";
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

test("Pi launch preserves repeatable, file and extension append arguments in every context", () => {
  const args = ["--append-system-prompt", "team rules", "--append-system-prompt", "orchestrator governance",
    "--append-system-prompt", "prompt.md", "--append-system-prompt=extension-owned", "--no-skills"];
  for (const context of [{ kind: "native" as const }, { kind: "wsl" as const, distro: "Ubuntu" }]) {
    const opts: DriverOptions = { command: "pi", args: [...args], cwd: "/unreadable-provider-cwd", env: {},
      config: {}, context, artifactGuidance: "artifact guidance" };
    const driver = makeDriver("pi", opts, { onEvent: () => {}, onStderr: () => {}, onExit: () => {} });
    // The launch must leave file resolution to Pi, including large files and native Windows.
    const effective = (driver as unknown as { opts: DriverOptions }).opts;
    assert.deepEqual(effective.args, [...args, "--append-system-prompt", "artifact guidance"]);
    assert.deepEqual(opts.args, args, "shared agent definition arguments are never mutated");
  }
});

test("Windows Pi guidance is one argument safely quoted through cmd without overriding Claude policy", () => {
  const note = artifactGuidance({ ...meta, driver: "pi" }, 198, "win32");
  assert.doesNotMatch(note, /[\r\n]/);
  const args = ["--append-system-prompt", "existing policy", "--append-system-prompt-file", "policy.txt"];
  for (const kind of ["pi", "claude-code"] as const) {
    const opts: DriverOptions = { command: `${kind}.cmd`, args, cwd: "C:\\workspace", env: {}, config: {},
      context: { kind: "native" }, artifactGuidance: note };
    const driver = makeDriver(kind, opts, { onEvent: () => {}, onStderr: () => {}, onExit: () => {} });
    const actual = (driver as unknown as { opts: DriverOptions }).opts.args;
    assert.doesNotThrow(() => windowsCmdInvocationSpec(opts.command, actual, { platform: "win32", comspec: "cmd.exe" }));
    assert.deepEqual(actual, kind === "pi" ? [...args, "--append-system-prompt", note] : args);
  }
});
