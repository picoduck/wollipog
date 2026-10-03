# Required CI Aggregation

`Typecheck, Test & Sidecar Bundle` is the protected required context in
`.github/workflows/ci.yml`. Its `check` job waits for `checks`, all five `browser`
shards, and the `win32` reusable workflow. It succeeds only when all three
dependency results are `success`; failure, cancellation, unexpected skipping,
and unknown results produce a failing shell exit with a named diagnostic.

The job condition uses `!cancelled()` together with the existing draft guard.
[GitHub's expression reference](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)
defines `cancelled()` as workflow cancellation and recommends `!cancelled()` for
jobs that should run regardless of success or failure. Including this status
function also prevents an implicit `success()` check from hiding failed or
skipped dependencies. A dependency's `needs.<job>.result` is inspected separately
by the aggregator shell while the workflow remains active. Whole-workflow
cancellation instead permits the aggregator to be cancelled with its obsolete
run; it must not be made unconditional with `always()`.

Draft PRs remain excluded. `ready_for_review` still runs even with a stale draft
payload, and delayed draft events retain their separate concurrency lane.
Workflow name, PR number or ref, and draft/active lane still define concurrency,
so unrelated PRs, main pushes, and distinct merge-group refs remain independent.
Active merge-group runs retain the same dependency checks and required name.
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
queued-job behavior is claimed.

## Safe Verification

Run the dedicated source contract and aggregation fixtures:

```sh
node --test scripts/workflow-pr-event-contract.test.mjs scripts/workflow-ci-aggregation.test.mjs
```

The aggregation fixtures evaluate the actual job condition using inert status
functions, with workflow cancellation independent of dependency results. They
execute the actual aggregator shell for success, failure, cancelled, skipped,
and unknown dependency results; verify named failure diagnostics; and cover
draft, ready-for-review, main, merge-group, and unrelated concurrency cases.
Reverting to `always()` or introducing an implicit-success guard fails coverage.
These tests prove expression and shell behavior under the documented model,
not GitHub's scheduler or service-side status evaluation.

Normal PR and merge-queue CI validate successful required aggregation on the
exact delivered head and integration. Observe naturally superseded runs if they
occur; do not create live cancellations solely as a test, cancel unrelated runs,
or interpret an obsolete run's cancelled conclusion as a current head passing.
