import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("every agent NDJSON stdout ingestion path uses the shared bounded accumulator", () => {
  const jsonrpc = readFileSync(new URL("./jsonrpc.ts", import.meta.url), "utf8");
  const claude = readFileSync(new URL("./drivers/claude-code.ts", import.meta.url), "utf8");

  assert.equal((jsonrpc.match(/new BoundedNdjsonBuffer/g) ?? []).length, 1);
  assert.equal((claude.match(/new BoundedNdjsonBuffer/g) ?? []).length, 3,
    "fork bootstrap, one-shot turns, and persistent transport must all be bounded");
  for (const source of [jsonrpc, claude]) {
    assert.doesNotMatch(source, /(?:buffer|buf|persistentBuffer) \+= chunk/);
  }
});
