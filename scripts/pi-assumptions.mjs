import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reportExit, reportFresh } from "./codex-assumptions.mjs";

export { reportExit, reportFresh };
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROBE_SCRIPT = "apps/runner/scripts/pi-assumptions-probe.ts";
const DOCS = "docs/pi-assumption-probes.md";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const BASELINE_VERSION = "1.4.0";
let interrupted = false;

export const PROBES = [
  { id: "network", minimum: 3, timeout: 4 * 60_000, documentation: `${DOCS}#network-isolation` },
  { id: "rpc-contract", minimum: 6, timeout: 6 * 60_000, documentation: "apps/runner/src/drivers/fixtures/fake-pi-rpc.mjs; apps/runner/src/discovery/pi-rpc.ts" },
  { id: "adr-0010", minimum: 3, timeout: 4 * 60_000, documentation: "docs/adr/0010-additive-orchestrator-role-for-pi.md" },
  { id: "sessions", minimum: 4, timeout: 4 * 60_000, documentation: `${DOCS}#session-store` },
  { id: "project-trust", minimum: 3, timeout: 4 * 60_000, documentation: "apps/runner/src/drivers/pi-rpc.ts; apps/runner/src/pi-agent-control-extension.ts" },
];
const STATUSES = ["unchanged", "changed", "could not run"];

export function parseVersion(output) {
  return output.match(/^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m)?.[1] ?? null;
}

/** Same rules as the Codex suite: anything short of complete, well-formed, exit-consistent output
 * is "could not run", never a measurement. */
export function collectResult(probe, execution) {
  const events = execution.stdout.split("\n").flatMap(line => {
    try { const value = JSON.parse(line); return value?.event === "pi_assumption" ? [value] : []; } catch { return []; }
  });
  const valid = events.length > 0 && events.every(e => STATUSES.includes(e.status) && typeof e.assumption === "string" &&
    typeof e.observed === "string" && typeof e.documentation === "string");
  const changed = events.some(e => e.status === "changed");
  const status = execution.unavailable || !valid || (!changed && events.length < probe.minimum) || ![0, 1].includes(execution.code) ||
    (execution.code === 1 && !changed) || events.some(e => e.status === "could not run") ? "could not run" : changed ? "changed" : "unchanged";
  return { probe: probe.id, status, assumptions: valid ? events.map(({ event, ...value }) => value) : [],
    observed: status === "could not run" ? "missing/incompatible binary, isolation, timeout, dependency or incomplete probe result" : "see measured assumptions",
    documentation: probe.documentation };
}

/** Network namespace launchers, tried in order; each must leave loopback up. Bubblewrap configures
 * loopback itself and is what hosted CI enables (scripts/harness-assumptions-prepare-pi.sh), since
 * the suite runs there as an unprivileged user without sudo. The unshare forms suit operator hosts;
 * the sudo form drops back to the invoking user before running anything else. */
export function isolationLaunchers(uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0) {
  // Disabling can only turn the network measurements into "could not run"; tests use it.
  if (process.env.PI_PROBE_DISABLE_ISOLATION === "1") return [];
  const loUp = 'PATH="$PATH:/usr/sbin:/sbin" ip link set lo up';
  return [
    { name: "bubblewrap network namespace (bwrap --unshare-net)", wrap: argv => ["bwrap", ["--bind", "/", "/", "--dev", "/dev", "--unshare-net", "--die-with-parent", "--", ...argv]] },
    { name: "unprivileged user+network namespace (unshare -rn)", wrap: argv => ["unshare", ["--user", "--map-root-user", "--net", "--", "sh", "-c", `${loUp} && exec "$@"`, "sh", ...argv]] },
    { name: "network namespace via passwordless sudo (sudo -n unshare -n)", wrap: argv => ["sudo", ["-n", "unshare", "--net", "--", "sh", "-c",
      `${loUp} && exec setpriv --reuid=${uid} --regid=${gid} --clear-groups -- "$@"`, "sh", ...argv]] },
  ];
}

/** The probe always runs with exactly this environment, inside or outside a namespace. */
export function probeArgv(probeId, env) {
  return ["env", "-i", ...Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`),
    process.execPath, "--import", "tsx", join(root, PROBE_SCRIPT), "--group", probeId];
}

export function resolveExecutable(name, path = process.env.PATH ?? "") {
  if (name.includes("/")) return isAbsolute(name) ? name : resolve(name);
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try { accessSync(join(directory, name), constants.X_OK); return join(directory, name); } catch { /* next */ }
  }
  return null;
}

export function markdown(report) {
  return ["# Pi Assumption Report", "", `Measured ${PI_PACKAGE}: ${report.version ?? "could not run"} (baseline ${BASELINE_VERSION})`,
    `Completed: ${report.completedAt}; complete=${report.complete}; exit=${report.exitCode}`,
    `Network isolation: ${report.isolation?.mechanism ?? "none"}; ${report.isolation?.observed ?? "not selected"}`, "",
    ...report.results.flatMap(result => [`## ${result.probe}: ${result.status}`, "", result.observed, `Old measurement: ${result.documentation}`, "",
      ...result.assumptions.flatMap(a => [`- ${a.assumption}: **${a.status}**. ${a.observed}. Old measurement: ${a.documentation}`]), ""]),
    "No probe changes a version pin, trust range, launch gate or hardening; changed results need a reviewed code change.", ""].join("\n");
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
      child.kill("SIGTERM");
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

/** First launcher whose namespace passes the probe's own negative control, or null with reasons. */
export async function selectIsolation(baseEnv, launchers = isolationLaunchers(), run = execute) {
  const reasons = [];
  for (const launcher of launchers) {
    const [command, args] = launcher.wrap(probeArgv("isolation-check", { ...baseEnv, PI_PROBE_ISOLATION: launcher.name }));
    const result = await run(command, args, baseEnv, root, 60_000);
    const control = result.stdout.split("\n").flatMap(line => { try { const v = JSON.parse(line); return v?.event === "pi_isolation" ? [v] : []; } catch { return []; } })[0];
    if (!result.unavailable && result.code === 0 && control?.verified === true) return { mechanism: launcher.name, observed: control.observed };
    reasons.push(`${launcher.name}: ${control?.observed ?? (result.unavailable ? "could not start" : `exit ${result.code}`)}`);
  }
  return { mechanism: null, observed: reasons.join("; ") || "no network namespace launcher is enabled" };
}

function writeReport(dir, report) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, value] of [["latest.json", JSON.stringify(report, null, 2) + "\n"], ["latest.md", markdown(report)]]) {
    const temporary = join(dir, `${name}.${process.pid}.tmp`);
    writeFileSync(temporary, value, { mode: 0o600 }); renameSync(temporary, join(dir, name));
  }
}

export function freshReport(report) {
  return reportFresh(report) && [0, 1, 2].includes(report.exitCode) && Array.isArray(report.results) && report.results.length === PROBES.length &&
    report.results.every((r, i) => r.probe === PROBES[i].id && STATUSES.includes(r.status)) && report.exitCode === reportExit(report.results);
}

export async function main(args = process.argv.slice(2)) {
  const dirIndex = args.indexOf("--report-dir");
  const reportDir = resolve(dirIndex >= 0 ? args[dirIndex + 1] : join(process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"), "wollipog-pi-probes"));
  if (args.includes("--check-fresh")) {
    let report; try { report = JSON.parse(readFileSync(join(reportDir, "latest.json"), "utf8")); } catch {}
    const fresh = freshReport(report);
    console.log(fresh ? `Fresh Pi report; measured ${report.version}; exit=${report.exitCode}` : "Could not run: Pi report missing, incomplete or older than 48 hours");
    return fresh ? report.exitCode : 2;
  }
  if (args.some((a, i) => !["--report-dir", "--check-fresh"].includes(a) && !(dirIndex >= 0 && i === dirIndex + 1))) throw new Error("Usage: pnpm probe:pi-assumptions [--report-dir PATH] [--check-fresh]");
  const scratch = mkdtempSync(join(tmpdir(), "wollipog-pi-assumptions-"));
  const report = { startedAt: new Date().toISOString(), completedAt: null, package: PI_PACKAGE, baselineVersion: BASELINE_VERSION, version: null,
    complete: false, exitCode: 2, isolation: null, results: [] };
  try {
    const binary = resolveExecutable(process.env.PI_BIN || "pi");
    // Only PATH, the resolved binary and a throwaway HOME cross into probes; no account state does.
    const baseEnv = { PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin"].join(delimiter), HOME: join(scratch, "home"), LANG: "C.UTF-8",
      TMPDIR: tmpdir(), ...(binary ? { PI_BIN: binary } : {}) };
    mkdirSync(baseEnv.HOME, { mode: 0o700 });
    const versionEnv = { ...baseEnv, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    const versionRun = binary ? await execute(binary, ["--version"], versionEnv, scratch, 30_000) : { code: null, stdout: "", unavailable: true };
    report.version = versionRun.code === 0 && !versionRun.unavailable ? parseVersion(versionRun.stdout) : null;
    // An incomplete fresh report replaces yesterday's green before doing any long-running work.
    writeReport(reportDir, report);
    let outerNamespace = "";
    try { outerNamespace = readlinkSync("/proc/self/ns/net"); } catch {}
    report.isolation = report.version ? await selectIsolation({ ...baseEnv, PI_PROBE_OUTER_NETNS: outerNamespace }) : { mechanism: null, observed: "Pi could not run" };
    console.log(`network isolation: ${report.isolation.mechanism ?? "unavailable"}; ${report.isolation.observed}`);
    const probeEnv = { ...baseEnv, PI_PROBE_OUTER_NETNS: outerNamespace,
      ...(report.isolation.mechanism ? { PI_PROBE_ISOLATION: report.isolation.mechanism } : { PI_PROBE_ISOLATION_UNAVAILABLE: report.isolation.observed }) };
    const launcher = isolationLaunchers().find(l => l.name === report.isolation.mechanism);
    for (const probe of PROBES) {
      const argv = probeArgv(probe.id, probeEnv);
      const [command, commandArgs] = launcher ? launcher.wrap(argv) : [argv[0], argv.slice(1)];
      const execution = report.version && !interrupted ? await execute(command, commandArgs, baseEnv, root, probe.timeout) : { stdout: "", code: 2, unavailable: true };
      const result = { ...collectResult(probe, execution), version: report.version };
      report.results.push(result);
      console.log(`${probe.id}: ${result.status}; ${result.observed}`);
      for (const a of result.assumptions.filter(a => a.status !== "unchanged")) console.log(`  ${a.assumption}: ${a.status}; ${a.observed}`);
      writeReport(reportDir, report);
    }
    if (report.version && !interrupted) {
      const finalVersion = await execute(binary, ["--version"], versionEnv, scratch, 30_000);
      if (finalVersion.code !== 0 || finalVersion.unavailable || parseVersion(finalVersion.stdout) !== report.version) {
        for (const result of report.results) { result.status = "could not run"; result.observed = "Pi changed or became unavailable during measurement; mixed-version results are not a pass"; }
      }
    }
    report.exitCode = interrupted ? 2 : reportExit(report.results);
    report.complete = !interrupted;
    report.completedAt = new Date().toISOString();
    writeReport(reportDir, report);
    console.log(`${PI_PACKAGE} ${report.version ?? "could not run"}; report: ${join(reportDir, "latest.md")}; exit=${report.exitCode}`);
    return report.exitCode;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, () => { console.error("Could not run Pi assumption suite or write its report"); process.exitCode = 2; });
}
