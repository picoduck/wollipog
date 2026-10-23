# Rolling Main Validation

Issue #3631 ships in shadow before a separately gated cutover. **Main Rolling
Controller** and **Main Rolling Validation** currently run alongside the existing
main-push full CI. **Main Rolling Relay** adds an independent completion wake;
it does not activate cutover. PR suites, merge-group suites, protected checks and
rulesets retain full validation. The lighter merge gate remains disabled.

Both main paths consume runner time during shadow. No savings are claimed from
shadow. The [shadow observations](main-rolling-shadow-2026-10-23.md) record measured
results and gaps in automatic completion delivery. The relay must be verified on
live completions after merge before a later cutover can be admitted.

## Coordination and Execution

Pushes to main and manual reconciliation wake a short controller. A separate
**Main Rolling Relay** subscribes to completed **Main Rolling Validation** and
**CI** workflows. It accepts only same-repository main worker dispatches or main-push
CI completions, checked by workflow path, source event and repository identity.
Its only step dispatches the controller on main with a job-scoped `actions: write`
token. It checks out no code, consumes no artifacts, supplies no target and mutates
no state. Every controller invocation reads live main and the Actions API; event
order and relay conclusions never determine certification or the next target.
Health monitoring remains independent of the relay.

The controller's own worker-completion subscription did not deliver run entries
for the first two completed workers, while an independent health subscriber did
receive the second. Its job predicate cannot explain a missing workflow-run entry.
Self-origin/chain suppression is a hypothesis, not a proven GitHub backend cause;
the independent relay needs live verification, not just a passing YAML contract.
See the [observed run links](main-rolling-shadow-2026-10-23.md#completion-wake-gap-and-next-natural-push).

Main can advance during a full run. The controller records one replaceable pending
target in durable state and **does not dispatch another worker while one is active**.
After completion, the next delivered reconciliation chooses current main, dropping
intermediate targets. The worker's constant concurrency group disables cancellation
and serializes its entire run, including manual reruns reusing admission outputs.
GitHub's one pending concurrency slot fences duplicate/delayed dispatches; it is
normally empty and does not itself guarantee another target will start.
Full CI's called concurrency lane uses the worker's workflow name, so it cannot
collide with normal CI. The controller has a separate short job lock. Pending
controller/relay wakes may coalesce; each surviving reconciliation reads live main.
Admission never joins that pending lane. Atomic state updates fence both writers;
admission re-reads and retries up to three times when the state OID changes.

Recovery is **event-driven**, not wall-clock bounded. GitHub's configured ten-minute
cron is best-effort: only one scheduled controller run appeared in the first five
hours. A fully missed idle push recovers on the next delivered push, completion,
scheduled event, or an operator's manual dispatch. There is no fixed latency guarantee
if none arrives, or if GitHub Actions is unavailable. No runner sleeps awaiting work.
See [GitHub's scheduled-event delivery limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

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
needs `contents: write` and `actions: read`. No PAT, App, secret, persistent permission
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
State commits trigger no CI push (main only); the three existing completion monitors
filter CI and their own PR/main-push/merge-group event types. This branch executes no
workflow. See [GitHub's atomic ref-update contract](https://docs.github.com/en/graphql/reference/git#updaterefs).

Intent is committed before dispatch. An unknown response causes no immediate retry:
the next reconciliation lists all active worker states before considering a retry
after ten minutes, using the same claim. Three dispatch attempts exhaust automatic
recovery and report `dispatch-unknown-operator-required`. Duplicate or delayed workers
are serialized and must match the current claim before full fan-out. First-attempt
admission also rejects a target that already has a verified completed verdict, so a
late duplicate cannot repeat the suite. Completed,
incomplete attempts retry at most three times per target, then report
`recovery-limit-operator-required`; a newer main snapshot can make progress. A full
red verdict is completed work and does not automatically retry forever.

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
  successful, and the worker run successful. Cancelled/skipped/missing/unverified
  outcomes are incomplete. A controller success certifies nothing.
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
for current main and three for its outstanding claim (including a worker that
finished before admission stored its run ID), plus its previous active pointer and a matching last-verdict
pointer. Immutable workflow blobs/target commits and ancestry comparisons are shared
within the invocation. A fixture with unrelated completed history bounds quiet
reconciliation to 22 API calls (including state and live-main reads), rather than
re-reading eight full records on every tick. Six scheduled ticks therefore model
at most 132 calls/hour in that fixture, plus pushes, completions, admission and
recovery. This is an API-call estimate, not observed token rate-limit usage; confirm
the controller token's live rate budget during shadow because existing CI monitors
share repository limits. Transient quota refusal fails closed and waits for recovery.

## Shadow Verification and Cutover Gate

The wake repair ships in shadow with legacy main-push CI retained. Verify a live
relay completion dispatches the controller and reconciliation advances the pending
target before preparing a separate cutover. If the independent relay also fails to
receive completions, report the blocker; do not claim automatic progress is fixed.
Then prepare the separate cutover as a draft, run focused tests and cross-model review,
and leave it idle while the parent observes natural traffic. Before asking for
cutover ready admission, record links and exact identities demonstrating:

1. A complete green or red worker verdict with all expected checkout/job outcomes.
   Compare its complete job set with ordinary main CI at the same target where available.
2. Main advances while that worker remains active; at most one pending target survives;
   after completion the latest main snapshot runs. Do not manufacture unrelated merges
   or cancel production validation to obtain this observation.
3. Duplicate/reordered/missed wakes and unknown dispatch are covered by the focused
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
