import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closedLoopbackPort, detectorSeesCanary, foreignTraceAttempts, isolatedClaudeEnv, isolatedHome, runClaude, startRefusingProxy } from "../apps/runner/scripts/claude-probe-support.ts";
import { REVIEWER_PIN, silenceVerdict } from "../apps/runner/scripts/claude-assumption-probes.ts";
import { CLAUDE_CONTROL_CONTRACT_MIN_VERSION, CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION, CLAUDE_STEERING_MIN_VERSION, claudeVersionAtLeast } from "../apps/runner/src/discovery/claude-code.ts";

// Same report and exit contract as scripts/codex-assumptions.mjs: exit 0 matched, 1 changed,
// 2 could not run; latest.json and latest.md written atomically; a run that could not measure is
// never reported as a pass.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROBE_SCRIPT = "apps/runner/scripts/claude-assumption-probes.ts";
const STATUSES = ["unchanged", "changed", "could not run"];
let interrupted = false;
const cancellation = new AbortController();

export const PROBES = [
  { id: "isolation", minimum: 3, timeout: 6 * 60_000, documentation: "docs/claude-assumption-probes.md#feasibility" },
  { id: "hooks", minimum: 13, timeout: 30 * 60_000, documentation: "docs/adr/0012-managed-worktree-guard-hook.md" },
  { id: "settings", minimum: 5, timeout: 12 * 60_000, documentation: "docs/adr/0012-managed-worktree-guard-hook.md" },
  { id: "control-channel", minimum: 5, timeout: 10 * 60_000, documentation: "docs/adr/0012-managed-worktree-guard-hook.md; apps/runner/src/drivers/fixtures/claude-can-use-tool-subagent.json" },
  { id: "mcp-image", minimum: 2, timeout: 5 * 60_000, documentation: "apps/runner/src/discovery/claude-code.ts" },
  { id: "steering", minimum: 2, timeout: 5 * 60_000, documentation: "apps/runner/src/discovery/claude-code.ts" },
  { id: "transcript", minimum: 2, timeout: 6 * 60_000, documentation: "docs/DRIVERS.md" },
  { id: "discovery", minimum: 5, timeout: 3 * 60_000, documentation: "apps/runner/src/discovery/claude-code.ts" },
  { id: "reviewer-pin", minimum: 4, timeout: 5 * 60_000, documentation: "apps/runner/src/claude-media-reviewer.ts" },
];

export const FLOORS = [
  { name: "stdio control contract", version: CLAUDE_CONTROL_CONTRACT_MIN_VERSION },
  { name: "steering", version: CLAUDE_STEERING_MIN_VERSION },
  { name: "MCP image tool results", version: CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION },
];

export const EXCLUSIONS = [
  { command: "probe:claude-mcp-image", reason: "Needs a signed-in account and a real model to read pixels back. This suite instead checks at the stub that the image block reaches the model request; whether a model can read it stays manual." },
  { command: "probe:claude-media-reviewer --live", reason: "Paid run with the dedicated reviewer key inside the reviewer namespace; human-only. This suite measures the reviewer's flags, event order, init shape and usage fields against a stub." },
  { command: "auto-mode classifier decisions", reason: "Only a real model makes them. The stub answers classifier requests with \"allow\" so allow-controls can run; no classifier behaviour is claimed, and auto-mode can_use_tool frames (which need the classifier to escalate) stay covered by the recorded fixture replay." },
];

export function parseVersion(output) {
  return output.match(/^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?) \(Claude Code\)/m)?.[1] ?? null;
}

export function reportExit(results) {
  return results.some(r => r.status === "changed") ? 1 : results.some(r => r.status === "could not run") ? 2 : 0;
}

export function collectResult(probe, execution) {
  const events = execution.stdout.split("\n").flatMap(line => {
    try { const value = JSON.parse(line); return value.event === "claude_assumption" ? [value] : []; } catch { return []; }
  });
  const valid = events.length > 0 && events.every(e => STATUSES.includes(e.status) &&
    typeof e.assumption === "string" && typeof e.observed === "string" && typeof e.documentation === "string");
  const changed = events.some(e => e.status === "changed");
  // A well-formed changed measurement is evidence even when the probe also failed elsewhere, so
  // changed wins (the shared contract). Anything short of a complete, clean exit-0 run is not a pass.
  const status = valid && changed ? "changed"
    : execution.unavailable || !valid || events.length < (probe.minimum ?? 1) || execution.code !== 0 ||
      events.some(e => e.status === "could not run") ? "could not run" : "unchanged";
  return { probe: probe.id, status, assumptions: valid ? events.map(({ event, ...value }) => value) : [],
    observed: status === "could not run" ? "missing/incompatible binary, detector, timeout, dependency or incomplete probe result" : "see measured assumptions",
    documentation: probe.documentation };
}

/** Whether the measured release behaves like the reviewer pin. Never moves the pin itself. */
export function reviewerPinResult(version, reviewer) {
  const status = !version || !reviewer || reviewer.status === "could not run" ? "could not run"
    : !claudeVersionAtLeast(version, REVIEWER_PIN) ? "below the pin; the reviewers refuse this release"
    : reviewer.status === "changed" ? "differs from the pinned behaviour"
      : version === REVIEWER_PIN ? "at the pin" : "matches the pinned behaviour; the pin can move through a reviewed change";
  return { pin: REVIEWER_PIN, version, status,
    action: status.startsWith("matches") ? `Review the measurements and move the reviewer pin from ${REVIEWER_PIN} to ${version} deliberately; no automatic code change.` : "No automatic pin or launch-policy change." };
}

export function floorResults(version) {
  return FLOORS.map(floor => ({ ...floor, met: version ? claudeVersionAtLeast(version, floor.version) : null }));
}

export function reportFresh(report, now = Date.now(), maxAgeMs = 48 * 60 * 60_000) {
  const age = now - Date.parse(report?.completedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs && report?.complete === true;
}

export function markdown(report) {
  return ["# Claude Code Assumption Report", "", `Measured CLI: ${report.version ?? "could not run"}`,
    `Completed: ${report.completedAt}; complete=${report.complete}; exit=${report.exitCode}`,
    `Reviewer pin ${report.reviewerPin?.pin ?? REVIEWER_PIN}: ${report.reviewerPin?.status ?? "could not run"}`,
    `Floors: ${(report.floors ?? []).map(f => `${f.name} ${f.version} (${f.met === null ? "unknown" : f.met ? "met" : "below"})`).join("; ")}`, "",
    ...report.results.flatMap(result => [`## ${result.probe}: ${result.status}`, "", result.observed, `Old measurement: ${result.documentation}`, "",
      ...result.assumptions.flatMap(a => [`- ${a.assumption}: **${a.status}**. ${a.observed}. Old measurement: ${a.documentation}`]), ""]),
    "## Excluded", "", ...EXCLUSIONS.map(e => `- ${e.command}: ${e.reason}`), ""].join("\n");
}

/** Resolve CLAUDE_BIN (or `claude` on PATH) to an absolute executable without running it. */
export function resolveBinary(value, path = process.env.PATH ?? "") {
  const executable = candidate => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } };
  if (value.includes("/")) { const absolute = isAbsolute(value) ? value : resolve(value); return executable(absolute) ? absolute : null; }
  for (const dir of path.split(delimiter)) if (dir && isAbsolute(dir) && executable(join(dir, value))) return join(dir, value);
  return null;
}

function execute(command, args, env, cwd, timeout) {
  return new Promise(resolve => {
    let stdout = "";
    let unavailable = false;
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let killTimer;
    const stop = () => {
      if (unavailable) return;
      unavailable = true;
      child.kill("SIGTERM"); // Each probe kills its own CLI process groups on SIGTERM.
      killTimer = setTimeout(() => {
        if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
        child.kill("SIGKILL");
      }, 6000);
    };
    const timer = setTimeout(stop, timeout);
    const onSignal = () => { interrupted = true; stop(); };
    process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 2_000_000) stop(); });
    // Provider-controlled stderr is never persisted in the operator report.
    child.stderr.resume();
    child.on("error", () => { unavailable = true; });
    child.on("close", code => { clearTimeout(timer); clearTimeout(killTimer); process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal); resolve({ stdout, code, unavailable }); });
  });
}

function writeReport(dir, report) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, value] of [["latest.json", JSON.stringify(report, null, 2) + "\n"], ["latest.md", markdown(report)]]) {
    const temporary = join(dir, `${name}.${process.pid}.tmp`);
    writeFileSync(temporary, value, { mode: 0o600 }); renameSync(temporary, join(dir, name));
  }
}

/** The suite's own `--version` runs are CLI runs too: traced into `ledger` like every probe run. */
async function measuredVersion(binary, scratch, ledger) {
  if (!binary) return null;
  // Even `--version` runs in a throwaway home with a dead base URL: nothing reads the real account.
  const paths = isolatedHome(mkdtempSync(join(scratch, "version-")));
  const proxy = await startRefusingProxy();
  try {
    // The suite keeps cancellation: it must still stop its probe and write an interrupted report.
    const run = await runClaude({ bin: binary, args: ["--version"], cwd: paths.work, timeoutMs: 30_000,
      env: isolatedClaudeEnv(paths, `http://127.0.0.1:${await closedLoopbackPort()}`, proxy.url),
      traceFile: ledger.detector.ok ? join(paths.root, "trace.log") : undefined, signals: "caller", abort: cancellation.signal });
    ledger.runs += 1;
    ledger.proxied.push(...proxy.destinations);
    if (ledger.detector.ok && run.trace === null) ledger.untraced += 1;
    if (ledger.detector.ok && run.trace !== null) ledger.foreign.push(...foreignTraceAttempts(run.trace, []).map(a => `${a.family} ${a.address}:${a.port ?? "?"}`));
    return run.code === 0 && !run.timedOut && !run.spawnError ? parseVersion(run.stdout) : null;
  } finally { await proxy.close(); }
}

/** Add the version runs' silence to the isolation result; changed wins, then could not run. */
export function withVersionSilence(isolation, verdict) {
  const assumptions = [...isolation.assumptions, { assumption: "the suite's own --version invocations contact nothing", status: verdict.status,
    observed: verdict.observed, documentation: "docs/claude-assumption-probes.md#feasibility" }];
  const status = isolation.status === "changed" || verdict.status === "changed" ? "changed"
    : isolation.status === "could not run" || verdict.status === "could not run" ? "could not run" : "unchanged";
  return { ...isolation, status, assumptions, observed: status === "could not run" && isolation.status !== "could not run" ? "version invocations could not be traced" : isolation.observed };
}

export async function main(args = process.argv.slice(2)) {
  const dirIndex = args.indexOf("--report-dir");
  const reportDir = resolve(dirIndex >= 0 ? args[dirIndex + 1] : join(process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"), "wollipog-claude-probes"));
  if (args.includes("--check-fresh")) {
    let report; try { report = JSON.parse(readFileSync(join(reportDir, "latest.json"), "utf8")); } catch {}
    const fresh = reportFresh(report) && [0, 1, 2].includes(report.exitCode) && Array.isArray(report.results) && report.results.length === PROBES.length &&
      report.results.every((r, i) => r.probe === PROBES[i].id && STATUSES.includes(r.status)) && report.exitCode === reportExit(report.results);
    console.log(fresh ? `Fresh Claude Code report; measured ${report.version}; exit=${report.exitCode}` : "Could not run: Claude Code report missing, incomplete or older than 48 hours");
    return fresh ? report.exitCode : 2;
  }
  if (args.some((a, i) => !["--report-dir", "--check-fresh"].includes(a) && !(dirIndex >= 0 && i === dirIndex + 1))) throw new Error("Usage: pnpm probe:claude-assumptions [--report-dir PATH] [--check-fresh]");
  const scratch = mkdtempSync(join(tmpdir(), "wollipog-claude-assumptions-"));
  const report = { startedAt: new Date().toISOString(), completedAt: null, version: null, complete: false, exitCode: 2, results: [], exclusions: EXCLUSIONS };
  // Probe runs get their own once-listeners in execute(); this one covers the version runs and keeps
  // the default exit from skipping the interrupted report.
  const onSignal = () => { interrupted = true; cancellation.abort(); };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  try {
    // An incomplete fresh report replaces yesterday's green before running anything at all.
    writeReport(reportDir, report);
    const binary = resolveBinary(process.env.CLAUDE_BIN || "claude");
    const versionRuns = { detector: await detectorSeesCanary(scratch), runs: 0, untraced: 0, foreign: [], proxied: [], routes: new Set() };
    report.version = interrupted ? null : await measuredVersion(binary, scratch, versionRuns);
    report.floors = floorResults(report.version);
    writeReport(reportDir, report);
    // The probe process gets no inherited provider variables either; it builds each CLI's environment itself.
    const env = { PATH: process.env.PATH, HOME: join(scratch, "probe-home"), TMPDIR: tmpdir(), LANG: "C.UTF-8", CLAUDE_BIN: binary ?? "", CLAUDE_PROBE_VERSION: report.version ?? "" };
    for (const probe of PROBES) {
      const execution = report.version && !interrupted ? await execute(process.execPath, ["--import", "tsx", join(root, PROBE_SCRIPT), "--probe", probe.id], env, root, probe.timeout)
        : { stdout: "", code: 2, unavailable: true };
      const result = collectResult(probe, execution);
      result.version = report.version;
      report.results.push(result);
      console.log(`${probe.id}: ${result.status}; ${result.observed}`);
      for (const a of result.assumptions.filter(a => a.status !== "unchanged")) console.log(`${a.assumption}: ${a.status}; ${a.observed}; old measurement: ${a.documentation}`);
      writeReport(reportDir, report);
    }
    const finalVersion = report.version && !interrupted ? await measuredVersion(binary, scratch, versionRuns) : null;
    const isolation = report.results.findIndex(r => r.probe === "isolation");
    report.results[isolation] = withVersionSilence(report.results[isolation], silenceVerdict(versionRuns));
    if (report.version && !interrupted && finalVersion !== report.version) {
      for (const result of report.results) { result.status = "could not run"; result.observed = "CLI changed or became unavailable during measurement; mixed-version results are not a pass"; }
    }
    report.reviewerPin = reviewerPinResult(report.version, report.results.find(r => r.probe === "reviewer-pin"));
    report.exitCode = interrupted ? 2 : reportExit(report.results);
    report.complete = !interrupted;
    report.completedAt = new Date().toISOString();
    writeReport(reportDir, report);
    console.log(`claude ${report.version ?? "could not run"}; reviewer pin ${REVIEWER_PIN}: ${report.reviewerPin.status}; report: ${join(reportDir, "latest.md")}; exit=${report.exitCode}`);
    return report.exitCode;
  } finally {
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, () => { console.error("Could not run Claude Code assumption suite or write its report"); process.exitCode = 2; });
}
