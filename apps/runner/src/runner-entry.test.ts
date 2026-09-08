import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRunnerEntry } from "./runner-entry.js";

test("runner entry resolves only the first SEA or Node application argument", () => {
  assert.deepEqual(resolveRunnerEntry(["runner.exe", "--state-doctor"], true), {
    mode: "--state-doctor", modeIndex: 1,
  });
  assert.deepEqual(resolveRunnerEntry(["node", "cli.ts", "--agent-control-mcp"], false), {
    mode: "--agent-control-mcp", modeIndex: 2,
  });
  assert.deepEqual(resolveRunnerEntry(["node", "cli.ts", "--wollipog-cli", "session", "list"], false), {
    mode: "--wollipog-cli", modeIndex: 2,
  });
});

test("later internal-looking values remain CLI data and never select another mode", () => {
  for (const later of ["--agent-control-mcp", "--policy-hook", "--state-doctor", "--conductor-mcp"]) {
    assert.deepEqual(resolveRunnerEntry(["runner.exe", "--wollipog-cli", "session", "create", later], true), {
      mode: "--wollipog-cli", modeIndex: 1,
    });
    assert.deepEqual(resolveRunnerEntry(["node", "cli.ts", "serve", later], false), {
      mode: "daemon", modeIndex: 2,
    });
  }
});

test("wollipog invocation name remains CLI unless its first argument is an internal contract", () => {
  assert.deepEqual(resolveRunnerEntry(["C:\\bin\\wollipog.exe", "session", "list", "--agent-control-mcp"], true), {
    mode: "--wollipog-cli", modeIndex: 1,
  });
  assert.deepEqual(resolveRunnerEntry(["/usr/local/bin/wollipog", "--agent-control-mcp"], true), {
    mode: "--agent-control-mcp", modeIndex: 1,
  });
});
