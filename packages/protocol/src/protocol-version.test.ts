import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL } from "./index.js";
import { PROTOCOL_VERSION as LEDGER_PROTOCOL_VERSION } from "./protocol-version.js";

const ledger = readFileSync(new URL("./protocol-version.ts", import.meta.url), "utf8");
const versions = [...ledger.matchAll(/^ {2}(\d+),$/gmu)].map((match) => Number(match[1]));
const headers = [...ledger.matchAll(/^ {2}\/\/ (\d+): /gmu)].map((match) => Number(match[1]));

test("PROTOCOL_VERSION is the ledger's highest entry, exported unchanged through index.ts", () => {
  assert.equal(PROTOCOL_VERSION, LEDGER_PROTOCOL_VERSION);
  assert.equal(typeof PROTOCOL_VERSION, "number");
  assert.ok(Number.isInteger(PROTOCOL_VERSION));
  assert.equal(PROTOCOL_VERSION, Math.max(...versions));
  // #975 moved the history out of index.ts when main was at 327; the value only ever grows.
  assert.ok(PROTOCOL_VERSION >= 327);
});

test("every version has exactly one history entry naming it, in increasing order", () => {
  assert.deepEqual(headers, versions);
  assert.ok(versions.every((version, index) => index === 0 || version > versions[index - 1]!));
});

test("no capability floor is above PROTOCOL_VERSION", () => {
  const above = Object.entries(RUNNER_CAPABILITY_MIN_PROTOCOL).filter(([, floor]) => floor > PROTOCOL_VERSION);
  assert.deepEqual(above, []);
});
