# Job: Coverage Gap Fill

Find behavior that no test would catch breaking, and propose the specific tests that would.

## The Definition

Propose a test only if it would fail when the behavior it covers is broken. This is the same
definition `useless-test-deletion` applies. Never propose a test that job would delete: no
tautologies, no assertions on fixtures the test built, no duplicate of existing coverage.

## Ground Truth

Run the suite with coverage:

```
NODE_OPTIONS=--enable-source-maps node --import tsx --test --experimental-test-coverage \
  --test-reporter=lcov --test-reporter-destination=<scratch>/lcov.info \
  "apps/**/src/**/*.test.ts" "apps/**/src/**/*.test.tsx" "apps/**/scripts/**/*.test.mjs" \
  "packages/**/src/**/*.test.ts" "packages/**/src/**/*.test.tsx" "scripts/**/*.test.mjs"
```

`--enable-source-maps` is load-bearing, not optional: without it Node reports uncovered lines in
transpiled-JS line space for every `.ts` file, so the line numbers are wrong and a covered line
can read as uncovered. The glob set matches the repository's `pnpm test` script; the original
two-glob form silently dropped every `.tsx` component test and every `.mjs` script test, making
whole trees read as near-zero coverage. (The first run proved both defects with a concrete
counterexample and re-ran corrected; this codifies its command.)

Rank the candidate list by **uncovered branches**, not by line percentage. Under
`--enable-source-maps`, lcov reports file-header comment blocks, `import` lines,
`export interface` / `export type` declarations, and function signature lines as uncovered `DA:`
entries; a small security module can read as 73–81% line coverage while every executable branch
is taken. One run's four top-ranked "security" candidates by line percentage were entirely this
artifact, and ranking by branch misses surfaced all three real findings and none of the noise.
Confirm a line-coverage gap against `BRDA` records before reading the source. The inverse
also holds: a non-zero `DA` count on the lines inside a guarded block does not prove the guard's
branch ran, because `DA` follows function hits. Only a `BRDA` record with a non-zero taken count
proves the branch. #592 called `durable-command-store.ts:110` covered on the strength of its `DA`
counts; the mismatch branch had never been taken.

Run the coverage command with a TAP reporter beside the lcov one
(`--test-reporter=tap --test-reporter-destination=<scratch>/tap.txt`). One run exited 1 with an
empty `lcov.info`, nothing on stderr, and every test reported passing, which left nothing to
diagnose; the TAP stream is the record that survives that failure.

When a finding rests on a mutation probe (the real module against a copy with one guard removed),
write the probe files in the run's scratch directory with the `.mts` extension and run them from
the repository root: `node --import tsx <scratch>/probe.mts`. Two things fail otherwise and cost a
run its probe budget: `tsx` cannot be resolved when the working directory is the scratch
directory, and top-level `await` is rejected in a `.ts` file that sits outside the repository's
module scope. The probe must import production modules from the repository and copy only the
code under mutation; the working tree stays untouched.

Coverage numbers are the candidate list, not the finding. Low coverage on a trivial getter matters
less than a single uncovered branch in credential validation. Rank candidates by consequence:

1. security and authorization boundaries;
2. durability, recovery, and exactly-once paths;
3. protocol compatibility and mixed-version behavior;
4. error and failure branches generally;
5. everything else.

## Gate

- Name the specific uncovered branch or path, with file and line.
- State the concrete failure the missing test would let through — a real broken behavior, not
  "this function is untested".
- Confirm no existing test already covers it through another path. Coverage tools miss indirect
  coverage; check by reading the tests around it.
- Prove the uncovered branch is reachable before drafting. An uncovered guard can be dead by
  construction — a comparison whose inputs are already forced equal by an earlier check, a
  fallthrough after a loop whose body always returns or throws — and a test that drives it is
  impossible or tautological, which is exactly what `useless-test-deletion` deletes. Report those
  as `dead-code-sweep` overlap instead. One run found three such guards; none was a finding.
- Do not propose tests for code the `dead-code-sweep` job has flagged. Report the overlap instead.

## Report

For each gap: the uncovered path, the consequence of it breaking undetected, and a sketch of the
test that would catch it — its name, its setup, and the assertion that would fail. Cap the report at
the ten highest-consequence gaps and say how many you left out.
