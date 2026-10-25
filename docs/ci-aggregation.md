# Required CI Aggregation

`Typecheck, Test & Sidecar Bundle` is the protected required context in
`.github/workflows/ci.yml`. Its `check` job waits for `checks`, `browser`, the
`win32` reusable workflow, `webkit`, and the optional PR `suite_plan`. The four
work results must be `success`. With the routing variable absent or ordinarily off,
the plan must be `skipped` with no output; an activated PR requires a successful
plan with an explicit `full` or `fast` output. Failure, cancellation, missing or
unknown output and unexpected skipping produce a failing shell exit with a named
diagnostic. [The exact proposed assurance contract](ci-pr-assurance.md) requires
separate human activation approval; merging its machinery activates nothing.
GitHub's case-insensitive expression matching admits a plan for case variants of
`enabled`, but exact raw shell checks force those variants to full and reject a
fast aggregate. The absent/ordinary off state still adds no executed jobs.

Full coverage remains five browser shards on every event while routing is off,
and always on merge groups, main, manual dispatch and reusable rolling validation.
Only an activated, trusted allowlisted prose fast PR uses one critical Chromium
job and the fast Node group. All other coverage stays mandatory. Checks/browser
wait for optional routing and use `!cancelled()` plus the same draft guard so an
expected disabled plan skip cannot skip full work. WebKit/Windows stay independent.

For PR runs, the job condition uses `!cancelled()` with the existing draft guard.
[GitHub's expression reference](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)
defines `cancelled()` as workflow cancellation and recommends `!cancelled()` for
jobs that should run regardless of success or failure. Including this status
function also prevents an implicit `success()` check from hiding failed or
skipped dependencies. A dependency's `needs.<job>.result` is inspected separately
by the aggregator shell while the PR workflow remains active. Whole-workflow
cancellation permits the PR aggregator to be cancelled with its obsolete run.
The cancellation term is `(github.event_name != 'pull_request' || !cancelled())`:
non-PR runs retain unconditional aggregation, including after cancellation.
This preserves merge-group and reusable rolling-main failure-reporting behavior
instead of extending the PR cancellation change to those events.

Draft PRs remain excluded. `ready_for_review` still runs even with a stale draft
payload, and delayed draft events retain their separate concurrency lane.
Workflow name, PR number or ref, and draft/active lane still define concurrency,
so unrelated PRs and distinct merge-group refs remain independent. Main-push full
validation now uses the separate rolling worker's native active/pending lane; its
reusable CI call does not share ordinary CI's concurrency group.
Merge-group runs retain the same cancellation admission, dependency checks and required name.
The separate obsolete-merge-group monitor and CI permissions are unchanged.

## Same-Head Runs

GitHub can start two `pull_request` runs for one head commit, for example when a
pull request is retargeted and force-pushed within the same second (#3283). When
both shared one lane with `cancel-in-progress: true`, one was cancelled, and its
`cancelled` aggregator stayed on that head beside the other run's `success`. The
head's check rollup then read `FAILURE` and the pull request stayed blocked until
someone re-ran the cancelled run.

Pull-request lanes therefore also include the head commit, and pull-request runs
never cancel in progress (`cancel-in-progress` is `true` only for other events).
A second run of the same head waits for the first and then runs to completion, so
no cancelled required check is left on a head that is still current.

Runs of an older head are cancelled by `.github/workflows/pr-ci-supersede.yml`
instead. On `workflow_run` `requested` for a CI `pull_request` run, it queues the
default branch's `scripts/pr-ci-supersede.mjs`, never the pull request's code. That
script acts only when every open pull request from the run's head repository and
branch is ready and has that run's head commit. It re-reads that just before
cancelling, and then cancels only active CI `pull_request` runs of the same head
repository and branch on other head commits. A draft head supersedes nothing, as
draft events never displaced a ready run before. If the evidence is unavailable or
a cancel is refused, older-head CI simply runs to completion: that costs runner
time, never the current head's required check.

`requested` lets cleanup queue before the new CI run receives its first runner,
rather than waiting for `in_progress`. GitHub [does not emit `requested` on
reruns](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
so `in_progress` remains admitted for `run_attempt > 1`. First-attempt
`in_progress` invocations are skipped by the job condition, before requesting a
runner, to avoid doing the same cleanup twice. Both entry points use the same
live-head and readiness checks, including before every cancellation. A delayed
event after a force-push back to an earlier SHA cannot supersede that current SHA.

This is partial mitigation for #3420: cleanup still runs on `ubuntu-24.04` in
the contended hosted pool. Earlier queue admission provides an opportunity to act
sooner; it does not provide a runner-independent cancellation bound. That issue's
runner-independent criterion remains open pending a human infrastructure decision.
Neither fixture tests nor the trigger change prove a production latency improvement.

For before/after observation, measure first-attempt CI creation (the request-time
proxy) to the corresponding supersede job's `started_at`, as well as that job's
own `created_at` to `started_at` runner wait. The structured supersede log's
`runId` identifies its source CI run; read that run's `created_at` from the Actions
API. Exclude reruns from this request-time comparison, since their run creation
predates the rerun. Keep skipped jobs and missing source evidence separate.
Use `scripts/merge-queue-wait-report.mjs` for merge-group runner wait over the
same window (see [Merge-Queue Wait](merge-queue-wait.md)). Collect natural
post-merge traffic; do not manufacture runs or cancellations to measure this change.

## Bounds and Evidence Limits

The aggregator owns one shell step and retains a five-minute job budget, measured
after runner execution starts. When ordinary cancellation marks a running job
for cancellation, [GitHub's cancellation reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
describes interruption and a five-minute forced-termination timeout for jobs
marked for cancellation. These bounds do not promise a wall-clock deadline for
queue admission, hosted-runner availability, or concurrency-slot release.

Issue #2452 records an obsolete PR run whose aggregator remained queued while
the replacement had no jobs until manual force cancellation. Final API records
corroborate the timing, but cannot reconstruct those earlier queue states or
prove their scheduler root cause. The cancellation-resistant `always()`
condition is a supported explanation for continued running jobs, and a plausible
contributor to this queued occurrence. No deterministic reproduction of GitHub's
queued-job behavior is claimed. A necessary fixture correction in PR #2454
naturally superseded [run 37085499566](https://github.com/picoduck/wollipog/actions/runs/37085499566),
which already used `!cancelled()`. The obsolete run and its required aggregator
both concluded `cancelled`; its replacement started without manual cancellation.
That is one observed check-conclusion outcome, not proof of every queued,
same-head replacement, dependency-timeout, or cancellation interleaving.

## Safe Verification

Run the dedicated source contract and aggregation fixtures:

```sh
node --import tsx --test scripts/workflow-pr-event-contract.test.mjs scripts/workflow-ci-aggregation.test.mjs \
  scripts/workflow-ci-routing.test.mjs scripts/pr-ci-supersede.test.mjs
```

The aggregation fixtures evaluate the actual job condition using inert status
functions, with workflow cancellation independent of dependency results. They
execute the actual aggregator shell for success, failure, cancelled, skipped,
and unknown dependency results; verify named failure diagnostics; and cover
draft, ready-for-review, main, merge-group, and unrelated concurrency cases.
Reverting to `always()` or introducing an implicit-success guard fails coverage.
These tests prove expression and shell behavior under the documented model,
not GitHub's scheduler, service-side status evaluation or forge check conclusions.

Normal PR and merge-queue CI validate successful required aggregation on the
exact delivered head and integration. Observe naturally superseded runs if they
occur; do not create live cancellations solely as a test, cancel unrelated runs,
or interpret any obsolete check conclusion as a current head passing. A skipped
required check can count as successful on GitHub: verify the successful aggregator
on the exact current head and merge integration, not a stale or skipped check.
