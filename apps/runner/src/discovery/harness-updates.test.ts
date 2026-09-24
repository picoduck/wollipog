import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHarnessUpdate, classifyNpmHarnessUpdate, codexOffersSelfUpdate, harnessVersionPinned, manualCodexUpdateCommand, npmPackageForInstallation } from "./harness-updates.js";

const result = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });

test("npm update comparison distinguishes newer, current, preview, and failed checks", () => {
  const tags = result(JSON.stringify({ latest: "0.210.0", next: "0.211.0-beta.1" }));
  assert.equal(classifyNpmHarnessUpdate("0.199.0", tags, "@openai/codex", 1).status, "update_available");
  assert.equal(classifyNpmHarnessUpdate("0.210.0", tags, "@openai/codex", 1).status, "up_to_date");
  assert.equal(classifyNpmHarnessUpdate("0.211.0-beta.0", tags, "@openai/codex", 1).status, "preview_channel");
  assert.equal(classifyNpmHarnessUpdate(undefined, tags, "@openai/codex", 1).status, "version_unknown");
  assert.equal(classifyNpmHarnessUpdate("0.199.0", result("", 1), "@openai/codex", 1).status, "check_failed");
  assert.equal(classifyNpmHarnessUpdate("0.199.0", result("not JSON"), "@openai/codex", 1).status, "check_failed");
  assert.match(classifyNpmHarnessUpdate("0.199.0", result("", 1), "@openai/codex", 1).guidance, /offline, behind a proxy, or rate limited/);
  assert.match(classifyNpmHarnessUpdate("0.199.0", result("", 1), "@openai/codex", 1).guidance, /no current release status was established/);
  assert.match(classifyNpmHarnessUpdate("0.211.0-beta.0", tags, "@openai/codex", 1).guidance, /preview channel/);
  assert.match(classifyNpmHarnessUpdate("0.199.0", tags, "@openai/codex", 1).guidance, /compatibility.*not been verified/);
  assert.doesNotMatch(classifyNpmHarnessUpdate("0.199.0", tags, "@openai/codex", 1).guidance, /original npm|belongs to/i);
});

test("failed release checks direct rediscovery of the same installation", () => {
  const failedResults = [
    result("", 1),
    { ...result(""), timedOut: true },
    result("not JSON"),
    result(JSON.stringify({ next: "0.211.0-beta.1" })),
  ];
  for (const failedResult of failedResults) {
    const assessment = classifyNpmHarnessUpdate("0.199.0", failedResult, "@openai/codex", 1);
    assert.equal(assessment.status, "check_failed");
    assert.match(assessment.guidance, /rediscover this installation in Connections/);
    assert.match(assessment.guidance, /Select Rediscover for a native Machine, or Reconnect for an SSH Machine/);
    assert.match(assessment.guidance, /organization owner or admin/);
    assert.doesNotMatch(assessment.guidance, /update|upgrade/i);
  }
});

test("an executable is npm-owned only when its exact launch resolves inside the matching package", () => {
  assert.equal(npmPackageForInstallation("codex", {
    path: "/home/u/.nvm/versions/node/v24/bin/codex", via: "version-manager",
    launch: { command: "/home/u/.nvm/versions/node/v24/bin/node",
      args: ["/home/u/.nvm/versions/node/v24/lib/node_modules/@openai/codex/bin/codex.js"] },
  }), "@openai/codex");
  assert.equal(npmPackageForInstallation("codex", {
    path: "/usr/bin/codex", via: "path", launch: { command: "/usr/bin/codex", args: [] },
  }), null);
  assert.equal(npmPackageForInstallation("claude", {
    path: "/home/u/.nvm/versions/node/v24/bin/codex", via: "version-manager",
    launch: { command: "/home/u/.nvm/versions/node/v24/bin/node",
      args: ["/home/u/.nvm/versions/node/v24/lib/node_modules/@openai/codex/bin/codex.js"] },
  }), null);
  assert.equal(npmPackageForInstallation("codex", {
    path: "/usr/bin/codex", via: "path",
    launch: { command: "/usr/bin/codex", args: ["--config", "/tmp/node_modules/@openai/codex/bin/codex.js"] },
  }), null, "a data argument must not claim manager ownership");
  assert.equal(npmPackageForInstallation("codex", {
    path: "/tmp/node_modules/@openai/codex/bin/codex.js", via: "path",
    launch: { command: "/usr/bin/codex", args: [] },
  }), null, "an alias cannot prove ownership of a different launch target");
});

test("built-in update support is probed on the exact discovered launch", async () => {
  const binary = { path: "/first/codex", via: "path" as const,
    launch: { command: "/first/node", args: ["/first/codex.js"] } };
  const observed: Array<{ command: string; args: string[]; timeoutMs: number | undefined }> = [];
  const execute = async (command: string, args: string[], options: { timeoutMs?: number } = {}) => {
    observed.push({ command, args, timeoutMs: options.timeoutMs });
    return result("Commands:\n  update  Update Codex to the latest version\n");
  };
  assert.equal(await codexOffersSelfUpdate(binary, { kind: "native" }, execute), true);
  assert.deepEqual(observed.pop(), { command: "/first/node", args: ["/first/codex.js", "--help"], timeoutMs: 3000 });
  assert.equal(await codexOffersSelfUpdate(binary, { kind: "wsl", distro: "Ubuntu" }, execute), true);
  assert.deepEqual(observed.pop(), { command: "wsl.exe", args: ["-d", "Ubuntu", "--exec", "/first/node", "/first/codex.js", "--help"], timeoutMs: 8000 });
  assert.equal(await codexOffersSelfUpdate(binary, { kind: "native" }, async () => result("unknown command")), false);
});

test("manual update guidance quotes the selected launch in its stated shell", () => {
  const binary = { path: "/opt/Agent's Tools/codex", via: "path" as const,
    launch: { command: "/opt/Agent's Tools/node", args: ["/opt/Agent's Tools/codex main.js"] } };
  assert.deepEqual(manualCodexUpdateCommand(binary, { kind: "native" }, "linux"), {
    command: "'/opt/Agent'\"'\"'s Tools/node' '/opt/Agent'\"'\"'s Tools/codex main.js' 'update'",
    shell: "a POSIX shell on this Machine",
  });
  assert.deepEqual(manualCodexUpdateCommand(binary, { kind: "wsl", distro: "Team Ubuntu" }, "win32"), {
    command: "'/opt/Agent'\"'\"'s Tools/node' '/opt/Agent'\"'\"'s Tools/codex main.js' 'update'",
    shell: "a POSIX shell inside WSL: Team Ubuntu",
  });
  assert.deepEqual(manualCodexUpdateCommand({ path: "C:\\Program Files\\Codex\\codex.exe", via: "path",
    launch: { command: "C:\\Program Files\\Codex\\codex.exe", args: ["O'Brien", "Team’s Profile"] } },
  { kind: "native" }, "win32"), {
    command: "& 'C:\\Program Files\\Codex\\codex.exe' 'O''Brien' 'Team’’s Profile' 'update'",
    shell: "PowerShell 7.3 or later on this Machine",
  });
});

test("native Windows batch update commands are excluded, including embedded quotes and percent signs", () => {
  for (const suffix of ["cmd", "BaT"]) {
    const binary = { path: `C:\\Tools\\codex.${suffix}`, via: "path" as const,
      launch: { command: `C:\\Tools\\codex.${suffix}`, args: ['embedded"quote', "%PATH%"] } };
    assert.equal(manualCodexUpdateCommand(binary, { kind: "native" }, "win32"), null);
    assert.deepEqual(manualCodexUpdateCommand(binary, { kind: "wsl", distro: "Ubuntu" }, "win32"), {
      command: `'C:\\Tools\\codex.${suffix}' 'embedded"quote' '%PATH%' 'update'`,
      shell: "a POSIX shell inside WSL: Ubuntu",
    });
  }
  assert.deepEqual(manualCodexUpdateCommand({ path: "C:\\Tools\\codex.exe", via: "path",
    launch: { command: "C:\\Tools\\codex.exe", args: ['embedded"quote', "%PATH%"] } },
  { kind: "native" }, "win32"), {
    command: `& 'C:\\Tools\\codex.exe' 'embedded"quote' '%PATH%' 'update'`,
    shell: "PowerShell 7.3 or later on this Machine",
  });
});

test("PowerShell legacy-passing executables cannot promise copyable update arguments", () => {
  for (const name of ["cmd", "cscript", "wscript", "find", "sqlcmd"]) {
    const command = `C:\\Windows\\System32\\${name}.exe`;
    const binary = { path: command, via: "path" as const,
      launch: { command, args: ["/c", "%WOLLIPOG_INTERPRETER_PROBE%"] } };
    assert.equal(manualCodexUpdateCommand(binary, { kind: "native" }, "win32"), null);
  }
});

test("native PowerShell probe: cmd.exe expands a quoted percent argument",
  { skip: process.platform !== "win32" }, () => {
    const command = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    const binary = { path: command, via: "path" as const,
      launch: { command, args: ["/d", "/c", "echo", "%WOLLIPOG_INTERPRETER_PROBE%"] } };
    assert.equal(manualCodexUpdateCommand(binary, { kind: "native" }, "win32"), null);
    // The command below was the previously offered PowerShell spelling of this launch.
    const copied = `& '${command}' '/d' '/c' 'echo' '%WOLLIPOG_INTERPRETER_PROBE%' 'update'`;
    const probe = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", copied], {
      encoding: "utf8", env: { ...process.env, WOLLIPOG_INTERPRETER_PROBE: "EXPANDED" },
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /^EXPANDED update\r?\n$/);
  });

test("native PowerShell probe: cscript.exe merges an embedded-quote argument with update",
  { skip: process.platform !== "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wollipog cscript probe "));
    try {
      const script = join(dir, "args.vbs");
      writeFileSync(script, 'Dim arg\r\nFor Each arg In WScript.Arguments\r\nWScript.Echo "ARG:" & arg\r\nNext\r\n');
      const command = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cscript.exe");
      const binary = { path: command, via: "path" as const,
        launch: { command, args: ["//nologo", script, 'a"b'] } };
      assert.equal(manualCodexUpdateCommand(binary, { kind: "native" }, "win32"), null);
      const copied = `& '${command}' '//nologo' '${script}' 'a"b' 'update'`;
      const probe = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", copied], {
        encoding: "utf8",
      });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout, "ARG:ab update\r\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("extensionless native Windows update commands cannot promise batch-safe arguments", () => {
  for (const command of ["codex", "C:\\Tools\\codex"]) {
    const binary = { path: "C:\\Tools\\codex.cmd", via: "path" as const,
      launch: { command, args: ['embedded"quote', "%PATH%"] } };
    assert.equal(manualCodexUpdateCommand(binary, { kind: "native" }, "win32"), null);
  }
});

test("dotted native Windows update commands can still resolve to batch wrappers", () => {
  for (const command of ["codex.v2", "C:\\Tools\\codex.v2"]) {
    const binary = { path: "C:\\Tools\\codex.v2.cmd", via: "path" as const,
      launch: { command, args: ['embedded"quote', "%PATH%"] } };
    assert.equal(manualCodexUpdateCommand(binary, { kind: "native" }, "win32"), null);
  }
});

test("PowerShell resolves dotted harness names to batch wrappers, so update guidance stays non-copyable",
  { skip: process.platform !== "win32" }, () => {
  for (const suffix of ["cmd", "bat"]) {
    const dir = mkdtempSync(join(tmpdir(), "wollipog dotted lookup "));
    try {
      writeFileSync(join(dir, `codex.v2.${suffix}`), "@echo off\r\necho DOTTED_WRAPPER_EXECUTED:%*\r\n");
      const script = join(dir, "probe.ps1");
      writeFileSync(script, [
        "$resolved = Get-Command codex.v2 -ErrorAction SilentlyContinue",
        "Write-Output \"RESOLVED:$($resolved.Source)\"",
        "& codex.v2 probe",
        "Write-Output \"NATIVE_EXIT:$LASTEXITCODE\"",
      ].join("\r\n"));
      const probe = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
        encoding: "utf8", env: { ...process.env, PATH: `${dir};${process.env.PATH}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      });
      assert.equal(probe.status, 0, probe.stderr);
      assert.match(probe.stdout, new RegExp(`RESOLVED:.*codex\\.v2\\.${suffix}`, "i"));
      assert.match(probe.stdout, /DOTTED_WRAPPER_EXECUTED:probe/);
      assert.match(probe.stdout, /NATIVE_EXIT:0/);
      const binary = { path: join(dir, `codex.v2.${suffix}`), via: "path" as const,
        launch: { command: "codex.v2", args: ['embedded"quote', "%PATH%"] } };
      assert.equal(manualCodexUpdateCommand(binary, { kind: "native" }, "win32"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a Windows batch shim advertising Codex update produces manager guidance, not a command",
  { skip: process.platform !== "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "wollipog codex update "));
    const shim = join(dir, "codex.cmd");
    try {
      writeFileSync(shim, "@echo off\r\necho Commands:\r\necho   update  Update Codex to the latest version\r\n", "utf8");
      const binary = { path: shim, via: "path" as const, launch: { command: shim, args: [] } };
      const assessment = await checkHarnessUpdate("codex", binary, { kind: "native" }, "0.2.0", true);
      assert.equal(assessment.status, "managed_externally");
      assert.match(assessment.guidance, /advertises its built-in `codex update` command/);
      assert.match(assessment.guidance, /No copyable update command is available/);
      assert.doesNotMatch(assessment.guidance, /Run `|& '.*codex\.cmd'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("Machine pins identify only the named harness", () => {
  assert.equal(harnessVersionPinned("codex", "claude,codex"), true);
  assert.equal(harnessVersionPinned("claude", "claude,codex"), true);
  assert.equal(harnessVersionPinned("pi", "claude,codex"), false);
  assert.equal(harnessVersionPinned("codex", "codex-other"), false);
});

test("pinned and checks-off policies suppress executable and registry probes", async () => {
  const originalPins = process.env.WOLLIPOG_HARNESS_UPDATE_PINNED;
  const originalChecks = process.env.WOLLIPOG_HARNESS_UPDATE_CHECKS;
  const binary = { path: "/missing/codex", via: "path" as const,
    launch: { command: "/missing/codex", args: [] } };
  try {
    process.env.WOLLIPOG_HARNESS_UPDATE_PINNED = "codex";
    delete process.env.WOLLIPOG_HARNESS_UPDATE_CHECKS;
    const pinned = await checkHarnessUpdate("codex", binary, { kind: "native" }, "0.155.1", true);
    assert.equal(pinned.evidenceSource, "Machine pinned-version policy");
    assert.equal(pinned.status, "managed_externally");
    assert.match(pinned.guidance, /Release checks are suppressed/);
    assert.doesNotMatch(pinned.guidance, /Run .*update/);
    delete process.env.WOLLIPOG_HARNESS_UPDATE_PINNED;
    process.env.WOLLIPOG_HARNESS_UPDATE_CHECKS = "off";
    const disabled = await checkHarnessUpdate("codex", binary, { kind: "native" }, "0.155.1", true);
    assert.equal(disabled.evidenceSource, "Machine update-check policy");
    assert.equal(disabled.status, "managed_externally");
    assert.match(disabled.guidance, /manual upgrades are permitted/);
  } finally {
    if (originalPins === undefined) delete process.env.WOLLIPOG_HARNESS_UPDATE_PINNED;
    else process.env.WOLLIPOG_HARNESS_UPDATE_PINNED = originalPins;
    if (originalChecks === undefined) delete process.env.WOLLIPOG_HARNESS_UPDATE_CHECKS;
    else process.env.WOLLIPOG_HARNESS_UPDATE_CHECKS = originalChecks;
  }
});
