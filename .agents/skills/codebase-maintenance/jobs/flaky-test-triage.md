# Job: Flaky Test Triage

Find tests that fail without a code change, and tests that have been failing on `main` long enough
that everyone has started ignoring them.

This job exists because two timing-dependent failures rode on `main` for weeks while every review
prompt carried a hand-written "2 pre-existing failures" note. That is exactly the state this job
should surface automatically.

## Ground Truth

Establish a clean baseline first: confirm the working tree matches `origin/main` before running,
since a dirty tree makes every result meaningless.

Run the suite three times: `pnpm test`. Compare the failure sets. Then run the Playwright suite
three times: `pnpm test:e2e`, from the repository root (the config and baseURL live there). Every
historical flake in this repository has been e2e/browser, so a unit-only pass is structurally
blind to the layer that actually flakes. Before each e2e run, check that port 4174 is free —
concurrent worktree sessions run their own e2e servers; if the port is held, wait and retry
rather than killing the other server, and stagger subsequent runs. Budget about 3.5 hours of wall
clock for the unit runs and three e2e passes: the 2026-10-06 suite collected 2,153 browser cases
and each complete pass took 55–56 minutes. Record current collection counts and actual durations
rather than treating this estimate as fixed. A window that long is also why HEAD moves under the
sweep, so the baseline-pinning rule below matters most for the e2e passes.

Launch each full-suite pass as its own command and await its completion before starting the next.
Do not chain the three passes into one background command: a per-command lifetime limit can end
the batch partway through a later pass (the 2026-10-06 batch was cut off after two hours). Use
separate run logs and completion records, and resume from those records if the session yields.
A killed, interrupted, or partial pass does not count toward the three comparable complete runs;
report incomplete coverage explicitly if replacements cannot be completed.

Pin the baseline across the whole set of runs. Record `git rev-parse HEAD` before the first run
and re-check it before and after every run, unit and e2e alike. Another session can fast-forward
the primary checkout mid-sweep (the shared rule only assumes HEAD *lags* `origin/main`, not that
it moves), and runs that straddle a pull are not comparable: a test set that grows or shrinks
between runs looks like nondeterministic collection when it is just a merged PR. If HEAD moved,
name the runs on each baseline in the report, discount any run whose tree changed while it was in
flight, and re-run the affected suite three times at the new HEAD before comparing failure sets.
The shared install-freshness check in `SKILL.md` applies here first of all: a stale install fails
the same files in every run and must be reported as `environment`, never as broken tests.

- Failing in all three runs: a **broken test**, not a flaky one. It is a real regression or a test
  that no longer matches intended behavior.
- Failing in some runs and not others: **flaky**. Capture the failure output from each run.
- Passing in all three: nothing to report.

For anything that fails, classify the mechanism from the failure output — a time or timeout
dependency, a filesystem or port race, a shared-state or ordering dependency between tests, or a
genuine bug that surfaces nondeterministically. Name the mechanism; do not guess a fix.

Check history with `git log -1 --format='%h %ad' -- <test-file>`, and read CI history across all
events, not only pushes to `main`: list every failed run of the CI workflow since the previous
sweep (`gh run list --workflow ci.yml --status failure --created '>=<previous sweep date>' --limit 500`)
and pull the log of every failed job other than the aggregator. A fixed run count does not cover a
week: on 2026-09-29 the last 200 runs reached back only 36 hours and held 15 of the week's 41
failed runs, missing the ejection that carried the #1819 evidence. In this repository flakes rarely show up as a red push. They surface as merge-queue
ejections and as browser jobs that failed once and passed on retry, which still fail the run
because `playwright.config.ts` sets `failOnFlakyTests` under CI. A 20-run window missed the
2026-09-22 phone-viewport flake and four merge-queue ejections entirely.

## Gate

- Never propose deleting or skipping a flaky test to make the suite green. A flaky test is often
  reporting a real race in the code it covers.
- Distinguish "flaky test" from "flaky code". If the nondeterminism is in the implementation, the
  finding is a bug in the implementation.
- Report a resource-contention failure as environmental only when you can show it — for example a
  port already bound by another process on this machine.
- If a browser pass suddenly produces a cascade of fast connection/navigation failures, check
  whether that pass's own configured web server is still listening and responding. In the
  2026-10-06 sweep, hundreds of roughly 300ms failures followed the disappearance of its Vite
  server on port 4174. Establish server loss from listener/process/readiness evidence; fast
  failures alone do not prove it. Record the failure, discount the incomplete pass when comparing
  test failure sets, and replace it on the same verified baseline. Preserve the logs and any
  genuine failures before server loss. Stop only processes verified to belong to this pass,
  never another session's server. Do not declare a server-exit cause without evidence.
- A hung or failing run observed in the process table may belong to another session's sandbox or
  to an agent-modified copy of a test file — this machine runs concurrent agent worktrees
  constantly. Before reporting one, verify the file is byte-identical to `main` and check the
  launching process's working directory and sandbox policy; one run nearly reported an
  environmental hang as a repository flake.
- A reproduced failure is exempt from the shared recent-work exclusion. That rule guards against
  inferring abandonment from code age; a live nondeterministic failure on the default branch is
  direct evidence, not an inference, and suppressing it for a week because its lines are young
  defeats this job's purpose. (The first run faced exactly this and overrode the rule with the
  same reasoning; this codifies it.) State each finding's line age so the reader can weigh it,
  and still skip findings whose lines are under an OPEN pull request — those belong to the PR.

## Report

For each failing or flaky test: the file and test name, the failure rate across the three runs, the
sanitized failure output, the mechanism, and how long it has been failing. State the total suite
result for each run so the baseline is visible.
