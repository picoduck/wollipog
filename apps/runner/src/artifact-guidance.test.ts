import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_CONTROL_RELAY_FIFO_ENV } from "./agent-control-fifo-relay.js";
import { artifactGuidance } from "./artifact-guidance.js";
import { makeDriver, type DriverOptions } from "./drivers/factory.js";
import { windowsCmdInvocationSpec } from "./windows-cmd.js";
import type { SessionMeta } from "./session-store.js";

// A Linux Codex worker whose runner established the FIFO channel, so its sandbox can reach the CLI.
const meta = { driver: "codex-app-server" as const,
  env: { WOLLIPOG_CLI: "/private/cli", [AGENT_CONTROL_RELAY_FIFO_ENV]: "/private/fifo", SECRET: "never-print-me" },
  context: { kind: "native" as const }, artifactUploads: "manual" as const };

test("ordinary, Orchestrator and child guidance is Manual without adding skill or upload authority", () => {
  for (const role of [undefined, { strictProjectIsolation: false }, { strictProjectIsolation: true }]) {
    const note = artifactGuidance({ ...meta, orchestrator: role }, 201);
    assert.match(note, /Manual \(default\)/); assert.match(note, /Awareness alone does not authorize/);
    assert.match(note, /private control-plane storage/); assert.match(note, /8 MiB/); assert.match(note, /32 MiB/);
    assert.doesNotMatch(note, /never-print-me|\/private\/cli|\/private\/fifo|SKILL.md/);
  }
});

test("hosting choices constrain task evidence and respect explicit hosting and approval rules", () => {
  const automatic = artifactGuidance({ ...meta, artifactUploads: "wollipog_automatic" }, 201);
  assert.match(automatic, /relevant task evidence/); assert.match(automatic, /never arbitrary filesystem files/);
  const external = artifactGuidance({ ...meta, artifactUploads: "external_hosting" }, 201);
  assert.match(external, /Do not silently fall back to Wollipog/); assert.match(external, /invent a destination/);
  for (const note of [automatic, external]) {
    assert.match(note, /Explicit task and project hosting requirements take precedence/);
    assert.match(note, /does not grant evidence-review or merge authority/);
  }
  assert.match(artifactGuidance({ ...meta, artifactUploads: "wollipog_automatic" }, 200), /Manual/);
});

test("commands match provisioned MCP, CLI, context and peer capabilities", () => {
  assert.doesNotMatch(artifactGuidance(meta, 201), /attach_session_artifact/);
  assert.match(artifactGuidance({ ...meta, driver: "claude-code" }, 201), /attach_session_artifact/);
  assert.match(artifactGuidance({ ...meta, driver: "claude-code" }, 201, "win32"), /ConvertFrom-Json/);
  assert.match(artifactGuidance(meta, 169), /does not support video/);
  for (const unsupported of [{ ...meta, env: {} }, { ...meta, context: { kind: "wsl" as const, distro: "Ubuntu" } },
    { ...meta, executionTarget: { adapter: "container" } as unknown as SessionMeta["executionTarget"] }]) {
    const note = artifactGuidance(unsupported, 201);
    assert.match(note, /file attachment is unavailable/); assert.doesNotMatch(note, /artifact attach|attach_session_artifact/);
  }
  assert.doesNotMatch(artifactGuidance(meta, 168), /artifact attach|attach_session_artifact/);
});

test("a Codex sandbox without the FIFO channel is never offered the CLI it cannot reach (#3270)", () => {
  const { [AGENT_CONTROL_RELAY_FIFO_ENV]: _fifo, ...withoutFifo } = meta.env;
  const sandboxed = { ...meta, env: withoutFifo };
  for (const driver of ["codex-app-server", "codex"] as const) {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      // No channel and no session MCP server: nothing that works inside the sandbox to offer.
      const bare = artifactGuidance({ ...sandboxed, driver }, 201, platform);
      assert.match(bare, /file attachment is unavailable/);
      assert.doesNotMatch(bare, /WOLLIPOG_CLI|artifact attach|attach_session_artifact/);
      // The session's own wollipog MCP server (#3123) runs outside the sandbox: offer only that.
      const withMcp = artifactGuidance({ ...sandboxed, driver, env: { ...withoutFifo, WOLLIPOG_SESSION_MCP: "1" } }, 201, platform);
      assert.match(withMcp, /Attach a file from disk with attach_session_artifact \(absolute path\)\./);
      assert.doesNotMatch(withMcp, /WOLLIPOG_CLI|artifact attach/);
    }
    // The Orchestrator preset turns network access on, so its loopback relay stays reachable.
    const preset = artifactGuidance({ ...sandboxed, driver, config: { permissionMode: "orchestrator" } }, 201);
    assert.match(preset, /"\$WOLLIPOG_CLI" artifact attach/);
  }
  // Only Codex runs every shell command in a sandbox Wollipog cannot reach; other harnesses keep it.
  for (const driver of ["claude-code", "pi"] as const) {
    assert.match(artifactGuidance({ ...sandboxed, driver }, 201), /"\$WOLLIPOG_CLI" artifact attach/);
  }
  // With the channel the CLI is offered, alongside the session MCP server when it has one.
  assert.match(artifactGuidance(meta, 201), /with "\$WOLLIPOG_CLI" artifact attach/);
  assert.match(artifactGuidance({ ...meta, env: { ...meta.env, WOLLIPOG_SESSION_MCP: "1" } }, 201),
    /attach_session_artifact \(absolute path\), or "\$WOLLIPOG_CLI" artifact attach/);
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
  const note = artifactGuidance({ ...meta, driver: "pi" }, 201, "win32");
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
