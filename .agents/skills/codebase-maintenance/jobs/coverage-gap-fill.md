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
- Do not propose tests for code the `dead-code-sweep` job has flagged. Report the overlap instead.

## Report

For each gap: the uncovered path, the consequence of it breaking undetected, and a sketch of the
test that would catch it — its name, its setup, and the assertion that would fail. Cap the report at
the ten highest-consequence gaps and say how many you left out.
