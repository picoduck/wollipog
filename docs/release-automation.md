# Resumable Releases and Scheduling Evidence

`pnpm release` coordinates stable release preparation and supervision. It retains the review,
required-check, actual merge-group success, signing, and hosted-asset gates in [Releasing](RELEASING.md).
It does not enqueue pull requests, delete worktrees, restart a stack, change repository policy,
provision runners, or purchase capacity. Prerelease releases continue to use the existing runbook.

## Prepare

Use a dedicated linked worktree based on fresh remote `main`, with Git, authenticated GitHub CLI,
Node 24, pnpm, and tar available. Put the reviewed release notes in
`docs/release-notes-vX.Y.Z.md`, ending with a newline. Keep the checkpoint on persistent private disk
outside the repository; a session-private temporary directory may disappear on provider relaunch.

```sh
pnpm release prepare --version 0.35.0 --state ~/.local/state/wollipog/releases/v0.35.0.json
```

Preparation changes the six version fields and the desktop Cargo lockfile, runs typecheck and the
full test suite, commits those files and the notes, pushes the branch, and creates a draft PR.
Unrelated changes, a primary checkout, a different origin, or a conflicting checkpoint are refused.
Repeating preparation after an interrupted push or accepted PR creation reconciles the existing
commit and PR. Never amend the intended notes/head behind an existing checkpoint; reconcile the
intent explicitly if review requires a changed preparation snapshot.

## Review and Merge

Complete the project's cross-model review, independently adjudicate findings, mark the PR ready,
and wait for the required `Typecheck, Test & Sidecar Bundle` on the exact reviewed head. Obtain
the applicable merge authorization, check queued changes for conflicts, then use the canonical
`gh pr merge URL --squash --match-head-commit SHA` command. The release command reports that next
action; it never treats its own flags as merge approval or invokes enqueue inside a wrapper.

```sh
pnpm release status --state ~/.local/state/wollipog/releases/v0.35.0.json --watch
```

Supervision follows the PR's current merge-queue entry and integration SHA, recording replacements.
An empty head on a queued entry is pending. Leaving the queue returns an explicit operator gate;
it never means the PR merged and never automatically re-enqueues a failed or ejected entry.

## Exact Full-Regression Certification

After merge, the release candidate is the actual merged commit, not the reviewed PR head or the
merge group's integration commit. Before tagging and immediately before stable publication,
supervision independently reads current Actions evidence for that exact SHA. It requires
`rolling-full-v1`: every rolling full-suite job, exact checkout proofs, executed test steps,
complete success and a compatible worker/CI/win32 workflow suite digest. Green ancestors,
descendants, other candidates, PR/merge-group checks, artifacts and scheduler receipts certify
nothing for this candidate. A newer main is allowed when the exact candidate retains compatible
full evidence; newer main's own success cannot substitute for it.

Read-only operator verification is available without running a release:

```sh
node scripts/release-certification.mjs --repository picoduck/wollipog \
  --target-sha FULL_MERGED_RELEASE_SHA
```

When rolling validation skipped an intermediate snapshot, the release checkpoint stops at
`full-regression-certification` and prints the exact candidate request command. An authorized
operator can request the [bounded candidate lane](main-validation-candidates.md):

```sh
gh workflow run main-rolling-controller.yml --ref main --repo picoduck/wollipog \
  -f candidate_sha=FULL_MERGED_RELEASE_SHA -f purpose=release
```

This records intent; it does not guarantee immediate execution or grant publication authority.
Main backlog has priority. Candidate requests share one full-worker slot, deduplicate, retain
bounded history and obey the exported per-purpose/global cooldown policy. Scheduler receipts
report queue wait and measured worker wait/execution separately from certification.

Schema-1 release checkpoints remain compatible. Their optional `certification` field records
only public run identities and the last observation. On resume it is always replaced by fresh
forge evidence, including when stage says `published`. A pointer locates an older run; it never
reuses its cached verdict. Pending reruns, new target workers, changed suites, missing/skipped/
cancelled jobs and incomplete listings withdraw success. Failed candidate validation leaves the
checkpoint and release draft intact and requires operator reconciliation, not automatic retries.

Each observation is read-only and limited to 48 API calls with the existing quota reserve. The
collector rechecks current main, exact attempt and the target-run census after job verification.
An observation expires when that evidence can no longer be established: for example, a rerun
starts, workflow blobs change, a required run is unavailable, or the bounded census since the
located run exceeds 1,000 workers. It fails closed; no age-based ancestor equivalence is used.
Inspect the precise run and reconcile through the bounded scheduler/operator recovery path.
Do not clear history, force a tag, or publish using a saved success to bypass these limits.

## Tag, Verify, and Publish

Once release publication and tagging are authorized for the exact reviewed head, resume with the
matching SHA and only the operations that authority covers:

```sh
pnpm release resume --state ~/.local/state/wollipog/releases/v0.35.0.json \
  --reviewed-head FULL_REVIEWED_PR_HEAD_SHA --allow-tag --allow-publish --watch
```

The flags are supplied anew on each invocation. Checkpoints contain identities and evidence,
never tokens, private transcripts, or persisted approval. They do not replace a hosting platform's
typed workflow decisions, human approval requirements, review receipts, or credential permissions.
An agent must consume any applicable exact action decision before acting; if its host cannot
authorize a wrapper's mutation, perform that authorized operation separately and resume observation.

The command verifies the actual merged commit is on `main` and its release fields/notes match the
reviewed preparation. Dependency and script changes merged from `main` may coexist with the
reviewed version fields; the release notes must still match byte for byte. It creates only an
absent tag, peels existing annotated tags, and refuses
to move a conflicting tag. It binds one tag-push Release run and its current attempt, then waits
for all native builds and final verification to succeed. Ambiguous runs and failed attempts require
operator reconciliation, including a competing tag-ref dispatch; the command never dispatches
or reruns builds itself. Required job identity and success are checked independently of timing
metadata. Unavailable timing metadata is recorded as unmeasured and cannot count as evidence.

Before publication it downloads assets by immutable numeric ID, checks their publisher digests,
and uses the verification helpers archived from the exact merged release commit. Those helpers
verify signatures, signed versions/file names, updater URLs, aliases, checksums, and the complete
asset inventory. Content-addressed installer caches are rehashed and signatures reverified on
every resume. Neither a cached stage nor a cached verdict permits publication. Keep enough disk
for the release update packages and remove the public installer cache when it is no longer useful.

The stable Release workflow also checks exact certification before native builds and after final
hosted-asset verification. Branch test builds and prerelease behavior remain as documented.
These checks add Actions read access only to preflight/final verification; they do not expand
signing or asset-write permissions or activate the dedicated finalizer.

The final mutation includes the explicit tag, target commit, title, notes, draft/prerelease state,
and stable/latest selection. The command rechecks workflow attempt, tag, release ID, asset metadata,
and updater key before that mutation. A newer stable release blocks automatic promotion. Recovery
after GitHub accepted publication reads the existing release back rather than repeating a PATCH.
Published metadata, assets, latest-stable identity and fresh exact-candidate certification must all
verify before completion is reported. Interruption after accepted publication does not repeat the
PATCH; invalidated certification keeps recovery incomplete until current evidence is valid.

`--watch` checks every 30 seconds, prints changed states, and stops at the next approval/recovery
gate or after six hours. `--timeout-seconds` can select a shorter bounded observation window.
While exact regression validation is pending, its proof scan runs every ten minutes to preserve
API quota. Within one watch invocation, native-build polling reuses its initial proof observation;
every new invocation and the final publication/recovery gate still read fresh proof.
Failures leave the checkpoint intact. Only one local process may own a checkpoint; a dead process's
lock can be recovered, while a live or ambiguous owner is retained for operator inspection.
An exclusive recovery guard serializes lock acquisition. If a process crashes during that short
critical section, inspect the `.lock.recovery` guard and its process before removing it manually.

## Optional Stable Dogfood Promotion and Rollback

An operator may keep a stable dogfood checkout pinned to a fully validated exact commit instead of
following every main update. Select the immutable SHA, establish its current exact certification
with the read-only command above, and record the source run/attempt and suite digest. Keep the
previous validated commit and its configuration/data compatibility notes as the rollback target.
Promotion still needs the existing operator approval and deployment checks; certification grants
neither deployment nor restart authority.

The process updating or restarting a stack must be proven outside that stack. A session hosted by
it must hand off the selected SHA and proof to that operator and cannot perform the update, even
through a detached helper. Current-main development installs remain an explicit operator choice;
they need not have stable certification and must not be described as stable promotion.

For rollback, stop promotion, re-establish proof for the chosen previous exact commit, check
configuration/data compatibility, and have the external authorized operator restore that pinned
checkout. Preserve released tags and published asset identities. A distributed desktop rollback
uses the existing signed, version-checked release procedure with a new version; do not silently
move an existing tag or reuse old signed assets under another version. No running stack is changed
by this documentation or its inert fixtures.

## Measure Release Finalization

```sh
pnpm release:timings picoduck/wollipog 39337087163
```

This read-only report binds the repository, release workflow, and exact attempt, fully pages jobs,
and requires one completed job per native target plus final verification. It separates each job's
creation-to-start wait from start-to-completion execution and records when all native builds made
finalization eligible. Missing, duplicate, skipped, or inconsistent timing evidence fails clearly.
Dispatches, reruns, prereleases, and failures cannot count towards natural stable-run evidence.
`naturalStableSuccess` describes workflow/tag evidence; separately verify actual stable publication
before counting an observation towards #3509's three-release acceptance window.

The v0.34.0 baseline is 2026-10-19: native jobs finished at 23:26:09 UTC, final verification began
at 23:56:22 and completed at 23:57:29. That is **1,813 seconds waiting** and **67 seconds executing**.
The report itself and supervision introduce no additional Actions jobs.

## Opt-In Finalizer and Pending Provisioning (#3509)

The final verification job defaults to `ubuntu-24.04`. The separately approved code-only opt-in
`RELEASE_FINALIZER_USE_DEDICATED == 'true'` selects exactly `wollipog-release-finalizer`; arbitrary
variable-selected labels are not supported. No runner is provisioned, variable activated, or
spending authorized by this change. The fixed label alone is not an access-control boundary.

A separately reviewed infrastructure proposal must identify a **fixed, trusted Linux x64 release
finalizer pool**, its provisioning and per-job operating cost, concurrency, and explicit deployment
approval. Restrict its runner group to trusted release workflow execution, isolate it from
public PR execution, and provide Git/Node 24/pnpm/GitHub CLI/tar and the required GitHub endpoints.
The finalizer needs the existing release asset write token and updater public key; it needs none
of the native signing private keys. Verify repository/workflow restrictions and trusted release
refs before activation: the pool handles release-asset write credentials. Unavailable dedicated
capacity should fail visibly or await an
operator-approved rollback to the existing hosted executor, not silently cross trust boundaries.

One provisioning option is a GitHub-hosted larger Linux runner in a restricted group. As of
2026-10-20, the organization uses GitHub Free; larger runners require Team or Enterprise and are
charged even for public repositories. The listed Linux 4-core rate is $0.012 per minute, rounded
up to whole minutes: a 67-second finalizer illustrates $0.024 of runner usage, excluding the plan
subscription. This is an estimate, not a spend cap or purchase decision. Confirm current pricing,
seat costs, pool concurrency, and workflow access restrictions in the infrastructure proposal.
See [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing),
[larger runners](https://docs.github.com/en/actions/concepts/runners/larger-runners), and
[runner access control](https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/control-access).

Do not reserve a general hosted runner for the entire native build just to avoid the final queue:
that consumes scarce capacity while waiting and can worsen #2674. Increasing browser shards or
extending job timeouts likewise does not address the observed finalizer scheduling wait. Evaluate
the existing concurrency-2 trial before proposing another shared-pool policy change.

#3509 remains open for provisioning/activation approval and three subsequent naturally occurring
stable releases whose finalization starts within five minutes of all native builds completing.
#2674 retains its separate normal-contention reliability window; code tests and an isolated fast
run do not satisfy it. No future observation is claimed by these reports.
