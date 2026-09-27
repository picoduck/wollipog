import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRunnerEntry } from "./runner-entry.js";

test("runner entry resolves only the first SEA or Node application argument", () => {
  assert.deepEqual(resolveRunnerEntry(["runner.exe", "runner.exe", "--state-doctor"]), {
    mode: "--state-doctor", modeIndex: 2,
  });
  assert.deepEqual(resolveRunnerEntry(["node", "cli.ts", "--agent-control-mcp"]), {
    mode: "--agent-control-mcp", modeIndex: 2,
  });
  assert.deepEqual(resolveRunnerEntry(["node", "cli.ts", "--wollipog-cli", "session", "list"]), {
    mode: "--wollipog-cli", modeIndex: 2,
  });
});

test("later internal-looking values remain CLI data and never select another mode", () => {
  for (const later of ["--agent-control-mcp", "--policy-hook", "--state-doctor"]) {
    assert.deepEqual(resolveRunnerEntry(["runner.exe", "runner.exe", "--wollipog-cli", "session", "create", later]), {
      mode: "--wollipog-cli", modeIndex: 2,
    });
    assert.deepEqual(resolveRunnerEntry(["node", "cli.ts", "serve", later]), {
      mode: "daemon", modeIndex: 2,
    });
  }
});

test("wollipog invocation name remains CLI unless its first argument is an internal contract", () => {
  assert.deepEqual(resolveRunnerEntry(["C:\\bin\\wollipog.exe", "C:\\bin\\wollipog.exe", "session", "list", "--agent-control-mcp"]), {
    mode: "--wollipog-cli", modeIndex: 2,
  });
  assert.deepEqual(resolveRunnerEntry(["/usr/local/bin/wollipog", "/usr/local/bin/wollipog", "--agent-control-mcp"]), {
    mode: "--agent-control-mcp", modeIndex: 2,
  });
});
