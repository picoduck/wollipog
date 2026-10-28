import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { quantile } from "./merge-queue-wait-report.mjs";

// Offline, deterministic queue model for the #3638 premerge-batching evaluation. It replays
// measured queue arrivals against three designs: GitHub's native per-entry merge groups, a
// true-batching queue that builds one full suite per batch, and #3625's fast gate plus rolling
// full validation. Seeded draws only: no clock, network or repository state is read.
// Outputs are modeled consequences of the stated inputs, not measurements.

export const INPUT_SCHEMA = "premerge-batching-inputs-v1";
const MINUTE = 60_000;

/** Defaults derived in docs/ci-premerge-batching-evaluation-2026-10-28.md; each is overridable. */
export const DEFAULTS = Object.freeze({
  seeds: 20,
  slots: 2, // concurrent full suites the shared pool sustains for the queue (20 jobs / 8 per suite, minus PR CI)
  flakeRate: 0.12, // spurious full-suite failure probability per build
  defectRate: 0.03, // entries that fail every build containing them until changed
  fastMinutes: 10, // fast-gate build, including its own runner wait
  fastSlots: 3, // concurrent fast builds; a fast build uses a few jobs, not a full suite's eight
  fastRunnerMinutes: 40,
  fastFlakeRate: 0.04,
  fastCatchRate: 0.6, // share of defects the fast gate catches
  repairMinutes: 20, // failed full verdict to revert enqueued
  backlogLimit: 5,
  ageLimitMinutes: 120,
  rollingOverheadMinutes: 0,
});

/** Mulberry32: small, seedable and stable across Node versions. */
export function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function validateInputs(inputs) {
  if (inputs?.schema !== INPUT_SCHEMA) throw new Error(`Inputs must use schema ${INPUT_SCHEMA}`);
  const times = inputs.arrivals?.map((arrival) => Date.parse(arrival?.at));
  if (!times?.length || times.some((time, i) => !Number.isFinite(time) || (i > 0 && time < times[i - 1])))
    throw new Error("arrivals must be a non-empty, time-ordered list of ISO timestamps");
  for (const key of ["passingExecutionMinutes", "sameHeadReenqueueMinutes"])
    if (!inputs[key]?.length || inputs[key].some((value) => !(Number.isFinite(value) && value >= 0)))
      throw new Error(`${key} must be a non-empty list of non-negative minutes`);
  if (!(inputs.runnerMinutesPerExecutionMinute > 0)) throw new Error("runnerMinutesPerExecutionMinute must be positive");
  return inputs;
}

/**
 * Arrival offsets in minutes from the first arrival. `scale` > 1 compresses the trace, raising the
 * arrival rate while keeping its daily shape.
 */
export function arrivalMinutes(inputs, scale = 1) {
  const start = Date.parse(inputs.arrivals[0].at);
  return inputs.arrivals.map((arrival) => (Date.parse(arrival.at) - start) / MINUTE / scale);
}

/**
 * One queue design over one seeded trace.
 *
 * design.kind: "native" | "batch" | "staged".
 *   native: one speculative merge group per entry; `depth` groups build at once (max_entries_to_build).
 *           `headGreen` models grouping_strategy HEADGREEN instead of the live ALLGREEN.
 *   batch: up to `batchSize` entries per full build, `depth` batches in flight; a failing batch splits by
 *          `split` ("bisect" | "single"); `retryBatch` retries a failing multi-entry batch once first.
 *   staged: native queue over a fast gate; one rolling full validation of main's tip at a time.
 */
export function simulate(inputs, design, params = {}, seed = 1) {
  const p = { ...DEFAULTS, ...params };
  const rng = prng(seed);
  const sample = (list) => list[Math.floor(rng() * list.length)];
  const staged = design.kind === "staged";
  const k = design.kind === "batch" ? design.batchSize : 1;
  const depth = design.depth ?? 2;
  const fullMinutes = () => sample(inputs.passingExecutionMinutes) + p.rollingOverheadMinutes;
  const entries = arrivalMinutes(inputs, p.scale ?? 1).map((at, id) => {
    // `defects` lists defective arrival indices for fixtures; otherwise each entry is drawn.
    const defective = p.defects ? p.defects.includes(id) : rng() < p.defectRate;
    return { id, arrival: at, defective, escapes: staged && defective && rng() >= p.fastCatchRate, revert: null };
  });
  const pending = entries.map((entry) => ({ at: entry.arrival, entry }));
  const queue = [];
  let units = [];
  let now = 0;
  let slotsUsed = 0;
  let fastSlotsUsed = 0;
  const stats = { merged: [], rejected: 0, fullBuilds: 0, fastBuilds: 0, cancelledBuilds: 0, runnerMinutes: 0,
    splits: 0, landings: [], redMinutes: 0, escapes: 0, exposedMerges: 0, holdMinutes: 0, validations: 0, reverts: 0 };
  // Staged: main history and its rolling validator.
  const main = [];
  let validated = 0;
  let failedTip = null;
  let validator = null;
  let liveDefects = new Set();
  let redSince = null;
  let healthFailing = false;
  let holdSince = null;

  const queueBuildMinutes = () => staged ? p.fastMinutes : fullMinutes();
  const chargeBuild = (minutes, full) => {
    stats.runnerMinutes += full ? minutes * inputs.runnerMinutesPerExecutionMinute : p.fastRunnerMinutes * Math.min(1, minutes / p.fastMinutes);
  };
  const enqueue = (entry, at) => {
    const position = entry.revert !== null ? queue.findIndex((other) => other.revert === null) : -1;
    entry.enqueuedAt = at;
    if (position >= 0) queue.splice(position, 0, entry); else queue.push(entry);
  };
  const held = () => staged && (healthFailing || main.length - validated > p.backlogLimit ||
    (main.length > validated && now - main[validated].at > p.ageLimitMinutes));
  const buildFails = (content) => staged
    ? content.some((entry) => entry.defective && !entry.escapes) || rng() < p.fastFlakeRate
    : content.some((entry) => entry.defective) || rng() < p.flakeRate;

  function schedule() {
    const holding = held();
    if (holding && holdSince === null) holdSince = now;
    if (!holding && holdSince !== null) { stats.holdMinutes += now - holdSince; holdSince = null; }
    while (units.length < depth && queue.length) {
      // A health or backlog hold admits only reverts.
      const take = holding ? queue.filter((entry) => entry.revert !== null).slice(0, k) : queue.slice(0, k);
      if (!take.length) break;
      for (const entry of take) queue.splice(queue.indexOf(entry), 1);
      units.push({ entries: take, build: null, retried: false });
    }
    // After a failed verdict the validator waits for a new tip, such as the revert.
    if (staged && !validator && validated < main.length && failedTip !== main.length && slotsUsed < p.slots) {
      const minutes = fullMinutes();
      const tip = main.length;
      validator = { tip, end: now + minutes, fails: liveDefects.size > 0 ? "defect" : rng() < p.flakeRate ? "flake" : null };
      slotsUsed++;
      stats.validations++;
      stats.fullBuilds++;
      chargeBuild(minutes, true);
    }
    const free = () => staged ? fastSlotsUsed < p.fastSlots : slotsUsed < p.slots;
    // Only the first `depth` units build, including the parts of a split batch.
    for (let i = 0; i < Math.min(units.length, depth) && free(); i++) {
      const unit = units[i];
      if (unit.build) continue;
      const content = units.slice(0, i + 1).flatMap((other) => other.entries);
      const minutes = queueBuildMinutes();
      unit.build = { start: now, end: now + minutes, fails: buildFails(content), done: false };
      if (staged) { fastSlotsUsed++; stats.fastBuilds++; } else { slotsUsed++; stats.fullBuilds++; }
    }
  }

  function release() {
    if (staged) fastSlotsUsed--; else slotsUsed--;
  }

  function cancel(unit) {
    if (!unit.build) return;
    if (!unit.build.done) {
      release();
      stats.cancelledBuilds++;
      chargeBuild(now - unit.build.start, !staged);
    }
    unit.build = null;
  }

  function land(unit) {
    stats.landings.push(unit.entries.length);
    for (const entry of unit.entries) {
      if (entry.revert === null) stats.merged.push(now - entry.arrival);
      if (!staged) continue;
      main.push({ at: now, entry });
      if (entry.revert === null && liveDefects.size) stats.exposedMerges++;
      if (entry.escapes) { liveDefects.add(entry); stats.escapes++; redSince ??= now; }
      if (entry.revert) liveDefects.delete(entry.revert);
    }
  }

  function resolve() {
    while (units[0]?.build?.done) {
      const [head] = units;
      if (!head.build.fails) { land(head); units.shift(); continue; }
      if (design.headGreen) {
        // HEADGREEN: a later passing group contains every entry ahead of it, so it vouches for them
        // within one merge (max_entries_to_merge 5). A still-running later group is awaited.
        const later = units.slice(1, 5);
        const vouch = later.findIndex((unit) => unit.build?.done && !unit.build.fails);
        if (vouch >= 0) { land({ entries: units.splice(0, vouch + 2).flatMap((unit) => unit.entries) }); continue; }
        if (later.some((unit) => unit.build && !unit.build.done)) break;
      }
      for (const unit of units.slice(1)) cancel(unit);
      units.shift();
      if (head.entries.length === 1) {
        const [entry] = head.entries;
        const failsAgain = staged ? entry.defective && !entry.escapes : entry.defective;
        if (failsAgain) stats.rejected++;
        else pending.push({ at: now + sample(inputs.sameHeadReenqueueMinutes), entry });
      } else if (design.retryBatch && !head.retried) {
        units.unshift({ entries: head.entries, build: null, retried: true });
      } else {
        stats.splits++;
        const parts = design.split === "single" ? head.entries.map((entry) => [entry])
          : [head.entries.slice(0, Math.ceil(head.entries.length / 2)), head.entries.slice(Math.ceil(head.entries.length / 2))];
        units = [...parts.map((part) => ({ entries: part, build: null, retried: false })), ...units];
      }
    }
  }

  function validatorDone() {
    slotsUsed--;
    const { tip, fails } = validator;
    validator = null;
    if (fails === "flake") return; // The rolling validator reruns the same tip at its next opportunity.
    if (fails === "defect") {
      healthFailing = true;
      failedTip = tip;
      for (const defect of liveDefects) {
        if (entries.some((entry) => entry.revert === defect)) continue;
        const revert = { id: entries.length, arrival: now + p.repairMinutes, defective: false, escapes: false, revert: defect };
        entries.push(revert);
        stats.reverts++;
        pending.push({ at: revert.arrival, entry: revert });
      }
      return;
    }
    validated = tip;
    if (healthFailing || redSince !== null) {
      if (liveDefects.size === 0) {
        stats.redMinutes += now - redSince;
        redSince = null;
        healthFailing = false;
      }
    }
  }

  for (let guard = 0; guard < 1_000_000; guard++) {
    schedule();
    pending.sort((a, b) => a.at - b.at);
    const buildEnds = units.filter((unit) => unit.build && !unit.build.done).map((unit) => unit.build.end);
    const next = Math.min(pending[0]?.at ?? Infinity, ...buildEnds, validator?.end ?? Infinity);
    if (next === Infinity) break;
    now = next;
    if (validator && validator.end <= now) validatorDone();
    for (const unit of units) if (unit.build && !unit.build.done && unit.build.end <= now) {
      unit.build.done = true;
      release();
      chargeBuild(unit.build.end - unit.build.start, !staged);
    }
    resolve();
    while (pending.length && pending[0].at <= now) {
      const { entry } = pending.shift();
      enqueue(entry, now);
    }
  }
  if (holdSince !== null) stats.holdMinutes += now - holdSince;
  if (redSince !== null) stats.redMinutes += now - redSince;
  return stats;
}

/** Pools every seed's entries before taking quantiles; never averages per-seed percentiles. */
export function evaluate(inputs, design, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const runs = Array.from({ length: p.seeds }, (_, i) => simulate(inputs, design, p, i + 1));
  const merged = runs.flatMap((run) => run.merged);
  const sum = (key) => runs.reduce((total, run) => total + run[key], 0);
  const perSeed = (key) => +(sum(key) / runs.length).toFixed(1);
  const landings = runs.flatMap((run) => run.landings);
  return {
    design: label(design), seeds: p.seeds, mergedPerSeed: merged.length / runs.length,
    latencyMinutes: { p50: round(quantile(merged, 0.5)), p90: round(quantile(merged, 0.9)), mean: round(merged.reduce((a, b) => a + b, 0) / merged.length) },
    fullBuildsPerMerge: round(sum("fullBuilds") / merged.length, 2),
    fastBuildsPerMerge: round(sum("fastBuilds") / merged.length, 2),
    cancelledBuildsPerSeed: perSeed("cancelledBuilds"),
    runnerMinutesPerMerge: round(sum("runnerMinutes") / merged.length),
    meanLandingSize: round(landings.reduce((a, b) => a + b, 0) / landings.length, 2),
    splitsPerSeed: perSeed("splits"), rejectedPerSeed: perSeed("rejected"),
    escapesPerSeed: perSeed("escapes"), redMinutesPerSeed: perSeed("redMinutes"),
    exposedMergesPerSeed: perSeed("exposedMerges"), holdMinutesPerSeed: perSeed("holdMinutes"), revertsPerSeed: perSeed("reverts"),
  };
}

const round = (value, places = 1) => value === null || !Number.isFinite(value) ? null : +value.toFixed(places);

export function label(design) {
  if (design.kind === "native") return `native depth ${design.depth ?? 2}${design.headGreen ? " HEADGREEN" : ""}`;
  if (design.kind === "staged") return `staged fast gate depth ${design.depth ?? 2}`;
  return `batch ${design.batchSize} depth ${design.depth ?? 2} ${design.split}${design.retryBatch ? " retry" : ""}`;
}

export const DESIGNS = [
  { kind: "native", depth: 2 },
  { kind: "native", depth: 5 },
  { kind: "native", depth: 2, headGreen: true },
  { kind: "batch", batchSize: 2, depth: 1, split: "bisect" },
  { kind: "batch", batchSize: 3, depth: 1, split: "bisect" },
  { kind: "batch", batchSize: 4, depth: 1, split: "bisect" },
  { kind: "batch", batchSize: 4, depth: 1, split: "single" },
  { kind: "batch", batchSize: 4, depth: 1, split: "bisect", retryBatch: true },
  { kind: "batch", batchSize: 4, depth: 2, split: "bisect" },
  { kind: "staged", depth: 2 },
];

export function report(inputs, { scales = [1, 2, 3], params = {} } = {}) {
  validateInputs(inputs);
  return { inputs: { window: inputs.window, arrivals: inputs.arrivals.length, executionSamples: inputs.passingExecutionMinutes.length },
    params: { ...DEFAULTS, ...params },
    scenarios: scales.map((scale) => ({ scale, results: DESIGNS.map((design) => evaluate(inputs, design, { ...params, scale })) })) };
}

export function markdown(result) {
  const lines = [];
  for (const { scale, results } of result.scenarios) {
    lines.push(`### Arrival Rate ×${scale}`, "",
      "| Design | Latency p50 | Latency p90 | Full Builds / Merge | Runner-Min / Merge | Mean Landing | Splits | Rejected | Escapes | Red Min | Exposed Merges | Hold Min |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const row of results) lines.push(`| ${row.design} | ${row.latencyMinutes.p50} | ${row.latencyMinutes.p90} | ${row.fullBuildsPerMerge} | ` +
      `${row.runnerMinutesPerMerge} | ${row.meanLandingSize} | ${row.splitsPerSeed} | ${row.rejectedPerSeed} | ${row.escapesPerSeed} | ` +
      `${row.redMinutesPerSeed} | ${row.exposedMergesPerSeed} | ${row.holdMinutesPerSeed} |`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function main(argv, { out = console.log, err = console.error } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { inputs: { type: "string" }, json: { type: "boolean" },
      scale: { type: "string", multiple: true }, set: { type: "string", multiple: true } } });
    if (!values.inputs) throw new Error("Usage: premerge-batching-model.mjs --inputs <file> [--scale n]... [--set key=value]... [--json]");
    const params = {};
    for (const pair of values.set ?? []) {
      const [key, value] = pair.split("=");
      if (!(key in DEFAULTS) || !Number.isFinite(Number(value))) throw new Error(`Unknown or non-numeric parameter: ${pair}`);
      params[key] = Number(value);
    }
    const scales = values.scale?.map(Number) ?? [1, 2, 3];
    if (scales.some((scale) => !(scale > 0))) throw new Error("--scale must be positive");
    const result = report(JSON.parse(await readFile(values.inputs, "utf8")), { scales, params });
    out(values.json ? JSON.stringify(result, null, 2) : markdown(result));
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
