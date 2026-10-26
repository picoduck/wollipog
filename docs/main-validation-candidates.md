# Exact Main Candidate Validation

An intermediate merged snapshot can request the same full regression worker used for rolling
main validation. Requests select an exact 40-character SHA in current main ancestry. A PR head,
merge-group commit or arbitrary branch cannot use this interface. No request grants release,
promotion, merge, ruleset or deployment authority.

## Request and Observe

The trusted `Main Rolling Controller` workflow accepts `candidate_sha` and `purpose` (`release`
or `repair`, default `release`) on `workflow_dispatch`, on the `main` branch. Leaving
`candidate_sha` empty performs ordinary reconciliation. An authorized operator can request:

```sh
gh workflow run main-rolling-controller.yml --ref main --repo OWNER/REPOSITORY \
  -f candidate_sha=FULL_MERGED_SHA -f purpose=release
```

The controller records intent before attempting worker dispatch. Its structured log and summary
contain a request receipt. Subsequent controller summaries show the retained request status;
`node scripts/main-rolling-validation.mjs report` also reports scheduler state and current
worker evidence using the existing trusted-main environment. The state ref and receipts are
scheduling hints, never regression certificates. Release and repair consumers must independently
reconcile current forge evidence for the exact SHA, suite and latest attempt.

Request recording uses a separate CAS-fenced job without the controller's replaceable pending
lane. Ordinary reconciliation may run before recording finishes; the next controller wake then
considers the retained intent. A failed request job requires inspecting its result and retrying
the idempotent request. An accepted workflow dispatch alone does not prove intent was recorded.

The reusable JavaScript interfaces are:

```js
// scripts/main-rolling-validation.mjs
await requestCandidate(repository, targetSha, { purpose = "release", api, now });
await candidateSuiteVersion(api, repository, sourceSha);
await readState(api, repository);

// scripts/main-validation-candidates.mjs
candidateReceipt(ledger, targetSha, purpose, suiteVersion, observedAt);
```

`api(path, {method, body}?)` is the existing asynchronous GitHub adapter; `now()` returns an ISO
timestamp and defaults to the current time. `sourceSha` is an immutable trusted workflow revision.
The suite digest uses the worker, reusable CI and win32 workflow blobs in that fixed order, matching
the authoritative health evidence. Obtain the retained ledger from `readState(...).value.candidates`.

The receipt schema is `main-validation-candidate-v1`, with `purpose`, `scheduledPurpose`,
`targetSha`, `suiteVersion`, `claimId`, `requestedAt`, `observedAt`, `dispatchedAt`, `runId`,
`status`, `statusObservedAt`, `queueWaitMinutes`, `waitMinutes`, `executionMinutes` and `certification: "none"`.
The requested purpose stays visible even when another purpose already owns the shared allocation.
`queueWaitMinutes` measures request-to-dispatch (or elapsed request wait). The worker wait and
execution values use the existing critical-path timing projection; unavailable data stays null.
Terminal statuses are historical receipts, not continually refreshed verdicts; `statusObservedAt`
identifies the latest live-run/record observation. Consumers must read current forge evidence
before relying on success, including after an operator reruns a previously completed worker.

## Bounds and Recovery

`CANDIDATE_POLICY` in `scripts/main-validation-candidates.mjs` is the single exported policy object.
Both purposes initially have equal priority and a 60-minute admission interval. A global
60-minute cooldown also applies. Conservatively, recent ordinary full-worker activity consumes that
cooldown too, including after coordination state recovery. Candidate work starts only when main
has a complete verdict and there is no active worker. A new main backlog takes priority over an
unadmitted candidate; an admitted full run finishes without cancellation. Continuous main work
can delay candidates indefinitely; no extra full-worker capacity is purchased or provisioned.

Admission rechecks current main and its complete verdict before promoting a candidate. A new
backlog observed after scheduling takes priority. Optional candidate reads have a 48-call budget
per reconciliation and honor the health collector's API reserve floor. Each wake reads the bounded
recent window and at most one queued/live candidate's retained run pointer. Terminal candidate
inventories are not repeatedly fetched. Growth past 1,000 completed workers does not disable
admission or require enumerating all repository history.

The existing native concurrency group permits one executing full worker and one replaceable
pending worker. At most 16 exact target/suite allocations are retained without automatic eviction.
Concurrent and cross-purpose duplicates share one allocation. An existing exact-suite verdict
is reused as an observation; a failed or incomplete validation is not automatically rerun.
Candidate dispatch is attempted once, after the CAS-fenced intent and cooldown have been stored.
An ambiguous dispatch consumes its allocation, and does not enter an automatic retry loop.
The existing worker admission rejects duplicate claims and full candidate reruns through admission.
Operator-triggered rerun-failed-jobs can reuse GitHub outputs and remains an explicit operator
action outside automatic candidate retry; it still invalidates older certification.

Failed, interrupted, ambiguous and incompatible-suite requests require operator reconciliation.
Do not clear the state to bypass limits. Preserve and inspect the exact run/attempt and request
history. A changed suite requires a new allocation for that exact suite; it cannot reuse the old
suite's success. A pending rerun withdraws the earlier success. Missing state, capacity or required
run evidence fails closed for candidate admission. Optional candidate-history failures do not
stop the main scheduler from queuing its next snapshot.

This primitive changes no full-suite job, health contract, signing permission or finalizer pool.
It is code-only; no candidate run or release is dispatched by its tests. Release-gate integration
is a separate slice of #3635.
