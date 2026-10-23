# Node Test Scheduling and Partitions

Refs #3627, under tracker #3625. Full Node coverage remains required on pull
requests, merge groups and main pushes. This change does not activate a fast-only
merge gate, change hosted capacity, increase concurrency, or alter the aggregator.

## Profile and Selection

The [safe timing profile](ci-node-profile-2026-10-23.json) comes from ordinary
merge-group run [39896139030](https://github.com/picoduck/wollipog/actions/runs/39896139030),
attempt 1, job 120226938449, tested/workflow SHA
`b1a90aad1d7fd4a7a4891abb45eeb93bbcdaeb46`. Collection used the existing reporter
and report tool, with the explicit half-open creation window
`[2026-10-23T03:39:00Z, 2026-10-23T03:40:00Z)`:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events \
  --since 2026-10-23T03:39:00Z --until 2026-10-23T03:40:00Z \
  --timing-job 120226938449 --timeout-minutes 15 --json > profile.json
```

Only the validated content-safe projection and source metrics are committed. No
logs, test inputs, broad artifact reports or new analytics pipeline are retained.
The run passed 16,072 tests and skipped 122. The Node step took 26.517 minutes;
its containing job executed for 30.267 minutes after 0.033 minutes of runner wait.
Those are one run's observations, not a distribution or measured optimization gain.

The largest observed file totals were:

| File (Relative to Its App's `src/`) | Seconds |
| --- | ---: |
| `control-plane/prepared-media-session-delegated.integration.test.ts` | 383.520 |
| `control-plane/sessions.test.ts` | 254.107 |
| `control-plane/prepared-media-session-integration.test.ts` | 218.433 |
| `runner/provider-home-lease-checkpoint.test.ts` | 197.951 |
| `control-plane/db.test.ts` | 92.777 |

These totals sum outermost test/suite durations; they exclude file startup/import
overhead and are not independent CPU demand or exact file wall time. The reporter
retains only the slowest 20. All other costs remain unmeasured, not zero.

The scheduler starts those measured high-cost files first, in descending cost,
then the unmeasured files in stable path order. This reduces the opportunity for
a known long file to become a late scheduling tail. It retains Node's default
`max(1, availableParallelism() - 1)` file concurrency and native process isolation.
It uses `node:test`'s `run({ files })` because the CLI sorts explicit paths again.
No repeated database, decoder, Git or process setup has been removed: inspection
of the largest files found real isolation and boundary scenarios, and this profile
does not prove their repeated setups equivalent. There is no claim of a gain
until comparable natural CI cohorts establish one.

## Reproducible Commands and Coverage Proof

```sh
pnpm test                     # Original complete CLI command; discovery oracle
pnpm test:full                # Same discovery, measured scheduling
pnpm test:ci                  # Full suite, plus the existing safe timing reporter
pnpm test:fast                # Explicitly reviewed protocol contracts
pnpm test:remaining           # Every discovered file outside the fast allowlist
pnpm test:inventory           # Current per-file full/partition mapping as JSON
# Optional fixed resource budget for local comparisons:
pnpm test:full --test-concurrency=3
pnpm test:fast --test-concurrency=3
```

The [file inventory](ci-node-inventory-2026-10-23.tsv) records every discovered
file at this change, its full-suite membership and exactly one partition.
The six glob patterns are the unchanged original root `test` command, not an
inventory-based inclusion filter. Discovery happens on every execution, including
untracked new files. `fast` is an exact allowlist; `remaining` is its complement.
New or unknown files therefore default to `full` and `remaining`. A stale inventory
cannot exclude them. The inventory is a snapshot, not a maintenance prerequisite
for executing new tests; use `pnpm test:inventory` to inspect the current tree.

`scripts/node-test-plan.test.mjs` proves disjointness, union equality, unique full
membership, all six discovery categories and new-file inclusion. It also tests
real subprocess assertion failures, test timeouts with after-hook cleanup,
process-global isolation, interruption exit status and worker reaping. TODO exit
semantics and dependency-directory exclusions match the native CLI. No existing
test assertions, OS/engine probes, sandbox availability checks, Git identity,
timeouts, cleanup hooks or package-manager boundaries change. `test:watch` remains
the native watch command. CI still runs all files in one full execution, so it
does not pay a second startup for the fast partition.

The initial fast allowlist contains 22 protocol test files with 201 tests. Their
imports and fixtures are in-process protocol/contract checks; the TypeScript
repository-scanning `runner-capability-labels.test.ts` stays in `remaining`.
This intentionally narrow partition is not a claim that all other tests are slow
or that the project's entire unit coverage has been classified as fast.

## Validation and Readiness Limits

On Linux with Node 24.18.1 and three-file concurrency, the fast partition passed
201/201 tests, with no skips or cancellations, in 1.020 seconds reported by the
native runner. The actual minimum Node 22.13.0 also passed all 201 tests with
two-file concurrency in 1.628 seconds. This is a local readiness observation, including file startup;
it is not hosted timing or a before/after improvement estimate. All seven launcher
and coverage-equivalence contracts passed on Node 24.18.1 and 22.13.0; the affected
root/timing/aggregation/browser-budget contracts passed with them on Node 24
(27 total). The full-suite validation and natural
post-change measurements must be reported with the delivered PR.

Timeout scope itself differs between the native engines: Node 22.13.0 bounds the
combined file duration, while Node 24 bounds each test. A four-test fixture with
150ms sequential tests and a 400ms limit reproduces that difference in both the
CLI and launcher. The timeout/after-hook regression compares against the actual
native CLI on the running engine, and the worker receives the explicit timeout
flag. On Node 24 the hanging-test after-hook writes its cleanup marker; on
22.13 the file deadline kills the worker before that hook, as its CLI does.

An initial synthetic launcher regression fixture inherited an `--eval` entry
point into workers and briefly produced recursive fixture processes. The fixture
now uses a file entry point, matching the public command; those synthetic workers
were removed. The concurrent baseline's load was contaminated, so its duration
must not be used as a clean performance comparison.

The [October 22 baseline](ci-baseline-2026-10-22.md) has 75 normal merge-group
first attempts: Node-step p50/p90 23.7/25.7 minutes; containing-job execution
26.8/29.2 minutes; containing-job runner wait 0.3/18.6 minutes. Complete group
runner-minutes p50/p90 were 173.0/185.3. Compare like event/outcome cohorts, with
explicit half-open windows and completeness counts, using
`scripts/merge-queue-wait-report.mjs`; retain execution, runner wait and total
runner-minutes separately. Do not manufacture runs, rerun for samples, infer
billed cost, or attribute changes in queue wait to scheduling without evidence.

Remaining bottlenecks include real media decode/database integration, lease
process scenarios, unmeasured import/startup overhead across more than a thousand
isolated files, and hosted runner wait. Multiple identified natural post-change
runs are still required to compare execution, wait and consumption. If too few
exist at merge time, that acceptance criterion remains undelivered under #3627;
release the ready slot and let the campaign's later measurement pass collect it.
