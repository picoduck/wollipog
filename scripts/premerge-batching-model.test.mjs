import assert from "node:assert/strict";
import test from "node:test";
import { DESIGNS, evaluate, INPUT_SCHEMA, main, markdown, prng, report, simulate, validateInputs } from "./premerge-batching-model.mjs";

const at = (minutes) => new Date(Date.UTC(2026, 9, 20) + minutes * 60_000).toISOString();
const inputs = (offsets, extra = {}) => ({ schema: INPUT_SCHEMA, arrivals: offsets.map((minutes, i) => ({ pr: i + 1, at: at(minutes) })),
  passingExecutionMinutes: [30], sameHeadReenqueueMinutes: [5], runnerMinutesPerExecutionMinute: 5, ...extra });
const clean = { flakeRate: 0, fastFlakeRate: 0, defectRate: 0 };

test("the generator is seeded and deterministic", () => {
  const a = prng(7), b = prng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(prng(8)(), prng(7)());
});

test("inputs are validated before modeling", () => {
  assert.throws(() => validateInputs({ ...inputs([0]), schema: "other" }), /schema/);
  assert.throws(() => validateInputs(inputs([10, 0])), /time-ordered/);
  assert.throws(() => validateInputs(inputs([0], { passingExecutionMinutes: [] })), /passingExecutionMinutes/);
  assert.throws(() => validateInputs(inputs([0], { runnerMinutesPerExecutionMinute: 0 })), /positive/);
});

test("native merge groups build once per entry even when entries arrive together", () => {
  const run = simulate(inputs([0, 0, 0, 0]), { kind: "native", depth: 5 }, { ...clean, slots: 4 });
  assert.equal(run.fullBuilds, 4);
  assert.deepEqual(run.merged, [30, 30, 30, 30]);
  assert.equal(run.runnerMinutes, 4 * 30 * 5);
});

test("a true batch builds once for the batch and lands it together", () => {
  const run = simulate(inputs([0, 0, 0, 0]), { kind: "batch", batchSize: 4, depth: 1, split: "bisect" }, clean);
  assert.equal(run.fullBuilds, 1);
  assert.deepEqual(run.landings, [4]);
});

test("a failing native head is removed and the speculative group behind it rebuilds without it", () => {
  const run = simulate(inputs([0, 0]), { kind: "native", depth: 2 }, { ...clean, defects: [0] });
  assert.equal(run.fullBuilds, 3);
  assert.equal(run.rejected, 1);
  assert.deepEqual(run.merged, [60]);
});

test("HEADGREEN lets a later passing group vouch for a flaky earlier entry but still builds per entry", () => {
  const trace = inputs([0, 0]);
  // Find a seed where only the head's group flakes; the group behind it contains the head and passes.
  const pairs = Array.from({ length: 200 }, (_, i) => i + 1).map((seed) => ({
    all: simulate(trace, { kind: "native", depth: 2 }, { ...clean, flakeRate: 0.4 }, seed),
    head: simulate(trace, { kind: "native", depth: 2, headGreen: true }, { ...clean, flakeRate: 0.4 }, seed) }));
  const vouched = pairs.find(({ all, head }) => head.fullBuilds === 2 && head.landings[0] === 2 && all.fullBuilds > 2);
  assert.ok(vouched, "expected a seed where HEADGREEN absorbs the head's flake");
  assert.deepEqual(vouched.head.merged, [30, 30]);
  // A vouching group frees the slots of earlier groups that are still running.
  // Uneven durations make a later group vouch while an intermediate group still runs.
  const staggered = inputs(Array.from({ length: 200 }, (_, i) => i), { passingExecutionMinutes: [10, 60] });
  for (let seed = 1; seed <= 20; seed++) {
    const run = simulate(staggered, { kind: "native", depth: 3, headGreen: true }, { ...clean, flakeRate: 0.4, slots: 3 }, seed);
    assert.equal(run.merged.length, 200);
    assert.equal(run.slotsHeldAtEnd, 0);
  }
  // A defect is never vouched for: every later group contains it.
  const defect = simulate(trace, { kind: "native", depth: 2, headGreen: true }, { ...clean, defects: [0] });
  assert.equal(defect.rejected, 1);
  assert.equal(defect.fullBuilds, 3);
});

test("bisection isolates one defect in a batch of eight with fewer builds than one-by-one", () => {
  const offsets = Array(8).fill(0);
  const bisect = simulate(inputs(offsets), { kind: "batch", batchSize: 8, depth: 1, split: "bisect" }, { ...clean, defects: [7] });
  const single = simulate(inputs(offsets), { kind: "batch", batchSize: 8, depth: 1, split: "single" }, { ...clean, defects: [7] });
  // 8 fail; 0-3 pass; 4-7 fail; 4-5 pass; 6-7 fail; 6 pass; 7 fail.
  assert.equal(bisect.fullBuilds, 7);
  // 8 fail; then each entry alone.
  assert.equal(single.fullBuilds, 9);
  for (const run of [bisect, single]) {
    assert.equal(run.rejected, 1);
    assert.equal(run.merged.length, 7);
  }
});

test("a spuriously failed single entry re-enqueues its unchanged head after the measured delay", () => {
  const runs = Array.from({ length: 40 }, (_, i) => simulate(inputs([0]), { kind: "native", depth: 2 }, { ...clean, flakeRate: 0.5 }, i + 1));
  assert.ok(runs.every((run) => run.rejected === 0 && run.merged.length === 1));
  // Fail at 30, re-enqueue 5 minutes later, pass at 65.
  assert.ok(runs.some((run) => run.merged[0] === 65 && run.fullBuilds === 2));
});

test("staged validation lands an escaped defect, holds ordinary admission and restores after a revert", () => {
  const run = simulate(inputs([0, 15, 200]), { kind: "staged", depth: 2 },
    { ...clean, defects: [0], fastCatchRate: 0, fastMinutes: 10, repairMinutes: 20 });
  assert.equal(run.escapes, 1);
  assert.equal(run.reverts, 1);
  assert.equal(run.exposedMerges, 1);
  // Landed at 10; the validator fails at 40; the revert lands at 70 and validates at 100.
  assert.equal(run.redMinutes, 90);
  assert.equal(run.merged.length, 3);
  assert.equal(run.fastBuilds, 4);
  assert.equal(run.fullBuilds, 4);
});

test("a spurious full verdict holds ordinary admission until a passing verdict", () => {
  const runs = Array.from({ length: 40 }, (_, i) => simulate(inputs([0]), { kind: "staged", depth: 2 }, { ...clean, flakeRate: 0.5 }, i + 1));
  const retried = runs.filter((run) => run.fullBuilds > 1);
  assert.ok(retried.length > 0);
  for (const run of retried) {
    assert.equal(run.holdMinutes, (run.fullBuilds - 1) * 30);
    assert.equal(run.redMinutes, 0);
  }
});

test("recovery is attributed only to defects in the failed snapshot", () => {
  const run = simulate(inputs([0, 15]), { kind: "staged", depth: 2 },
    { ...clean, defects: [0, 1], fastCatchRate: 0, repairMinutes: 100 });
  // Validators: 10-40 sees only entry 0 (revert due 140); 40-70 sees both (revert for 1 due 170).
  // Reverts land at 150 and 180; the validator at 180-210 passes and closes both.
  assert.equal(run.reverts, 2);
  assert.equal(run.redMinutes, 200);
  // Entry 1 landed at 25 while entry 0's defect was live.
  assert.equal(run.exposedMerges, 1);
});

test("a hold withdraws an ordinary entry already in flight until recovery", () => {
  const run = simulate(inputs([0, 35, 200]), { kind: "staged", depth: 2 },
    { ...clean, defects: [0], fastCatchRate: 0, fastMinutes: 10, repairMinutes: 20 });
  // The failed verdict at 40 withdraws the entry building 35-45; the revert lands at 70 and the
  // validator passes at 100, so the entry rebuilds 100-110.
  assert.deepEqual(run.merged, [10, 75, 10]);
  assert.equal(run.exposedMerges, 0);
  assert.equal(run.redMinutes, 90);
  assert.equal(run.holdMinutes, 60);
  assert.equal(run.slotsHeldAtEnd, 0);
});

test("a fast-gate catch rejects the defect without reaching main", () => {
  const run = simulate(inputs([0]), { kind: "staged", depth: 2 }, { ...clean, defects: [0], fastCatchRate: 1 });
  assert.equal(run.escapes, 0);
  assert.equal(run.rejected, 1);
  assert.equal(run.fullBuilds, 0);
});

test("evaluation pools seeds deterministically and reports every design", () => {
  const trace = inputs([0, 5, 9, 40, 41, 42, 120, 121, 300]);
  const a = evaluate(trace, DESIGNS[2], { seeds: 3 });
  assert.deepEqual(a, evaluate(trace, DESIGNS[2], { seeds: 3 }));
  const result = report(trace, { scales: [1], params: { seeds: 2 } });
  assert.equal(result.scenarios[0].results.length, DESIGNS.length);
  assert.match(markdown(result), /\| native depth 2 \|/);
});

test("the command refuses unknown parameters without reading other state", async () => {
  const errors = [];
  assert.equal(await main(["--inputs", "missing.json", "--set", "budget=1"], { out: () => {}, err: (line) => errors.push(line) }), 1);
  assert.match(errors[0], /Unknown or non-numeric parameter/);
  assert.equal(await main([], { out: () => {}, err: (line) => errors.push(line) }), 1);
});
