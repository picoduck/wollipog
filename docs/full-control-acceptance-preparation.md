# Full Control Acceptance Preparation

Issue #2939 remains open. This stack prepares independent contract joins and an executable,
fail-closed live handoff on exact foundation `4d545faa2ba97cc9d865930bf9694eca76b39fdf`
(PR #3061). It must never merge into the foundation branch. Final delivery transplants only this
stack's owned commits after prerequisites actually land on main, reconciles the current contracts,
and repeats exact-head review, branch CI, merge-group CI and typed merge approval.

## Executable Preparation

From this worktree:

```sh
node scripts/full-control-acceptance.mjs matrix
node scripts/full-control-acceptance.mjs run-deterministic
node scripts/full-control-acceptance.mjs check-plan scripts/fixtures/full-control-live-plan.json
pnpm exec playwright test apps/web/e2e/delegated-ui-evidence-live.spec.ts apps/web/e2e/campaign-status-live.spec.ts
```

`run-deterministic` uses a static suite allowlist and no shell interpolation, removes injected
hosting Session/control-plane/runner configuration, and stops on a failure. The selected suites
run real production services/storage/driver parsers against synthetic runners and isolated local
data. A subprocess restriction must be resolved by the execution harness rather than counted as
a passing test. No suite invokes a live model or publishes to a real tracker. Browser tests use
temporary local control planes; “live” in their filenames means HTTP/browser integration.

`check-plan` prints only missing-input codes and returns **2 (blocked)** even if every field is
filled. It checks plan completeness, never grant validity, server enforcement, actual delivery or
production readiness. JSON digests and claimed authorizers cannot create a Human allowance or
certify a namespace. There is intentionally no live-execution switch. `matrix` prints the ordered
operator handoff; missing integrated production adapters are a blocker, not a disabled-preview
positive result.

The new `full-control-acceptance.integration.test.ts` joins one fixture authenticated-human
foundation admission with root provider planning and inspection, generic child inspection, exact
typed child decisions, concurrent one-shot consumption and database reopen on both declared
managed driver paths. It rejects synthetic screenshot evidence, creates different repaired
artifact bytes, refuses old digests and unacknowledged delivery, then approves/consumes the new
exact occurrence. It also replays one protected credential exception while a sibling consumes
authorized work, revokes a grant on restart, and demonstrates actual scope/video human fallback
on the foundation. A fixture principal is test setup; it is never a live issuer.

## Existing Coverage and Integration Boundaries

| Acceptance surface | Deterministic coverage reused | Required integrated/live proof |
| --- | --- | --- |
| Initial authorization and root/child permissions | New joined suite; foundation campaign-authority tests; runner additive/permission tests | #2940 human launch/default/live ingress composes issue, budget and evidence boundaries once; record exact revision, scope, allowed effects and unchanged worker selection |
| Scope, sanitation, publication and closure | Campaign Status ledger dedup/accounting; current scope human refusal | #2935 accepted-origin lineage, exact sanitized payload and duplicate reservation, actual issue readback and enforced closure; no production tracker effects in CI |
| Review feedback and repair | Different screenshot bytes, original occurrence denial, replacement receipt/consumption; driver/service tests | Verify the actual reviewer identified a defect, independently reproduce it, repair code, review changed head and bytes; synthetic rejection is not a quality verdict |
| Screenshot delivery | Existing delegated-image HTTP/browser digest/receipt route coverage; joined service test | Actual selected model receives private attached bytes and answers a fresh blind image challenge; identifiers and acknowledgments alone are insufficient |
| Normal video | Existing candidate complete-frame decode/transient/integrity tests; normal video fails closed on foundation | #1321 registered normal-profile runtime/transport/admission/decision bridge and trusted all-source-frame temporal proof, criteria/defect verdict and measured maximum-profile model cost |
| Native code review and allowance | Existing bounded review/usage contracts inspected read-only | #2936 exact native controller/executable/account/profile admission, durable job identity and final priced usage settlement; native code jobs do not attest managed media delivery |
| Exact-head CI, merge queue and delivery | Existing workflow-action reconciliation routes and ledger/forge-state tests | Actual required check on pushed reviewed SHA, matching canonical command admission, successful merge-group check, forge MERGED and commit present on default branch |
| Recovery and decision inspection | Existing steering, descendant routes, durable reports/attention and action reconciliation suites | #1448 and #1469 supported agent recovery/read paths; #2938 bounded single-flight recovery and unknown-outcome fences on final integrated runtime |
| Cleanup and completion | Campaign Status cleanup refusal and report verification; attention persistence suites | Actual branch deletion after safe stacked handoff, managed worktree retirement, session Stop/Archive confirmation, informational completion with no required acknowledgment |

These files intentionally do not import sibling implementations. Inspected preparation snapshots:

- #2935 PR #3063: `1ed656018aa282bf5c084ad8ad117207088ad93a`, protocol 216 issue authority.
- #2936 PR #3065: `828464a9a8272d42d5f49f8a1482ee5959ea0cc2` at initial inspection;
  its continuing corrections and exact native-review contract must be read again at integration.
- #1321 production preparation: `efa6ea5210ad939f2ed2af3f2ac227009ed2f935`;
  offline PR #3053: `1f379ed690d3b7bcd0850c55ef5285a4c6459de6`.
- #2938 PR #3068: `9eb186d24593835b8ae4d83bbf6ab246d1c79365`.
- #2937 PR #3066: `db5bb75ae3f496fd5742e511d98f459d588c4063`.
- #2940 PR #3069: `0590591767e42b258919739b463458cff94c8f56` (unsupported launch preview).
- Exact #1448 and #1469 issue bodies remain open: uncertain steering recovery and descendant
  workflow-decision read access respectively. Neither is proof of informational completion.

Scope 216, budget 217 and proposed evidence 218 are sibling contracts, not capability declarations
from this branch. Main integration must register real adapters and preserve all optional authority
subobjects. A default-off short operator candidate cannot substitute for normal-video readiness.
The matrix's criterion names describe its target surfaces; the current descendant-route tests
exercise audience and own-child decisions, not the unfinished #1469 ancestor enumeration API.
Scope/budget/evidence composition and exhaustion tests remain pending until those production
contracts exist together. Do not fill that gap with a synthetic all-approved owner table.

## Concrete Live Proposal, Awaiting Human Limits and Operator Resources

`scripts/fixtures/full-control-live-plan.json` names the proposed **private** isolated repository
`picoduck/wollipog-full-control-2939-validation`, synthetic issue #1 and one related follow-up. It
does not claim that repository exists or that anyone approved creating it. Operator setup must
create/verify that exact private destination and sanitized seed issue before the observed campaign,
or explicitly approve a revised exact plan. Do not use `picoduck/wollipog` for validation effects.
Seed fixtures and bootstrap effects are disclosed separately from the measured positive campaign.

Proposed aggregate admission bounds are **$40 model-priced usage, 1,200 distinct tool calls, two
concurrent descendants/jobs, one accepted follow-up, 180 minutes and six fault attempts**. These
are proposals, not authority or guaranteed invoice caps. The operator must inspect current official
pricing, context/frame feasibility, native invalid-attempt cost and stricter Session/organization
limits before minting the exact envelope through authenticated human ingress. Exhaustion stops
without repeated overrides; unknown usage keeps reservations. If normal/maximum media cannot fit,
report that concrete refusal rather than silently increasing limits, sampling frames or using an
external unaccounted reviewer. All positive and fault attempts share the original ledger/allowance.

Root/implementation path: fixed Codex App Server / `gpt-6.1-sol` / high, existing runner-default
OpenAI account. Proposed media path: a separately admitted, narrowed managed Session on that exact
provider/model only if its actual capability and namespace probes pass. Native code review remains
Claude Opus 5.5 / high / Read-only using the exact #2936 admitted controller, executable hash, CLI
version and existing runner-default Claude account. Neither account is provisioned, inspected for
secrets, copied or changed by this preparation. Provider-account retention and permissions are
human-only inputs. Persistent grants and unsupported profiles remain exceptions.

Disposable data paths are listed under `/tmp/wollipog-2939-live/` in the proposal. An operator must
create a fresh owner-only run directory (refuse existing state) and bind its canonical paths into
the exact plan before authorization. Select new loopback ports and separate runner/provider state;
do not restart or configure the hosting stack. Relevant sanitized generated media goes only to
that disposable control plane's private Session artifact store. The initial disclosure names the
actual private destination, audience, retention/deletion policy and provider-local transcript/media
retention outside Wollipog's metadata-only audit guarantee. No arbitrary file or unrelated Session
upload is authorized. Retaining private proof artifacts requires the operator's exact retention
decision before deleting disposable storage.

Before generating fresh random oracle content, probe the **actual launched review boundary**:
media-only registered tools and an enforced filesystem/network/resource namespace excluding the
generator, oracle, operator directories, shared provider history and every unrelated Session.
Record direct-path, symlink, parent-traversal, shell/search/plugin/resource/management refusal and
the actual tool/capability digest. Separate folders, prompt omission or a cooperative reviewer
assertion do not create a blind oracle. Generic coding worker tools must never inherit this media
namespace, and native code-review admission must never stand in for media admission. If the
managed driver cannot enforce it, the live plan remains blocked.

The #1321 handoff's offline generator prepares fresh candidate, paced and maximum challenges only
after that boundary exists. Normal proof must include readable native resolution, complete ordered
source frames, presentation timestamps/durations, contiguous partitions, source/manifest/criteria
digests and exact delivery receipts. The initial UI Evidence Approval occurrence retains its
original source artifact IDs and resource snapshot; trusted managed reviewer identity, namespace,
allocation, complete delivery and criterion/defect verdict are separate references. Do not invent
parent-received worker receipts or replace the sole authority gate. A native job, static screenshot,
synthetic receipt, blind-answer claim or advertised image capability does not prove temporal review.

## Fault Schedule and Required Observations

| Fault attempt | Injection | Assertion on authoritative records |
| --- | --- | --- |
| 1 | Restart/reconnect after durable reservation and before response | Same authority/allowance/review epoch; no second provider launch, effect or reservation refund; stale unconsumed grants revoke |
| 2 | Concurrent approve/consume and stale snapshot | One winner; old head/artifact/revision cannot consume; no reset by replacement worker identity |
| 3 | Transient evidence/decode failure | Bounded queue/retry/recapture; unchanged exact gate binding; complete coverage retained; unrelated authorized work continues |
| 4 | Uncertain steering, follow-up publication or merge response | Inspect exact durable submission/payload/head/forge object before replay; unknown stays fenced; no duplicate issue or merge |
| 5 | Auth, unknown human information, foreign scope and Human Required ask | One actionable owned exception with reason/resource/input; no agent issuer or sign-in workaround; sibling work proceeds |
| 6 | Hard denial, exhausted/unpriced allowance and unsupported peer | Stop admission, preserve usage/reservations and failed attempt accounting; no repeated override prompt or substituted profile |

Use the original bound for all faults. No interactive authentication, unavailable human information,
out-of-bound effects or mandatory Human Required rule is part of a successful zero-prompt route.
Exceptions must remain visible and truthful; the negative run demonstrates graceful interruption,
not a successful unattended positive run. Lack of a required acknowledgment is observed at the
result/attention/notification surfaces rather than inferred from a role or owner fixture.

## Result and Cleanup Contract

The operator's private result bundle must retain exact initial server-authorized scope/budget/evidence
digests, effective driver/model/provider/profile and capability limits, every post-authorization
human request/acknowledgment/policy edit, media source and ordered receipt bindings, independently
verified blind quality answers, defect/fix/review head records, native review job/adjudication/usage,
both forge PR/check/merge-group/merge readbacks, accepted follow-up lineage/sanitized payload/dedup
and publication readback, delivered-vs-remaining closure evidence, stacked-dependent checks,
branch-ref absence, retired managed worktree receipts and confirmed Stop/Archive states.

Record model-priced usage (tokens/cache/pricing provenance), latency and billed usage separately.
An invoice not yet available is **unavailable**, not zero or equal to the model estimate. Record
all paid invalid reviews and failed live attempts. Private raw provider/media/oracle evidence stays
out of repository commits, ordinary audit logs and public issue comments. References/digests alone
are correlation; independently inspected authentic server/provider/forge records supply proof.

On failure, stop only disposable processes. Reconcile unknown mutations and provider final usage
before releasing reservations, retrying publication or removing state. Keep dirty/unpushed worktrees
and stacked base refs, report their exact blockers, and leave helper final reports for the controlling
parent to verify. Never reset limits or review counters by starting another campaign/epoch. A
successful enqueue, claimed `merged` stage or closed issue alone is insufficient completion.

No real live provider delivery, temporal recognition, metered campaign cost, isolated test repository
creation, issue publication/closure, forge merge or configured cleanup is established by this stack.
All original #2939 integrated/live criteria remain pending until those actual observations exist.

Normal-video empirical certification is a distinct prerequisite phase. If the integrated #1321
contract still requires authenticated-human inspection/registration of profile proof, complete
that separately authorized operator phase **before** the measured campaign's initial authorization.
The candidate/paced/maximum trials need their own exact finite authorized reservations and retained
cost evidence; the proposal's $40 is a planning ceiling for the combined exercise, not permission
to create that preliminary allowance. A later certification prompt or human proof registration
during the measured campaign invalidates the zero-prompt positive result. Any capability change
invalidating the prior proof ends that attempt rather than moving the boundary silently. A read-only
operator can compare the final campaign's blind response to its oracle afterward; that comparison
must not be a required intervention that unblocks a campaign stage.
