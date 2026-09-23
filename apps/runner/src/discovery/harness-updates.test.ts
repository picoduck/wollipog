import assert from "node:assert/strict";
import { test } from "node:test";
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
