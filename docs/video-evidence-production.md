# Production Video Evidence Integration

This slice integrates the twelve retained production-preparation commits onto actual main
`5fe22ec2d09878c1cdf96f298bdd95063d3f54a6`, after the offline preparation PR #3053,
foundation PR #3061, scope PR #3063 and budget PR #3065 actually merged. Historical
preparation handoffs and their reviews do not approve this integrated snapshot.

Whole #1321 remains incomplete. The installed native media-only enforcement contract,
actual compatible reviewer launch, trusted capture adapter, finite Human live permit and
independently inspected all-frame/oracle/final-usage/pricing evidence remain required.
No provider launch, upload, live proof registration, hosting activation or permission change
is authorized by these modules or deterministic tests. Code review and exact-head CI are
separate gates from live acceptance.

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
protocol revision or activate production. Current main advertises public protocol223 for
runner-mediated session cross-model review; public221 describes background retry exhaustion and
public222 describes bounded event reads. Scope uses217, native allowance uses218, accounting uses219
and child work-item creation uses220. The private media compatibility floor remains223, but that
integer is not a private protocol allocation or a media capability claim: public223 session review
does not advertise this media contract. Its separate, still-unadvertised compatibility metadata is
exactly `{ id: "wollipog-paced-video-review-v1", revision: 1 }`; public or future protocol numbers
alone cannot establish this private contract. No current discovery or compatibility response emits
that metadata. Metadata itself is neither native isolation evidence nor admission, delivery,
pricing, quality, Stop or refund authority. #2936 owns campaignBudgetWorkerPreflight and
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
A hash-only `privateOracleCommitmentSha256` is pinned in that scope **before** any dispatch;
Human inspection must match the private oracle to this original commitment and source. Oracle
bytes, generator and expected truth remain outside the actual reviewer's namespace and inputs.
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
process it by labeling it paced or weakening its limits. The distinct candidate decoder now
derives explicit native presentation times and durations, with 8 MiB source/total frames,
16 frames, 640x360, 4 seconds, 1 MiB/frame and 250 ms minimum intervals. A trusted current
validation-permit profile selects it; candidate observations cannot approve production. Actual
provider-wide restricted-tool enforcement remains held; paced/maximum retain their original bounds. Deterministic permit/Session/transport tests are disclosed
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
Historical observation is withheld until trusted final priced settlement and normal completion
match that exact generation. An active allocation never substitutes for final usage; an early
quality check preserves the original pending record while settlement remains outstanding.

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

The private Session materializer is composed on actual merged budget main. The transplant
excludes old dependency, unreviewed budget and duplicate offline commits. The reviewed strict
never-dispatched budget method stays unchanged, including missing-table refusal.

Materialization reuses the existing Session creation path. Ordinary governance asks are durably preflighted before entering its atomic Session/member/command transaction, then the same current gate is rechecked inside. The trusted resolver supplies configuration and current authority; public request JSON cannot request private preparation. A permanent purpose marker stores the exact unsent command and actual budget generation together. Generic prompts, config, restart, forks, TUI/shell mutations and broad Session credential routes cannot repurpose that worker. Parent stop and archival remain available. Tests use in-memory DBs and disclosed synthetic proof/rates/source; no actual provider or live validation record is created.

The controller audience must be contained within the source audience before preparation, and the reviewer inherits that narrower controller audience. A changed private source audience refuses preparation before a Session or reservation is created.

The namespace preserves the existing network grant and mounts only individually verified public DNS/TLS configuration files when that grant permits networking. It never mounts the whole `/etc` tree. Their digests enter the namespace policy binding; a changed runtime file invalidates empirical proof. An executable outside the allowlisted runtime roots has an explicit `/provider` mapping for dispatch. Synthetic kernel probes verify certificate loading, forbidden-state denial and that executable mapping; no provider is launched by these tests.

The original-gate bridge source composes core resolution and consumption behind a prerequisite
private registered runtime. It persists exact delegated media references separately from the
controller's directly inspected image IDs, with the original snapshot/digest unchanged. Approval,
provenance and image receipt consumption commit atomically; current source/frame/criterion/verdict
and historical actor proof are checked again before consumption. Corrupt proof, expired/replaced
image receipt, revoked authority, unsupported peer or an absent runtime refuses. Delegated tools
require private223 and the exact separate identity from the authenticated current compatibility
response; a cached integer, public221/222/223, or another installation's metadata cannot authorize a
POST. Hosting registration remains absent.

The existing human-only campaign control CAS can compose an evidence proposal only through trusted destination/provider disclosure lookups, deriving the authenticated author, revision and scope. Public, unknown, stale or agent-authored disclosure is refused. Budget and issue scope retain their existing contracts. No disclosure lookup is registered on the hosting service and no authority has been minted there.


## Installed Native Readiness and Integrated Adapters

Offline inspection on 2026-10-13 found Codex CLI 0.162.1. Its generated experimental
`ThreadStartParams` includes `dynamicTools`, and `config` permits extra properties. Neither
establishes a complete built-in tool suppression contract. The installed preflight records a
specific `builtin_tool_allowlist_unavailable` refusal; unknown versions, schemas or executable
identities fail closed. It never starts App Server, reads account credentials or advertises support.
[Official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes dynamic
calls alongside native tool namespaces; [configuration documentation](https://learn.chatgpt.com/docs/config-file/config-reference)
provides individual controls, not this installation's complete audited media-only surface.
The existing inference-transport module reports transport diagnostics and supplies no interceptor.
The exact current implementation decision retains that installed-native refusal. An unused
transport-filter abstraction cannot substitute for an audited managed SDK ingress. There is no
provider/base-URL/profile override or new sender registration in this slice.

Prepared commands now carry a permanent media purpose. The ordinary runner start path refuses
that marker before workspace/generation/credential/driver work. Actual provider launch still needs
its dedicated same-generation dispatcher. Terminal never-dispatched fences enter through the
owning authenticated runner WebSocket identity, with minimum private media protocol223 and the
exact current selected installation's contract metadata; agent API bodies
and claimed runner identifiers cannot authorize release. The reservation release still requires its
same-database cancellation claim and exact source command/purpose/generation, with no usage history.

The unregistered durable recovery coordinator requires an explicit trusted recoverable inadequate-evidence
disposition by the actual current typed owner. Generic or hard permission denial, Human Required,
unknown disposition, expiry, scope denial and owner revocation never become recoverable quality failure.
Human-owned gates remain blocked by this preparation. Independent current finite capture/action
reservation and fresh gate authority are separate prerequisites, with original aggregate spending,
tool and work ceilings retained across new IDs, profiles, admissions and restarts.

The coordinator commits separate exact intents for original owner rejection, capture and fresh-occurrence
creation before invoking each mutation. A lost reply only reconciles that same stage operation;
unverified original rejection, artifact or gate outcomes block another attempt. Two total replacement
attempts are pinned to immutable original ancestry; no new ID resets capacity and no unknown charge
is refunded. Old execution rows without trustworthy ancestry remain conservative. Completed readback
independently rechecks actual immutable artifacts/occurrences and current authority rather than trusting
cached capture-worker proof.

Complete trusted original timing/action/transient provenance may cover at most eight adjacent segments,
each at most 900 native frames and 30 seconds. Aggregate encoded source remains at most 32 MiB and
derived PNG storage 128 MiB, with the original per-frame 2 MiB and finite work bounds retained.
Byte-preserving split/conversion must preserve every original PNG hash, frame, native time and duration.
Specific oversized-frame recapture may produce changed pixels only with independently derived complete
original timing/action/transient coverage and fresh immutable exact source/criteria/profile/gate
bindings. It cannot approve the original artifact from those new pixels. Sampled, omitted, retimed,
unbound or unknown transients refuse. Actual capture/allowance/provenance/typed-owner/gate execution
ports remain unregistered; disclosed synthetic SQLite fixtures prove code control flow only, not real
capture, native model inspection, Human allowance, genuine usage or production readiness.

Current private destination and provider disclosure revisions, retention text and exact offered
reviewer identities are re-read at preparation, resolution and consumption. A privacy or retention
change invalidates admission/provenance even if the Human previously approved the old disclosure.
No disclosure authority, candidate runtime profile or live registry record is activated by this slice.

Private quality review metadata, receipts and verdicts now reference the actual root, source child
and reviewer Sessions with delete cascades. The checked prior-schema migration preserves exact live
provenance and drops only orphan quality metadata. This is partial privacy cleanup: derived frame
artifacts remain attached to their private source child and use the existing artifact retention and
content-addressed byte garbage collection. Deleting a reviewer or root does not claim those bytes
were removed. Permanent purpose and prepared command payloads remain intentionally durable while
unknown/live effects or reservations require exact command, generation and history reconciliation.
No budget/effect history is deleted or refunded. A trusted terminal/no-uncertainty command cleanup
and derived-frame retention policy must be independently established before live registration;
the preparation supplies neither a terminal proof nor automatic worker termination.

Resolution and consumption own their transaction boundary and reject enclosing transactions.
Current proof checks remain inside each gate transaction. If they actually record an exact linked
review's irreversible negative, rollback discards partial positive approval/provenance mutations
but commits that observed negative afterward. Restored source, frames, binding or expiry cannot
revive it; absent final genuine usage remains pending rather than becoming a quality rejection.
Changed authority cannot authorize an old uncertain recovery effect: reporting stays uncertain
without any readback, replay, replacement or refund under renewed authority. Full expiry/owner/
allowance/lineage/cap bindings are retained. Session access denial precedes permanent-purpose route
restriction, preserving indistinguishable inaccessible and absent Session responses.

Pending permanent media commands also quarantine generic lifecycle inputs. Budget/guardrail Stop
reuses only the exact existing same-database locally never-enqueued cancellation; unknown,
possibly dispatched, missing/corrupt/replaced/history/checkpoint proof retains its Session and
reservation without generic Stop/Delete RPC or tombstone. Generic disconnect, absence, direct
status and inventory/live snapshots cannot manufacture a permanent same-command fence or terminal
state. Authenticated possible usage, monotonic costs, checkpoints and history are still retained
independently of status quarantine. Only a validated stored active same-command/purpose/current
generation can resume authenticated lifecycle projection. This is historical dispatch identity,
not spending/quality authority; real sender/driver registration is still absent.

Generic deletion permits only independently proven exact cancelled media identity. Cleanup of an
active or settled media command remains held for a separate trusted terminal privacy/retention
contract before live registration. Durable purpose/command/budget/history is never silently purged.
After completed recovery, a changed current authority for the same original subject/plan reports
unsupported without readback, revalidation, replay or new authority. Durable completion, true
rejection, changed-subject refusal and uncertainty stay distinct; full authority/expiry/caps remain.

Current-main integration preserves public child-at-creation work-item admission at protocol220.
Private media reviewers refuse `campaignWorkItemId` before governance or materialization: their
origin is already pinned by trusted purpose and lineage, and they cannot replace implementation
ownership or nest public assignment publication inside the media coordinator's outer transaction.
Possible priced usage also sends the existing authoritative accounting acknowledgement while
lifecycle remains quarantined. Correction coordinates stay bound; a missing correction prefix
defers synchronization rather than sending an unbound price. Neither acknowledgement nor the
immutable active dispatch identity supplies terminal Stop, settlement or privacy-cleanup proof.

Dedicated active Stop preparation uses `PreparedMediaActiveStops` and `RunnerMediaActiveStops`.
The private ports require both the actual current prepared/purpose/member generation and the
owning runner's exact durable launch claim plus registered worker handle. No hosting adapter is
registered. Missing, revoked, corrupt, replaced or unknown ownership refuses; generic SessionManager
or PID kills are never a fallback. With those trusted ports, a Stop can return 202 while retaining
the queued identity, reservation and history. Request and ACK cannot settle cost, capacity or quality.
The operation is committed before the first send/signal and anchored on the original command as
well as the Stop record. Duplicate requests and restarts use exact readback; missing Stop history
cannot reset the command fence. A separate authenticated same-command terminal fence and actual
final same-generation usage/ledger proof are still required before terminal projection or cleanup.

The optional source library in `apps/runner/native-media-core` has the distinct execution identity
`wollipog-native-media-core-v1`. It is not the installed App Server and cannot borrow its disclosure,
capability, account, fixed child-harness identity or native proof. It constructs release-pinned core
startup restrictions through `ThreadManager`'s public startup options; it never starts a Session or
loads an account. The installed App Server's unsupported refusal remains unchanged. Pure source
tests, declared route-observation booleans and successful compilation cannot establish real namespace
exclusion, complete native model delivery, price/usage, privacy cleanup or Human authority.
Actual selection/registration requires a separately audited execution contract and Human gate.

Private compatibility is rechecked from each exact current authenticated selected installation
for the root, child and reviewer before preparation or reservation. The standalone reviewer source
requires all three protocol/identity pairs before durable begin, reservation and dispatch. The
service's optional read-only peer lookup has no registered implementation: missing, throwing,
malformed, removed or replaced metadata refuses decoder/retry/readback, private frame delivery,
image ACK, verdict and owner provenance before those effects. Identity metadata cannot certify
the installed SDK's tool policy, inherited context, FS/network/resource/control-route exclusions
or immutable resume. The installed App Server still lacks the required startup isolation hooks.

Source regression history retains numeric-only failing-before guards and final focused controls.
Early file-level Node test failures executed no cases because the default sandbox denied worker
forks with `EPERM`; normal test flags under one-shot tool-reviewed execution produced the actual
assertions. No persistent grants, profiles, compiler/test limits or hosting settings changed.
These source tests and the historical native compiler/library results supply no genuine frame
delivery, temporal quality, final priced usage, cleanup or supported fixed-harness certificate.
