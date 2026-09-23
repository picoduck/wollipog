import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyNpmHarnessUpdate, npmPackageForInstallation } from "./harness-updates.js";

const result = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });

test("npm update comparison distinguishes newer, current, preview, and failed checks", () => {
  const tags = result(JSON.stringify({ latest: "0.210.0", next: "0.211.0-beta.1" }));
  assert.equal(classifyNpmHarnessUpdate("0.199.0", tags, "@openai/codex", 1).status, "update_available");
  assert.equal(classifyNpmHarnessUpdate("0.210.0", tags, "@openai/codex", 1).status, "up_to_date");
  assert.equal(classifyNpmHarnessUpdate("0.211.0-beta.0", tags, "@openai/codex", 1).status, "preview_channel");
  assert.equal(classifyNpmHarnessUpdate(undefined, tags, "@openai/codex", 1).status, "version_unknown");
  assert.equal(classifyNpmHarnessUpdate("0.199.0", result("", 1), "@openai/codex", 1).status, "check_failed");
  assert.equal(classifyNpmHarnessUpdate("0.199.0", result("not JSON"), "@openai/codex", 1).status, "check_failed");
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
});
