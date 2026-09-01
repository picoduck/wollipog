# Job: Useless Test Deletion

Find tests that cannot fail, and tests that duplicate coverage another test already provides.

## The Definition

A test earns its place only if it would fail when the behavior it covers is broken. This is the same
definition `coverage-gap-fill` uses when it proposes new tests. If the two jobs ever disagree,
report the conflict rather than acting.

## Ground Truth

A test that cannot fail is provable, not a matter of taste. For each candidate, establish which of
these it is:

- **Asserts nothing.** No assertion runs, or every assertion is inside a branch that never executes.
  `git grep -n "test(\|it(" -- '**/*.test.ts'` to enumerate, then read the body.
- **Asserts only on its own fixture.** The assertions check values the test itself constructed and
  never pass through the code under test.
- **Tautological.** Asserts a language or library guarantee rather than repository behavior.
- **Duplicate.** Another test exercises the same function through the same path with the same
  inputs; the second adds no distinct failure mode.

The strongest evidence is a demonstration: describe precisely which change to production code the
test would fail to catch, and name the other test that does catch it.

## Gate

- The test's file must not be in the exclusion set from the shared skill.
- Check provenance with `git log --follow --format='%h %ad %s' -- <test-file>`. Note whether the test
  arrived in a large model-generated batch, which the interview cited as the usual source of useless
  tests, but never treat provenance alone as sufficient.
- Never propose deleting a test merely because it is short, has an unclear name, or covers something
  that seems obvious.
- Never propose deleting a regression test that names an issue or PR number. That test exists
  because something broke once.
- A helper with the same name in two packages is not a duplicate. Two tests can share
  byte-identical assertion lines while each pins its own implementation —
  `isControlPlaneService` exists independently in `scripts/dev-runner-bootstrap.mjs` and
  `packages/protocol/src/index.ts`, and a cross-file detector flags their tests. Before calling
  a cross-file duplicate, `git grep` the symbol and confirm there is one definition (or a bare
  re-export); two definitions mean two contracts, each entitled to its own test.

## Report

**Calibration, recorded 2026-09-01:** two consecutive weekly runs over a ~4,300-test suite have
produced exactly one small duplicate-test finding each and zero findings in the other three
categories — this job's steady-state yield is roughly one six-to-nine-line finding per run. The
schedule stays weekly by explicit decision (the cost is negligible on a subscription); read this
as the expected baseline, not as underperformance, and do not manufacture findings to beat it.


For each candidate: the file and test name, which of the four categories it falls into, the specific
proof it cannot fail or is duplicated, and the test that covers the behavior instead. State the
total test count before and after, so the proposed reduction is visible.
