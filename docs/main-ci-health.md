# Main CI Health

The merge queue tests every entry on top of `main`, so a red `main` fails every queued pull
request, whatever it changes. Normally nothing reaches `main` without passing the queue. The one
exception is the `main: merge queue` ruleset's bypass: organization admins can merge without the
queue, and a security advisory's temporary private fork always merges that way. GitHub runs no CI
in those forks and enforces no branch protection when their changes merge
([GitHub Docs](https://docs.github.com/en/code-security/tutorials/fix-reported-vulnerabilities/collaborate-in-a-fork)).
This page covers how to land such a change safely, and how a red `main` gets noticed (#3284).

## The Main CI Is Failing Alert

`Main CI Health` (`.github/workflows/main-ci-health.yml`) runs after each CI run for a push to
`main` completes. It checks out trusted default-branch code without persisted credentials, never
reads the triggering commit or its artifacts, and runs `scripts/main-ci-health.mjs`. One
reconciliation runs at a time. That limit sits on the eligible job, not the workflow: every CI
completion starts the workflow, and a skipped pull-request invocation must never replace a pending
`main` reconciliation.

The script ignores the triggering run's own result. It reads the newest completed `main` push CI run
with a verdict (`success`, `failure`, `timed_out` or `startup_failure`). Cancelled and skipped runs
are superseded or filtered work, so they never decide. An out-of-order completion therefore cannot
flip the alert. Then:

- **Red, no alert open:** it opens one issue titled **Main CI Is Failing**, labelled `main-ci-red`
  (created on first use). The issue names the commit, the run and its failing jobs, and mentions
  the head commit's author when that is a user. Creating the issue notifies that author and
  everyone watching the repository.
- **Red, alert open, a run not yet reported:** it comments with the new run and records it in the
  issue's hidden `latest` marker, so the same run is never reported twice.
- **Green, alert open:** it comments with the passing run and closes the issue as completed.

Only an open issue with that title and label, written by `github-actions[bot]`, counts as the alert.
API failures change nothing: the job logs a warning with the HTTP status and fails, and the next
`main` CI completion tries again. Logs never include API response bodies or tokens. The workflow
starts working once it lands on `main`. Its tests drive the decision and transport paths against a
fake API.

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
