# GitLab Campaign Smoke Results

## Run 2026-11-09 — Prerequisite Inspection Only

Refs #3839. **No live GitLab smoke was executed. Keep the issue open.**
This record accompanies the [operator procedure](gitlab-campaign-smoke.md); it is
not a certification that the implementation works against a live instance.

| Environment Field | Observed Value |
| --- | --- |
| Procedure base | `74a64a50bf5955a353c7f29182d306fb1dcc3ef2`, freshly fetched `origin/main` |
| Implementation | Managed isolated branch `docs/3839-gitlab-operator-smoke` |
| `glab` | Unavailable: `command -v glab` returned no executable; `glab --version` returned command not found |
| GitLab version / revision / edition | Not observed; no live API request made |
| Authorized GitLab target / project ID | Not supplied or verified |
| Existing GitLab login | Not inspected: CLI missing; no credential files read |
| Running Wollipog CLI | `0.36.0 (protocol v332)` from `wollipog --version` |
| Source package version | `0.36.1`; source version does not prove running deployment version |
| Live control-plane / runner build SHAs | Not established; CLI version alone does not establish both |
| Campaign boundary | Revision 3; authorized issue scope includes GitHub #3839, not disposable GitLab issue writes |
| Prerequisite clarification | `workflow_a62fb5771c164a19841183433bcaeaf6`, typed `implementation_question`, kind `question` |
| Authentication / infrastructure changes | None |
| Live evidence artifacts | None captured or uploaded; artifact ID/media type/size/digest: not applicable |

## Criterion Matrix

All rows below are **BLOCKED**, rather than fixture-derived passes. Shared blockers
are missing `glab`, no verified existing operator-authorized disposable nested target,
and no established compatible GitLab Location and typed campaign authority for its
issue/merge/deletion writes. No secret or new infrastructure was requested.

| Criterion | Status | Actual Outcome / Additional Prerequisite |
| --- | --- | --- |
| Nested namespace, train-capable instance, operator login | BLOCKED | No project or instance observed; version and train entitlement unknown |
| Open MR Campaign Status: pipeline, approvals, train state | BLOCKED | No live MR recorded or observed; requires comparison at same pushed head |
| Head-pipeline wait through completion | BLOCKED | Not called against GitLab; requires running pipeline and admitted MR |
| Separate train-pipeline wait through completion | BLOCKED | Not called; train entry/pipeline IDs unavailable |
| Typed train merge, verified merge commit | BLOCKED | No decision requested or merge executed against GitLab |
| Typed direct merge with trains disabled, verified merge commit | BLOCKED | No project settings verified or changed; needs authorized disabled-train case |
| Delete branch, then retire worktree | BLOCKED | Neither operation attempted against GitLab smoke resources |
| Retire worktree, then delete branch | BLOCKED | Neither operation attempted against GitLab smoke resources |
| Managed review at pushed MR head | BLOCKED | No GitLab MR review requested; procedure PR's GitHub review is separate |
| Checklist umbrella discovery and scope admission | BLOCKED | No GitLab scope read or mutation attempted |
| Completed closure with verified delivery | BLOCKED | No GitLab issue closure attempted |
| Not-planned closure including exact note | BLOCKED | No GitLab closure attempted; current boundary permits completed closures only |
| Fixture/live comparison; fix or file each mismatch | BLOCKED | No live responses; no API mismatch identified or ruled out |

## Local Verification and Delivery

Record test/typecheck and managed review outcomes in the procedure PR and final
campaign report. Local fixture tests validate existing assumptions only; they do not
change this matrix. No product behavior, command generator or contributor-owned
PR #4247 files are changed. Issue #4242 remains with its contributor.

For a later live run, copy this record and add actual UTC times, GitLab/glab versions,
heads, pipeline/train IDs, decision/digest/receipt references, merge SHAs, retirement
outcomes and evidence metadata. Keep private identifiers and raw responses private.
A complete run requires each live row to pass and each mismatch to have a scoped fix
or verified follow-up link.
