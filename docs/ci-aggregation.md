# Required CI Aggregation

`Typecheck, Test & Sidecar Bundle` is the protected required context in
`.github/workflows/ci.yml`. Its `check` job waits for `checks`, all five `browser`
shards, and the `win32` reusable workflow. It succeeds only when all three
dependency results are `success`; failure, cancellation, unexpected skipping,
and unknown results produce a failing shell exit with a named diagnostic.

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
This preserves the prior merge-group and main-push failure-reporting behavior
instead of extending the PR cancellation change to those events.

Draft PRs remain excluded. `ready_for_review` still runs even with a stale draft
payload, and delayed draft events retain their separate concurrency lane.
Workflow name, PR number or ref, and draft/active lane still define concurrency,
so unrelated PRs, main pushes, and distinct merge-group refs remain independent.
Merge-group runs retain the same cancellation admission, dependency checks and required name.
The separate obsolete-merge-group monitor and CI permissions are unchanged.

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
node --import tsx --test scripts/workflow-pr-event-contract.test.mjs scripts/workflow-ci-aggregation.test.mjs
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
