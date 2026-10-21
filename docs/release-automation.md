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

The final mutation includes the explicit tag, target commit, title, notes, draft/prerelease state,
and stable/latest selection. The command rechecks workflow attempt, tag, release ID, asset metadata,
and updater key before that mutation. A newer stable release blocks automatic promotion. Recovery
after GitHub accepted publication reads the existing release back rather than repeating a PATCH.
Published metadata, assets and latest-stable identity must all verify before completion is reported.

`--watch` checks every 30 seconds, prints changed states, and stops at the next approval/recovery
gate or after six hours. `--timeout-seconds` can select a shorter bounded observation window.
Failures leave the checkpoint intact. Only one local process may own a checkpoint; a dead process's
lock can be recovered, while a live or ambiguous owner is retained for operator inspection.
An exclusive recovery guard serializes lock acquisition. If a process crashes during that short
critical section, inspect the `.lock.recovery` guard and its process before removing it manually.

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
