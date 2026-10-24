# Proposed PR Assurance Routing

Refs #3630 and tracker #3625. **Inactive.** This change installs routing machinery;
it does not authorize activation. `CI_PR_SUITE_ROUTING` is a repository Actions
variable. Only its exact value `enabled` activates routing. Missing, empty,
misspelled and all other values mean off. The implementation agent must not
create, set or change this variable, including for live tests. Activation is a
human policy decision, separate from implementation/merge approval.

GitHub expression equality is case-insensitive. `Enabled`, `ENABLED` and other
case variants therefore admit one short planning job, but a case-sensitive raw
shell check returns **full** before invoking the selector. The work shells and
aggregate also enforce the exact lowercase value before fast coverage can pass.
This is an overhead exception only: case variants never activate reduced
assurance. Missing/ordinary off values and every non-PR event add no executed job.

## Exact Required-Context Contract

The workflow remains `CI` at `.github/workflows/ci.yml`. The single protected
context remains **Typecheck, Test & Sidecar Bundle**. No ruleset, required-check
name, write permission or queue-coverage change is proposed.

| Event | Switch Off | Switch Enabled |
| --- | --- | --- |
| Draft PR: Opened, Synchronize, Reopened | No work or required aggregator | Same |
| Ready PR: Opened, Synchronize, Reopened, Ready for Review | Complete current required coverage | Trusted plan; only validated allowlisted prose can reduce Node/Chromium |
| Ready for Review with Stale Draft Payload | Complete current required coverage | Same routing as other ready events |
| Merge Group | Complete current required coverage | Complete current required coverage; no routing job is admitted |
| Main Push | Complete current required coverage | Same |
| Manual Workflow Dispatch | Complete current required coverage | Same, including branch diagnostics |
| Reusable Rolling Validation | Complete current required coverage on its immutable target | Same |

The full contract is unchanged: every discovered Node test, all five disjoint
development Chromium projects, production build/smoke on shard 1, complete
configured WebKit, Windows scope/conditional baseline comparison, all package
typechecks and bundles, provisioned Node/pnpm engine boundaries, and both
delegated Linux containment checks. The existing intentional Windows comparison
skip remains inside its reusable workflow; the caller must still succeed.

An activated PR acquires a required `PR Suite Routing` job. It checks out the
event's immutable base SHA with credentials persistence disabled, computes
#3629's selection from Git objects, and verifies the tested CI workflow blob
equals that trusted base workflow blob. It never checks out, imports or executes
PR code to select coverage. PR edits to policy, tests, scripts, config or workflow
select full. A workflow edit cannot qualify for reduced assurance. The workflow
itself still uses GitHub's ordinary PR delivery and existing review protections;
this is not a new security boundary against an author rewriting the workflow
to bypass checks altogether. There is no `pull_request_target` execution or
status-writing token.

`full`, `affected`, unknown and high-risk selections run the complete existing
contract. Today's affected closure already contains every portable Node and
Chromium test; retaining privileged/platform coverage is deliberately more
conservative than that candidate group definition. **Only `fast` selection with
validated context and no fallback/risk reasons reduces work.** Its sole current
qualifying path is the reviewed prose allowlist in `ci-suite-policy.mjs`, initially
`docs/ci-suite-evidence-2026-10-23.md`. This is not a general Markdown exemption
or an app-source latency improvement claim.

The fast route changes exactly these two parts:

- Node runs #3629's `node-fast` group: #3627's 22 protocol files plus authentication,
  recovery API and real-server runner-channel tests (25 files at introduction).
- One Chromium job runs the five complete critical files: authentication recovery,
  new-session choices, request surfaces, issue closure and conversation handoff.
  The existing unpartitioned config preserves file fixtures, one worker, retries
  and fail-on-flaky semantics. That job also runs all shard-1 production work.

All engine, Linux containment, Windows, WebKit, typecheck and bundle coverage
still runs. Deferred Node/development Chromium files remain required in the
complete merge-group integration. PR success therefore means the selected PR
contract passed; merge-group success continues to mean full combined-integration
coverage passed. A PR result never substitutes for queue validation.

## Failure and Cancellation Contract

The plan job has a five-minute bound. Setup failure, job timeout or cancellation
fails the required aggregate when routing is enabled. Git-fetch or selector
unavailability is an explicit successful **full** fallback, not an empty plan.
Missing/malformed selection, missing mandatory inventory, uncertain diff or
context, deleted/renamed paths, security/approval/persistence/runner changes,
cross-package edits and unknown paths all retain full coverage. The aggregator
rejects an active plan's missing/unknown output even if every work job succeeds.

With a missing/ordinary off value or on a non-PR event, the plan must be explicitly
`skipped` with no output. Case variants require successful planning and explicit
`full` output; `fast` is rejected by the raw shell check. Any other result is
rejected. This is the one newly expected job skip;
work-job skips remain errors. With routing enabled, plan and all four existing
work-job results must be `success`. Failed, missing, cancelled, unexpectedly
skipped and unknown results cannot pass. Selection is a two-mode fixed command
choice; neither PR metadata nor plan output supplies arbitrary commands/arguments.

Checks/browser depend only on optional routing and use an explicit status
function so disabled routing's skip does not suppress full work. Windows/WebKit
remain independent. The aggregator retains its exact PR-only `!cancelled()` and
draft/ready condition, unconditional non-PR failure reporting, and five-minute
budget. Workflow name/path, per-head PR concurrency, no in-progress PR
cancellation, stale-head superseding, rerun admission and merge-group replacement
are unchanged. The advisory selection job stays advisory. Release/rolling
supervision continues to inspect the same complete non-PR job/step identities.

## Full PR Diagnostic and Rollback

An author can run the existing manual full workflow on the pushed PR branch:

```sh
gh workflow run ci.yml --repo picoduck/wollipog --ref <pushed-pr-branch>
```

Dispatch has no reduced-suite input and ignores the routing variable. Inspect its
tested SHA: this diagnoses the branch head, while ordinary PR CI tests GitHub's
PR merge commit. It does not replace exact-head required PR/queue verification.
The existing synthetic-artifact probe remains opt-in, default false, and full.
Do not dispatch extra runs for measurement or during a prohibited CI window.

**Rollback:** the authorized human/operator deletes `CI_PR_SUITE_ROUTING` or sets
it to any value other than exactly `enabled`. Start a **new PR CI run**, for example
with a new push, to establish full rollback coverage. Re-running failed jobs
retains the earlier successful plan/output and selected matrix. It cannot expand
a prior one-job fast matrix into five full shards; the aggregate rejects this
stale plan after rollback rather than passing partial coverage. A re-run-all-jobs
attempt counts as full evidence only after verifying a skipped plan, all five
full Chromium shards and the full Node command. If expansion is retained, use a
new PR event. Do not infer what an in-flight run saw during a variable change.
No workflow/ruleset/check-name migration is needed. Normal reruns under an
unchanged switch retain the existing workflow behavior.

Before activation, put this exact assurance contract in the implementing PR,
request the campaign's typed `implementation_question`, and obtain the human's
activation decision through the Orchestrator. Merge approval does not authorize
the variable write. Record the approved revision, actor and UTC activation time
before an authorized operator changes it. Read the variable back afterward.

## Job Count and Runner-Minute Accounting

Missing/ordinary off routing adds **zero executed jobs**: the optional plan is skipped; the
existing full work jobs and advisory shadow are unchanged. A full PR has five
Chromium jobs. An activated fast PR replaces these with one and adds one routing
job: **net three fewer executed jobs** (four browser jobs removed, one plan added).
An activated full-fallback PR adds one routing job, with no removed work jobs.
Case-variant off values add one planning job but remove no full work. Merge
groups/main/manual/reusable validation add zero executed jobs for every value.

The plan's five-minute timeout bounds its execution after runner admission;
checkout/network/setup failure still blocks the active PR. Its actual elapsed
runner-minute cost is unmeasured until activation. The fast-route delta is:

`routing minutes + fast Node/checks minutes - full Node/checks minutes
+ one critical/production browser job minutes - five full browser job minutes`.

Windows, WebKit, required aggregation and advisory shadow still contribute their
actual elapsed minutes; their queueing can also change. File-count reduction or
separately timed local phases cannot establish this delta, billing savings or
feedback speedup. No natural fast PR has been executed by this implementation.

## Measurement and Remaining Work

Use the existing `merge-queue-wait-report.mjs`, reporters and October 22 baseline.
The [pre-change evidence](ci-pr-assurance-baseline-2026-10-24.md) records the
baseline window, outcome denominators and limits. Collect post-activation
**natural** traffic with explicit UTC bounds, then compare offline:

```sh
# Read-only collection; provision the existing GitHub credential as documented in merge-queue-wait.md.
node scripts/merge-queue-wait-report.mjs --repo picoduck/wollipog --all-events \
  --since <activation-or-later-UTC> --until <exclusive-UTC> --json > /tmp/post.json
node scripts/merge-queue-wait-report.mjs --input /tmp/post.json \
  --baseline docs/ci-baseline-2026-10-22.json --json > /tmp/comparison.json
```

The comparison reuses deduplicated raw attempt records, requires ordered,
nonoverlapping windows for the same repository, rejects repeated attempts,
and keeps first attempts/reruns and passing/failing/cancelled/skipped outcomes
separate. It reports passing PR feedback and merge-group required-result latency,
all-state cancellations, measured elapsed runner minutes, and merged queue-entry
to merge latency. Truncation and missing timing remain explicit. It does not
claim causal speedup, billing cost, selection certification or activation approval.
The existing bounded log collector can include the routing/selection job to
retain exact policy/suite/tested identities; compare compatible cohorts, and
keep fast, affected/full, rollback and infrastructure interruptions distinct.

**Remaining:** human activation approval/operator action; natural post-activation
PR/queue observations; compatible before/after feedback, queue, cancellation and
runner-minute comparison; and #3629's independent shadow evidence/certification
requirements. Do not manufacture traffic or hold the campaign ready slot for it.
