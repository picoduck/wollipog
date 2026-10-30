import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { test } from "node:test";
import { acknowledgeUnavailable, collectResult, guardRangeResult, markdown, reportExit, reportFresh, parseVersion, PROBES, EXCLUSIONS } from "./codex-assumptions.mjs";
import { isGuardianRequest, isolatedProbeEnv, unavailableProbeOutput } from "../apps/runner/scripts/codex-probe-support.ts";
import { CASES, caseMatches, fixtureHomeBase, hardeningRestorable, SANDBOX_CONTROL_ARGS, sandboxFailureDetail, sandboxNamespaceUnavailable } from "../apps/runner/scripts/codex-escalation-probe.ts";
import { withoutMcpApproval } from "../apps/runner/scripts/codex-mcp-wait-probe.ts";
import { additiveCodexMcpServerArg, sessionCodexMcpServerArg, CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC } from "../apps/runner/src/orchestrator-preset.ts";

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
  for (const code of [null, 137, 3, 1]) assert.equal(collectResult(probe, { ...execution(), code }).status, "could not run");
  assert.equal(collectResult({ ...probe, minimum: 2 }, execution()).status, "could not run");
  assert.equal(collectResult({ ...probe, minimum: 2 }, execution("changed")).status, "changed");
});

test("version rechecks compare semantic versions across harmless output formatting", () => {
  for (const output of ["codex-cli 0.163.0", "codex-cli 0.163.0 (build)", "codex-cli 0.163.0\r\n", "warning\ncodex-cli 0.163.0\n"]) assert.equal(parseVersion(output), "0.163.0");
  assert.equal(parseVersion("codex-cli unavailable"), null);
});

test("only the measured namespace denial is eligible for acknowledgement, never a timeout or unrelated failure", () => {
  const denied = { status: 1, signal: null, stderr: "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.\n" };
  assert.equal(sandboxNamespaceUnavailable(denied), true);
  for (const result of [null, { ...denied, error: new Error("ETIMEDOUT") }, { ...denied, signal: "SIGTERM" },
    { ...denied, status: null }, { ...denied, status: 0 }, { ...denied, stderr: "bwrap: Operation not permitted" },
    { ...denied, stderr: "error: unrecognized subcommand sandbox" }]) assert.equal(sandboxNamespaceUnavailable(result), false);
});

test("the sandbox control uses the current `codex sandbox [OPTIONS] [COMMAND]...` form", () => {
  // `codex sandbox linux -- ...` runs a program named `linux` on 0.155.1 and 0.166.0.
  assert.deepEqual(SANDBOX_CONTROL_ARGS.slice(0, 2), ["sandbox", "--"]);
  assert.ok(!SANDBOX_CONTROL_ARGS.includes("linux"));
  assert.equal(SANDBOX_CONTROL_ARGS.at(-1), "printf PROBE_SANDBOX_READY");
});

test("the escalation fixture's Codex home leaves the temporary directory only for a throwaway HOME outside it", () => {
  assert.equal(fixtureHomeBase("/opt/harness-probe/work/codex/0.166.0/tmp/s/home", "/tmp"), "/opt/harness-probe/work/codex/0.166.0/tmp/s/home");
  assert.equal(fixtureHomeBase("/tmp/wollipog-codex-assumptions-x/home", "/tmp"), null);
  assert.equal(fixtureHomeBase("/tmp", "/tmp"), null);
  assert.equal(fixtureHomeBase("/tmpfoo/home", "/tmp"), "/tmpfoo/home");
  assert.equal(fixtureHomeBase(undefined, "/tmp"), null);
  assert.equal(fixtureHomeBase("relative/home", "/tmp"), null);
});

test("a failed sandbox control reports its exact cause, bounded and printable", () => {
  assert.equal(sandboxFailureDetail({ status: 1, signal: null, stderr: "\nbwrap: setting up uid map: Permission denied\nmore\n" }), "exited 1: bwrap: setting up uid map: Permission denied");
  assert.equal(sandboxFailureDetail({ status: null, signal: "SIGKILL", stderr: "" }), "killed by SIGKILL with no stderr");
  assert.equal(sandboxFailureDetail({ status: null, error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }), stderr: null }), "could not start (ETIMEDOUT) with no stderr");
  assert.equal(sandboxFailureDetail({ status: 0, stderr: "" }), "exited 0 without the ready marker with no stderr");
  assert.equal(sandboxFailureDetail(null), "no Linux sandbox on this platform");
  assert.equal(sandboxFailureDetail({ status: 101, stderr: 'WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp"\nthread main panicked at sandbox.rs: could not exec helper\n' }),
    "exited 101: thread main panicked at sandbox.rs: could not exec helper");
  assert.equal(sandboxFailureDetail({ status: 101, stderr: "thread 'main' (2) panicked at linux-sandbox/src/linux_run_main.rs:1193:5:\nfailed to apply sandbox: Permission denied (os error 13)\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n" }),
    "exited 101: thread 'main' (2) panicked at linux-sandbox/src/linux_run_main.rs:1193:5: failed to apply sandbox: Permission denied (os error 13)");
  assert.equal(sandboxFailureDetail({ status: 1, stderr: "WARNING: only a warning\n" }), "exited 1: WARNING: only a warning");
  const long = sandboxFailureDetail({ status: 2, stderr: `\u001b[31m${"x".repeat(500)}` });
  assert.ok(long.length < 430 && !long.includes("\u001b"));
});

test("acknowledged namespace unavailability succeeds operationally with visible unmeasured evidence; every other failure remains failing", () => {
  const escalation = PROBES.find(p => p.id === "escalation");
  const unavailable = { ...execution("could not run", { unavailableReason: "sandbox_namespace_unavailable",
    observed: "Host denies unprivileged user namespaces; no escalation assumption measured" }), code: 2 };
  const result = collectResult(escalation, unavailable);
  const acknowledged = acknowledgeUnavailable(result, "escalation");
  assert.equal(acknowledged.status, "acknowledged unavailable");
  assert.equal(acknowledged.measuredStatus, "could not run");
  assert.equal(acknowledged.assumptions[0].status, "could not run");
  assert.equal(reportExit([acknowledged]), 0);
  assert.equal(reportExit([acknowledgeUnavailable(result)]), 2);
  assert.equal(reportExit([acknowledgeUnavailable(result, "guard")]), 2);
  for (const run of [execution("could not run"), { ...unavailable, unavailable: true }, { ...unavailable, code: null },
    { ...unavailable, stdout: unavailable.stdout + "\n" + execution().stdout },
    { ...execution("could not run", { unavailableReason: "missing_binary" }), code: 2 }]) {
    assert.equal(reportExit([acknowledgeUnavailable(collectResult(escalation, run), "escalation")]), 2);
  }
  const changed = acknowledgeUnavailable(collectResult(escalation, execution("changed")), "escalation");
  assert.equal(changed.status, "changed");
  assert.equal(reportExit([acknowledged, changed]), 1);
  assert.equal(reportExit([result, changed]), 1);
  assert.equal(acknowledgeUnavailable(collectResult(PROBES.find(p => p.id === "guard"), unavailable), "guard").status, "could not run");

  const dir = mkdtempSync(join(tmpdir(), "codex-acknowledged-test-"));
  try {
    const report = { version: "0.163.0", complete: true, completedAt: new Date().toISOString(), exitCode: 0,
      results: PROBES.map(p => p.id === "escalation" ? acknowledged : collectResult(p, {
        code: 0, stdout: Array(p.minimum).fill(execution().stdout).join("\n"), unavailable: false })) };
    writeFileSync(join(dir, "latest.json"), JSON.stringify(report));
    const persisted = readFileSync(join(dir, "latest.json"), "utf8");
    assert.match(persisted, /"status":"acknowledged unavailable"/);
    assert.match(persisted, /"measuredStatus":"could not run"/);
    assert.match(markdown(report), /acknowledged unavailable: Host denies unprivileged user namespaces/);
    const check = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/codex-assumptions.mjs", "--check-fresh", "--report-dir", dir], { encoding: "utf8", timeout: 20000 });
    const fresh = check();
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /escalation: acknowledged unavailable: Host denies unprivileged user namespaces/);
    report.completedAt = new Date(Date.now() - 49 * 3600000).toISOString();
    writeFileSync(join(dir, "latest.json"), JSON.stringify(report));
    assert.equal(check().status, 2);
    const service = readFileSync(new URL("./systemd/wollipog-codex-probes.service", import.meta.url), "utf8");
    assert.match(service, /^EnvironmentFile=-%h\/\.config\/wollipog-codex-probes\.env$/m);
    assert.ok(!service.includes("CODEX_ASSUMPTION_ACKNOWLEDGED_UNAVAILABLE="));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("both real MCP entry kinds lose their approval grant in the negative control, retaining the timeout", () => {
  for (const builder of [additiveCodexMcpServerArg, sessionCodexMcpServerArg]) {
    const approved = builder({ command: "node", args: ["stub.cjs"], env: {} });
    const unapproved = withoutMcpApproval(approved);
    assert.notEqual(unapproved, approved);
    assert.ok(!unapproved.includes('"approval_mode"'));
    assert.ok(!unapproved.includes('"default_tools_approval_mode"'));
    assert.ok(unapproved.includes(`"tool_timeout_sec" = ${CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC}`));
  }
  assert.throws(() => withoutMcpApproval("unrecognized entry"), /could not remove/);
});

test("sandbox startup failure is not mistaken for a measured filesystem denial", () => {
  assert.equal(unavailableProbeOutput("bwrap: No permissions to create new namespace"), true);
  assert.equal(unavailableProbeOutput("TIMED OUT"), true);
  assert.equal(unavailableProbeOutput("cat: fixture: Permission denied"), false);
  assert.equal(unavailableProbeOutput("NETBLOCKED"), false);
});

test("withheld hardening becomes re-enablable only with retained network and every denial/approval control", () => {
  const marker = "fixture-marker";
  const outcome = (c, output) => ({ output, guardianRequests: c.guardian ? 1 : 0 });
  const outputs = new Map(CASES.map(c => [c.name, outcome(c, c.expect === "denied" ? "Permission denied" :
    c.expect === "declined" ? "declined" : c.expect === "markerRead" ? marker :
      c.expect === "network" || c.escalate ? "NETOK!!" : "NETBLOCKED")]));
  assert.equal(hardeningRestorable(outputs, marker), true);
  for (const c of CASES) {
    const incomplete = new Map(outputs); incomplete.delete(c.name);
    assert.equal(hardeningRestorable(incomplete, marker), false, `missing control ${c.name}`);
  }
  const denied = CASES.find(c => c.expect === "denied");
  const namespaceFailure = new Map(outputs); namespaceFailure.set(denied.name, outcome(denied, "bwrap: Operation not permitted"));
  assert.equal(hardeningRestorable(namespaceFailure, marker), false);
  const approved = CASES.find(c => c.sandbox === "profile" && c.escalate && c.expect === "noNetwork" && !c.guardian);
  const stillBroken = new Map(outputs); stillBroken.set(approved.name, outcome(approved, "NETBLOCKED"));
  assert.equal(hardeningRestorable(stillBroken, marker), false);
  // A Guardian denial the fixture never answered is a failed review, not a measured control.
  const guardianDenied = CASES.find(c => c.guardian === "deny");
  const unreviewed = new Map(outputs); unreviewed.set(guardianDenied.name, { output: "declined", guardianRequests: 0 });
  assert.equal(hardeningRestorable(unreviewed, marker), false);
});

test("Guardian requests are recognised by their subagent header or the auto-review model", () => {
  // codex-cli 0.166.0 with a custom provider: the session's model, marked by the header.
  assert.equal(isGuardianRequest({ "x-openai-subagent": "guardian" }, { model: "probe-model" }), true);
  // codex-cli 0.155.1: the dedicated model, and the same header.
  assert.equal(isGuardianRequest({ "x-openai-subagent": "guardian" }, { model: "codex-auto-review" }), true);
  assert.equal(isGuardianRequest({}, { model: "codex-auto-review" }), true);
  assert.equal(isGuardianRequest({}, { model: "probe-model" }), false);
  assert.equal(isGuardianRequest({ "x-openai-subagent": "review" }, { model: "probe-model" }), false);
});

test("an escalation case routed through Guardian matches only when the fixture answered Guardian", () => {
  const marker = "fixture-marker";
  for (const c of CASES.filter(c => c.guardian)) {
    const output = c.expect === "declined" ? "declined" : c.expect === "network" ? "NETOK!!" : "NETBLOCKED";
    assert.equal(caseMatches(c, { output, guardianRequests: 1 }, marker), true, c.name);
    // Codex 0.166.0 under the old fixture: Guardian's request went unrecognised, its review failed,
    // and "Guardian denied" still read "declined". That must never count as a match.
    assert.equal(caseMatches(c, { output, guardianRequests: 0 }, marker), false, c.name);
  }
  for (const c of CASES.filter(c => !c.guardian && c.expect === "declined")) {
    assert.equal(caseMatches(c, { output: "declined", guardianRequests: 0 }, marker), true, c.name);
    assert.equal(caseMatches(c, { output: "declined", guardianRequests: 1 }, marker), false, c.name);
  }
});

test("a successful unknown-version guard measurement proposes widening without changing admission", () => {
  assert.equal(guardRangeResult("0.166.0", { status: "unchanged" }).status, "unchanged");
  assert.equal(guardRangeResult("0.166.1", { status: "unchanged" }).status, "measured OK, range can be widened");
  assert.equal(guardRangeResult("0.166.1", { status: "changed" }).status, "changed");
  assert.equal(guardRangeResult("0.166.1", { status: "could not run" }).status, "could not run");
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
      encoding: "utf8", timeout: 20000, env: { ...process.env, CODEX_BIN: join(dir, "missing-codex"), CODEX_ASSUMPTION_ACKNOWLEDGED_UNAVAILABLE: "escalation" },
    });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(readFileSync(join(dir, "latest.json")));
    assert.equal(report.version, null); assert.equal(report.complete, true); assert.equal(report.exitCode, 2);
    assert.ok(report.results.every(r => r.status === "could not run"));
    assert.equal(report.guardTrust.status, "could not run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a successful hooks/list response with a changed consumed shape is drift, not binary unavailability", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-inventory-test-"));
  try {
    const binary = join(dir, "codex.cjs");
    writeFileSync(binary, `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
require('node:readline').createInterface({input:process.stdin}).on('line',line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 console.log(JSON.stringify({id:m.id,result:m.method==='hooks/list'?{data:[{hooks:[{key:42,enabled:true,trustStatus:'untrusted'}]}]}:{}}));
});
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["--import", "tsx", "apps/runner/scripts/codex-guard-hook-probe.ts"], {
      encoding: "utf8", timeout: 20000, env: { ...process.env, CODEX_BIN: binary },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /"status":"changed"/);
    assert.match(result.stdout, /key, enabled or trustStatus shape/);
    assert.match(result.stdout, /docs\/adr\/0012-managed-worktree-guard-hook.md/);
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
