# Main CI Health

The merge queue tests every entry on top of `main`, so a red `main` fails every queued pull
request, whatever it changes. Normally nothing reaches `main` without passing the queue. The one
exception is the `main: merge queue` ruleset's bypass: organization admins can merge without the
queue, and a security advisory's temporary private fork always merges that way. GitHub runs no CI
in those forks and enforces no branch protection when their changes merge
([GitHub Docs](https://docs.github.com/en/code-security/tutorials/fix-reported-vulnerabilities/collaborate-in-a-fork)).
This page covers how to land such a change safely, and how a red `main` gets noticed (#3284).

## The Main CI Is Failing Alert

Main's full regression path is **Main Rolling Validation**; `ci.yml` retains full PR/merge-group,
manual and reusable validation, with its legacy main-push fan-out retired. See the
[cutover evidence and rollback](main-rolling-validation.md#rollback).
`Main CI Health` (`.github/workflows/main-ci-health.yml`) subscribes to main CI and rolling-worker
completions, a best-effort recovery schedule, and manual dispatch on main. Delivered legacy main-CI
completions have woken health; dispatched-worker completion delivery has not been established.
After cutover, an idle health observation can therefore depend on best-effort schedule or manual
dispatch. Native pending worker progress is independent of those health wakes. No fixed event or
cron delivery bound is promised. Push and in-progress wakes are omitted. Skipped workflow-run
jobs consume no observer API calls. It checks out trusted default-branch code without persisted credentials and runs
`scripts/main-ci-health.mjs`; it never executes the triggering run's code or artifacts. The
issue-writing job serializes reconciliations. Skipped PR invocations cannot displace main work.
Repository-level permissions remain read-only; only this trusted job has contents write (for
the health ref), Actions read, and issues write. No new secret, App, PAT or repository setting is
needed. Neither health-state nor rolling-state pushes match a main-only push trigger.

The event is only a wakeup. Live forge evidence decides the tested target, attempt and verdict.
Rolling check runs attach to the dispatch-time SHA, which may differ from the tested SHA. The
observer uses the worker's target/claim run-name identity and successful exact-checkout assertions
in all nine checkout jobs, independently verifies workflow-source and target ancestry against
pinned live main, and retains the executed worker, CI and Windows workflow blob identities. It
checks the workflow-to-checkout input bindings and the complete expected job and test-step
inventory, including all five browser shards, rendered production smoke, WebKit, engine boundaries
and bundles. A successful aggregator alone certifies nothing. Then:

- **Red, no alert open:** it opens one issue titled **Main CI Is Failing**, labelled `main-ci-red`
  (created on first use). The issue names the commit, the run and its failing jobs, and mentions
  the head commit's author when that is a user. Creating the issue notifies that author and
  everyone watching the repository.
- **Red, alert open, a run not yet reported:** it comments with the new run and records it in the
  issue's hidden `latest` marker, so the same run is never reported twice.
- **Verified full passing descendant, alert open:** only when that pass supersedes every unresolved
  failure, it comments and closes the issue. Fast/legacy success, partial, cancelled, skipped,
  synthetic-artifact dispatch, unrelated workflow and missing evidence cannot close a full incident.

Only an open issue with that title and label, written by `github-actions[bot]`, counts as the alert.
API failures leave an incident open. The JSON health becomes unknown; failed writes leave the
previous ref intact. Logs never include API response bodies or tokens. Existing `latest` issue
markers migrate in place; exact run/attempt markers prevent repeated failure comments on schedule
wakes. The existing alert's run pointer is reverified even when older than the rolling era.

## Exact Snapshot Record and Consumers

The dedicated `refs/heads/ci/main-health-state` ref holds one `health.json`, schema
`main-ci-health-v1`. It is a queryable observation and recovery index, **not a trust anchor**:
any repository writer can modify it. Readers must call the read-only report to reverify evidence
before an admission or release decision:

```sh
# Trusted environment; Actions/content/issues read access. Prints one JSON document.
GITHUB_REF=refs/heads/main node scripts/main-ci-health.mjs report
```

Supply `GITHUB_REPOSITORY` and `GITHUB_TOKEN` through the environment. `report` mutates no ref,
issue, check or run; an unknown result prints JSON and exits 1. Reconciliation also writes the
JSON to `MAIN_CI_HEALTH_OUTPUT`, retains a workflow artifact for 30 days, and writes a step summary.
Artifacts are historical observations, never replacements for live forge revalidation. The
lighter merge gate remains disabled; this issue changes no required check, ruleset or queue policy.

| Field | Meaning |
| --- | --- |
| `currentMainSha`, `observedAt` | Pinned current main and observation time; main is rechecked before returning. |
| `latestAttempt` | Newest tested target by ancestry, then run ID/attempt for that same target. |
| `latestPassingSnapshot` | Most recent still-valid exact full passing snapshot; it may lag main. |
| `fullCertification` | Full certificate for current main only, otherwise null; always inspect overall status too. |
| `unresolvedFailures` | Full-worker failures and retained legacy incidents not covered by a verified full descendant. |
| `evidence` | Rolling records: repository, tested SHA, claim, run/attempt/URL, workflow path/revision/blobs, suite version/revision, checkout/ancestry evidence, exact job/step inventory, result and times. |
| `legacyEvidence` | Explicit `legacy-main-push` evidence, always `certification: none`; a legacy/fast success cannot certify or resolve rolling health. |
| `backlog` | Commit and merged-PR counts, Git merge-commit count, oldest unvalidated landing time/age and its forge evidence; null means unknown. |
| `status`, `reasons` | `passing`, `failing`, `pending`, `stale` or `unknown`, with allowlisted content-safe diagnostics. |

`passing` requires current-main full certification. `pending` means verified passing ancestry
exists with newer unvalidated main commits. `stale` means the oldest unvalidated change exceeds
the two-hour investigation budget. A full failure remains failing through a pending rerun;
unknown evidence or a stalled validator remains explicit rather than silently reusing green.
The budget is an investigation threshold, not a guarantee about GitHub scheduling or runner time.

The freshness clock is the oldest unvalidated commit's **verified landing time**, not its
committer time or the age of the last green run. A merge-group commit can be created before it
lands: production commit `784d96e50d4d7bf5ee641d476aa57ccf886fd32b` has committer time
19:20:07Z on 2026-10-23 but PR #3647 merged at 20:01:22Z. Using commit time would incorrectly
include 41 minutes of queue residence in its unvalidated age.

For each backlog commit, the existing bounded associated-PR lookup must match the exact merge
commit SHA, main base and repository. Its forge `merged_at` establishes landing. If no qualifying
PR exists, a bounded lookup of Main Rolling Controller runs for that exact SHA requires the
trusted workflow path, push event, main branch, repository identities and a valid forge
`created_at`. This fallback is a post-landing observation and can understate age by the delay
between landing and run creation; it survives the #3631 main-push full-CI cutover. No commit clock
is used as a fallback. Missing, future, malformed or incomplete evidence yields unknown.
`backlog.clock` is `forge-landing-time`; `backlog.landingEvidence` records each commit's timestamp,
source and PR/run URL. PR-based timing adds no requests to the existing merge-count lookup;
direct-push fallback adds at most one bounded controller listing per commit within the same
quota-sized invocation cap (at most 96 requests). Once caught up, idle main has zero backlog and zero unvalidated age
even after weeks without a run. `merges` counts associated PRs actually merged into main at each
backlog commit, including squash merges; `mergeCommits` separately counts commits with multiple
parents.

## Reruns, Ordering and Recovery

A verified unexecuted superseded worker is retained in `evidence` with `result: "non-verdict"`,
`nonVerdictReason: "superseded-worker-attempt"` and `certification: "none"`. The canonical
`isSupersededWorkerAttempt` helper runs only after worker identity, source/target ancestry,
workflow bindings and a complete exact-attempt job listing are verified. It recognizes only
first-attempt completed cancellations with no started jobs/steps, or the explicit successful
**Skip Superseded Rolling Claim** receipt with no executed/unknown full-suite job.
These records remain in the complete run-number census and final live revalidation. They cannot
be `latestAttempt`, replace `newestForTarget`, withdraw a certificate, or supply incident
resolution. A prior real incident stays open until a verified compatible full pass resolves it.
This is separate from `supersededRunIds`, which describes covered/resolved history. Started,
unknown, incomplete and rerun attempts retain the conservative withdrawal behavior below.
Once a run has been rerun, every retained attempt uses that conservative classification.

A run's latest authoritative attempt replaces its earlier green verdict. Requested/in-progress
reruns and a new worker at the same target withdraw that target's certificate; terminal incomplete
attempts leave it unknown. Earlier failing attempts remain unresolved until a complete full pass
on that target with later run/attempt identity, or a full passing descendant, supersedes them.
Delayed completion timestamps never outrank target ancestry. A passing ancestor cannot close a
newer failure. The `rolling-full-v1` coverage contract requires the same complete inventory even
when workflow blob versions change; actual workflow hashes remain recorded as `suiteVersion`.
Unexpected inventory changes need an explicit observer contract update and remain uncertified.

The health ref supplies only bounded run-ID hints. Every invocation rebuilds verdicts from
Actions and compare APIs, rechecking current attempts after reading jobs. It never reads
`ci/main-rolling-state` as health evidence. Both reconciliation and the read-only report recover
the current incident pointer directly from the issue, even after health-ref loss. A missing
incident pointer remains unknown; a deleted cache-only hint is discarded once fresh evidence is
available. Non-main dispatches cannot poison the repository's health. An incident whose identity
marker was removed stays open with `incident-identity-unavailable`; restore the verified run ID
before expecting automatic closure.

A freshly verified full pass establishes an **ancestry window**, not a timestamp cutoff. The
observer enumerates every main commit from that passing target through pinned current main, then
queries complete worker/legacy run listings by each exact dispatcher SHA. Eligible workers prove
the tested target is an ancestor of the dispatcher revision, as well as both being ancestors of
main. Therefore any newer tested target must have a dispatcher inside this window. A dispatch to
an old target, a delayed push record, or a completion created before an older-target pass cannot
hide a newer target's failure. The stored checkpoint is a hint; its complete worker certificate
is reverified, and a conflicting later attempt invalidates the checkpoint. No push-run timestamp
or event arrival time establishes absence of failures.
If the complete census discovers that a newer run at the same target invalidates the sampled
checkpoint, the observer retries once with checkpoint selection disabled and the rejected hint
removed. Recovery has its own twelve-request cap inside the invocation cap. Incomplete recovery
returns unknown with `recovery.reason: checkpoint-invalidated`, no active certificate and no alert
mutation. A persisted recovery drops the rejected hint even when unknown. Full-history bounds
still apply; a stopped invocation cannot write and leaves the previous ref intact. A later full
pass or reviewed reconciliation repair may be needed after a long red streak.

Bootstrap examines at most eight recent completions for a positive checkpoint, stopping at a
verified pass. That sample never proves absence: the subsequent window is enumerated completely,
and all active workers are scanned independently before checkpoint selection. Without a positive
checkpoint, complete bounded rolling history is scanned and the worker workflow's forge creation
time is the legacy transition horizon. Existing incident
pointers are included regardless of age. Missing worker run-number sequences inside the window
expose deleted/expired history and remain unknown. Main-push fan-out can stop in #3631 without
removing any rolling certification dependency. Caught-up idle main stays fresh.
Pre-rolling closed incidents are outside the new record's historical scope.

All enumerations are bounded: 100 dispatcher SHAs in an ancestry window, ten 100-item pages per run/job/commit listing, ten attempts per run,
128 retained attempt records, and fewer than 100 associated PRs per backlog commit. A fully
passing strict descendant with identical workflow blobs covers older target history without
reloading its jobs. Truncated/changed listings, inaccessible/deleted evidence, missing source or
checkout evidence, unsupported workflow binding, unknown ancestry and API failures yield unknown,
never passing. API retention can limit recovery; no cached success survives missing forge proof.
If a bound is reached, inspect the diagnostic and extend the observer's bounded reconciliation
with reviewed code; editing the state ref cannot manufacture a certificate.

Writes use GraphQL `updateRefs` with an exact `beforeOid` fence. A stale writer fails closed.
Every 128th write, and recovery from malformed state, starts a new root generation; at most 128
state commits remain reachable. GitHub controls collection of unreachable objects. The state
branch runs no workflow. Migration does not alter the controller/worker's coordination contract.

For investigation, first inspect `main_ci_health_observed` (main SHA, passing SHA, status, reasons
and backlog), keyed by `observationId` and the actual `entryPoint`. Then use the record's exact run
attempt URL and job inventory. `validation-stalled` needs an operator to inspect the worker;
pagination, ancestry or permission diagnostics need API/observer repair. Do not close an incident
or switch credentials to work around unknown evidence. Focused fake-API tests cover these paths;
they do not prove GitHub scheduler latency or token policy. After landing, inspect the natural
health workflow's state write and artifact before claiming production persistence is verified.

First-attempt non-red legacy runs retain explicit uncertified forge metadata without repeatedly
fetching complete job inventories. They cannot contain an earlier failing attempt. Red legacy
runs and reruns still load their full evidence. Only completed workflow events request an eligible
observation job. The schedule detects a rerun in progress or a missed completion; a main push
does not add an extra observation.

### Shared API Budget

Every CLI/workflow invocation has a hard cap derived from authoritative REST response headers:
**`min(96, floor(48 * REST_limit / 1000))` requests**, including failed calls, the quota
preflight, ref reads/writes, GraphQL and alert calls. It starts at 48 until headers are verified;
missing headers stop production unknown rather than assuming a larger token allowance.
Reconciliation reserves eight calls up front for the four state-write calls and at most four
alert/author/label calls. Observation stops at cap minus eight (40 at a 1000 limit, 88 at 5000).
An exhausted observation cannot unlock that reserve. Read-only reports reserve no writes.
Checkpoint recovery has a separate twelve-call cap inside the same invocation budget. Existing
checkpoint hints are reverified and the complete census is restricted to their dispatcher-ancestry
window. Seed failures are inspected too, so a same-target red seed cannot promote an invalid older
pass into recovery. We never replace completeness proof with cached verdicts to save calls.

Within an observation, verified ancestry comparisons serve the checkpoint window and backlog,
and known strict ancestry also proves the reverse is false. The mutable hint file is read at its
pinned commit directly. The current run response supplies its latest attempt identity; older
attempts use their own endpoint and every job inventory uses an exact attempt URL. Already
inspected hints are not fetched again. A newly resolved pointer supplies its live run response
without an immediate duplicate lookup. All inspected run identities are still rechecked after
the full observation, followed by complete listing fingerprints. These savings preserve race
detection while making an ordinary red transition affordable.

Before any observation, `GET /rate_limit` supplies authoritative numeric response headers. This
endpoint is [exempt from GitHub's primary rate limit](https://docs.github.com/en/rest/rate-limit/rate-limit).
The REST floor is **`max(600, ceil(0.60 * REST_limit))`**: 600 at a 1000 limit, 3000 at 5000.
Below the floor, the invocation stops unknown before any observation read or mutation. At the
floor, the next request is also refused. Lower limits reduce the cap; a limit below 600 cannot
admit observation. Every later response refreshes a conservative low-water mark;
missing, malformed, impossible or changing quota limits also stop unknown. Logs expose only
numeric `x-ratelimit-limit` and `x-ratelimit-remaining` values as `rateLimit`/`rateRemaining`, plus
request counts, limits and safe reasons in `main_ci_health_api_usage`. `readCalls`/`mutationCalls`
and `restCalls`/`graphqlCalls` partition the calls by method and quota respectively, including
failures. The usage event carries the observation's entry point and correlation ID. The separate GraphQL
bucket has its own numeric `graphqlLimit`/`graphqlRemaining` fields; it is never mixed into the
REST floor. GraphQL errors and malformed GraphQL quota still prevent further mutation. Report stdout remains one
JSON document; its usage log goes to stderr. `apiBudget` in the record is the observation-time
snapshot; the final usage log includes subsequent writes. No token, response body or reset header
is logged. Failed requests and concurrent requests count before launch, and there are no retries.

Let C be eligible main-CI completions, R rolling completions, and M manual dispatches/read-only
reports per hour. With cap B, the unconstrained envelope is `B * (3 + C + R + M)`:
three schedules and one CI/worker completion each give at most 240 calls at B=48 or 480 at B=96.
Skipped jobs and push/in-progress events add zero invocations. C, R and M are not inherently
bounded. The live floor F limits aggregate admission: conservatively `REST_limit - F + B`
exposed calls, leaving `F - B` shared headroom (552 at limit 1000, 2904 at 5000). Per-response
checks normally stop near F; serialized jobs avoid simultaneous health invocations. This is
not an atomic quota reservation: other consumers and GitHub's distributed header counters
can change the balance. Low-quota wakes make only the primary-exempt preflight. Secondary
limits still apply; any 403/429 stops this invocation with no retry.

`api-budget-exhausted`, `api-quota-reserved`, `api-rate-limited` and `rate-limit-unavailable` yield unknown, no active
certificate, and no incident opening or closure. If the budget/floor stops further calls, the
previous health ref stays unchanged and the current artifact/CLI output explains the unknown
observation. Consumers must reverify and must not treat the previous cached ref as current proof.
A smaller recovery may persist unknown while retaining the global write reserve; it still cannot
mutate an incident. These limits deliberately trade long-backlog availability for controller
headroom. The lighter merge gate remains disabled.

The earlier unbounded diagnostic fixtures measured 88/312/725 calls at 8/40/99 unvalidated commits;
they establish why a hard cap is necessary, not current production request counts. Production
entry-point tests stop long backlogs at their observation ceiling with no mutation, verify low-quota wakes use
only the exempt preflight, and verify caught-up evidence plus CAS persistence fits within 48.
They also persist and open the incident for a failing worker one commit after a pass, including
existing state and a red legacy run. The quota-sized matrix covers lag zero through five,
active-worker overlap, full failures and verified recovery/closure at the production entry point.
The 100-dispatcher, pagination and evidence caps still apply independently. Fixtures do not prove
live quota, scheduling latency or production ref permissions; verify natural post-merge writes.
See the [bounded production census, sizing evidence, operating envelope and rollback](main-ci-health-budget-2026-10-24.md).
It records a natural lag-one budget exhaustion despite 4979/5000 REST remaining, two completed
lag-one active-worker observations, and the limits of its red/incident-recovery evidence.

## When a Merge Group Fails on Code Your Pull Request Did Not Touch

Check `main` before you investigate the pull request:

```bash
gh run list --workflow main-rolling-validation.yml --branch main --event workflow_dispatch --limit 5
```

The run title's `Rolling <target-SHA> <claim>` names the tested target. A dispatch-time
`headSha` or green controller is not certification; use the read-only health report above to
verify checkout, ancestry and complete outcomes. Legacy `ci.yml` push history is frozen at the
cutover and is useful only for historical comparison or an explicitly restored rollback.

If `main`'s verified rolling run fails the same test, or a **Main CI Is Failing** issue is open, the pull request
is not at fault. Find the pull request fixing `main` (or open one), wait for it, then add the
unchanged head back to the queue behind it. The queue tests each entry on top of the entries ahead of
it, so yours runs with the fix. Merge authorization for an unchanged head carries over.

## Landing a Change Outside the Merge Queue

Use a normal pull request through the queue whenever you can. Bypass only when a change cannot be
public before it lands, which in practice means a security fix prepared in a temporary private fork.

**Before merging**, build the exact result locally and run what the required check runs:

1. Fetch `origin/main` and apply the fork's changes on top, as the merge will (a squash merge
   applies them as one commit).
2. On that tree, on Linux with `bubblewrap` installed as CI is, run what the required check's jobs
   run (`.github/workflows/ci.yml` is the authority):
   `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`,
   `pnpm --filter @wollipog/web build`,
   `pnpm --filter @wollipog/runner exec node scripts/build-binary.mjs --bundle-only`,
   `pnpm --filter @wollipog/desktop exec node scripts/build-sidecar.mjs --bundle-only`
   and `pnpm test:e2e`. The required check also covers the Node engine boundary and WebKit, which a
   local run rarely reproduces. A local run narrows the risk; it does not replace CI.
3. Run the tests without your own Git identity. CI has none, and that difference broke `main` once:
   a test that committed with an unset identity passed on every developer machine.

   ```bash
   GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
   GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true \
     pnpm test
   ```

   `user.useConfigOnly` stops Git guessing an identity from the host name, so a test that relies on
   one fails here as it does in CI. Tests that set their own identity are unaffected.
**Right after merging**, inspect rolling validation for the commit that landed. GitHub can
take a moment to dispatch the worker, and until then the newest run can test an older target:

```bash
git ls-remote origin refs/heads/main   # record the commit that landed
gh run list --workflow main-rolling-validation.yml --branch main --event workflow_dispatch \
  --limit 10 --json databaseId,displayTitle,status,conclusion
gh run watch RUN_ID --exit-status
```

Choose the run by its target in `displayTitle`, never by `--commit` (the dispatcher SHA).
If newer main traffic coalesces the original target away, inspect the read-only health report
for a verified full passing descendant containing that change. `--exit-status` reports workflow
failure; a successful admission-only superseded run still supplies no certificate. Verify the
target's checkout and full job inventory through health before calling main green. If no worker
appears, inspect controller status and request trusted manual reconciliation as documented in
the [rolling runbook](main-rolling-validation.md); an absent run is not pending evidence.

**If it fails**, fix forward. Open a pull request with the fix and put it at the front of the queue,
so the entries already waiting test on top of it:

```bash
gh api graphql -f query='mutation($id:ID!){ enqueuePullRequest(input:{pullRequestId:$id, jump:true}) { mergeQueueEntry { position } } }' \
  -F id="$(gh pr view <n> --json id -q .id)"
```

Do not revert a security fix to make `main` green: that withdraws the fix from everyone running
`main`. Revert through the queue only an out-of-queue change that is not a security fix, and only
when a forward fix cannot land promptly. Keep the vulnerability's details out of the fix pull
request until the advisory is published. The fix should describe only the test or build it repairs.
