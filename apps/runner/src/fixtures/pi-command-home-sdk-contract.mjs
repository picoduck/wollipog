// Installed SDK tool factory only. Runs with a synthetic HOME and no inherited credentials.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const [prototypeUrl, codeRoot, cwd] = process.argv.slice(2);
const { verifyPiCommandHomePrototypeInstallation, verifyPiCommandHomePrototypeRuntime, installPiCommandHomePrototype } = await import(prototypeUrl);
assert.equal(verifyPiCommandHomePrototypeInstallation(codeRoot), true);
assert.equal(verifyPiCommandHomePrototypeRuntime(process.execPath, new URL("./pi-command-home-entrypoint.mjs", prototypeUrl).pathname), true);
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
let operationsError;
const operations = Object.freeze({ async exec(command, actualCwd, options) {
  calls.push({ command, actualCwd, env: options.env });
  options.onData(Buffer.from("INERT_SDK_BACKEND"));
  if (operationsError) throw new Error(operationsError);
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
for (const [error, formatted] of [["aborted", "Command aborted"], ["timeout:0.001", "Command timed out after 0.001 seconds"]]) {
  operationsError = error;
  await assert.rejects(registered.execute("fixture-call", { command: "never-spawn-this" }), error => {
    assert.match(error.message, /INERT_SDK_BACKEND/u);
    assert.ok(error.message.endsWith(formatted));
    return true;
  });
}
console.log("PINNED_PI_SDK_OPERATIONS_CONTRACT: passed");
