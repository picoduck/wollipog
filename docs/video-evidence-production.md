# Production Video Evidence Integration

This is the #1321 follow-on implementation stack. PR #3053 delivers offline preparation only.
The stack starts at foundation commit 4d545faa2ba97cc9d865930bf9694eca76b39fdf plus the two
exact reviewed preparation commits. Final main delivery must transplant only these owned changes
after #2934, #2935, #2936 and #3053 actually merge, and repeat cross-model review and exact-head CI.

## Owned Modules and Contracts

- protocol/campaign-evidence-authority: optional human-minted narrowing envelope on
  CampaignAuthorityBoundary.evidenceAuthority. Existing UI Evidence Approval remains the authority.
- evidence-authority: derives provenance from the authenticated human and exact current private
  destination/provider disclosures; a proposal cannot claim a public destination is private.
- video-evidence-runtime: trusted complete source derivation, pinned acceptance criteria,
  exact immutable context, ordered acknowledgements, separate criterion/defect verdict provenance.
- video-evidence-artifacts: concrete private content-addressed frame storage, exact-source deletion
  and bounded expiry cleanup for crashed staging, without trusting caller-authored metadata.
- evidence-review-service: authenticated owner/reviewer methods, post-decode revocation checks,
  bounded retries and metadata-only lifecycle audit ports.
- video-evidence-runtime-store: durable SQLite metadata with private artifact-storage ports;
  no raw bytes, signed URLs, storage credentials, or oracle content enter audit records.
- evidence-review-admission-store: durable dispatch intent and unknown-launch reconciliation,
  immutable settled managed snapshots, no invented Session identity or transferable allowance.
- video-evidence-decision-bridge: original snapshot/resource digest stays unchanged; direct owner
  image inspection IDs remain separate from actual worker video references. Current authority and
  full provenance are rechecked at resolution and consumption; no parent-received receipts are made.
- evidence-review-worker: admitted managed Session identity and allowance adapter, exact human
  provider/model envelope, protected readiness, request digest and unknown-outcome reconciliation.
- evidence-review-recovery: two busy retries or replacement captures, no sampling/downscaling,
  recorded single-frame overflow recapture. Busy exhaustion waits for capacity; inadequate capture
  exhaustion recommends exact typed rejection for child correction, not a new human permission.
  Custom and genuinely unavailable trusted capability/access retain human fallback.
- video-evidence-review-routes: exact credential-to-path binding, bounded media/ack/verdict methods,
  no-store responses and separate owner provenance; not yet registered in the hosting entry point.
- runner/evidence-review-namespace: allowlist mount namespace with no host-root/project bind and
  synthetic kernel probes denying oracle, generator, parent-path and symlink access.
- runner/video-evidence-review-mcp: a two-handler registry enforces media-only names at discovery
  and dispatch, with current actual Session/namespace checks; generic file, management, upload and
  native code-review-job handlers are excluded. It is not yet registered in a live managed Session.
- runner/video-evidence-review-transport: pinned full-context/criterion/native-frame verification
  before authenticated acknowledgement and model image handoff; never claims typed approval.
- video-live-validation: durable human-inspected candidate/paced/maximum empirical proof,
  bound to exact driver/model/provider/capability digest. No default record is supplied.
- scripts/prepare-video-live-challenge.ts: offline fresh synthetic source/oracle preparation.

The reviewer modules currently have no hosting entry-point caller. Artifact maintenance is
prepared in the source tree only; the hosting process has not been changed or restarted. They do not advertise a current runner
protocol revision or activate production. Protocol 218 is reserved for final production integration,
after scope 216 and allowance 217. #2936 owns campaignBudgetWorkerPreflight and
allocateCampaignBudget; the final adapter must use durable managed admission before dispatch and
retain live reservations until cancellation/completion settles. An external process is unsupported.

## Supported Admission Envelope

The paced profile covers one silent VP8/VP9/H.264 WebM/MP4 stream, native 960x540–1280x720,
up to 30 seconds / 900 frames at observed intervals of at least 33ms, source at most 32 MiB,
PNG at most 2 MiB/frame and 128 MiB total. Native decoding remains network-isolated, bounded
by memory/CPU/wall time and a two-active/two-queued decoder. Contiguous partitions preserve every
source frame, presentation time and duration. Consecutive delivery batches include at most 32
images and at most 8 MiB of encoded response data, shrinking the window when native frames are
large. Every frame is independently verified; acknowledgements commit atomically before any
image is handed to the model. A missing or changed frame withholds the entire window. Partitions are delivery boundaries, not sampled clips.

The duration/resolution limits are conditional admission ceilings, not universal content guarantees.
An offline maximum testsrc2 720p/30fps/30-second clip exceeded the existing PNG conversion envelope.
That is a genuine refusal and original-issue feasibility evidence, not live validation. The bounded
testsrc synthetic challenge fits all 16/360/900 frames; it does not establish that every detailed
30-second capture fits. Splitting/recapture must preserve coverage and create new immutable artifacts
and occurrences. A single-frame overflow specifically requires simpler readable recapture; splitting
duration cannot repair it.

## Exact Operator Validation Proposal

No campaign agent has permission to perform this operation on the hosting stack. The proposal is
for an authenticated human/operator to execute on a separately isolated disposable service/runner
after the integrated code is reviewed. Before execution, freeze its reviewed commit, concrete
campaign and Session IDs, actual provider/model, disclosed private artifact configuration, and the
#2936 metered reservation. Those exact resources must be approved through their enforced routes.

1. Create an isolated service using a new operator-owned temporary data directory, a new loopback
   port, CONTROL_PLANE_DB pointing only to that temporary database, and CONTROL_PLANE_ARTIFACT_DIR
   pointing only to its private temporary artifact directory. Use a separate managed runner state;
   no hosting database, state directory, port, process, or settings are modified.
2. The authenticated human creates a dedicated campaign, repository/issue scope limited to #1321
   validation, UI Evidence Approval owner, private destination disclosure and exact provider retention
   disclosure. Human-mint the Full Control boundary and metered managed reviewer allocation.
   The live worker must already have a durable same-campaign ledger admission; external shell
   reviewers and fabricated zero-cost accounting are refused.
3. For the existing candidate, the operator selects only the exact isolated controlling Session via
   CONTROL_PLANE_VIDEO_FRAME_REVIEW_VALIDATION_SESSION_ID before that disposable service startup.
   This is not an agent-authorized environment change and never applies to the hosting service.
   Normal-profile exercises additionally require a separate exact bounded experimental allowance;
   image support alone does not authorize or establish temporal review.
4. The human/operator runs the following from the reviewed worktree, using new absolute directories
   outside reviewer workspace/context. Directory separation and prompt omission alone are not a
   blind boundary. Before generating the fresh oracle, establish and test a narrowed media-only
   reviewer tool or filesystem namespace. The actual reviewer must be unable to access the oracle,
   source generator, recipe, expected truth, operator storage or other Sessions through generic
   Read, shell, search, network/file tools, plugins, MCP resources or management APIs. Do not change
   campaign isolation preferences or broaden provider grants to achieve this.

   Preserve runner-owned evidence of the exact available tool set, namespace/mount allowlist and
   capability digest. Probe forbidden paths/resources from the actual narrowed reviewer boundary
   without displaying their contents; verify both direct and symlink/parent traversal access fail.
   A policy prompt, read-only write sandbox, separate directory or cooperative reviewer assertion
   is insufficient. If the installed managed harness cannot enforce this restriction, stop live
   admission with a concrete unsupported-readiness reason.

   Use an existing operator-only parent directory as the excluded root, then a new private
   oracle subdirectory for each challenge. Seed fresh approved provider state; do not expose a
   shared provider HOME containing old conversations, projects or expected truth. Enforce the
   exact media-only tool set and strict MCP server configuration in the actual driver; the
   standalone namespace builder and unit probes alone do not certify a launched reviewer.

   Generate the private oracle only afterward in the operator namespace, outside all reviewer
   accessible inputs. The narrowed reviewer receives the immutable synthetic capture through the
   scoped audited media transport and unbiased criteria; capture transport/source/criterion/verdict/
   usage evidence without leaking random overlay values, timestamps or oracle hints. Use:

   node --import tsx apps/control-plane/scripts/prepare-video-live-challenge.ts \
     --capture-dir <new-private-capture-directory> \
     --private-oracle-dir <separate-operator-only-oracle-directory>

   Use a fresh run. The existing fixture recipe and local smoke-test oracles are disclosed test
   material and cannot serve as blind challenges. The generator performs no model call or upload.
   It prints only source/profile metadata and the oracle commitment; it never prints oracle bytes.
5. Attach only the synthetic candidate/paced/maximum capture bytes through the authorized private
   evidence path, with exact artifactId/mediaType/sizeBytes/sha256. Keep the oracle separate.
   The operator must independently verify the narrowed namespace still holds at dispatch.
   Feed every source frame in source order with exact timestamps and contiguous segment coverage
   through bounded consecutive multi-image batches in the actual audited MCP tool-result transport to the managed reviewer. Do not replace
   this with local verifier output, screenshots sampled from a recording, mocked transport,
   a normal worker message, or a receipt merely asserted by a caller.
6. Require an authenticated criterion/defect verdict and blind answer describing the random transient
   overlays, geometry, order and exact source timestamps. The human compares the completed answer
   against the private committed oracle only afterward. Preserve exact complete ordered receipt
   sets and model-visible delivery evidence. A mismatch leaves production unsupported.
7. Collect actual provider usage, latency and current official pricing/cost evidence for all three
   runs, including the maximum admitted profile. Verify capability/context capacity and provider-local
   retention, not only protocol acknowledgement. Record only digest/reference metadata after the human
   independently inspects all evidence. No synthetic proof record or fake live receipt is permitted.
8. Only the authenticated human ingress can register the inspected proof. The existing typed decision
   owner must still review server-verifiable provenance and resolve/consume the exact UI gate.
   A proof expires or revokes with changed capability/provider/model; it does not broaden the
   upload destination, workflow ownership, scope, allowance or provider permissions.

No real live delivery, model temporal recognition, model usage/cost, external transfer, human grant,
or production activation has occurred in this implementation session. Until the final adapters,
human-only empirical proof and preceding main dependencies are present, readiness fails closed.

## Remaining Integration

The private `operator-video-validation.ts` permit path prepares first-proof admission without
claiming that a production profile has passed live validation. It is code/interface preparation,
with no hosting route or installed native sender/driver registration. Only an authenticated Human
owner/admin who established the current boundary may mint a finite permit after the trusted server
adapter has verified the original **Human-owned** pending UI occurrence and its exact source,
complete native manifest/ordered frame set, criteria, private destination/provider disclosure,
installed executable/tool/namespace profile, audience and current action/allowance constraints.
The original gate stays Human-owned and its resource digest remains unchanged.

Human mint requires `expectedScopeSha256` for the exact independently reviewed action scope.
A changed profile/source/criterion/request between inspection and mint is rejected. The permit
expires within one hour and pins finite cost/tool ceilings from the guarded Session
request; it does not create grants or increase existing limits. The ordinary creation pipeline
atomically binds a real unsent Session/member/command/generation and permanent validation purpose
to the one-shot permit. Normal governance, fixed harness/model/effort, tighter ceilings and all
user/org/session/daily/host/child/aggregate/native/media concurrency guards remain required.
Replay, unknown outcome, substituted source/criteria/profile/authority, expiry, revocation and
replacement generation cannot create or reuse admission. Unknown dispatch keeps its reservation.

Trusted runner preparation must bind the exact per-Session namespace launch, reusable policy and
full grant digest before dispatch. Every validation receipt and criterion verdict carries
`operatorValidation={permitId,scopeSha256}`. Transport verifies that purpose; stripping or borrowing
it withholds model images/verdict confirmation. The production runtime approval-provenance method,
original gate bridge and owner preparation service reject validation observations. Human inspection
uses a separate observation method, rechecking complete receipts/integrity and current historical
settlement; it grants no new access, gate approval or production support. Registry proof registration
still requires independently inspected **actual** delivery, fresh blind temporal verdict and metered
usage/current pricing evidence. A fabricated fixture/bootstrap proof is rejected in validation admission.

The 16-frame 640x360 candidate remains a distinct envelope. The normal ≥960-width decoder cannot
process it by labeling it paced or weakening its limits. Its operator transport/derivation adapter
and actual provider-wide restricted-tool enforcement remain held integrations; paced/maximum use
the complete native derivation contract. Deterministic permit/Session/transport tests are disclosed
synthetic tests and prove no live provider behavior or oracle isolation.

### Reviewable Isolated Live Action

Before any separately Human-authorized live action, fill and inspect this exact action record using
the isolated test control plane's actual immutable records. Placeholder or unknown fields mean
unsupported admission; a campaign code-design approval cannot authorize the action.

| Pinned Item | Required Evidence |
| --- | --- |
| Campaign/work item/original occurrence | Actual campaign, #1321, Human owner, child/evidence IDs, pending occurrence, source and criterion digests, current policy/boundary/scope revisions |
| Destination/provider | Exact configured private Session-artifact destination/org/disclosure, provider identity and retention; independently verified privacy |
| Installed reviewer | Actual managed Session/admission/runner/dispatch generation, fixed driver/model/effort, executable and native two-tool profile digests |
| Isolation | Disposable new ports/DB/artifact/provider state, exact namespace launch/policy, verified inaccessible fresh oracle/generator/truth across actual tools/filesystem/resources/APIs |
| Three separate bounded runs | Fresh candidate16, paced360, maximum900 captures/complete derivations; finite cost/tools and expiry within existing allowance for each one-shot permit |
| Dispatch/recovery | Exact durable command/grant digest, no replay after unknown reply, retained unknown allocation, authenticated terminal fence and final accounting |
| Inspection | Complete ordered receipt and model-visible transport digests, unbiased criteria/blind answer, private oracle commitment comparison after completion, genuine final usage/latency/current official pricing |

No live executable command is offered until the actual registered restricted driver/sender and
candidate adapter support the record. Existing fixture recipes or previous smoke oracles cannot
be used as blind challenges. Never point this action at the hosting dogfood ports/DB/provider state,
restart that stack, or silently change policy, isolation, account, grants or budget ceilings.

Private storage, bounded expiry, authenticated route definitions and runner transport are prepared.
Wire exact current workflow/policy/audience/capability lookup,
accountable worker admission, protected media reading/verdict routes and typed owner resolution.
Compose the evidence envelope through the human-only campaign CAS route without overwriting
issueAuthority or budgetAuthority. Expose specific unavailable/recovery reasons; preserve Custom,
mixed-peer and revocation behavior. Add authenticated service/runner end-to-end coverage after
legitimate integration. Final review retains the prep ledger and its deferred findings.

The frame-overflow recommendation is already recorded by the parent as duplicate of original
#1321 recovery scope. No new follow-up issue is proposed or published.

## Operational Questions

Lifecycle audit events answer why preparation required recovery, whether the queue retried or exhausted,
whether every frame was acknowledged before a quality verdict, and how long preparation took.
The exact occurrence is the correlation ID and entryPoint distinguishes owner preparation, reviewer
media/verdict and owner provenance. The final adapter must feed structured logs and bounded-label
latency/failure histograms; raw bodies, images, signed URLs, oracle content and credentials are excluded.
Human-inspected proof metadata supplies separate actual provider usage, price and latency evidence.

## Completed Reviewer Provenance

The owned `PreparedMediaReservationRelease` adapter and guarded budget method separate an unsent
cancellation from real final usage settlement. The coordinator claims cancellation in the same
SQLite transaction before deactivating the exact unchanged reservation and ending that never-run
Session's queued lifecycle. Existing cost/tool peaks, ceilings, generation, history and permanent
purpose are preserved. Nonzero usage, any usage state/tool record/checkpoint/settlement, replaced
generation, a generic/code-job identity, or an unclaimed/ambiguous dispatch retains capacity.
No fabricated zero-cost usage or completed attestation is written.

An unknown outcome can release only after the owning authenticated runner delivers a durable
exact-command terminal fence. `RunnerMediaDispatchFences` must be consulted before **every**
provider action, delayed command and recovery: cancellation survives disk reopen and forbids
claiming that command later; a previously claimed launch cannot certify never-dispatched status.
The digest is integrity metadata, not authentication. Control-plane ingress uses the actual runner
channel ID and binds original root/Session/generation/command/grant. These sender/channel/driver
registrations are still held; a bare response string or worker message cannot establish the fence.
Ledger reservation deactivation commits with cancellation or rolls back together, including under
concurrent cancel/dispatch and storage failure. This adapter grants no media access or budget reset.

The historical-attestation lifecycle separates completed quality proof from fresh access.
Current managed budget admission is required
for dispatch, media access and verdict submission. The quality verdict durably stores the exact
server worker/allocation/authority snapshot before normal terminal usage settlement.

Normal completion removes fresh media/attestation access; it does not manufacture a new authority
or automatically revoke an otherwise exact completed quality proof. Owner resolution rechecks the
current controlling owner, occurrence/policy/boundary/scope, capability/disclosure, source and every
frame, receipt expiry/revocation and current action/allowance denial. A completed worker cannot be
reused as a replacement or spend from an old snapshot. Hard denial/exhaustion cannot be bypassed.
Final usage must settle one time before unused reservation release. Campaign helper verification
and stop/cleanup remain parent-owned; no helpers have been launched in this implementation session.

## Prepared Managed Media Session Admission

The owned prepared-media-sessions.ts coordinator is a private server implementation boundary; it is not a public Session option or pre-staged automation adapter. The current budget guard rejecting pre-staged automation remains required. Final Session-service wiring waits for the actual foundation, issue scope, and budget contracts to land.

Its same-database materialization callback must run all existing Session creation checks and atomically create the actual Session and budget member with the exact unsent start command. The coordinator rejects mismatched model/effort, changed generations, wider launch ceilings, or a different database. Only then can trusted derivation bind the complete immutable media grant and the actual narrowed namespace launch. The dispatch digest covers that grant, namespace, command, and admitted generation together.

Dispatch records intent before sending and claims it once in SQLite, including across separate coordinator instances. Lost replies and restarts reconcile the original command, runner, Session, and generation; they cannot replay or launch a replacement. Only an authoritative terminal never-dispatched receipt, or locally proven unsent preparation, can release that reservation. Runner absence from an in-memory process list is insufficient. Runner rejection receipts must fence that exact command permanently so a late network delivery cannot start it after cancellation. Final live usage and same-generation completed attestation remain owned by the campaign budget ledger; the media lifecycle cannot invent settlement or zero-cost live accounting.

Offline lifecycle tests exercise atomic rollback, cross-instance dispatch claiming, changed generations, grant substitution, authority revocation and uncertain launch recovery. They establish no actual provider delivery, media Session identity, live usage or readiness. The integrated materializer, authenticated command transport and actual driver namespace enforcement remain required before production support can be advertised.

The evidence-review-budget-provenance adapter separately checks active admission and completed quality provenance. It pins the immutable verdict to the exact original binding and actual worker model/effort/generation. Completed provenance requires the durable same-generation final checkpoint and usage digest, normal completion, and current owner/root action constraints. A code-review job, terminal status alone, changed generation, missing settlement, or overspent pinned allocation cannot stand in for media reviewer proof. Completed status grants no new media access.

The dedicated media-only MCP stdio endpoint advertises and dispatches only the two exact media handlers. It offers no filesystem resources, prompts, management, upload or code-review APIs. Incoming UTF-8 lines, outstanding requests and image responses are bounded; a media operation remains busy until its response drains to the provider. Internal exceptions and supplied paths/URLs are not reflected in errors. EOF drains the final admitted response. Actual provider-wide generic tool disabling and enforced OS namespace remain separate prerequisites; this endpoint alone is not live isolation or delivery proof.

The private Session materializer is now composed on the immutable prepared budget checkpoint 6e0ad1455237f6306305d6a6ec5cfda622fa165d. This is an unreviewed dependency stack, not delivered main code or current-host readiness. The exact replay range-diff is retained outside the repository for parent inspection. Final transplant excludes the dependency and preparation commits.

Materialization reuses the existing Session creation path. Ordinary governance asks are durably preflighted before entering its atomic Session/member/command transaction, then the same current gate is rechecked inside. The trusted resolver supplies configuration and current authority; public request JSON cannot request private preparation. A permanent purpose marker stores the exact unsent command and actual budget generation together. Generic prompts, config, restart, forks, TUI/shell mutations and broad Session credential routes cannot repurpose that worker. Parent stop and archival remain available. Tests use in-memory DBs and disclosed synthetic proof/rates/source; no actual provider or live validation record is created.

The controller audience must be contained within the source audience before preparation, and the reviewer inherits that narrower controller audience. A changed private source audience refuses preparation before a Session or reservation is created.

The namespace preserves the existing network grant and mounts only individually verified public DNS/TLS configuration files when that grant permits networking. It never mounts the whole `/etc` tree. Their digests enter the namespace policy binding; a changed runtime file invalidates empirical proof. An executable outside the allowlisted runtime roots has an explicit `/provider` mapping for dispatch. Synthetic kernel probes verify certificate loading, forbidden-state denial and that executable mapping; no provider is launched by these tests.

The original-gate bridge is now composed with core resolution and consumption behind a private registered runtime. It persists exact delegated media references separately from the controller's directly inspected image IDs, with the original snapshot/digest unchanged. Approval, its provenance and image receipt consumption commit atomically; current source/frame/criterion/verdict and historical actor proof are checked again before consumption. Corrupt proof, expired/replaced image receipt, revoked authority, unsupported peer or an absent runtime refuses the operation. The dedicated tool rejects delegated references on pre-218 peers before sending any approval. Hosting registration remains absent.

The existing human-only campaign control CAS can compose an evidence proposal only through trusted destination/provider disclosure lookups, deriving the authenticated author, revision and scope. Public, unknown, stale or agent-authored disclosure is refused. Budget and issue scope retain their existing contracts. No disclosure lookup is registered on the hosting service and no authority has been minted there.
