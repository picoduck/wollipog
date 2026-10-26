# Regression Admission Read-Only Observation

Refs #3633; first disabled policy slice. No settings, permissions, workflow
dispatches, status contexts or rulesets were changed. No failure was manufactured.

## Live Evidence

One read-only authoritative `report` observation ran at
**2026-10-26T01:00:10.276Z**, evaluated at **01:00:15.414Z**, using the new live
adapter from the session worktree based on
`b0b1313e420df3f537c4abf5a080ff978f6b65f6`. Authentication used the existing
GitHub CLI account in process memory; credentials were not printed or retained.
The adapter called `main-ci-health.mjs` in `report` mode, with its normal live
job/checkout/ancestry/rerun verification and quota guardrails.

| Field | Result |
| --- | --- |
| Repository / pinned main | `picoduck/wollipog` / `b0b1313e420df3f537c4abf5a080ff978f6b65f6` |
| Health | `passing`, zero backlog commits and unvalidated age, no unresolved failure |
| Passing worker / attempt | [40229673312 / 1](https://github.com/picoduck/wollipog/actions/runs/40229673312/attempts/1) |
| Tested target / workflow revision | Both `b0b1313e420df3f537c4abf5a080ff978f6b65f6` |
| Worker completion | 2026-10-25T20:46:12Z; independently reverified during this observation |
| Coverage | `rolling-full-v1`; full checkout and target/workflow ancestry verified |
| Suite version | `6f90c7f874312be09cfae284acf0f5886bb88f791a28c7253532a8d8d7601504` |
| Complete report SHA-256 | `bceec599469d54bebe838cd5f7dc397c112ff6d9788cb4620fbdd414a436ac2e` (JSON serialization used by the adapter) |
| Calls | 24 total, all REST reads, zero mutations, zero retries |
| API cap / remaining floor | 96 calls / 3000 remaining; observed REST 4904 of 5000 |
| Decision | `ordinary-admission-eligible`, enforcement `none` |

The integration identity was **inert**, using live main as both base and target.
It was not an actual PR or queue entry, did not receive any check/status and cannot
authorize merging. The health observation itself was live. The full report and
decision were retained locally for investigation; the digest above identifies that
historical report, not evidence that may be reused for a future decision.

This demonstrates fresh reevaluation of caught-up idle main even though its full
suite completed hours earlier. It does not measure natural shadow workflow timing,
failure detection, hold enforcement, repair admission, production incident closure,
quota under load or a check-to-merge race. No policy setting was enabled to obtain it.

## Inert Checks and Remaining Recovery Proof

`scripts/main-merge-admission.test.mjs` covers missing/malformed/foreign evidence,
stale and future observations, full failures retained despite an older pass,
incomplete full certificates, exact base movement, unknown/rate-budget failure,
backlog and age equality, threshold crossing while collection runs, changed repair
heads and label/prompt/receipt refusal. It checks that the live adapter requests
only `report`, retains the complete report, and records a hold when collection fails.
The workflow contract proves no admission dependency into required checks.

These are fixtures, not live enforcement. The remaining #3633 slice must consume
#3635's merged candidate interface and demonstrate the complete dry-run recovery:
hold → independently validated exact repair integration → actual merge-identity
reconciliation → verified main-health release, plus rollback restoring full queue
validation before removing any hold. No cutover may precede that proof. See the
[operator runbook](main-merge-admission.md) for the exact proposed contexts, bounds,
outage limitations and separate human approvals.
