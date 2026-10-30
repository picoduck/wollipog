// Harness-neutral driver for .github/workflows/harness-assumptions.yml. It detects each harness's
// newest npm release, decides from the per-harness measurement record whether a full run is due,
// installs every target version into a disposable prefix and runs that harness's probe suite.
// Contract: docs/harness-assumption-probes.md. Dependency-free so detection needs no pnpm install.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DRIVER = "scripts/harness-assumptions.mjs";
const ISOLATION = "scripts/harness-assumptions-isolate.sh";
/** Bump when the record format or the meaning of a matched record changes; old records then miss. */
export const RECORD_VERSION = 1;
export const EXIT = { matched: 0, changed: 1, couldNotRun: 2 };
const TARGET_STATUS = { 0: "matched", 1: "changed", 2: "could not run" };
// Per-result statuses a suite may report. "optional drift" is advisory; anything else, including an
// operator acknowledgement, is not a CI measurement and reads as could not run.
const RESULT_STATUSES = new Set(["unchanged", "changed", "could not run", "optional drift"]);
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

/**
 * One entry per supported harness. Adding a harness means adding an entry here, its id to the
 * workflow matrix, and a suite that honours the report contract. Every command is an argv array.
 * - npmPackage / bin: the release that is installed and the executable it provides.
 * - binaryEnv: environment variable through which the suite receives that executable.
 * - baselines: versions measured on every full run besides the newest release, each read from a
 *   repository file so a reviewed change to the source moves the measurement with it.
 * - prepare: optional host preparation; a failure is reported and makes the run could not run.
 * - suite: command run once per target with `<reportDirArg> <dir>` appended.
 * - sources: files and `{ dir, prefix }` groups whose content invalidates the record when changed.
 */
export const HARNESSES = [
  {
    id: "codex",
    name: "Codex",
    npmPackage: "@openai/codex",
    bin: "codex",
    binaryEnv: "CODEX_BIN",
    baselines: [{
      label: "CODEX_GUARD_TRUST_VERSION_RANGE lower bound",
      file: "apps/runner/src/codex-managed-worktree-guard.ts",
      pattern: /^export const CODEX_GUARD_TRUST_VERSION_RANGE = ">=(\d+\.\d+\.\d+) [^"]*";$/mu,
    }],
    prepare: {
      command: ["bash", "scripts/harness-assumptions-prepare-codex.sh"],
      purpose: "Escalation probe needs bubblewrap user namespaces (scripts/configure-ci-bubblewrap.sh)",
    },
    suite: ["node", "--import", "tsx", "scripts/codex-assumptions.mjs"],
    reportDirArg: "--report-dir",
    timeoutMinutes: 150,
    documentation: "docs/codex-assumption-probes.md",
    sources: [
      "scripts/codex-assumptions.mjs",
      "scripts/check-codex-app-server-schema.mjs",
      "scripts/configure-ci-bubblewrap.sh",
      "scripts/harness-assumptions-prepare-codex.sh",
      "apps/runner/src/codex-managed-worktree-guard.ts",
      "apps/runner/src/discovery/fixtures/codex-app-server-required-contract.json",
      { dir: "apps/runner/scripts", prefix: "codex-" },
    ],
  },
];

export function harnessById(id) {
  const harness = HARNESSES.find(h => h.id === id);
  if (!harness) throw new Error(`Unknown harness "${id}"; known: ${HARNESSES.map(h => h.id).join(", ")}`);
  return harness;
}

export function paths(harness, temp = process.env.RUNNER_TEMP) {
  if (!temp) throw new Error("RUNNER_TEMP is not set");
  return {
    reportDir: join(temp, "harness-assumptions", harness.id),
    recordDir: join(temp, "harness-assumption-record", harness.id),
    statePath: join(temp, "harness-assumption-state", `${harness.id}.json`),
    installRoot: join(temp, "harness-assumption-install", harness.id),
  };
}

export function sourceFiles(harness, root = ROOT) {
  const files = [DRIVER, ISOLATION];
  for (const source of harness.sources) {
    if (typeof source === "string") { files.push(source); continue; }
    const entries = readdirSync(join(root, source.dir)).filter(name => name.startsWith(source.prefix)).sort();
    if (entries.length === 0) throw new Error(`No ${source.dir}/${source.prefix}* sources`);
    files.push(...entries.map(name => `${source.dir}/${name}`));
  }
  return [...new Set(files)].sort();
}

/** Content hash of the probe set; a missing or unreadable source throws (could not run). */
export function fingerprint(harness, root = ROOT) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ RECORD_VERSION, harness: describe(harness) }));
  for (const file of sourceFiles(harness, root)) {
    if (!statSync(join(root, file)).isFile()) throw new Error(`${file} is not a file`);
    hash.update(`\0${file}\0`).update(readFileSync(join(root, file)));
  }
  return hash.digest("hex");
}

function describe(harness) {
  return { ...harness, baselines: harness.baselines.map(b => ({ ...b, pattern: String(b.pattern) })) };
}

export function baselineVersions(harness, root = ROOT) {
  return harness.baselines.map(baseline => {
    const version = readFileSync(join(root, baseline.file), "utf8").match(baseline.pattern)?.[1];
    if (!version || !VERSION.test(version)) throw new Error(`Could not read ${baseline.label} from ${baseline.file}`);
    return { label: baseline.label, version };
  });
}

/** Newest published release from the registry's `latest` dist-tag; anything unexpected throws. */
export async function newestRelease(harness, { fetchImpl = fetch, attempts = 3, delayMs = 5000 } = {}) {
  const url = `https://registry.npmjs.org/${harness.npmPackage.replace("/", "%2f")}/latest`;
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`registry answered HTTP ${response.status}`);
      const document = await response.json();
      if (document?.name !== harness.npmPackage || typeof document.version !== "string" || !VERSION.test(document.version)) {
        throw new Error(`registry returned no stable ${harness.npmPackage} version`);
      }
      return document.version;
    } catch (error) {
      failure = error;
      if (attempt < attempts) await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw new Error(`Could not read the newest ${harness.npmPackage} release from ${url}: ${failure?.message ?? failure}`);
}

export function targetsFor(newest, baselines) {
  const targets = [{ label: "newest release", version: newest }];
  for (const baseline of baselines) {
    const existing = targets.find(t => t.version === baseline.version);
    if (existing) existing.label += `; ${baseline.label}`; else targets.push(baseline);
  }
  return targets;
}

export function recordKey(harness, targets, sourceHash) {
  const digest = createHash("sha256").update(JSON.stringify({ targets: targets.map(t => t.version), sourceHash })).digest("hex").slice(0, 24);
  return `harness-assumptions-v${RECORD_VERSION}-${harness.id}-${targets.map(t => t.version).join("_")}-${digest}`;
}

/** A record only counts when it is exactly the matched measurement of this key. */
export function validRecord(record, state) {
  return record?.recordVersion === RECORD_VERSION && record.harness === state.harness && record.key === state.key &&
    record.exitCode === EXIT.matched && record.sourceHash === state.sourceHash &&
    JSON.stringify(record.targets?.map(t => t.version)) === JSON.stringify(state.targets.map(t => t.version)) &&
    typeof record.completedAt === "string" && Number.isFinite(Date.parse(record.completedAt));
}

/** Whether this dispatch forces a full run for the harness; an unknown requested harness throws. */
export function forced(harness, event, requested) {
  if (event !== "workflow_dispatch") return false;
  const value = (requested ?? "all").trim() || "all";
  if (value !== "all") harnessById(value);
  return value === "all" || value === harness.id;
}

/**
 * Combine per-target outcomes; the harness contract matches the per-probe one: changed wins over
 * could not run, and any could not run (including failed preparation) fails the run.
 */
export function combinedExit(targets, preparation) {
  if (targets.some(t => t.exitCode === EXIT.changed)) return EXIT.changed;
  if (targets.length === 0 || preparation?.status === "failed" || targets.some(t => t.exitCode !== EXIT.matched)) return EXIT.couldNotRun;
  return EXIT.matched;
}

/**
 * Validate one suite's report against its exit code. Anything that is not a complete, consistent
 * report of exactly the installed version is could not run, never a pass.
 */
export function judgeSuite(target, execution, report) {
  const couldNotRun = reason => ({ ...target, exitCode: EXIT.couldNotRun, status: TARGET_STATUS[2], reason });
  if (execution.timedOut) return couldNotRun(`suite exceeded its ${execution.timeoutMinutes}-minute limit`);
  if (execution.error) return couldNotRun(`suite could not start: ${execution.error}`);
  if (![0, 1, 2].includes(execution.code)) return couldNotRun(`suite exited with ${execution.code ?? execution.signal ?? "no status"}, outside the 0/1/2 contract`);
  if (!report) return couldNotRun("suite wrote no readable latest.json");
  if (report.complete !== true) return couldNotRun("suite report is incomplete");
  if (report.version !== target.version) return couldNotRun(`suite measured ${report.version ?? "no version"}, not the installed ${target.version}`);
  const results = Array.isArray(report.results) ? report.results : [];
  if (results.length === 0) return couldNotRun("suite report has no results");
  const unknown = results.find(r => !RESULT_STATUSES.has(r?.status));
  if (unknown) return couldNotRun(`suite reported "${unknown?.status}" for ${unknown?.probe ?? "a probe"}, which is not a CI measurement`);
  const recomputed = results.some(r => r.status === "changed") ? EXIT.changed : results.some(r => r.status === "could not run") ? EXIT.couldNotRun : EXIT.matched;
  if (report.exitCode !== execution.code || recomputed !== execution.code) {
    return couldNotRun(`suite exit ${execution.code}, report exit ${report.exitCode} and its results (${recomputed}) disagree`);
  }
  return { ...target, exitCode: execution.code, status: TARGET_STATUS[execution.code], ...(execution.code === 2 ? { reason: "suite reported could not run; see its probe results" } : {}) };
}

/** Minimal suite environment: a throwaway HOME, no CI tokens, credentials or acknowledgements. */
export function suiteEnv(harness, binary, home, base = process.env) {
  // TMPDIR stays /tmp, where the recorded local measurements placed their fixtures.
  return { PATH: base.PATH, HOME: home, TMPDIR: "/tmp", LANG: "C.UTF-8", CI: "true", [harness.binaryEnv]: binary };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeAtomic(dir, name, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `${name}.${process.pid}.tmp`);
  writeFileSync(temporary, value, { mode: 0o600 }); renameSync(temporary, join(dir, name));
}

function runUrl(env = process.env) {
  return env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
}

const SUMMARY_LIMIT = 900_000;
export function markdown(report, suiteMarkdown = {}) {
  const verdict = { 0: report.measured ? "matched" : "no new release", 1: "changed", 2: "could not run" }[report.exitCode] ?? "could not run";
  const lines = [`# ${report.name} Assumption Probes: ${verdict}`, "",
    `Harness: ${report.harness} (\`${report.npmPackage}\`); exit=${report.exitCode}; event=${report.event ?? "unknown"}`,
    `Run: ${report.runUrl ?? "local"}; completed ${report.completedAt}`, ""];
  if (report.reason) lines.push(`**${report.measured ? "Reason" : "Not measured"}:** ${report.reason}`, "");
  if (report.targets?.length) {
    lines.push("| Target | Version | Result |", "| --- | --- | --- |",
      ...report.targets.map(t => `| ${t.label} | ${t.version} | ${t.status ?? "not measured"}${t.reason ? `: ${t.reason}` : ""} |`), "");
  }
  if (report.isolation) lines.push(`Isolation: **${report.isolation.status}**. ${report.isolation.detail}`, "");
  if (report.preparation) lines.push(`Preparation: **${report.preparation.status}**. ${report.preparation.purpose}. ${report.preparation.detail}`, "");
  if (report.record) lines.push(`Last matched measurement: ${report.record.completedAt} in ${report.record.runUrl ?? "an unrecorded run"} (key \`${report.record.key}\`).`, "");
  for (const target of report.targets ?? []) {
    if (!suiteMarkdown[target.version]) continue;
    lines.push(`## ${target.version} Suite Report`, "", ...suiteMarkdown[target.version].split("\n").map(l => l.startsWith("#") ? `##${l}` : l), "");
  }
  const text = lines.join("\n");
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}\n\n_Truncated; the full report is in the artifact._\n` : text;
}

function publish(harness, report, suiteMarkdown = {}, env = process.env, { quiet = false } = {}) {
  const { reportDir } = paths(harness, env.RUNNER_TEMP);
  const text = markdown(report, suiteMarkdown);
  writeAtomic(reportDir, "latest.json", JSON.stringify(report, null, 2) + "\n");
  writeAtomic(reportDir, "latest.md", text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text + "\n");
  // Suite markdown is release-influenced; outside stop-commands only the verdict reaches the log.
  console.log(quiet ? text.split("\n")[0] : text);
}

function output(values, env = process.env) {
  const text = Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join("");
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text); else process.stdout.write(text);
}

function baseReport(harness, env = process.env) {
  return { harness: harness.id, name: harness.name, npmPackage: harness.npmPackage, event: env.GITHUB_EVENT_NAME ?? null, runUrl: runUrl(env),
    measured: false, complete: true, exitCode: EXIT.couldNotRun, completedAt: new Date().toISOString(), documentation: harness.documentation };
}

export async function detect(harness, { env = process.env, root = ROOT, fetchImpl = fetch, delayMs } = {}) {
  const location = paths(harness, env.RUNNER_TEMP);
  rmSync(location.statePath, { force: true });
  try {
    const sourceHash = fingerprint(harness, root);
    const targets = targetsFor(await newestRelease(harness, { fetchImpl, delayMs }), baselineVersions(harness, root));
    const state = { harness: harness.id, targets, sourceHash, key: recordKey(harness, targets, sourceHash) };
    writeAtomic(dirname(location.statePath), `${harness.id}.json`, JSON.stringify(state, null, 2) + "\n");
    output({ key: state.key }, env);
    console.log(`${harness.name}: ${targets.map(t => `${t.label} ${t.version}`).join("; ")}; record key ${state.key}`);
    return EXIT.matched;
  } catch (error) {
    // Unreachable npm or an unreadable baseline is could not run, never "no new release".
    publish(harness, { ...baseReport(harness, env), reason: `Release detection could not run: ${error.message}` }, {}, env);
    return EXIT.couldNotRun;
  }
}

export function decide(harness, { env = process.env } = {}) {
  const location = paths(harness, env.RUNNER_TEMP);
  const state = readJson(location.statePath);
  if (!state || state.harness !== harness.id) {
    publish(harness, { ...baseReport(harness, env), reason: "Release detection state is missing" }, {}, env);
    return EXIT.couldNotRun;
  }
  let force;
  try { force = forced(harness, env.GITHUB_EVENT_NAME, env.DISPATCH_HARNESS); } catch (error) {
    publish(harness, { ...baseReport(harness, env), reason: error.message, targets: state.targets }, {}, env);
    return EXIT.couldNotRun;
  }
  const recordPath = join(location.recordDir, "record.json");
  const record = readJson(recordPath);
  if (!force && validRecord(record, state)) {
    publish(harness, { ...baseReport(harness, env), exitCode: EXIT.matched, targets: state.targets, record,
      reason: "every target version was already measured matched with this probe set; no suite ran today" }, {}, env);
    output({ measure: "false" }, env);
    return EXIT.matched;
  }
  // A lost, unreadable or mismatched record always measures: the fail-safe direction.
  const why = force ? "manual dispatch" : !existsSync(recordPath) ? "no matched record for these versions and probe set" : "measurement record unreadable or does not match";
  console.log(`${harness.name}: measuring (${why})`);
  writeAtomic(dirname(location.statePath), `${harness.id}.json`, JSON.stringify({ ...state, why }, null, 2) + "\n");
  output({ measure: "true" }, env);
  return EXIT.matched;
}

/**
 * Run argv with a deadline; resolves { code, signal, timedOut, error, tail, stdout } and never rejects.
 * `inherit` streams to the job log, `capture` also keeps a tail, `quiet` keeps stdout unmirrored.
 */
export function execute(argv, { cwd = ROOT, env, timeoutMs = 60_000, stdio = "inherit" } = {}) {
  return new Promise(done => {
    let tail = "", stdout = "", timedOut = false, error, killTimer;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: stdio === "inherit" ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"], detached: true });
    const keep = chunk => { if (stdio === "capture") process.stdout.write(chunk); tail = (tail + chunk).slice(-4000); };
    child.stdout?.on("data", chunk => { if (stdio === "quiet") { if (stdout.length < 4_000_000) stdout += chunk; } else keep(chunk); });
    child.stderr?.on("data", keep);
    const stop = () => {
      if (killTimer) return;
      child.kill("SIGTERM"); // Probe suites (and sudo, which relays it) tear down their owned groups on SIGTERM.
      killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 15_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    // The child leads its own group, so a cancelled job must forward the signal explicitly.
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    child.on("error", e => { error = e.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
      done({ code, signal, timedOut, error, tail, stdout });
    });
  });
}

/** CI runs unreviewed releases as a separate unprivileged user; see scripts/harness-assumptions-isolate.sh. */
export function isolationFrom(env = process.env) {
  const user = env.HARNESS_PROBE_USER, root = env.HARNESS_PROBE_ROOT;
  if (user && root) return { user, root };
  if (env.GITHUB_ACTIONS === "true") throw new Error("HARNESS_PROBE_USER and HARNESS_PROBE_ROOT are required in CI; an unreviewed release never runs with the job's privileges");
  return null;
}

const ok = run => run.code === 0 && !run.timedOut && !run.error;
const describeRun = run => run.timedOut ? "timed out" : run.error ? `could not start (${run.error})` : `exited ${run.code ?? run.signal}`;
const lastLines = run => JSON.stringify((run.tail ?? "").trim().split("\n").slice(-6).join(" | "));

/**
 * Where and as whom suites run. Isolated: a staged read-only checkout, directories owned by the
 * probe user, every one of its processes killed after each suite, and only regular report files
 * copied back. Direct (local debugging only): the current user and checkout.
 */
export function sandbox(harness, isolation, { env, root, exec, location }) {
  const sudo = argv => exec(["sudo", "-n", ...argv], { cwd: "/", env, timeoutMs: 120_000, stdio: "quiet" });
  if (!isolation) {
    return {
      isolated: false, cwd: root, installRoot: location.installRoot, workRoot: join(env.RUNNER_TEMP, "harness-assumption-work", harness.id),
      stage: async () => ({ code: 0 }),
      makeDir: async dir => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true, mode: 0o700 }); return true; },
      run: (argv, suiteEnvironment, timeoutMs) => exec(argv, { cwd: root, env: suiteEnvironment, timeoutMs }),
      reap: async () => true,
      collect: async (dir, name) => {
        try { const path = join(dir, name); return lstatSync(path).isFile() && statSync(path).size < 2 * 1024 * 1024 ? readFileSync(path, "utf8") : null; } catch { return null; }
      },
      remove: async dir => { rmSync(dir, { recursive: true, force: true }); },
    };
  }
  const { user, root: base } = isolation;
  return {
    isolated: true, cwd: join(base, "repo"), installRoot: join(base, "install", harness.id), workRoot: join(base, "work", harness.id),
    stage: () => exec(["bash", "scripts/harness-assumptions-isolate.sh", user, base], { cwd: root, env, timeoutMs: 20 * 60_000, stdio: "capture" }),
    makeDir: async dir => ok(await sudo(["rm", "-rf", "--", dir])) && ok(await sudo(["install", "-d", "-o", user, "-g", user, "-m", "700", dir])),
    // env -i: the suite sees only the minimal environment, never the job's.
    run: (argv, suiteEnvironment, timeoutMs) => exec(["sudo", "-n", "-u", user, "--", "/usr/bin/env", "-i", ...Object.entries(suiteEnvironment).map(([k, v]) => `${k}=${v}`), ...argv],
      { cwd: join(base, "repo"), env, timeoutMs }),
    reap: async () => {
      await sudo(["pkill", "-KILL", "-u", user]);
      for (let attempt = 0; attempt < 10; attempt++) {
        if ((await sudo(["pgrep", "-u", user])).code === 1) return true;
        await new Promise(r => setTimeout(r, 500));
        await sudo(["pkill", "-KILL", "-u", user]);
      }
      return false;
    },
    // Only a regular file owned by the probe user is read, so a planted symlink or another file
    // can never be copied into the published report.
    collect: async (dir, name) => {
      const found = await sudo(["find", dir, "-maxdepth", "1", "-type", "f", "-user", user, "-name", name, "-size", "-2048k", "-print"]);
      if (!ok(found) || found.stdout.trim() !== join(dir, name)) return null;
      const read = await sudo(["cat", "--", join(dir, name)]);
      return ok(read) ? read.stdout : null;
    },
    remove: async dir => { await sudo(["rm", "-rf", "--", dir]); },
  };
}

export function suiteArgv(harness, reportDir, nodePath = process.execPath) {
  return [...harness.suite.map((part, i) => i === 0 && part === "node" ? nodePath : part), harness.reportDirArg, reportDir];
}

export async function measure(harness, { env = process.env, root = ROOT, exec = execute } = {}) {
  const location = paths(harness, env.RUNNER_TEMP);
  const state = readJson(location.statePath);
  const report = { ...baseReport(harness, env), measured: true, complete: false, startedAt: new Date().toISOString(), targets: [] };
  const suiteMarkdown = {};
  rmSync(location.reportDir, { recursive: true, force: true });
  rmSync(join(location.recordDir, "record.json"), { force: true });
  if (!state?.targets?.length || state.harness !== harness.id) {
    publish(harness, { ...report, complete: true, reason: "Release detection state is missing" }, {}, env);
    return EXIT.couldNotRun;
  }
  report.reason = state.why ?? null;
  report.targets = state.targets.map(t => ({ ...t }));
  const fail = (target, reason) => ({ ...target, exitCode: EXIT.couldNotRun, status: TARGET_STATUS[2], reason });
  let box;
  try { box = sandbox(harness, isolationFrom(env), { env, root, exec, location }); } catch (error) {
    report.targets = report.targets.map(t => fail(t, error.message));
    report.exitCode = EXIT.couldNotRun;
    publish(harness, { ...report, complete: true }, {}, env);
    output({ exit: String(report.exitCode) }, env);
    return report.exitCode;
  }
  // Untrusted suite output must not issue workflow commands; GITHUB_OUTPUT is a file and unaffected.
  const resume = env.GITHUB_ACTIONS === "true" ? randomUUID() : null;
  if (resume) console.log(`::stop-commands::${resume}`);
  try {
    // An incomplete report is on disk before the long-running work starts.
    writeAtomic(location.reportDir, "latest.json", JSON.stringify(report, null, 2) + "\n");
    const staged = await box.stage();
    report.isolation = box.isolated
      ? ok(staged) ? { status: "ok", detail: `Suites ran as the unprivileged ${env.HARNESS_PROBE_USER} user without sudo, against a read-only copy.` }
        : { status: "failed", detail: `\`scripts/harness-assumptions-isolate.sh\` ${describeRun(staged)}; no suite ran. Last output: ${lastLines(staged)}` }
      : { status: "not isolated", detail: "Local run as the current user." };
    if (report.isolation.status === "failed") {
      report.targets = report.targets.map(t => fail(t, "the unprivileged probe user could not be prepared"));
    } else {
      if (harness.prepare) {
        const run = await exec(harness.prepare.command, { cwd: root, env, timeoutMs: 15 * 60_000, stdio: "capture" });
        report.preparation = ok(run) ? { status: "ok", purpose: harness.prepare.purpose, detail: "Completed." }
          : { status: "failed", purpose: harness.prepare.purpose,
            detail: `\`${harness.prepare.command.join(" ")}\` ${describeRun(run)}; the dependent probes report could not run. Last output: ${lastLines(run)}` };
      }
      for (const [index, target] of report.targets.entries()) {
        report.targets[index] = await measureTarget(harness, target, { box, env, exec, suiteMarkdown });
        writeAtomic(location.reportDir, "latest.json", JSON.stringify(report, null, 2) + "\n");
      }
    }
  } finally { if (resume) console.log(`::${resume}::`); }
  report.exitCode = combinedExit(report.targets, report.preparation);
  if (report.isolation?.status === "failed" && report.exitCode === EXIT.matched) report.exitCode = EXIT.couldNotRun;
  report.complete = true;
  report.completedAt = new Date().toISOString();
  publish(harness, report, suiteMarkdown, env, { quiet: Boolean(resume) });
  if (report.exitCode === EXIT.matched) {
    writeAtomic(location.recordDir, "record.json", JSON.stringify({ recordVersion: RECORD_VERSION, harness: harness.id, key: state.key, sourceHash: state.sourceHash,
      targets: report.targets.map(({ label, version }) => ({ label, version })), exitCode: EXIT.matched, completedAt: report.completedAt, runUrl: report.runUrl }, null, 2) + "\n");
  }
  output({ exit: String(report.exitCode) }, env);
  return report.exitCode;
}

async function measureTarget(harness, target, { box, env, exec, suiteMarkdown }) {
  const fail = reason => ({ ...target, exitCode: EXIT.couldNotRun, status: TARGET_STATUS[2], reason });
  const prefix = join(box.installRoot, target.version);
  rmSync(prefix, { recursive: true, force: true }); mkdirSync(prefix, { recursive: true });
  // --ignore-scripts: installing runs none of the release's code; only the suite executes it.
  const install = await exec(["npm", "install", "--prefix", prefix, "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", `${harness.npmPackage}@${target.version}`],
    { cwd: prefix, env, timeoutMs: 10 * 60_000, stdio: "capture" });
  const installed = readJson(join(prefix, "node_modules", ...harness.npmPackage.split("/"), "package.json"))?.version;
  const binary = join(prefix, "node_modules", ".bin", harness.bin);
  if (!ok(install) || installed !== target.version || !existsSync(binary)) {
    return fail(`npm install of ${harness.npmPackage}@${target.version} failed (${describeRun(install)}, installed ${installed ?? "nothing"})`);
  }
  const work = join(box.workRoot, target.version);
  const home = join(work, "home"), suiteDir = join(work, "report");
  if (!await box.makeDir(work) || !await box.makeDir(home) || !await box.makeDir(suiteDir)) return fail("could not create the suite's throwaway directories");
  try {
    const timeoutMinutes = harness.timeoutMinutes;
    const execution = await box.run(suiteArgv(harness, suiteDir), suiteEnv(harness, binary, home, env), timeoutMinutes * 60_000);
    // Nothing the release started may outlive its suite, or its results are not trustworthy.
    if (!await box.reap()) return fail("processes started by the suite survived it and could not be killed");
    const json = await box.collect(suiteDir, "latest.json");
    let suiteReport = null; try { suiteReport = json === null ? null : JSON.parse(json); } catch {}
    const md = await box.collect(suiteDir, "latest.md");
    if (md !== null) suiteMarkdown[target.version] = md;
    return judgeSuite(target, { ...execution, timeoutMinutes }, suiteReport);
  } finally {
    await box.reap();
    await box.remove(work);
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, flag, id, ...rest] = args;
  if (!["detect", "decide", "measure"].includes(command) || flag !== "--harness" || !id || rest.length) {
    throw new Error("Usage: node scripts/harness-assumptions.mjs detect|decide|measure --harness <id>");
  }
  const harness = harnessById(id);
  return command === "detect" ? detect(harness) : command === "decide" ? decide(harness) : measure(harness);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`Could not run the harness assumption driver: ${error.message}`); process.exitCode = 2; });
}

