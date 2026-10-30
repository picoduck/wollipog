import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectResult, freshReport, main, markdown, parseVersion, PROBES, reportExit, selectIsolation } from "./pi-assumptions.mjs";
import { piProbeExit, verifyNetworkIsolation } from "../apps/runner/scripts/pi-probe-support.ts";
import { compareShapes, recordShapes } from "../apps/runner/scripts/pi-rpc-shape.ts";
import { expectedSessionDirectory } from "../apps/runner/scripts/pi-assumptions-probe.ts";

const probe = { id: "fixture", minimum: 1, documentation: "old-measurement.md" };
function line(status, extra = {}) {
  return JSON.stringify({ event: "pi_assumption", assumption: "fixture contract", status, observed: "fixture observation", documentation: "old-measurement.md", ...extra });
}
function execution(status = "unchanged", extra = {}) {
  return { code: status === "changed" ? 1 : status === "could not run" ? 2 : 0, unavailable: false, stdout: line(status, extra) };
}

test("changed and could-not-run stay distinct, and nothing short of a complete measurement passes", () => {
  assert.equal(collectResult(probe, execution()).status, "unchanged");
  assert.equal(reportExit([collectResult(probe, execution())]), 0);
  const changed = collectResult(probe, execution("changed"));
  assert.equal(changed.status, "changed"); assert.equal(reportExit([changed]), 1);
  for (const run of [
    { code: 0, stdout: "", unavailable: false }, // no output at all
    { code: 2, stdout: "", unavailable: false },
    { ...execution(), unavailable: true }, // timeout or spawn failure, even with good-looking output
    execution("could not run"),
    { ...execution(), stdout: line("passed") }, // a status outside the contract
    { ...execution(), stdout: line("unchanged", { observed: 3 }) },
    { ...execution(), stdout: "not json\n" },
  ]) {
    const result = collectResult(probe, run);
    assert.equal(result.status, "could not run"); assert.equal(reportExit([result]), 2);
    assert.match(result.observed, /missing|incomplete/);
  }
  for (const code of [null, 137, 3, 1]) assert.equal(collectResult(probe, { ...execution(), code }).status, "could not run");
  assert.equal(collectResult({ ...probe, minimum: 2 }, execution()).status, "could not run");
  assert.equal(collectResult({ ...probe, minimum: 2 }, execution("changed")).status, "changed");
  // One could-not-run assumption fails the whole probe even beside matches.
  assert.equal(collectResult({ ...probe, minimum: 2 }, { code: 2, unavailable: false, stdout: [line("unchanged"), line("could not run")].join("\n") }).status, "could not run");
  assert.equal(reportExit([collectResult(probe, execution("changed")), collectResult(probe, execution("could not run"))]), 1);
});

test("probe groups never exit 0 without measurements", () => {
  assert.equal(piProbeExit([]), 2);
  assert.equal(piProbeExit(["unchanged", "could not run"]), 2);
  assert.equal(piProbeExit(["unchanged", "changed"]), 1);
  assert.equal(piProbeExit(["unchanged", "unchanged"]), 0);
});

test("Pi versions parse from the bare --version output only", () => {
  for (const output of ["1.4.0", "1.4.0\n", "1.4.0\r\n", "warning\n1.4.0\n", "2.0.0-beta.1"]) assert.ok(parseVersion(output));
  assert.equal(parseVersion("1.4.0\n"), "1.4.0");
  assert.equal(parseVersion("pi unavailable"), null);
  assert.equal(parseVersion("Error: Unknown option 1.4.0"), null);
});

test("isolation is selected only when the namespace's own negative control verifies", async () => {
  const launchers = [{ name: "first", wrap: argv => ["first", argv] }, { name: "second", wrap: argv => ["second", argv] }];
  const control = (verified, observed = "control") => JSON.stringify({ event: "pi_isolation", verified, observed });
  const runs = { first: { code: 0, stdout: "", unavailable: false }, second: { code: 0, stdout: control(true, "lo only"), unavailable: false } };
  assert.deepEqual(await selectIsolation({}, launchers, async command => runs[command]), { mechanism: "second", observed: "lo only" });
  // A launcher that exits 0 without a verified control, or reports verified with a failing exit, is not isolation.
  for (const first of [{ code: 0, stdout: control(false), unavailable: false }, { code: 2, stdout: control(true), unavailable: false },
    { code: 0, stdout: control(true), unavailable: true }]) {
    const selected = await selectIsolation({}, launchers.slice(0, 1), async () => first);
    assert.equal(selected.mechanism, null);
  }
  assert.equal((await selectIsolation({}, [], async () => { throw new Error("unused"); })).mechanism, null);
});

test("an unverifiable host never verifies network isolation and sends no external control traffic", async () => {
  assert.equal((await verifyNetworkIsolation({})).verified, false);
  let own = "";
  try { own = readlinkSync("/proc/self/ns/net"); } catch { return; }
  const started = Date.now();
  const result = await verifyNetworkIsolation({ PI_PROBE_ISOLATION: "claimed", PI_PROBE_OUTER_NETNS: own });
  assert.equal(result.verified, false);
  assert.match(result.observed, /suite's own/);
  assert.ok(Date.now() - started < 2000, "the TEST-NET and DNS controls must not run from the host namespace");
});

test("fixture drift is reported for missing kinds, fields, types and enum values; real-only fields are not drift", () => {
  const fixture = recordShapes([
    { type: "response", id: "1", command: "get_entries", success: true, data: { entries: [], leafId: null } },
    { type: "response", id: "2", command: "get_commands", success: true, data: { commands: [{ name: "a", source: "skill", location: "user" }] } },
    { type: "extension_ui_request", id: "t", method: "select", title: "Trust", options: ["a", "b"] },
  ]);
  const real = recordShapes([
    { type: "response", id: "9", command: "get_entries", success: true, data: { entries: [{ id: "x" }], leafId: "x" } },
    { type: "response", id: "8", command: "get_commands", success: true, data: { commands: [{ name: "a", source: "prompt", sourceInfo: { scope: "user" } }] } },
  ]);
  const differences = compareShapes(fixture, real);
  assert.ok(differences.some(d => d.includes("data.leafId") && d.includes("type null")));
  assert.ok(differences.some(d => d.includes("data.commands[].location") && d.includes("absent")));
  assert.ok(differences.some(d => d.includes("data.commands[].source") && d.includes('value ="skill"')));
  assert.ok(differences.some(d => d.startsWith("event:extension_ui_request:select") && d.includes("never by real Pi")));
  assert.deepEqual(compareShapes(fixture, fixture), []);
  assert.deepEqual(compareShapes(recordShapes([{ type: "agent_end", messages: [] }]), recordShapes([{ type: "agent_end", messages: [{ role: "user" }], willRetry: false }])), []);
  assert.deepEqual(compareShapes(fixture, real, new Set(["response:get_entries data.leafId", "response:get_commands data.commands[].location",
    "response:get_commands data.commands[].source"])).filter(d => !d.startsWith("event:")), []);
});

test("the expected session directory encodes the working directory the way Pi 1.4.0 does", () => {
  assert.equal(expectedSessionDirectory("/h/.pi/agent", "/tmp/x/project"), "/h/.pi/agent/sessions/--tmp-x-project--");
});

test("reports are fresh only when complete, recent and consistent with their results", () => {
  const results = PROBES.map(p => ({ probe: p.id, status: "unchanged", observed: "see measured assumptions", documentation: p.documentation, assumptions: [] }));
  const report = { complete: true, completedAt: new Date().toISOString(), exitCode: 0, results };
  assert.equal(freshReport(report), true);
  assert.equal(freshReport({ ...report, complete: false }), false);
  assert.equal(freshReport({ ...report, completedAt: new Date(Date.now() - 49 * 60 * 60_000).toISOString() }), false);
  assert.equal(freshReport({ ...report, exitCode: 1 }), false);
  assert.equal(freshReport({ ...report, results: results.slice(1) }), false);
  assert.equal(freshReport({ ...report, results: [{ ...results[0], status: "acknowledged unavailable" }, ...results.slice(1)] }), false);
  assert.match(markdown({ ...report, version: "1.4.0", isolation: { mechanism: null, observed: "none" } }), /Measured @earendil-works\/pi-coding-agent: 1\.4\.0/);
});

/** End to end through the real suite: a missing binary, a binary that never speaks RPC, and a version
 * that changes mid-run must each produce a complete report that fails with exit 2, never a pass. */
test("the suite fails closed for missing, non-RPC and mid-run-upgraded Pi binaries", { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-assumptions-test-"));
  const previous = { PI_BIN: process.env.PI_BIN, PI_PROBE_DISABLE_ISOLATION: process.env.PI_PROBE_DISABLE_ISOLATION };
  const log = console.log;
  try {
    process.env.PI_PROBE_DISABLE_ISOLATION = "1";
    console.log = () => {};
    const counter = join(dir, "count");
    writeFileSync(counter, "0");
    const upgrading = join(dir, "pi-upgrading");
    writeFileSync(upgrading, `#!/bin/sh\nif [ "$1" = "--version" ]; then n=$(cat ${counter}); echo $((n+1)) > ${counter}; if [ "$n" = "0" ]; then echo 1.4.0; else echo 1.4.1; fi; exit 0; fi\nexit 0\n`);
    const silent = join(dir, "pi-silent");
    writeFileSync(silent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.0; fi\nexit 0\n`);
    for (const stub of [upgrading, silent]) chmodSync(stub, 0o755);
    for (const [label, binary] of [["missing", join(dir, "missing-pi")], ["silent", silent], ["upgrading", upgrading]]) {
      process.env.PI_BIN = binary;
      const reportDir = join(dir, `report-${label}`);
      const code = await main(["--report-dir", reportDir]);
      const report = JSON.parse(readFileSync(join(reportDir, "latest.json"), "utf8"));
      assert.equal(code, 2, label);
      assert.equal(report.exitCode, 2);
      assert.equal(report.complete, true);
      assert.equal(report.isolation.mechanism, null);
      assert.equal(report.results.length, PROBES.length);
      assert.ok(report.results.every(result => result.status === "could not run"), `${label}: ${JSON.stringify(report.results.map(r => [r.probe, r.status]))}`);
      assert.equal(report.version, label === "missing" ? null : "1.4.0");
      if (label === "upgrading") assert.ok(report.results.every(result => result.observed.includes("mixed-version")));
      if (label === "silent") {
        // The probes themselves ran and reported could-not-run measurements; no assumption claimed a match.
        assert.ok(report.results.every(result => result.assumptions.length >= PROBES.find(p => p.id === result.probe).minimum &&
          result.assumptions.every(a => a.status === "could not run")),
          JSON.stringify(report.results.map(r => r.assumptions.map(a => [a.assumption, a.status]))));
      }
      assert.equal(await main(["--report-dir", reportDir, "--check-fresh"]), 2);
    }
  } finally {
    console.log = log;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});
