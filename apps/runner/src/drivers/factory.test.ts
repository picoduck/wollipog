import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_EXEC_RETIRED_REASON } from "@wollipog/protocol";
import { makeDriver } from "./factory.js";

test("the retired Codex exec driver is never constructed, and never falls through to ACP (#3259)", () => {
  assert.throws(
    () => makeDriver("codex", { command: "codex", args: ["exec"], cwd: "/repo", env: {} } as never, {} as never),
    new Error(CODEX_EXEC_RETIRED_REASON),
  );
});
