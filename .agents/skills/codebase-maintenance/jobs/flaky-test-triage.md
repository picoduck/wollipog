# Job: Flaky Test Triage

Find tests that fail without a code change, and tests that have been failing on `main` long enough
that everyone has started ignoring them.

This job exists because two timing-dependent failures rode on `main` for weeks while every review
prompt carried a hand-written "2 pre-existing failures" note. That is exactly the state this job
should surface automatically.

## Ground Truth

Establish a clean baseline first: confirm the working tree matches `origin/main` before running,
since a dirty tree makes every result meaningless.

Run the suite three times: `pnpm test`. Compare the failure sets.

- Failing in all three runs: a **broken test**, not a flaky one. It is a real regression or a test
  that no longer matches intended behavior.
- Failing in some runs and not others: **flaky**. Capture the failure output from each run.
- Passing in all three: nothing to report.

For anything that fails, classify the mechanism from the failure output — a time or timeout
dependency, a filesystem or port race, a shared-state or ordering dependency between tests, or a
genuine bug that surfaces nondeterministically. Name the mechanism; do not guess a fix.

Check history with `git log -1 --format='%h %ad' -- <test-file>` and, when the tests are run in CI,
`gh run list --limit 20` to see how long the failure has been present.

## Gate

- Never propose deleting or skipping a flaky test to make the suite green. A flaky test is often
  reporting a real race in the code it covers.
- Distinguish "flaky test" from "flaky code". If the nondeterminism is in the implementation, the
  finding is a bug in the implementation.
- Report a resource-contention failure as environmental only when you can show it — for example a
  port already bound by another process on this machine.

## Report

For each failing or flaky test: the file and test name, the failure rate across the three runs, the
sanitized failure output, the mechanism, and how long it has been failing. State the total suite
result for each run so the baseline is visible.
