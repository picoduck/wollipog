# GitLab Campaign Operator Smoke

This on-demand manual procedure covers #3839. Run it only against an **existing,
operator-authorized disposable project in a nested namespace**, using the operator's
existing `glab` login on the runner that executes the campaign. It creates no
infrastructure and changes no authentication. A fixture test passing is never a live
result. Keep #3839 open until every live criterion below has passed.

## Admission and Run Record

Copy [the results record](gitlab-campaign-smoke-results.md) for each run. Give the run
a unique ID; record UTC times, the tested Wollipog commit, control-plane/runner protocol
versions, `glab --version`, and GitLab's `GET /version` response version/revision.
Never replace an earlier blocked run with an implied success.

Before any write, the operator and controlling Orchestrator must identify:

- The exact host, full project path (for example `group/subgroup/smoke`), project ID,
  default branch, and existing Project Location. Confirm it is disposable and its
  CI jobs incur only already-authorized costs. Do not provision a project or runner.
- Existing merge-train entitlement, compatible GitLab version, working CI runner,
  merged-results/train pipeline configuration, and authority to change this disposable
  project's train setting between the two merge cases. If unavailable, block those cases.
- Campaign repository membership and exact authorized issue scope, including a checklist
  umbrella, one completed issue, and one not-planned issue. The boundary must permit both
  closure reasons. GitHub campaign scope does not authorize writes to a GitLab project.
- Managed worker/reviewer admission, configured reviewer provider/model/effort and budget,
  and the owners of scope, closure, merge, branch-deletion and evidence decisions. Read
  each exact typed occurrence's authority; never infer it from Full Control.
- Two disposable source branches and merge requests (A for train, B for direct merge),
  pushed by their owning worker sessions from clean managed worktrees with upstreams.
  Use harmless file changes and CI that runs long enough to observe a pending pipeline.
  Keep automatic source deletion off so the explicit deletion checks remain possible.
  Create these resources only under separately established operator authorization.

Missing prerequisites mean **BLOCKED**, not a request for a token, sign-in, paid tier,
or broader permissions. A child asks a typed `implementation_question` with
`kind: "question"` about concrete target/authority blockers. Its answer is clarification,
not an action grant. Do not restart or update the hosting stack to gain capabilities.

## Read-Only Preflight

Use only an explicit authorized host and path. Do not dump environment variables,
credential files, tokens, auth status output, debug HTTP headers or raw API errors.
If `command -v glab` fails, stop before any API access; record the missing CLI.
The following examples are shell commands for an operator to substitute with their
approved non-secret identifiers, not a batch to execute unattended:

```sh
command -v glab
glab --version
# Project path slashes are percent-encoded; the hostname is not part of the API path.
glab api version --hostname gitlab.example.com
glab api projects/group%2Fsubgroup%2Fsmoke --hostname gitlab.example.com
```

Inspect responses privately; retain only version/revision and selected project fields:
`id`, `path_with_namespace`, `default_branch`, `merge_trains_enabled`, `squash_option`.
Confirm the returned identity matches the approved project. A denied, missing or malformed
response does not prove trains are disabled. Current Wollipog preflight requires GitLab
15.11 or newer for its train endpoint; record the actual version rather than assuming
that version alone proves entitlement or correct CI configuration.

For each MR use these read-only comparisons, substituting its IID:

```sh
glab api projects/group%2Fsubgroup%2Fsmoke/merge_requests/1 --hostname gitlab.example.com
glab api projects/group%2Fsubgroup%2Fsmoke/merge_requests/1/approvals --hostname gitlab.example.com
glab api projects/group%2Fsubgroup%2Fsmoke/merge_trains --hostname gitlab.example.com
```

Read head and train pipelines by their actual IDs using
`projects/<encoded-project>/pipelines/<pipeline-id>`. Follow pagination when comparing
lists; an empty page or a truncated list cannot prove an item absent. Retain only the
necessary IDs, SHAs, statuses, approvals counts and train state, with timestamps.
Keep private host/project names and raw payloads out of public reports.

## 1. Campaign Status and Head-Pipeline Wait

1. The Orchestrator records MR A on its assigned work item using
   `update_campaign_work_item` with `pullRequests: [{repository, number}]`, where
   `repository` is the host-qualified full project path and `number` is the MR IID.
   Open Campaign Status while the MR is open and its head pipeline is pending/running.
2. Compare the displayed pipeline, approvals and train state with the read-only API
   responses at the same head. Record an approval requirement as well as its current
   approved/unapproved state when the project has rules. Record no train entry before
   enqueueing, then an actual train entry in step 3; absence alone does not test train UI.
3. Call `wait_pull_request` with the MR URL, `headSha` equal to the pushed head and
   a bounded `timeoutMs` supported by the harness. Start it **before** pipeline completion.
   On `timeout`, resume the wait; do not call a completed pipeline a transition test.
   Record the returned outcome, pipeline ID/status and SHA. Passing requires that the
   observed head pipeline finishes successfully and the result corresponds to that head.
   Skipped/manual pipelines are blocked, not passed; a changed head needs a new run entry.
4. Capture Campaign Status before and after the transition. For live visual evidence,
   attach screenshots from disk as private Session artifacts and record `artifactId`,
   `mediaType`, `sizeBytes`, `sha256`. Submit exact `ui_evidence_approval` occurrences;
   the assigned reviewer must inspect every item before approval. Attachment alone is
   not evidence review. Do not substitute fixture screenshots.

## 2. Review the Pushed Merge Request

The MR's owning worker requests `request_review_session` with the host-qualified
`repository`, MR IID as `number`, exact `headSha` and a brief naming intent, acceptance
criteria and tests already run. The equivalent is:

```text
wollipog review session run --repo <host/group/subgroup/project> --pr <iid> --head <sha> --brief-file <path> --json
wollipog review session get <review-session-id> --json
```

Use the controlled review-session route, never an unaccounted local reviewer fallback.
Wait for the continuation and read the complete result: reviewed head, terminal state,
validity, effective vote, findings, harness/model/effort and accounting. Adjudicate
findings independently, fix verified blockers and re-review changed heads. Record refusals
or missing review/cost proof as blocked. Repeat for MR B before its direct merge.

## 3. Typed Merge Through the Train and Train-Pipeline Wait

1. Confirm trains are enabled via the project read. Re-read MR A's head, ready state,
   successful required pipeline, approval requirements and source-deletion settings.
   Verify no unexpected closing references in its description/commits. Use `Refs` for
   issues that must stay open. Check dependent MRs and queued changes for conflicts.
2. Request `pr_merge` with the exact current snapshot: `repository`, `pullRequest`,
   `headSha`, `mergeMethod: "merge_train"`, explicit `squash`,
   `removeSourceBranch: false`, exact `intendedClosures`, `reviewResult`, review session
   ID and `requiredChecks` (passed checks, same head, fresh `checkedAt`). Read the
   occurrence's actual owner and obtain its approval. An old approval is not reusable.
3. Immediately before the action, consume that unchanged snapshot with action kind
   `pr_merge_enqueue` and the exact canonical command generated for it. Execute that
   one command once. Record the command, decision occurrence/digest and runner receipt
   privately. The current command generator is `canonicalPrMergeEnqueueCommand` in
   `apps/control-plane/src/sessions.ts`; use its returned command verbatim rather than
   constructing a second spelling. The train call is a `glab api --method POST` to
   `projects/<encoded-project>/merge_trains/merge_requests/<iid>`, with explicit hostname,
   approved `sha=` and squash field. If the consume message names a different command
   or refuses it, record the exact sanitized mismatch and stop. Do not fix the generator
   as part of this smoke procedure (related contributor work: #4242 / #4247).
4. Observe the train entry and its pipeline while pending/running in Campaign Status.
   Start a **separate** `wait_pull_request` at the approved head before the train
   pipeline finishes. Record its pipeline ID separately from the head pipeline ID.
   A head-pipeline-only result does not satisfy the train-pipeline criterion. If the
   train finishes too quickly to observe, mark that transition unexecuted and use a
   newly authorized MR for another attempt, never replay the consumed merge command.
5. Wait until GitLab reports the MR actually `merged`, at the approved source head.
   Record `merge_commit_sha` (or `squash_commit_sha` when that is the available verified
   merge result) and compare the wait and Campaign Status observations. Enqueued is
   unfinished. A transport timeout is uncertain: inspect before any retry. Reconcile
   an armed decision only through the supported receipt/reconciliation route; an
   unsupported GitLab reconciliation path is a recorded blocker, not a guessed receipt.

## 4. Typed Direct Merge with Trains Disabled

Only the authorized operator changes the disposable project's train configuration,
after A finishes and no other work uses its train. Record the before/after setting and
restore the original setting after the smoke if authorized. If settings changes were
not authorized, use a second already-authorized nested project with trains disabled,
or block this case. Do not silently change settings from the worker.

Repeat steps 1–3 for MR B's head pipeline, review and fresh typed merge snapshot, using
`mergeMethod: "merge"`. Read the project setting immediately before consumption: a
direct merge on a train-enabled project must not bypass its train. The canonical direct
command uses `glab api --method PUT` to
`projects/<encoded-project>/merge_requests/<iid>/merge`, explicit hostname, approved
`sha=`, squash and source-deletion fields. Use the generator's exact command. Verify
actual merged state and merge SHA as for A, and record that there was no train entry.
Never substitute a raw merge when a typed decision is refused.

## 5. Branch Deletion in Both Retirement Orders

Use A and B's distinct branches/worktrees; disable automatic deletion in both merges.
For **each** deletion, first verify the MR merged the approved head, the remote branch
still points to that head, and no open MR targets that source branch. Check all pages.
Request a distinct `merged_branch_deletion` snapshot with `repository`, branch,
`headSha`, MR number, `merged: true`, verified `mergeCommitSha`, and fresh
`dependentPullRequests: {checkedAt, open: []}`. Read owner/approval and consume the
unchanged snapshot immediately before deleting only that approved remote ref through
the supported GitLab path. Never reuse GitHub-only execution helpers for GitLab.

- **A: delete, then retire.** Execute the authorized remote deletion, independently
  confirm the exact remote ref is absent, then call `discard_worktree` for its clean,
  fully pushed managed path. Do not use `git worktree remove`.
- **B: retire, then delete.** Save the pushed branch/head/MR/merge identifiers first.
  Retire the clean, fully pushed managed worktree with `discard_worktree`. After the
  retirement is actually complete, request/consume the fresh deletion approval and
  delete the remote branch via the supported route without depending on that directory.
  Confirm absence independently. A `deferred` retirement is pending until provider exit;
  record the later completion before claiming this ordering passed.

If retirement refuses or deletion cannot execute after retirement, retain the refusal
and mark that order blocked/failed as appropriate. Do not force removal or deletion.

## 6. Checklist Scope and Both Closure Reasons

In the authorized GitLab campaign, use an existing operator-approved umbrella whose
member checklist contains the two disposable issue URLs (`https://<host>/<full-path>/-/issues/<iid>`).
The Orchestrator calls `get_campaign_issue_scope` with the umbrella IID and
host-qualified repository. Compare discovered candidates to the checklist, including
the nested namespace. Propose only authorized members with
`request_campaign_issue_scope_change` at the current revision. Obtain the exact
scope decision from its actual owner and re-read scope after resolution.

1. Complete and deliver the assigned work for the completed-case issue, including
   actual default-branch merge and verified campaign report. The root requests
   `request_github_issue_closure` (historical tool name also used for GitLab) with
   repository, IID, `reason: "completed"`, explanation and evidence. Read and approve
   through its effective owner, execute `close_github_issue` with occurrence/digest,
   and verify the closed issue plus `issueClosureResult`. A missing delivery proof
   does not justify closing a test issue manually.
2. For the distinct not-planned issue, establish the authorized not-planned disposition
   and request the same typed closure route with `reason: "not_planned"`, exact
   explanation and optional comment. This requires a boundary permitting that reason.
   After execution, read issue state and notes, confirming exactly one expected note:
   `Closed as not planned: <explanation>` followed by the optional comment. GitLab's
   closed state alone does not prove the not-planned reason was recorded.
3. Record all scope revisions, occurrences, dispositions, note and closure results.
   If note posting succeeds but closing fails, treat the outcome as uncertain and
   inspect both state and notes; never replay blindly and duplicate the note.

## Result and Mismatch Rules

For every criterion record PASS, FAIL (executed with an observed mismatch), BLOCKED
(missing prerequisite/authority) or NOT RUN, timestamps, tested head, expected and
observed selected fields, evidence references and versions. No blank means success.
A pass needs actual live execution and independent read-back. Record the first failing
step and preserve sanitized evidence; stop dependent writes. Do not modify unrelated
resources to get a green run. Do not publish private raw API responses.

Compare live responses with the fixture assumptions in `campaign-gitlab-status`,
`gitlab-merge-preflight`, `gitlab-merge-closures`, `gitlab-issue-closure`, MR wait/review
and GitLab branch-deletion tests. For every observed mismatch, either implement a
scoped fix with a regression test and managed review, or report a proposed follow-up
title/repository to the parent for deduplication and exact publication approval.
Record its verified issue link when published. No live API response means no claim
that fixtures match the instance. Do not close #3839 from a procedure-only PR.
