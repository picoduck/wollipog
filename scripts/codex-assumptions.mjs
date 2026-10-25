import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedProbeEnv } from "../apps/runner/scripts/codex-probe-support.ts";
import { CODEX_GUARD_TRUST_VERSION_RANGE, codexGuardHashTrustVersionSupported } from "../apps/runner/src/codex-managed-worktree-guard.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runner = "apps/runner/scripts/";
let interrupted = false;
export const PROBES = [
  { id: "schema", script: "scripts/check-codex-app-server-schema.mjs", minimum: 1, timeout: 120_000, documentation: "docs/DRIVERS.md; apps/runner/src/discovery/fixtures/codex-app-server-required-contract.json" },
  { id: "escalation", script: runner + "codex-escalation-probe.ts", minimum: 13, timeout: 25 * 60_000, documentation: "docs/adr/0012-managed-worktree-guard-hook.md" },
  { id: "guard", script: runner + "codex-guard-hook-probe.ts", minimum: 26, timeout: 40 * 60_000, documentation: "docs/adr/0012-managed-worktree-guard-hook.md" },
  { id: "diagnostics", script: runner + "codex-diagnostics-probe.ts", minimum: 3, timeout: 90_000, documentation: "docs/DRIVERS.md#openai-inference-transport" },
  { id: "mcp-wait", script: runner + "codex-mcp-wait-probe.ts", minimum: 1, timeout: 35 * 60_000, documentation: "docs/DRIVERS.md; skills/using-wollipog/SKILL.md" },
  { id: "mcp-controls", script: runner + "codex-mcp-wait-probe.ts", minimum: 3, args: ["--seconds", "310", "--entry", "orchestrator", "--default-limit", "--without-approval"], timeout: 25 * 60_000, documentation: "docs/DRIVERS.md; skills/using-wollipog/SKILL.md" },
];
export const EXCLUSIONS = [{ command: "probe:codex-inference-transport", reason: "Requires real account authentication and external model traffic; excluded from this credential-free suite. Optional transport diagnostics are measured separately; real WebSocket success is never inferred." }];

export function reportExit(results) {
  return results.some(r => r.status === "could not run") ? 2 : results.some(r => r.status === "changed") ? 1 : 0;
}

export function collectResult(probe, execution) {
  const events = execution.stdout.split("\n").flatMap(line => {
    try { const value = JSON.parse(line); return value.event === "codex_assumption" ? [value] : []; } catch { return []; }
  });
  const valid = events.length > 0 && events.every(e => ["unchanged", "changed", "could not run", "optional drift"].includes(e.status) &&
    typeof e.assumption === "string" && typeof e.observed === "string" && typeof e.documentation === "string" && (e.status !== "optional drift" || e.optional === true));
  const status = execution.unavailable || !valid || events.length < (probe.minimum ?? 1) || execution.code === 2 || events.some(e => e.status === "could not run") ? "could not run" :
    execution.code !== 0 || events.some(e => e.status === "changed") ? "changed" : events.some(e => e.status === "optional drift") ? "optional drift" : "unchanged";
  return { probe: probe.id, status, assumptions: valid ? events.map(({ event, ...value }) => value) : [],
    observed: status === "could not run" ? "missing/incompatible binary, sandbox, timeout, dependency or incomplete probe result" : "see measured assumptions",
    documentation: probe.documentation };
}

export function guardRangeResult(version, guard) {
  const status = guard.status === "unchanged" && !codexGuardHashTrustVersionSupported(version) ? "measured OK, range can be widened" : guard.status;
  return { version, range: CODEX_GUARD_TRUST_VERSION_RANGE, status,
    action: status === "measured OK, range can be widened" ? "Review the measurements and widen CODEX_GUARD_TRUST_VERSION_RANGE deliberately; no automatic code change." : "No automatic trust or launch-policy change." };
}

export function reportFresh(report, now = Date.now(), maxAgeMs = 48 * 60 * 60_000) {
  const age = now - Date.parse(report?.completedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs && report?.complete === true;
}

export function markdown(report) {
  return ["# Codex Assumption Report", "", `Measured CLI: ${report.version ?? "could not run"}`,
    `Completed: ${report.completedAt}; complete=${report.complete}; exit=${report.exitCode}`,
    `Guard trust: ${report.guardTrust?.status ?? "could not run"}; range=${CODEX_GUARD_TRUST_VERSION_RANGE}`, "",
    ...report.results.flatMap(result => [`## ${result.probe}: ${result.status}`, "", result.observed, `Old measurement: ${result.documentation}`, "",
      ...result.assumptions.flatMap(a => [`- ${a.assumption}: **${a.status}**. ${a.observed}. Old measurement: ${a.documentation}`]), ""]),
    "## Excluded", "", ...EXCLUSIONS.map(e => `- ${e.command}: ${e.reason}`), ""].join("\n");
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
      child.kill("SIGTERM"); // Let each probe tear down its detached owned groups and fixtures.
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

export async function main(args = process.argv.slice(2)) {
  const dirIndex = args.indexOf("--report-dir");
  const reportDir = resolve(dirIndex >= 0 ? args[dirIndex + 1] : join(process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"), "wollipog-codex-probes"));
  if (args.includes("--check-fresh")) {
    let report; try { report = JSON.parse(readFileSync(join(reportDir, "latest.json"), "utf8")); } catch {}
    const fresh = reportFresh(report) && [0, 1, 2].includes(report.exitCode) && Array.isArray(report.results) && report.results.length === PROBES.length &&
      report.results.every((r, i) => r.probe === PROBES[i].id && ["unchanged", "changed", "could not run", "optional drift"].includes(r.status)) && report.exitCode === reportExit(report.results);
    console.log(fresh ? `Fresh Codex report; measured ${report.version}; exit=${report.exitCode}` : "Could not run: Codex report missing, incomplete or older than 48 hours");
    return fresh ? report.exitCode : 2;
  }
  if (args.some((a, i) => !["--report-dir", "--check-fresh"].includes(a) && !(dirIndex >= 0 && i === dirIndex + 1))) throw new Error("Usage: pnpm probe:codex-assumptions [--report-dir PATH] [--check-fresh]");
  const scratch = mkdtempSync(join(tmpdir(), "wollipog-codex-assumptions-"));
  const report = { startedAt: new Date().toISOString(), completedAt: null, version: null, complete: false, exitCode: 2, results: [], exclusions: EXCLUSIONS };
  try {
    const binary = process.env.CODEX_BIN || "codex";
    const env = { ...isolatedProbeEnv(join(scratch, "home")), CODEX_BIN: binary.includes("/") && !isAbsolute(binary) ? resolve(binary) : binary };
    const versionRun = await execute(env.CODEX_BIN, ["--version"], env, scratch, 30_000);
    report.version = versionRun.code === 0 && !versionRun.unavailable ? versionRun.stdout.match(/^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m)?.[1] ?? null : null;
    // An incomplete fresh report replaces yesterday's green before doing any long-running work.
    writeReport(reportDir, report);
    for (const probe of PROBES) {
      const execution = report.version && !interrupted ? await execute(process.execPath, ["--import", "tsx", join(root, probe.script), ...(probe.args || [])], env, root, probe.timeout)
        : { stdout: "", code: 2, unavailable: true };
      const result = collectResult(probe, execution);
      result.version = report.version;
      report.results.push(result);
      console.log(`${probe.id}: ${result.status}`);
      for (const a of result.assumptions.filter(a => a.status !== "unchanged")) console.log(`${a.assumption}: ${a.status}; ${a.observed}; old measurement: ${a.documentation}`);
      writeReport(reportDir, report);
    }
    if (report.version && !interrupted) {
      const finalVersion = await execute(env.CODEX_BIN, ["--version"], env, scratch, 30_000);
      if (finalVersion.code !== 0 || finalVersion.unavailable || !finalVersion.stdout.includes(`codex-cli ${report.version}\n`)) {
        for (const result of report.results) { result.status = "could not run"; result.observed = "CLI changed or became unavailable during measurement; mixed-version results are not a pass"; }
      }
    }
    report.guardTrust = guardRangeResult(report.version, report.results.find(r => r.probe === "guard"));
    report.exitCode = reportExit(report.results);
    report.complete = true;
    report.completedAt = new Date().toISOString();
    writeReport(reportDir, report);
    console.log(`codex-cli ${report.version ?? "could not run"}; guard: ${report.guardTrust.status}; report: ${join(reportDir, "latest.md")}; exit=${report.exitCode}`);
    return report.exitCode;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, () => { console.error("Could not run Codex assumption suite or write its report"); process.exitCode = 2; });
}
