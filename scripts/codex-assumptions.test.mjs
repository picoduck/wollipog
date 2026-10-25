import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { collectResult, guardRangeResult, reportExit, reportFresh, PROBES, EXCLUSIONS } from "./codex-assumptions.mjs";
import { isolatedProbeEnv, unavailableProbeOutput } from "../apps/runner/scripts/codex-probe-support.ts";

const probe = { id: "fixture", documentation: "old-measurement.md" };
function execution(status = "unchanged", extra = {}) {
  return { code: status === "changed" ? 1 : 0, unavailable: false, stdout: JSON.stringify({ event: "codex_assumption", assumption: "fixture contract", status, observed: "fixture observation", documentation: "old-measurement.md", ...extra }) };
}

test("changed assumptions and unavailable probes are distinct and both fail; optional drift stays advisory", () => {
  const changed = collectResult(probe, execution("changed"));
  const optional = collectResult(probe, execution("optional drift", { optional: true }));
  for (const run of [{ code: 0, stdout: "", unavailable: false }, { code: 2, stdout: "", unavailable: false }, { ...execution(), unavailable: true }]) {
    const result = collectResult(probe, run);
    assert.equal(result.status, "could not run"); assert.equal(reportExit([result]), 2);
  }
  assert.equal(changed.status, "changed"); assert.equal(reportExit([changed]), 1);
  assert.equal(optional.status, "optional drift"); assert.equal(reportExit([optional]), 0);
  assert.equal(collectResult(probe, execution("optional drift")).status, "could not run");
});

test("sandbox startup failure is not mistaken for a measured filesystem denial", () => {
  assert.equal(unavailableProbeOutput("bwrap: No permissions to create new namespace"), true);
  assert.equal(unavailableProbeOutput("TIMED OUT"), true);
  assert.equal(unavailableProbeOutput("cat: fixture: Permission denied"), false);
  assert.equal(unavailableProbeOutput("NETBLOCKED"), false);
});

test("a successful unknown-version guard measurement proposes widening without changing admission", () => {
  assert.equal(guardRangeResult("0.163.0", { status: "unchanged" }).status, "unchanged");
  assert.equal(guardRangeResult("0.164.0", { status: "unchanged" }).status, "measured OK, range can be widened");
  assert.equal(guardRangeResult("0.164.0", { status: "changed" }).status, "changed");
  assert.equal(guardRangeResult("0.164.0", { status: "could not run" }).status, "could not run");
});

test("missing, incomplete, future and stale reports cannot look fresh", () => {
  const now = Date.now();
  assert.equal(reportFresh(undefined, now), false);
  for (const hours of [-1, 49]) assert.equal(reportFresh({ complete: true, completedAt: new Date(now - hours * 3600000).toISOString() }, now), false);
  assert.equal(reportFresh({ complete: false, completedAt: new Date(now).toISOString() }, now), false);
  assert.equal(reportFresh({ complete: true, completedAt: new Date(now - 47 * 3600000).toISOString() }, now), true);
});

test("all package probes are accounted for and authenticated inference is never in the runnable set", () => {
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).scripts;
  const covered = new Set(PROBES.map(p => p.script));
  for (const [name, command] of Object.entries(scripts).filter(([name]) => name.startsWith("probe:codex-") || name === "check:codex-schema")) {
    if (name === "probe:codex-assumptions") continue;
    assert.ok([...covered].some(script => command.endsWith(script)) || EXCLUSIONS.some(e => e.command === name), name);
  }
  assert.ok(PROBES.every(p => !p.script.includes("inference-transport")));
});

test("probe environments discard accounts, credentials, endpoint overrides and Node preload hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-env-test-"));
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  try {
    const env = isolatedProbeEnv(dir);
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.WOLLIPOG_SESSION_TOKEN_FILE, undefined); assert.equal(env.CODEX_HOME, dir);
    assert.equal(env.HOME, dir); assert.equal(env.XDG_CONFIG_HOME, dir);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("missing binary writes a complete failing report rather than passing or claiming drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-missing-test-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/codex-assumptions.mjs", "--report-dir", dir], {
      encoding: "utf8", timeout: 20000, env: { ...process.env, CODEX_BIN: join(dir, "missing-codex") },
    });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(readFileSync(join(dir, "latest.json")));
    assert.equal(report.version, null); assert.equal(report.complete, true); assert.equal(report.exitCode, 2);
    assert.ok(report.results.every(r => r.status === "could not run"));
    assert.equal(report.guardTrust.status, "could not run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing optional RPC fields stay advisory and preserve sanitized unknown diagnostics", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-optional-test-"));
  try {
    const binary = join(dir, "codex.cjs");
    writeFileSync(binary, `#!/usr/bin/env node
const readline = require('node:readline');
const send = m => console.log(JSON.stringify(m));
readline.createInterface({input:process.stdin}).on('line',line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 if(m.method==='config/read') return send({id:m.id,error:{code:-32601,message:'private-provider-error'}});
 send({id:m.id,result:m.method==='initialize'?{userAgent:'codex/0.163.0 (fixture)'}:m.method==='thread/start'?{thread:{id:'fixture'}}:{}});
 if(m.method==='turn/start') send({method:'turn/completed',params:{}});
});
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["--import", "tsx", "apps/runner/scripts/codex-diagnostics-probe.ts"], {
      encoding: "utf8", timeout: 20000, env: { ...process.env, CODEX_BIN: binary },
    });
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(events.length, 3);
    assert.ok(events.every(e => e.status === "optional drift" && e.optional === true));
    assert.match(result.stdout, /provider=unknown; configuredTransport=unknown; observedTransport=unverified/);
    assert.ok(!result.stdout.includes("private-provider-error"));
    assert.ok(!result.stdout.includes("WebSocket success\""));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
