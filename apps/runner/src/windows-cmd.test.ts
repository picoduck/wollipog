import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsCommandSpec } from "./windows-cmd.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./discovery/resolve.js";
import { runContextCommand } from "./context-command.js";
import { codexOrchestratorMcpArgs } from "./orchestrator-preset.js";

test("Windows batch shims use an explicit non-expanding cmd.exe boundary", () => {
  const spec = windowsCommandSpec(
    "C:\\Program Files\\nodejs\\codex.cmd",
    ["--config", 'mcp_servers={ "wollipog" = true }', "a&b", "bang!kept"],
    { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" },
  );
  assert.equal(spec.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spec.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.match(spec.args[4]!, /codex\.cmd/);
  assert.match(spec.args[4]!, /""wollipog""/);
  assert.match(spec.args[4]!, /"a&b"/);
  assert.match(spec.args[4]!, /bang!kept/);
});

test("Windows command specs reject active cmd expansion and preserve direct executables", () => {
  assert.throws(() => windowsCommandSpec("agent.cmd", ["%PATH%"], { platform: "win32" }), /would expand/);
  assert.throws(() => windowsCommandSpec("agent.cmd", ["one\ntwo"], { platform: "win32" }), /CR\/LF/);
  assert.deepEqual(
    windowsCommandSpec("C:\\tools\\agent.exe", ["%PATH%"], { platform: "win32" }),
    { file: "C:\\tools\\agent.exe", args: ["%PATH%"] },
  );
  assert.deepEqual(windowsCommandSpec("agent.cmd", ["x"], { platform: "linux" }), { file: "agent.cmd", args: ["x"] });
});

test("Windows .cmd probes preserve argv and enforce Codex MCP isolation", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog cmd probe (x86) & Tools "));
  const capture = join(dir, "capture.cjs");
  const shim = join(dir, "capture args.cmd");
  const codex = join(dir, "codex shim.cmd");
  try {
    writeFileSync(capture, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", "utf8");
    writeFileSync(shim, `@echo off\r\nnode "%~dp0capture.cjs" %*\r\n`, "utf8");
    writeFileSync(codex, "@echo off\r\necho [{\"name\":\"wollipog\",\"enabled\":true},{\"name\":\"ambient\",\"enabled\":true}]\r\n", "utf8");

    const argv = [
      "space value", "amp&value", 'say "yes"', "paren(value)", "pipe|value",
      "less<value", "more>value", "caret^value", "bang!kept", "comma,value", "semi;value", "equals=value",
    ];
    const probe = await run(shim, argv);
    assert.equal(probe.code, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), argv);
    const context = await runContextCommand({ kind: "native" }, shim, argv, { cwd: dir });
    assert.deepEqual(JSON.parse(context.stdout), argv);
    assert.deepEqual(await codexOrchestratorMcpArgs({ command: codex, args: [] }, dir), [
      "-c", "mcp_servers.ambient.enabled=false",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
