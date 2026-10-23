# Main CI Health

The merge queue tests every entry on top of `main`, so a red `main` fails every queued pull
request, whatever it changes. Normally nothing reaches `main` without passing the queue. The one
exception is the `main: merge queue` ruleset's bypass: organization admins can merge without the
queue, and a security advisory's temporary private fork always merges that way. GitHub runs no CI
in those forks and enforces no branch protection when their changes merge
([GitHub Docs](https://docs.github.com/en/code-security/tutorials/fix-reported-vulnerabilities/collaborate-in-a-fork)).
This page covers how to land such a change safely, and how a red `main` gets noticed (#3284).

## The Main CI Is Failing Alert

`Main CI Health` (`.github/workflows/main-ci-health.yml`) reconciles on main pushes, main CI and
rolling-worker completions and rerun in-progress events, a twenty-minute recovery schedule, and manual dispatch
on main. It checks out trusted default-branch code without persisted credentials and runs
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
| `backlog` | Commit and merged-PR counts, Git merge-commit count, oldest unvalidated time/age; null means unknown. |
| `status`, `reasons` | `passing`, `failing`, `pending`, `stale` or `unknown`, with allowlisted content-safe diagnostics. |

`passing` requires current-main full certification. `pending` means verified passing ancestry
exists with newer unvalidated main commits. `stale` means the oldest unvalidated change exceeds
the two-hour investigation budget. A full failure remains failing through a pending rerun;
unknown evidence or a stalled validator remains explicit rather than silently reusing green.
The budget is an investigation threshold, not a guarantee about GitHub scheduling or runner time.

The freshness clock is the oldest unvalidated commit's **committer-time proxy**, not the age of
the last green run and not measured push arrival. Squash merges from the queue receive a committer
timestamp when they land, making it the useful freshness anchor for this repository. Once caught
up, idle main has zero backlog and zero unvalidated age even after weeks without a run. `merges`
counts associated PRs actually merged into main at each backlog commit, including squash merges;
`mergeCommits` separately counts commits with multiple parents.

## Reruns, Ordering and Recovery

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
runs and reruns still load their full evidence. First-attempt in-progress/requested events do
not request a runner: main pushes, decisive completions, rerun in-progress, and the recovery
schedule cover meaningful changes.

The 50-main-commit fixture bounds one caught-up observation to fewer than 45 API calls and fewer
than 12 ancestry comparisons, including checkpoint revalidation, complete window listings and
active-worker scans. Ordering uses each target's distance from pinned main and adjacent ancestry
checks; it does not compare every historical pair. An eight-unvalidated-push fixture remains below
100 calls and loads no legacy-success job inventories. Three scheduled ticks model fewer than
135 calls per hour while caught up, plus main pushes, decisive event wakes and the separate
controller's usage. Larger backlogs and bursty traffic cost more; API quota failures remain unknown
and never close an incident. This is a fixture
budget, not a live quota or latency measurement. Long unvalidated windows still fail closed at the
enumeration/evidence bounds instead of silently dropping history.

## When a Merge Group Fails on Code Your Pull Request Did Not Touch

Check `main` before you investigate the pull request:

```bash
gh run list --workflow ci.yml --branch main --event push --limit 5
```

If `main`'s own runs fail the same test, or a **Main CI Is Failing** issue is open, the pull request
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
**Right after merging**, watch CI for the commit that landed, not just the newest run. GitHub can
take a moment to list the push's run, and until then the newest run is the previous commit's:

```bash
sha=$(git ls-remote origin refs/heads/main | cut -f1)   # the commit the merge produced
until run=$(gh run list --workflow ci.yml --branch main --event push --commit "$sha" \
    --json databaseId --jq '.[0].databaseId // empty') && [ -n "$run" ]; do sleep 15; done
gh run watch "$run" --exit-status
```

`--exit-status` makes the watch fail when the run fails. A cancelled run is not a pass either: if a
later push cancelled it, watch that push's run instead.

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
