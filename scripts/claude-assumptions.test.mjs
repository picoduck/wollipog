import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { test } from "node:test";
import { collectResult, EXCLUSIONS, floorResults, markdown, parseVersion, PROBES, reportExit, reportFresh, resolveBinary, reviewerPinResult } from "./claude-assumptions.mjs";
import { DUMMY_API_KEY, foreignTraceAttempts, isolatedClaudeEnv, isolatedHome, startMessagesStub } from "../apps/runner/scripts/claude-probe-support.ts";
import { PROBE_IDS, REVIEWER_PIN, silenceVerdict } from "../apps/runner/scripts/claude-assumption-probes.ts";

const probe = { id: "fixture", documentation: "old-measurement.md" };
const line = (status, extra = {}) => JSON.stringify({ event: "claude_assumption", assumption: "fixture contract", status, observed: "fixture observation", documentation: "old-measurement.md", ...extra });
const execution = (status = "unchanged", extra = {}) => ({ code: status === "changed" ? 1 : status === "could not run" ? 2 : 0, unavailable: false, stdout: line(status, extra) });

test("changed and could-not-run stay distinct; nothing short of a complete, clean probe is a pass", () => {
  assert.equal(collectResult(probe, execution()).status, "unchanged");
  const changed = collectResult(probe, execution("changed"));
  assert.equal(changed.status, "changed"); assert.equal(reportExit([changed]), 1);
  for (const run of [
    { code: 0, stdout: "", unavailable: false }, // no measurement at all
    { code: 2, stdout: line("could not run"), unavailable: false },
    { ...execution(), unavailable: true }, // timed out or failed to spawn after printing a pass
    { ...execution(), code: null }, { ...execution(), code: 137 }, { ...execution(), code: 2 }, { ...execution(), code: 1 },
    { code: 0, stdout: line("optional drift", { optional: true }), unavailable: false }, // not a Claude status
    { code: 0, stdout: line("unchanged", { observed: 42 }), unavailable: false },
    { code: 0, stdout: [line("unchanged"), line("could not run")].join("\n"), unavailable: false },
    { code: 0, stdout: JSON.stringify({ event: "codex_assumption", assumption: "x", status: "unchanged", observed: "y", documentation: "z" }), unavailable: false },
  ]) {
    const result = collectResult(probe, run);
    assert.equal(result.status, "could not run", JSON.stringify(run)); assert.equal(reportExit([result]), 2);
  }
  assert.equal(collectResult({ ...probe, minimum: 2 }, execution()).status, "could not run", "too few measurements is incomplete");
  assert.equal(collectResult({ ...probe, minimum: 2 }, execution("changed")).status, "changed", "a change is reported even when incomplete");
  assert.equal(reportExit([collectResult(probe, execution()), changed, collectResult(probe, { code: 2, stdout: "", unavailable: false })]), 1);
});

test("network silence is a pass only with a working detector that traced every run", () => {
  const clean = { detector: { ok: true, observed: "canary seen" }, runs: 3, untraced: 0, foreign: [], proxied: [], routes: new Set(["POST /v1/messages"]) };
  assert.equal(silenceVerdict(clean).status, "unchanged");
  assert.equal(silenceVerdict({ ...clean, detector: { ok: false, observed: "strace missing" } }).status, "could not run");
  assert.equal(silenceVerdict({ ...clean, untraced: 1 }).status, "could not run");
  assert.equal(silenceVerdict({ ...clean, runs: 0, routes: new Set() }).status, "could not run");
  assert.equal(silenceVerdict({ ...clean, foreign: ["AF_INET 160.79.104.10:443"] }).status, "changed");
  assert.equal(silenceVerdict({ ...clean, detector: { ok: false, observed: "blind" }, proxied: ["CONNECT api.anthropic.com:443"] }).status, "changed", "evidence of traffic beats a blind detector");
  assert.equal(silenceVerdict({ ...clean, routes: new Set(["POST /v1/messages", "POST /v1/messages/count_tokens"]) }).status, "changed");
});

test("the trace parser reports every network destination except the stub, including local DNS", () => {
  const log = [
    `101 connect(12, {sa_family=AF_INET, sin_port=htons(40001), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 EINPROGRESS (Operation now in progress)`,
    `101 connect(13, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("160.79.104.10")}, 16) = -1 EINPROGRESS (Operation now in progress)`,
    `102 connect(4, {sa_family=AF_UNIX, sun_path="/var/run/nscd/socket"}, 110) = -1 ENOENT (No such file or directory)`,
    `103 connect(5, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2607:6bc0::10", &sin6_addr), sin6_scope_id=0}, 28) = -1 ENETUNREACH`,
    `104 sendto(6, "\\x12\\x34", 2, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.53")}, 16) = 2`,
    `105 connect(7, {sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ECONNREFUSED (Connection refused)`,
    `106 connect(8, {sa_family=AF_UNSPEC, sa_data="..."}, 16) = 0`,
    `101 sendto(12, "POST /v1/messages?beta=true HTTP"..., 85483, MSG_DONTWAIT|MSG_NOSIGNAL, NULL, 0) = 85483`,
  ].join("\n");
  const found = foreignTraceAttempts(log, [40001]).map(a => `${a.address}:${a.port}`);
  assert.deepEqual(found, ["160.79.104.10:443", "2607:6bc0::10:443", "127.0.0.53:53", "127.0.0.1:9"]);
  assert.deepEqual(foreignTraceAttempts(log, [40001, 9, 53, 443]).map(a => a.address), ["160.79.104.10", "2607:6bc0::10", "127.0.0.53"], "allowed ports are loopback-only");
});

test("CLI environments carry no real credential, endpoint or provider home", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-env-test-"));
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: "must-not-leak", CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak", CLAUDE_CONFIG_DIR: "/real/claude", ANTHROPIC_AUTH_TOKEN: "must-not-leak", NODE_OPTIONS: "--require evil", WOLLIPOG_SESSION_TOKEN_FILE: "/x" });
  try {
    const paths = isolatedHome(dir);
    const env = isolatedClaudeEnv(paths, "http://127.0.0.1:1", "http://127.0.0.1:2");
    assert.equal(env.ANTHROPIC_API_KEY, DUMMY_API_KEY);
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1");
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "NODE_OPTIONS", "WOLLIPOG_SESSION_TOKEN_FILE"]) assert.equal(env[key], undefined, key);
    assert.equal(env.CLAUDE_CONFIG_DIR, paths.configDir); assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(dir));
    assert.notEqual(env.CLAUDE_CONFIG_DIR, join(env.HOME, ".claude"), "a write that ignores CLAUDE_CONFIG_DIR must be visible");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    for (const value of Object.values(env)) assert.ok(!String(value).includes("must-not-leak"));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true });
  }
});

test("the scripted stub streams replies, records unscripted routes and fails loudly on responder errors", async () => {
  const stub = await startMessagesStub(request => {
    if (request.body?.explode) throw new Error("bad script");
    return { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "true" } }] };
  });
  try {
    const streamed = await fetch(`${stub.url}/v1/messages?beta=true`, { method: "POST", body: JSON.stringify({ stream: true, model: "m", messages: [] }) });
    const body = await streamed.text();
    assert.match(body, /event: message_start/); assert.match(body, /"stop_reason":"tool_use"/); assert.match(body, /input_json_delta/);
    assert.equal((await fetch(`${stub.url}/v1/models`)).status, 404);
    assert.equal((await fetch(`${stub.url}/v1/messages`, { method: "POST", body: JSON.stringify({ explode: true }) })).status, 500);
    assert.deepEqual(stub.requests.map(r => `${r.method} ${r.path}`), ["POST /v1/messages?beta=true", "GET /v1/models", "POST /v1/messages"]);
    assert.deepEqual(stub.faults, ["bad script"]);
  } finally { await stub.close(); }
});

test("reviewer pin comparison never moves the pin and never passes an unmeasured release", () => {
  assert.equal(reviewerPinResult(REVIEWER_PIN, { status: "unchanged" }).status, "at the pin");
  const newer = reviewerPinResult("2.1.314", { status: "unchanged" });
  assert.match(newer.status, /^matches the pinned behaviour/); assert.match(newer.action, /deliberately; no automatic code change/);
  assert.equal(reviewerPinResult("2.1.314", { status: "changed" }).status, "differs from the pinned behaviour");
  assert.match(reviewerPinResult("2.1.277", { status: "unchanged" }).status, /^below the pin/);
  assert.match(reviewerPinResult("2.1.296-rc.1", { status: "unchanged" }).status, /^below the pin/, "a prerelease of the pin is not the pin");
  assert.equal(reviewerPinResult("2.1.277", { status: "could not run" }).status, "could not run");
  for (const [version, result] of [["2.1.314", { status: "could not run" }], [null, { status: "unchanged" }], ["2.1.314", undefined]]) {
    assert.equal(reviewerPinResult(version, result).status, "could not run");
  }
});

test("floors come from the runner's own constants and prerelease ordering", () => {
  assert.deepEqual(floorResults("2.1.241").map(f => f.met), [true, true, false]);
  assert.deepEqual(floorResults("2.1.277-rc.1").map(f => f.met), [true, true, false]);
  assert.deepEqual(floorResults(null).map(f => f.met), [null, null, null]);
  assert.equal(parseVersion("2.1.314 (Claude Code)\n"), "2.1.314");
  assert.equal(parseVersion("codex-cli 0.163.0"), null);
});

test("missing, incomplete, future and stale reports cannot look fresh", () => {
  const now = Date.now();
  assert.equal(reportFresh(undefined, now), false);
  for (const hours of [-1, 49]) assert.equal(reportFresh({ complete: true, completedAt: new Date(now - hours * 3600000).toISOString() }, now), false);
  assert.equal(reportFresh({ complete: false, completedAt: new Date(now).toISOString() }, now), false);
  assert.equal(reportFresh({ complete: true, completedAt: new Date(now - 47 * 3600000).toISOString() }, now), true);
  const dir = mkdtempSync(join(tmpdir(), "claude-fresh-test-"));
  try {
    const results = PROBES.map(p => collectResult(p, { code: 0, unavailable: false, stdout: Array(p.minimum).fill(line("unchanged")).join("\n") }));
    const report = { version: "2.1.314", complete: true, completedAt: new Date().toISOString(), exitCode: 0, results };
    writeFileSync(join(dir, "latest.json"), JSON.stringify(report));
    const check = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/claude-assumptions.mjs", "--check-fresh", "--report-dir", dir], { encoding: "utf8", timeout: 30000 });
    assert.equal(check().status, 0);
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ ...report, exitCode: 0, results: [...results.slice(0, -1), { ...results.at(-1), status: "could not run" }] }));
    assert.equal(check().status, 2, "a recorded exit that disagrees with its results is not fresh");
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ ...report, completedAt: new Date(Date.now() - 49 * 3600000).toISOString() }));
    assert.equal(check().status, 2);
    assert.match(markdown(report), /Reviewer pin 2\.1\.296/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every probe id has a suite entry, and the credentialed probes are excluded with reasons", () => {
  assert.deepEqual(PROBES.map(p => p.id), [...PROBE_IDS]);
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).scripts;
  for (const name of Object.keys(scripts).filter(name => name.startsWith("probe:claude-") && name !== "probe:claude-assumptions")) {
    assert.ok(EXCLUSIONS.some(e => e.command.startsWith(name)), name);
  }
  assert.equal(scripts["probe:claude-assumptions"], "node --import tsx scripts/claude-assumptions.mjs");
});

test("a missing binary writes a complete failing report rather than passing", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-missing-test-"));
  try {
    assert.equal(resolveBinary(join(dir, "missing-claude")), null);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/claude-assumptions.mjs", "--report-dir", dir], {
      encoding: "utf8", timeout: 60000, env: { ...process.env, CLAUDE_BIN: join(dir, "missing-claude") },
    });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(readFileSync(join(dir, "latest.json")));
    assert.equal(report.version, null); assert.equal(report.complete, true); assert.equal(report.exitCode, 2);
    assert.ok(report.results.every(r => r.status === "could not run"));
    assert.equal(report.reviewerPin.status, "could not run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a CLI that fakes a successful result without doing the work is never measured as unchanged", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-fake-test-"));
  try {
    const binary = join(dir, "claude");
    // Reports a version and a clean result event for every turn, but never calls the model,
    // runs a hook or a tool: every behavioural measurement must fail as "could not run".
    writeFileSync(binary, `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("2.1.314 (Claude Code)"); process.exit(0); }
console.log(JSON.stringify({ type: "system", subtype: "init", permissionMode: "bypassPermissions", session_id: "s" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s" }));
`, { mode: 0o755 });
    for (const id of ["settings", "transcript"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "apps/runner/scripts/claude-assumption-probes.ts", "--probe", id], {
        encoding: "utf8", timeout: 120000, env: { PATH: process.env.PATH, HOME: dir, CLAUDE_BIN: binary, CLAUDE_PROBE_VERSION: "2.1.314" },
      });
      const events = result.stdout.split("\n").filter(Boolean).map(l => JSON.parse(l));
      assert.ok(events.length >= 2, `${id}: ${result.stdout}${result.stderr}`);
      assert.notEqual(result.status, 0, `${id} passed a fake CLI`);
      const behavioural = events.filter(e => !e.assumption.includes("contact only the loopback"));
      assert.ok(behavioural.every(e => e.status !== "unchanged"), `${id}: ${JSON.stringify(behavioural)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
