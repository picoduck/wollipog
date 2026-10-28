# Fast Merge-Gate Activation Proposal

Refs #3637 under #3625. **This is a proposal for human approval. Nothing here is
approved or activated.** No repository variable, secret, ruleset, required context,
permission, status-writing grant or budget was changed to prepare it. Every step
below is a separate human operator action; agents do not perform them.

Current state and evidence are in the generated
[readiness report](fast-gate-readiness-2026-10-28.md). Its verdict today is **not
ready**: code, observation and approval gaps remain. Do not start step 1 until a
report regenerated at the activation revision shows no open code gap and every
approval below has been recorded.

## What Approval Would Change

| Change | Exact Value | Today |
| --- | --- | --- |
| Repository variable `CI_REGRESSION_ADMISSION` | `dry-run` (shadow window), never another value | Absent |
| Status-writing identity | A dedicated GitHub App, installed only on `picoduck/wollipog` | None |
| Ruleset `22200037` (`main: merge queue`) | Add `Regression Admission` pinned to that App's `integration_id` | Only `Typecheck, Test & Sidecar Bundle` (15368) |
| Repository variable `CI_MERGE_GROUP_GATE` | `enabled` during the bounded rollout, `disabled` to roll back | Absent |
| Repository variable `CI_PR_SUITE_ROUTING` | Unchanged by this proposal; #3630 approves it separately | Absent |
| Merge queue parameters, bypass actors, timeouts, budgets | **Unchanged** | `max_entries_to_build` 2, `check_response_timeout_minutes` 120 |
| AGENTS.md and contributor guidance | The text in [Guidance to Apply at Activation](#guidance-to-apply-at-activation) | Full-gate semantics |

The protected context `Typecheck, Test & Sidecar Bundle` keeps its exact name and
issuer. Nothing is renamed or removed; any rename or removal needs its own
reviewed migration. Unfinished or unknown required checks still block merging.

## Preconditions

All must hold before step 1. The readiness report tracks each one.

1. **Code gaps closed.** At the five-commit backlog limit the writer has 41 status
   writes for a 45-target fan-out, and the batched 45-target set uses 96/96 calls
   (#3711). Either outcome refuses with zero writes. Each needs a reviewed fix or an
   explicit decision to keep full queue validation. Sticky merge-group success is
   addressed by [just-in-time group admission](main-merge-admission.md#fail-closed-group-admission).
   Approve its availability cost (a stalled queue during a controller outage) and its
   remaining write-to-landing race. Exhausted investigation escalation is
   delivered to the open incident once per attempt
   ([escalation delivery](main-regression-automation.md#escalation-delivery)), but only
   after `MAIN_REGRESSION_ESCALATION_MENTION` is set to an approved target and read back.
2. **#3633 enforcement bound.** A measured, approved failure-to-block bound from
   natural shadow traffic (shipped bound today: none), plus an accepted forge race.
3. **Prerequisite windows.** #3628/#3629 long-window comparisons complete;
   #3634 investigation activation approved; #3630 either measured or left off.
4. **Coordination.** No other CI measurement window (#2674, #3629, #3630) is open,
   or its boundary is recorded so cohorts stay separable.

## Thresholds to Approve

Values live in `PROPOSED_THRESHOLDS` (`scripts/fast-gate-rollback.mjs`) with
`approved: false`. Unapproved thresholds always evaluate to rollback. Backlog and
age reuse #3633's `POLICY`, so the hold point and the rollback point cannot diverge.

| Threshold | Proposed Value | Measurement Basis |
| --- | --- | --- |
| Fast execution target | 5–10 min | #3637 target. Unmeasured: no fast merge group has run. |
| Required-result p90 | ≤ 15 min over the latest 20 eligible integrations | #3637 target. Full-gate passing p90 was 64.10 min ([baseline](ci-baseline-2026-10-22.md)). |
| Unvalidated age | Hold at 7,200 s; roll back above it | Rolling dispatch-to-verdict 33.68/34.27/46.42 min; two-suite envelope 92.84 min ([admission runbook](main-merge-admission.md)). Queue waits of 102–105 min were seen under runner pressure. |
| Unvalidated backlog | Hold at 5 commits; roll back above it | #3633 shadow cutoff. Lag 0–5 is fixture-tested; sustained lag 5 is unmeasured. |
| Observation age | 120 s | #3633 decision lease. |
| Detection | Landing to failed full verdict ≤ 120 min | Equal to the age bound. The rehearsal's virtual value is 35.30 min. |
| Recovery | Failed verdict to verified healthy main ≤ 240 min | The rehearsal's virtual value is 67.66 min with a fixture 20-minute repair. Human repair latency is unmeasured. |
| Validator or controller outage | Roll back at ≥ 30 min, or immediately if the start is unknown | Shorter than one rolling run (33.68 min minimum), so a sticky success cannot outlive a validation cycle unnoticed. |
| Regression escapes | Roll back on any escape found outside rolling validation, or on more than 1 in the rollout window | Conservative; there is no escape history for a fast gate. |

## Ordered Activation Steps

Run every command from a trusted operator machine outside the stack that hosts
agents. Read each change back before continuing. Stop and roll back on any
mismatch.

0. **Record the starting state.**

   ```sh
   gh api repos/picoduck/wollipog/rulesets/22200037 > ruleset-before.json
   gh api repos/picoduck/wollipog/actions/variables --jq '.variables[] | [.name, .value] | @tsv'
   node scripts/fast-gate-readiness-report.mjs --json > readiness-at-activation.json
   ```

1. **Status-writing identity (human).** Create a GitHub App named for
   `Regression Admission`, installed only on `picoduck/wollipog`. Grant repository
   permissions Commit statuses: write and Actions, Contents, Metadata, Pull requests:
   read. Grant nothing else. Keep its key on the approved operator host. Record the
   App ID as `APPROVED_ADMISSION_APP_ID`. No workflow gains `statuses: write`, and
   `GITHUB_TOKEN` (integration 15368) must never be the admission issuer, because
   any workflow job could write that context.
2. **Shadow window.**

   ```sh
   gh variable set CI_REGRESSION_ADMISSION --repo picoduck/wollipog --body dry-run
   gh api repos/picoduck/wollipog/actions/variables/CI_REGRESSION_ADMISSION --jq .value   # dry-run
   ```

   Collect natural shadow observations as described in the
   [admission runbook](main-merge-admission.md#dry-run-evidence-and-separate-operator-steps).
   Report `base-moved` holds separately from health holds.
3. **Enforce admission.** Provision the controller on the operator host. Prime
   `Regression Admission` for current entries. The PUT replaces every field it names,
   so first confirm that ruleset `22200037` still equals the snapshot in **all** of them:
   `name`, `target`, `enforcement`, `conditions`, `bypass_actors` and its own `rules`.
   Any difference, for example a bypass actor removed since the snapshot, stops here:
   regenerate the body from a fresh snapshot instead of restoring old settings. The
   body is built from this ruleset's rules, not from the effective branch rules, which
   other rulesets could contribute to.

   ```sh
   fields='{name, target, enforcement, conditions, bypass_actors, rules: [.rules[] | {type, parameters}]}'
   gh api repos/picoduck/wollipog/rulesets/22200037 | jq -S "$fields" > ruleset-now.json
   jq -S ".ruleset | $fields" scripts/fixtures/fast-gate-live-settings-2026-10-28.json > ruleset-snapshot.json
   diff ruleset-now.json ruleset-snapshot.json   # must print nothing
   ```

   Then save the [ruleset body](#ruleset-body) as `ruleset-proposed.json`, replace the
   placeholder with the integer App ID, and apply it:

   ```sh
   gh api -X PUT repos/picoduck/wollipog/rulesets/22200037 --input ruleset-proposed.json
   gh api repos/picoduck/wollipog/rules/branches/main > rules-after.json
   jq -c '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[]]' rules-after.json
   # [{"context":"Typecheck, Test & Sidecar Bundle","integration_id":15368},{"context":"Regression Admission","integration_id":<id>}]
   ```

   The placeholder is a string, not an integer. Applied unfilled, the gate reads the
   issuer as unpinned and keeps full validation. Drain and rebuild existing queue
   groups so that no pre-enforcement success is inherited. Confirm new, queued,
   building and already-green behavior against the approved bound.
4. **Verify the gate would admit.** Run `node scripts/ci-merge-group-gate.mjs evaluate
   --config proposal.json`, where `rules` is the content of `rules-after.json`. It
   must report `enforcement.active: true`. Any other result stops here.
5. **Enable the fast gate for the bounded rollout.**

   ```sh
   gh variable set CI_MERGE_GROUP_GATE --repo picoduck/wollipog --body enabled
   gh api repos/picoduck/wollipog/actions/variables/CI_MERGE_GROUP_GATE --jq '[.value, .updated_at] | @tsv'   # enabled
   ```

   On the first natural merge group, confirm that `Merge Group Gate` succeeded and
   ran exactly one of its two record steps. Do not create runs to check this.

## Ruleset Body

`PUT /repos/picoduck/wollipog/rulesets/22200037`. It is generated from the live snapshot in the
readiness report: every live rule is unchanged except the added second required check.
`node scripts/fast-gate-readiness-report.mjs --check` fails if this body drifts from the generator.

```json
{
  "name": "main: merge queue",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "exclude": [],
      "include": [
        "~DEFAULT_BRANCH"
      ]
    }
  },
  "bypass_actors": [
    {
      "actor_id": null,
      "actor_type": "OrganizationAdmin",
      "bypass_mode": "always"
    }
  ],
  "rules": [
    {
      "type": "deletion"
    },
    {
      "type": "non_fast_forward"
    },
    {
      "type": "required_linear_history"
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "dismissal_restriction": {
          "enabled": false,
          "allowed_actors": []
        },
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": [
          "squash"
        ]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {
            "context": "Typecheck, Test & Sidecar Bundle",
            "integration_id": 15368
          },
          {
            "context": "Regression Admission",
            "integration_id": "<APPROVED_ADMISSION_APP_ID>"
          }
        ]
      }
    },
    {
      "type": "merge_queue",
      "parameters": {
        "merge_method": "SQUASH",
        "max_entries_to_build": 2,
        "min_entries_to_merge": 1,
        "max_entries_to_merge": 5,
        "min_entries_to_merge_wait_minutes": 0,
        "grouping_strategy": "ALLGREEN",
        "check_response_timeout_minutes": 120
      }
    }
  ]
}
```

## Bounded Rollout Scope

- **Changes reduced:** only combined merge groups that the trusted selector, run
  from current main, classifies `fast` with ordinary risk. Everything else stays
  full; the code enforces this.
- **Time box:** one window of at most seven working days. It starts at the read-back
  `updated_at` of step 5 and ends with the rollback commands below unless continuation
  is separately approved. The window is never extended automatically.
- **Frozen surroundings:** no change to `CI_PR_SUITE_ROUTING`, merge-queue parameters,
  runner capacity, budgets or required contexts during the window.
- **Supervision:** an operator who can run the rollback is available during UTC
  working hours, and rollback triggers are evaluated at least daily.

## Measurement Plan (AC3 and AC4)

At least **30 eligible normal-traffic integrations over five full UTC working days**
inside the window. With fewer, report the evidence as incomplete. Never report
too little traffic as passing, and never manufacture runs.

| Metric | Definition | Source |
| --- | --- | --- |
| Eligible integration | First attempt of a merge-group `ci.yml` run in the window whose `Merge Group Gate` ran `Record Reduced Merge Group Coverage` | `merge-queue-wait-report.mjs --all-events` job steps |
| High-risk fallback | Same, but `Record Full Merge Group Coverage`; reported separately, outside the ordinary p90 | Same |
| Required latency p50/p90 | Run creation to aggregator completion (`requiredMinutes`); gate execution counts as execution | Same, nearest rank |
| Runner wait and minutes | `criticalWaitMinutes`, `longestJobWaitMinutes`, `consumedRunnerMinutes` (missing timing stays unmeasured) | Same |
| All-green timeout | A `checks_timed_out` removal whose exact group had every required result passing or unfinished; reconcile each episode to its run | Removals + queue history |
| Regression escape | A rolling full failure whose first failing target contains a change landed through an eligible group; record who found it | Main CI Health incidents, rolling runs |
| Oldest unvalidated age and backlog | Max and p90 of `backlog.oldestUnvalidatedAgeSeconds` and `backlog.commits` over health observations | Health artifacts |
| Detection time | Forge landing time of the first broken commit to the failed full verdict observed by health | Health + rolling runs |
| Recovery time | That failed verdict to the first health observation `passing` with the failure resolved | Health |
| Holds | Count `holdKind` classes apart: `base-moved` only (a re-sync artifact) versus health or policy. Report false holds separately | Controller decisions |

Collect with `scripts/merge-queue-wait-report.mjs --all-events --since <step 5 updated_at>
--until <window end> --json`, and compare against `docs/ci-baseline-2026-10-22.json`
with `--baseline`. This window is a new cohort. Do not merge it into, or reuse it
for, #2674's trial, #3629's comparison or #3630's post-activation window.

## Rollback

`node scripts/fast-gate-rollback.mjs triggers --observation obs.json --thresholds
approved.json` exits 1 when a trigger fires. The triggers are: required-latency
breach (including any all-green expiry), missed regression or escapes beyond the
limit, detection beyond its bound, recovery beyond its bound, validator or
controller outage, and backlog beyond the limit. The
[rollback rehearsal](fast-gate-readiness-2026-10-28.md#rollback-rehearsal-ac5)
exercises each one.

Restore full validation first, then verify it, and only then consider removing a hold:

```sh
gh variable set CI_MERGE_GROUP_GATE --repo picoduck/wollipog --body disabled
gh api repos/picoduck/wollipog/actions/variables/CI_MERGE_GROUP_GATE --jq '[.value, .updated_at] | @tsv'   # disabled
# After the next natural merge group completes (do not create one):
GITHUB_TOKEN=<read token> node scripts/ci-merge-group-restoration.mjs --repository picoduck/wollipog \
  --since <read-back updated_at> --trusted-ref <reviewed full-coverage commit SHA> --runs 1 > restoration.json
node scripts/fast-gate-rollback.mjs plan --repository picoduck/wollipog --proof restoration.json
```

The verifier exits 0 only when the newest completed group after the switch-back
executed the trusted workflow blobs, the full job and step inventory, and a skipped
gate. `plan` works offline. It first refuses a proof that is not internally consistent
verifier output: the restoration schema, no refusal reasons, both trusted workflow
blobs, and every selected run certified `full`. It then runs #3633's `planRollback`.
Without a usable proof it returns `restore-full-queue-validation-first`. With one, it
returns `operator-hold-removal-approval-required` and a `fullQueueProofDigest`. Only an
approval bound to that digest (`--approval`) yields `operator-hold-removal-planned`.

Use only the verifier's own output as the proof, written by the command above.
#3633's `planRollback` checks only the proof's top-level fields, and no offline check
can detect a proof that was edited by hand consistently. This is a known code gap in the
[readiness report](fast-gate-readiness-2026-10-28.md).

Removing the admission context afterwards is a separate manual operation: PUT the
ruleset without the `Regression Admission` entry and read it back, delete
`CI_REGRESSION_ADMISSION`, and keep `Typecheck, Test & Sidecar Bundle` required
throughout. If full validation still fails, keep holds and repair forward. Never
clear holds or remove a required context to make the queue green.

**Never auto-expanded.** No step, trigger or tool raises the API call caps (48/96),
the REST floor, the merge-queue check timeout (120 min), `max_entries_to_build`,
runner capacity, paid capacity, investigation budgets or bypass rights to meet a
target. Missing a target is a rollback trigger or incomplete evidence, never a reason
to widen a budget. Any such change is a separate human approval.

## Guidance to Apply at Activation

Do not apply this text before step 5. Today's semantics are unchanged.

In AGENTS.md, under **Merge Queue and CI**, replace "Exactly one status check is
required" with:

> Two status checks are required: **`Typecheck, Test & Sidecar Bundle`** and
> **`Regression Admission`**. The aggregator still appears late. While the fast
> merge-group gate is enabled (`CI_MERGE_GROUP_GATE=enabled`), ordinary merge groups
> run a reduced suite, and full regression runs on main through Main Rolling
> Validation after landing. A `Regression Admission` hold means main's validation
> is failing, stale or backlogged, or that your group's base moved. It is not a
> verdict on your change. Wait; do not re-enqueue to work around it. A merge group
> can land a regression that only the full suite catches, so check for an open
> **Main CI Is Failing** issue before investigating a red rolling run.

And replace "`Browser End-to-End Tests` is the long pole at roughly 20–30 minutes,
and the merge group re-runs it" with:

> In a reduced merge group, `Browser End-to-End Tests` is a single critical shard;
> a full-fallback group still runs all five shards, roughly 20–30 minutes.

In `docs/agent-workflow.md`, replace "The required check is `Typecheck, Test &
Sidecar Bundle`" with "The required checks are `Typecheck, Test & Sidecar Bundle`
and `Regression Admission`; a `Regression Admission` hold is main's health, not a
failed check on the PR". Also update the long-pole sentence in
`docs/ci-aggregation.md` and the release note in `docs/RELEASING.md`. Exact-candidate
certification is unchanged and remains mandatory.

## #2674 Reconciliation

The fast gate is **not evidence** that #2674's historical full-gate reliability
criterion passed. #2674 measures complete merge-group validation within the queue
timeout over five working days. A reduced gate removes most of that work from the
queue, so its latency says nothing about the full gate.

Proposed path for a human to decide (this proposal edits neither #2674 nor its
acceptance criteria):

1. Report #2674's five-day trial (October 20–23 and 26) on its own full-gate cohort,
   pass or fail, before the fast gate is enabled.
2. If the fast gate is approved, amend #2674's scope in a reviewed edit. Its
   full-gate latency criterion then applies to full validation: rollback mode,
   high-risk fallback groups and rolling validation. It no longer applies to
   ordinary merge groups.
3. Keep `check_response_timeout_minutes` at 120. A timeout or capacity change is a
   separate approval, never part of this rollout.
4. Close or retarget #2674 only by explicit human decision with its trial evidence.
