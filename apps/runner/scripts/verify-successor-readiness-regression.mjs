import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runFocusedValidation } from "./successor-load-lifecycle.mjs";

// Exercise the real fixture with exactly one change. An unrelated failure, skipped
// test, outer timeout, or incomplete cleanup must not count as killing the mutant.
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const original = new URL("../src/provider-home-lease.test.ts", import.meta.url);
// Explicitly named to Node; excluded from the regular test glob if interrupted.
const mutated = new URL(`../src/provider-home-lease.readiness-${randomUUID()}.mutation.ts`, import.meta.url);
const source = readFileSync(original, "utf8");
const gate = /^    assert\.ok\(await waitUntil\(\(\) => states\.every\(\(state\) => state\.ready\), options\.readinessMs \?\? 10_000, true\), "contender readiness timed out"\);$/gm;
assert.equal([...source.matchAll(gate)].length, 1, "locate exactly one parent readiness wait");
let output = "";
writeFileSync(mutated, source.replace(gate, "    // Readiness wait removed by the mutation verifier."), { flag: "wx" });
try {
  await assert.rejects(runFocusedValidation({
    cwd: repo,
    args: [
      "--import", "tsx", "--test", "--test-reporter=tap", "--test-timeout=45000",
      "--test-name-pattern=^successor election keeps slow startup out of the result deadline$",
      fileURLToPath(mutated),
    ],
    outerMs: 60_000,
    onOutput: (chunk) => { output += chunk; },
  }), (error) => error instanceof Error && error.message === "focused validation exit=1 signal=null");
  const lines = output.split(/\r?\n/);
  assert.ok(lines.some((line) => /^not ok \d+ - successor election keeps slow startup out of the result deadline$/.test(line)), "the exact regression must fail");
  for (const expected of ["# tests 1", "# pass 0", "# fail 1", "# cancelled 0", "# skipped 0"]) {
    assert.ok(lines.includes(expected), `unexpected mutation result: ${expected}`);
  }
  assert.match(output, /both contenders report before the race deadline; \[/);
  assert.equal((output.match(/"closed":true/g) ?? []).length, 2, "both owned contenders closed");
  console.log("Readiness mutation rejected at the reporting deadline; both contenders closed and fixture state removed.");
} catch (error) {
  process.stdout.write(output);
  throw error;
} finally {
  unlinkSync(mutated);
}
