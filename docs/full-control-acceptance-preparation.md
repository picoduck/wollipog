# Full Control Acceptance Preparation

Issue #2939 remains open. This main integration ports only the five owned acceptance paths
from preparation PR #3070 onto pinned main `827c84de8a7d6bcdcdd9f68d9d851cbb1c34ec5c`.
Its original range was `4d545faa2ba97cc9d865930bf9694eca76b39fdf` through
`1f17c8d489d461c6498bdb5c5b1642e91159240f`; no foundation or dependency implementation
is transplanted. Historical review findings, raw attempts and usage remain retained independently.
The original `a13dedca37c83dff15ae7dfaf7d344b623d757f1` payload and inert `49017d7f9f04e1d3eddd360ad85b7644b70eccef`
port packet remain unchanged historical evidence. This port updates only current-base and recovery
coverage declarations; it does not replay or turn historical failures into passes.
Current protocol 222, including child-at-create attribution/transaction rollback and repeated-provider
rejection recovery, stays intact. The merged #3230 touch behavior and #3260 settled opening-frame
fixtures are preserved without editing their implementation or tests. Preparation tests do not complete the original live release criteria.

## Executable Preparation

From this worktree:

```sh
node scripts/full-control-acceptance.mjs matrix
node scripts/full-control-acceptance.mjs run-deterministic
node scripts/full-control-acceptance.mjs check-plan scripts/fixtures/full-control-live-plan.json
pnpm exec playwright test apps/web/e2e/delegated-ui-evidence-live.spec.ts apps/web/e2e/campaign-status-live.spec.ts
```

`run-deterministic` uses a static suite allowlist and no shell interpolation, removes injected
hosting Session/control-plane/runner configuration including legacy MAM names, case variants,
provider/account configuration and credential environment names, and stops on a failure. This
scrub limits subprocess inheritance; it is not filesystem/network/context isolation. The selected suites
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
authorized work, revokes a grant on restart, and demonstrates current scope/video human fallback.
New bounded joins record the child's work attempt before launch, reject both returned and thrown
ledger failures without leaving reservations/launches, then consume an exact implementation
decision after retry/reopen. Plain-file inspection uses structured path metadata; root Git
inspection remains protected because Git can invoke repository helpers. A fixture principal is
test setup; it is never a live issuer, and a synthetic runner launch is not a native provider job.

## Native Feasibility Before Live Authorization

The fixed release target remains Codex App Server, `gpt-6.1-sol`, high effort. Offline inspection
of installed Codex `0.162.1` found executable SHA256
`628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1` and freshly generated
experimental `ThreadStartParams` schema SHA256
`80a40a7fac15b4bf70efb7f893fb353acc0a0d30c68f54aee4f01923deca85de`.
Schema generation makes no inference request. These digests identify inspected inputs,
not runtime enforcement or compilation provenance.

Release-pinned source contains real internal `ToolPolicy.allowed_tools` and
`SessionIsolation::Isolated` primitives supplied through `ExtensionDataInit` before core startup.
The policy is captured once, must be supplied again on resume and defaults to ordinary tool
selection. Isolation removes inherited extensions/instruction providers and implicit Apps/MCP.
The App Server `ThreadStartParams` interface does not expose those attachments, and its startup
task initializes only selected capability roots in the fresh extension data. Its in-process
App Server interface does not add a per-thread policy hook either. Native control APIs also need
isolation: `thread/shellCommand` is explicitly an unsandboxed host escape.

The official [App Server documentation](https://learn.chatgpt.com/docs/app-server) describes
experimental dynamic tools persisted on resume. The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes narrower shell/image/MCP/connector switches. Adding dynamic tools, omitting prompts,
emptying environments, accepting arbitrary config keys or advertising image modality does not
establish complete native tool/context/FS/network/resource/API restriction.

Codex media preflight therefore stays **unsupported / `builtin_tool_allowlist_unavailable`**, and the
plan's media boundary no longer accepts it. The boundary now requires the Claude Code media-only
reviewer from #1321 PR B (`docs/video-evidence-media-reviewer.md`): driver `claude-code`,
`claude-opus-5-5` at high effort, profile `claude-code-media-only-v1`, pinned CLI `2.1.296`, exactly
the `review_video_evidence_frame` and `submit_video_evidence_verdict` tools, a dedicated API key, the
runner's executable and namespace policy digests, a denied-routes probe digest, and an
`attestationSha256` equal to the media `capabilitiesSha256` that the certification proof names.
Every other check is unchanged. A possible upstream/native-host bridge to the internal
startup hooks requires separate owner coordination, authorization, immutable resume enforcement
and adversarial denied-route evidence; acceptance preparation does not implement or activate it.
The proposal now records the inspected native inputs and absent enforcement prerequisites.
Filling those fields with synthetic references still returns blocked and cannot certify readiness.
No implementing/reviewing model may inspect private oracle, expected truth or generator inputs
to prove blindness. Native dispatch/usage receipts remain separate from media delivery and quality.

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
| Recovery and decision inspection | Existing route fixtures cover agent uncertain-steering resolution, ancestor decision read/list with status and pagination, audience refusal and ancestor consume/reconcile refusal; runner steering and durable recovery suites are reused | Actual integrated recovery/read delivery and #2938 bounded single-flight recovery with unknown-outcome fences remain live proof requirements; closed #1448/#1469 alone do not satisfy them |
| Cleanup and completion | Campaign Status cleanup refusal and report verification; attention persistence suites | Actual branch deletion after safe stacked handoff, managed worktree retirement, session Stop/Archive confirmation, informational completion with no required acknowledgment |

These files intentionally do not import sibling implementations. Historical preparation snapshots
(retained for lineage, not current supported capability declarations):

- #2935 PR #3063: `1ed656018aa282bf5c084ad8ad117207088ad93a`, protocol 216 issue authority.
- #2936 PR #3065: `828464a9a8272d42d5f49f8a1482ee5959ea0cc2` at initial inspection;
  its continuing corrections and exact native-review contract must be read again at integration.
- #1321 production preparation: `efa6ea5210ad939f2ed2af3f2ac227009ed2f935`;
  offline PR #3053: `1f379ed690d3b7bcd0850c55ef5285a4c6459de6`.
- #2938 PR #3068: `9eb186d24593835b8ae4d83bbf6ab246d1c79365`.
- #2937 PR #3066: `db5bb75ae3f496fd5742e511d98f459d588c4063`.
- #2940 PR #3069: `0590591767e42b258919739b463458cff94c8f56` (unsupported launch preview).
- #1448 and #1469 were both closed on 2026-10-13. Their delivered source is present in the pinned
  base: `session-descendants-route.integration.test.ts` covers agent uncertain-steering recovery
  and durable ancestor workflow-decision inspection, including read/list restrictions. These
  deterministic source assertions and issue closures do not prove the campaign's actual live
  recovery/read delivery, provider behavior or informational completion.

Historical scope 216, budget 217 and proposed evidence 218 snapshots are not current capability
declarations. Pinned main uses protocol 222 and includes the budget/native CODE kernel and
child-at-create rollback; media runtime registration and full live acceptance remain absent.
Protocol 222 and merged candidate code do not establish registered native/media runtime support. Final integration must preserve
all optional authority subobjects. A default-off short operator candidate cannot substitute for normal-video readiness.
The matrix's criterion names distinguish delivered deterministic route coverage from remaining
integrated live proof. Current descendant-route fixtures exercise ancestor decision read/list,
status retention, pagination, audience restrictions and refusal of ancestor consume/reconcile;
these checks do not establish model-visible delivery in this campaign.
The matrix now reuses current finite-budget/native-job and repeated-provider rejection suites;
their fixtures cannot prove actual provider dispatch, daily/tighter limit faults, unknown orphan
ownership or media readiness. Complete scope/budget/evidence/native composition remains a live
prerequisite. Do not fill that gap with a synthetic all-approved owner table.
The executable matrix lists actual integrated steering recovery and descendant decision inspection under `pending`; passing the listed deterministic contracts does not establish their live delivery in this campaign.

## Concrete Live Proposal, Awaiting Human Limits and Operator Resources

The Human decided that the live #2939 run targets `picoduck/wollipog` itself, not an isolated
sandbox repository, under a Human-set **$200** ceiling. `scripts/fixtures/full-control-live-plan.json`
records that decision as `repositoryTarget` (`kind: "human_authorized_repository"`,
`authorizedBy: "human"`, the repository and `costCeilingUsd: 200`). The check admits
`picoduck/wollipog` only through that explicit target, only when the target names the plan's own
repository and only while `limits.costUsd` stays within the ceiling. The report then asks for
`human_repository_target_authorization` instead of `isolated_repository_operator_authorization`.
A plan without a target still rejects `picoduck/wollipog`, so the isolation check is not weakened
for any other plan. Agent-authored JSON is not evidence of the Human's decision; the Human still
confirms it through the authenticated ingress. Seed fixtures and bootstrap effects are disclosed
separately from the measured positive campaign.

Proposed aggregate admission bounds are **$200 model-priced usage, 1,200 distinct tool calls, two
concurrent descendants/jobs, one accepted follow-up, 180 minutes and six fault attempts**. These
are proposals, not authority or guaranteed invoice caps. The operator must inspect current official
pricing, context/frame feasibility, native invalid-attempt cost and stricter Session/organization
limits before minting the exact envelope through authenticated human ingress. Exhaustion stops
without repeated overrides; unknown usage keeps reservations. If normal/maximum media cannot fit,
report that concrete refusal rather than silently increasing limits, sampling frames or using an
external unaccounted reviewer. All positive and fault attempts share the original ledger/allowance.

Root/implementation path: fixed Codex App Server / `gpt-6.1-sol` / high, existing runner-default
OpenAI account. Media path: the separately admitted Claude Code media-only reviewer
(`claude-opus-5-5`, high, dedicated runner-local API key) only if its runner attestation and actual
namespace probes pass and a current Human-recorded live proof certifies that exact attestation. Native code review remains
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
The executable ordering places certification before measured authorization, and the plan checker
requires its proof reference/digest, capability binding, separate operator reservation and completion
timing flag. These are proposed evidence references only; the checker cannot verify their authenticity.
