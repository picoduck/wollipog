// Installed SDK tool factory only. Runs with a synthetic HOME and no inherited credentials.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const [prototypeUrl, codeRoot, cwd] = process.argv.slice(2);
const { verifyPiCommandHomePrototypeInstallation, installPiCommandHomePrototype } = await import(prototypeUrl);
assert.equal(verifyPiCommandHomePrototypeInstallation(codeRoot), true);
const sdk = await import(pathToFileURL(`${codeRoot}/dist/core/tools/bash.js`).href);
const handlers = new Map();
const source = "/immutable/synthetic-extension.mjs";
let registered;
const pi = {
  registerTool(tool) { registered = tool; },
  on(name, handler) { handlers.set(name, handler); },
  getActiveTools: () => ["bash"],
  getAllTools: () => [{ name: "bash", sourceInfo: { source: "cli", path: source } }],
};
const calls = [];
const operations = Object.freeze({ async exec(command, actualCwd, options) {
  calls.push({ command, actualCwd, env: options.env });
  options.onData(Buffer.from("INERT_SDK_BACKEND"));
  return { exitCode: 0 };
} });
installPiCommandHomePrototype(pi, sdk, operations, cwd, source);
handlers.get("session_start")({ reason: "startup" });
const result = await registered.execute("fixture-call", { command: "never-spawn-this", timeout: 1 });
assert.match(JSON.stringify(result), /INERT_SDK_BACKEND/);
assert.equal(calls.length, 1);
assert.equal(calls[0].command, "never-spawn-this");
assert.equal(calls[0].actualCwd, cwd);
assert.equal(calls[0].env.HOME, cwd);
assert.equal(handlers.get("user_bash")({ command: "rpc-inert" }).operations, operations);
console.log("PINNED_PI_SDK_OPERATIONS_CONTRACT: passed");
