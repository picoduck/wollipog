# Rolling Main Validation

Issue #3631 remains in **shadow**: the rolling controller and worker run alongside
existing main-push full CI. The controller records and dispatches a durable pending
claim while the active snapshot runs. GitHub's whole-workflow concurrency starts
the pending worker when the active run finishes. PR/merge-group full validation,
protected checks and rulesets stay intact. The lighter gate remains disabled.

Shadow adds runner work. The [observations](main-rolling-shadow-2026-10-23.md)
record verdicts, timing and completion-event limits; no causal savings are claimed.
Only a separate, evidence-gated cutover may remove legacy main-push full CI.

## Coordination and Execution

Pushes to main, manual dispatch and best-effort cron wake the short controller.
Every invocation reads live main and Actions. It persists pending intent before
dispatching a worker. An active snapshot is never cancelled. A newer dispatch
replaces only the native pending worker. The whole worker, including admission
and manual reruns, uses constant group `main-rolling-full-validation`,
`cancel-in-progress: false` and the default single-pending behavior. GitHub starts
the pending run after the active one finishes, without a controller callback or
sleeping runner. See [documented concurrency semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
Full CI uses the caller workflow's lane and cannot collide with ordinary CI.

Queue order is not dispatch order. Admission must match the current pending
target/claim and its actual run/attempt. Before CAS promotion it independently
reads prior run pointers and requires terminal attempts, predecessor identity and
main ancestry. Missing or still-active predecessor evidence cannot authorize it.
A superseded/mismatched run skips the suite, records the explicit
`Skip Superseded Rolling Claim` receipt, and attempts a short controller dispatch.
This repairs a late obsolete dispatch displacing the intended pending run. The
wake supplies no verdict. Failed delivery recovers on another delivered wake or
manual reconciliation. Admission and controller CAS conflicts retry at most three
times from fresh state. Admission never joins the controller's short pending lane.
No controller path invokes an active-run cancellation API.

Unsafe predecessor evidence is different from supersession: admission fails with
`predecessor-evidence-operator-required`, so its default-success receipt/wake steps
do not run. This prevents a persistent fence failure causing a dispatch/reject/wake
loop. Reconciliation discards missing or contradicted pointer hints using Actions.
For an active-at-main shortcut it also requires a current admission acknowledgement
or actual suite execution, never just an in-progress run or a ref's active label.
An unadmitted draining run can therefore have a native successor already queued.

**Main Rolling Relay** remains an opportunistic legacy main-push CI completion wake.
It demonstrated relay-to-controller dispatch, not worker-completion delivery, and
is **not load-bearing** for native pending progress. The controller's own worker
completion subscription is also unreliable. The earlier health-subscriber inference
was corrected: that event followed cancelled legacy CI, rather than establishing
worker completion. See the [live correction](main-rolling-shadow-2026-10-23.md#post-relay-live-result).
GitHub's [generated-event restriction](https://docs.github.com/en/actions/concepts/security/github_token)
and a [primary dispatched-run reproduction](https://github.com/orgs/community/discussions/48748)
are consistent with the observation; the internal service cause remains an inference.

A fully missed idle push has no pending worker. It recovers on the next delivered
push, legacy completion, best-effort scheduled event or manual controller dispatch.
The ten-minute cron has delivered sparsely and provides no fixed latency bound.
Runner capacity, event delivery and API availability remain external dependencies.
No new secret, App, PAT, setting or external hosting is required.

The worker first runs trusted main workflow-revision code with scoped write access,
checks its exact run/attempt/claim, and checks the target is an ancestor of current
main using the compare API. Only admitted work calls the existing complete CI with
`contents: read`. The Node/engine/bundle jobs, five Chromium shards (including rendered
production smoke), WebKit and Windows baseline jobs are shared unchanged. Every
checkout job asserts its actual `git rev-parse HEAD` equals the admitted target.
Dispatches always use main workflow definitions; arbitrary PR code never sees a
controller token. None of the rolling workflows interpolates event values into shell source.
Before adopting any worker or accepting a record, the observer independently proves
**both** its workflow revision and target are ancestors of the pinned live-main SHA.
`head_branch: main` alone cannot establish this: a tag can have the same name.

## Durable State and Recovery

The dedicated `refs/heads/ci/main-rolling-state` branch contains only `state.json`.
The controller declares per-job `contents: write` and `actions: write`; admission
needs `contents: write` for promotion and `actions: write` for its rejected-claim wake.
No PAT, App, secret, persistent permission
grant or repository setting is required. Repository token policy can still refuse
these operations; a refusal is an operator blocker, never a reason to add credentials.

The ref is **unprotected and untrusted**. Schema validation and removal of unknown
fields prevent it supplying shell code, log content or certification. Active run and
completed-verdict hints are re-read through Actions, including after ref loss,
corruption or rewriting. Recent completed workers reconstruct missing hints. If
older evidence has expired or cannot be recovered, revalidation is conservative.
The controller never treats a state summary, dispatcher SHA, uploaded artifact, or
its own successful job as a passing regression result.

Each write creates a commit containing a bounded snapshot and uses GraphQL
`updateRefs` with the exact `beforeOid`. Stale writers fail closed. Every 128th write
starts a root generation using the same exact-old-OID fence; recovery from malformed
state also starts a root. Thus at most 128 state commits remain reachable from this
ref, with at most 32 run/attempt pointers in a snapshot. GitHub determines when
unreachable Git objects are collected; compaction is not a promise of byte deletion.
State commits trigger no CI/controller push (main only). Completion subscribers
`pr-ci-supersede` and `merge-group-cleanup` filter their PR/merge-group source events;
`main-ci-health`, `main-rolling-controller` and `main-rolling-relay` additionally
require the worker/CI head branch to be main. State-branch activity runs no workflow.
See [GitHub's atomic ref-update contract](https://docs.github.com/en/graphql/reference/git#updaterefs).

The version-2 snapshot retains an active claim and separate pending claim. Each
records target SHA, UUID, claim time, run-ID hint, dispatch count and last dispatch
time; pending also records observation time and `priorRunId`. Admission consumes
pending in a fenced promotion after checking predecessor terminal evidence. The
ref remains untrusted coordination, never certification. Version-1 observed active
claims are retained; unacknowledged legacy intent becomes pending; bare old pending
target hints are replaced from live main. Missing/corrupt/unsupported state recovers
from independently verified active and queued Actions runs. Historical admission
code cannot interpret version 2; do not rerun old code as a state repair.

Intent is committed before dispatch. Unknown responses never retry in-place. Later
reconciliation scans all active statuses, adopts matching native queued runs and
retries an unseen claim only after ten minutes, at most three dispatch attempts.
Exhaustion reports `dispatch-unknown-operator-required`; newer main can replace
pending intent. Delayed duplicates must consume the still-current claim, and a
first-attempt duplicate of a verified completed target skips the suite. Incomplete
validation attempts retain bounded recovery. Superseded non-verdicts consume no
incomplete-attempt allowance and never replace a decisive success/failure pointer.

A completed, first-attempt cancelled worker with no started jobs or steps is
**superseded**. So is a completed worker with the explicit skipped-claim receipt
and no executed full-validation jobs. These are non-verdicts: no checkout proof,
certificate or validation-lag value. Cancellation after work began, missing receipt,
partial test execution and any rerun remain incomplete; reruns still withdraw an
earlier certificate. The pure shared `isSupersededWorkerAttempt(run, jobs)` helper
requires a **complete** Actions attempt job listing. Reports retain superseded run
identities and measured execution overhead separately from decisive verdict counts.
Health must exclude these non-verdicts from latest-verdict/certificate withdrawal
and incident mutation, but retain their run numbers in complete history scans.
The separate #3654 consumer integration must land before pending behavior activates;
missing support blocks release. Health code is outside this repair's ownership.

An active run older than two hours reports `stalled-active-run`. The controller
**never cancels it**, expires its execution lease or overlaps it with another full
run. An operator must investigate a hung/queued run; admission resumes only after
Actions reports it terminal. Controller restarts need no process memory. A missing
or failed API response, truncated active listing (>1,000 per state), or >10 attempts
on one run fails reconciliation and emits a sanitized status. The next delivered
wake tries again; cron delivery is not guaranteed. Operators can dispatch trusted
reconciliation without creating a duplicate full worker:

```sh
gh workflow run main-rolling-controller.yml --ref main --repo picoduck/wollipog
```

Inspect the resulting controller summary, state-ref write and worker identity.
A successful dispatch response alone does not prove the controller ran. Operators
can also rerun the controller from Actions;
manual worker reruns retain whole-workflow serialization. Do not edit state to
manufacture a verdict.
An operator's rerun waiting in the native pending slot is also replaceable by a
newer controller dispatch. A cancelled rerun remains incomplete and withdraws its
earlier certificate; it is never a superseded first-attempt non-verdict. Prefer
manual controller reconciliation to request fresh current-main validation. Copied
successful admission output in a failed-job rerun does not bypass native execution
serialization; it can still validate an older target and supplies no current-main
certificate unless the exact latest-attempt evidence satisfies the health contract.
For a rerun, the stall clock starts at the latest attempt's `run_started_at`, rather
than the original run's creation time.

## Identity Contract for Consumers

`scripts/main-rolling-validation.mjs report` performs read-only reconciliation of
Actions evidence and emits JSON. Run it with `GITHUB_REPOSITORY`, `GITHUB_TOKEN` and
`GITHUB_REF=refs/heads/main` in a trusted environment. The controller's step summary
also includes the records observed during that invocation. No issue or alert is
opened by this script. The exact-SHA health consumer is documented in
[Main CI Health](main-ci-health.md); health changes are separate from this wake repair.

Each `main-rolling-validation-v1` record contains:

- `repository`, `targetSha`/`testedSha`, `claimId`, `runId` and `attempt`.
- `dispatcherSha` and `workflowRevision.sourceSha`, identifying the workflow execution
  revision separately from the checkout; `executedBlobSha` identifies the worker file.
- `workflowBlobs` for worker, full CI and Windows definitions, their SHA-256 `suiteVersion`,
  and `suiteRevision` for target test source. Local reusable workflows execute from the
  caller's revision. Consumers must retain both revisions.
- Exact `requiredOutcomes`, per-job/per-step Actions evidence and `checkoutVerified`.
  A green verdict requires every expected job exactly once, every checkout assertion
  successful, and the worker run successful. Executed cancelled/skipped/missing/unverified
  outcomes are incomplete; proven superseded first attempts are non-verdicts. A controller success certifies nothing.
- `mainSnapshotSha`, `workflowAncestryVerified` and `targetAncestryVerified` describe
  the observer's independent ancestry checks against its pinned live main snapshot.
- Every retained run attempt, including earlier attempts of a rerun. Measurement reuses
  #3626's `attemptRecord` and `listJobs`. `metrics.consumedRunnerMinutes` remains null
  for reruns with copied job timing, rather than inventing billable duration.
  Metrics remove the reusable caller prefix before collection and retain original
  API job names alongside `measurementName`; extra admission dependencies may still
  leave a critical-path split unmeasured. Failure artifacts prefer the tested target
  over the dispatcher SHA.
- `dispatchToVerdictMinutes` and `commitToVerdictMinutes`. The latter is explicitly a
  committer-timestamp proxy for validation lag, not measured push arrival time. Missing
  timing remains null. API records and GitHub retention bound historical recovery.

The read-only report reconstructs the eight most recent completed workers, their
attempts, the last durable decisive-verdict pointer and any prior active pointer.
All nonterminal statuses are scanned separately, so a burst of newer completed
runs cannot hide an active worker. Consumers must not interpret this bounded report
as a complete historical census. Export observed records for a chosen measurement
window before Actions evidence expires.
Ordinary controller reconciliation reads at most three recent completed workers
for current main and one latest completion for each outstanding active/pending claim,
including work completed before admission stored its run ID. Its active/pending and
predecessor pointers, plus a matching last-verdict pointer, are read independently.
Immutable workflow blobs/target commits and ancestry comparisons are shared
within the invocation. A fixture with unrelated completed history bounds quiet
reconciliation to 22 API calls (including state and live-main reads), rather than
re-reading eight full records on every tick. Six scheduled ticks therefore model
at most 132 calls/hour in that fixture, plus pushes, completions, admission and
recovery. This is an API-call estimate, not observed token rate-limit usage; confirm
the controller token's live rate budget during shadow because existing CI monitors
share repository limits. Transient quota refusal fails closed and waits for recovery.

## Shadow Verification and Cutover Gate

The native pending repair ships in shadow with legacy main-push CI retained and
the health non-verdict consumer integrated. Before cutover, record **two consecutive
natural cycles** where a dispatched pending worker starts automatically after its
active predecessor completes, without requiring legacy CI, cron or a controller
callback to start it. Cite active/pending worker IDs and exact claims, queue status,
terminal/start times, admission evidence and tested SHAs. A post-legacy-CI controller
wake does not satisfy the gate. Natural traffic must supply pending work; do not
manufacture merges, cancel active validation or dispatch redundant suites for proof.
Failure of native progression or health classification blocks cutover.
Then prepare the separate cutover as a draft, run focused tests and cross-model review,
and leave it idle while the parent observes natural traffic. Before asking for
cutover ready admission, record links and exact identities demonstrating:

1. A complete green or red worker verdict with all expected checkout/job outcomes.
   Compare its complete job set with ordinary main CI at the same target where available.
2. Main advances while that worker remains active; at most one pending target survives;
   after completion the latest main snapshot runs. Do not manufacture unrelated merges
   or cancel production validation to obtain this observation.
3. Duplicate/reordered/missed wakes, native replacement, lost-state recovery,
   predecessor fences, supersession and unknown dispatch are covered by the focused
   fake-API tests; inspect actual controller summaries for normal-traffic recovery.
   A fixture is not proof of GitHub scheduling, token permissions or live run names.
4. Export full record JSON, completed verdict counts, sum of known runner-minutes,
   missing timing counts, dispatch-to-verdict and commit-to-verdict lag for the same
   bounded before/after traffic window. Reuse `scripts/merge-queue-wait-report.mjs`
   for ordinary push/PR/merge-group baseline cohorts. Keep shadow overhead separate.
5. Verify the rollback below in the proposed cutover diff and its source-contract tests.
   Have the exact head independently reviewed, pass required CI and merge-group CI,
   and obtain the campaign's exact merge approval before enqueueing.

The campaign's readiness threshold is either:

- Five completed rolling verdicts on natural main traffic, including at least one
  observation of main advancing during an active worker and subsequent newest-target
  progress; or
- At least 24 hours after the stage-one merge (2026-10-24 15:15:07 UTC), with at least
  three completed rolling verdicts. Report candidly whether coalescing was observed
  when using this alternative.

Use whichever threshold is met first. Count complete verified success/failure
verdicts, not cancelled/incomplete runs, controller successes or repeated records
for the same run attempt. Compare completed versus cancelled/incomplete legacy
main-push results, runner-minutes and validation lag over exactly the same window.
Keep missing timings and shadow overhead visible. The threshold does not waive
operator blockers, evidence of broken automatic progress, review or merge gates.
Do not spend model turns polling the window: report the reviewed draft and let the
parent prompt the implementer when enough natural evidence exists.

Only the later cutover PR may remove the main-push full fan-out. Preserve every PR
and merge-group check and keep the lighter gate disabled. Keep health logic separate;
see [Main CI Health](main-ci-health.md) for its exact-SHA contract. A green dispatcher
SHA, stale snapshot or absent alert does not establish current-target health.

## Shadow Rollback and Later Cutover

During shadow, the existing main-push full suite remains the safety path. An operator
can disable **Main Rolling Relay** and **Main Rolling Controller** through Actions if
needed. Disabling only the relay leaves push, manual and best-effort scheduled
controller wakes enabled. Let active workers finish; no active-cancellation automation
is part of rollback. Keep the untrusted state ref for diagnosis. Do not execute an
operational disable merely to test these instructions.

The later cutover PR must include a focused, reviewed restoration of `ci.yml`'s
main-push trigger that preserves concurrent PR/merge-group/job changes. Verify its
rollback locally before activation, then use ordinary required CI, merge-group CI
and exact typed merge approval. If operational rollback is needed after cutover,
restore legacy push CI first, verify a successful full run at the resulting exact
main SHA, and only then disable rolling dispatch while allowing active work to finish.
No workflow files should be removed while workers are active. Local tests do not
prove GitHub event delivery: retain actual restoration-run evidence if rollback is used.
