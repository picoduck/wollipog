import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyNpmHarnessUpdate, codexOffersSelfUpdate, harnessVersionPinned, npmPackageForInstallation } from "./harness-updates.js";

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
  assert.match(classifyNpmHarnessUpdate("0.211.0-beta.0", tags, "@openai/codex", 1).guidance, /preview channel/);
  assert.match(classifyNpmHarnessUpdate("0.199.0", tags, "@openai/codex", 1).guidance, /compatibility.*not been verified/);
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
  const observed: Array<{ command: string; args: string[] }> = [];
  const execute = async (command: string, args: string[]) => {
    observed.push({ command, args });
    return result("Commands:\n  update  Update Codex to the latest version\n");
  };
  assert.equal(await codexOffersSelfUpdate(binary, { kind: "native" }, execute), true);
  assert.deepEqual(observed.pop(), { command: "/first/node", args: ["/first/codex.js", "--help"] });
  assert.equal(await codexOffersSelfUpdate(binary, { kind: "wsl", distro: "Ubuntu" }, execute), true);
  assert.deepEqual(observed.pop(), { command: "wsl.exe", args: ["-d", "Ubuntu", "--exec", "/first/node", "/first/codex.js", "--help"] });
  assert.equal(await codexOffersSelfUpdate(binary, { kind: "native" }, async () => result("unknown command")), false);
});

test("Machine pins identify only the named harness", () => {
  assert.equal(harnessVersionPinned("codex", "claude,codex"), true);
  assert.equal(harnessVersionPinned("claude", "claude,codex"), true);
  assert.equal(harnessVersionPinned("pi", "claude,codex"), false);
  assert.equal(harnessVersionPinned("codex", "codex-other"), false);
});
