# Managed Provider HOME Retirement Proposal (Refs #3157)

Revision 4. Physical cleanup remains disabled. The isolated state model and the control-plane
producer observation slice below are implemented prerequisites; the filesystem/distributed retirement protocol remains a proposal, not a supported
feature. Account removal continues to return `credentialsRetained: true`. No real credentials may
be retired during implementation or verification.

The bounded model follows the independently assessed Phase 1 proposal (37,677 bytes, SHA-256
`6ae49db6e9bcd03df39f31270524d8feec3ce4b6ba26db830883d39c2658cabb`). The earlier temporary
`583129b9…` proposal is unavailable and was not recovered. Its denied decision grants no authority.
The state-only implementation decision is `workflow_b77ff12b71c94d0a91acc711c3b864f6`, resource
digest `b10d60fb850ad5638a9c16382982fc2c05724e52c34e90e741e2ae3876a4c103`, consumed for option
`approve_isolated_state_model` at receipt `consumedAt: 1792357901882` (policy revision 1,
authority `orchestrator`, basis `custom_policy`). It authorizes no production integration or
reviewer launch.

## Control-Plane Producer Enrollment

`provider-profile-publication-store.ts` is now used by production `ControlPlaneDb` grant writers
and the adoption and Add Account RPC producers. It does **not** import the isolated model, attest
HOME ownership, or expose a public protocol/API. Its source history is always incomplete and
physically ineligible. Neither a first-install store epoch, ticket, SQLite commit nor successful
runner reply grants retirement authority.

The supported applicability remains the same SSH OS account and host: a shared profile root
outside disposable runner data directories, replacement runners, and multiple control planes with
explicit grants. This does not establish safe concurrent provider use or cross-host filesystem
support. Existing direct-name HOMEs are not a new, proved retirement cohort.

All four grant writers (authorize, bind created account, complete, revoke) and completion's exact
superseded grant use a dedicated outermost `BEGIN IMMEDIATE` transaction. It rejects an existing
transaction or `synchronous != FULL` before any mutation, never joins `atomic()` and never changes
event-ingest durability. Grant changes and their observations commit together. Both adoption and
Add Account authorize and enroll dispatch in one outermost FULL transaction. If enrollment refuses,
only a fresh grant inserted under that same uninterrupted writer lock is marked revoked before
commit; it is never externally visible as pending. Its immutable authorization intent remains.
A reused/preexisting grant or uncertain earlier dispatch is retained: `created: true` from an older
transaction is not proof that no other connection has used the grant. Inventory completion keeps
its existing behavior and does not become proof of dispatch completeness. Only a completed COMMIT
returns admission. A request already enrolled cannot admit a
second dispatch; no outbox executor, automatic retry or command resumption was added.

Current production callers run after registration/agent-inventory/login-inventory commits, or
directly in HTTP authorization, adoption, removal and reply settlement. They do not run inside
`appendEvent`, `appendHydratedPage`, retention or blob relaxed transactions. Unexpected outer/NORMAL
inventory calls leave the grant pending and defer to the next existing report, without RPC or
false completion. Direct unsafe-context calls refuse, including revocation; no nested method can
claim a caller's future commit. Supported outermost revocation still works without audit capacity.

The per-database limits are one source row, 4,096 immutable intent rows, 32,768 event rows and 4,096
UTF-8 bytes per canonical record. Canonical grant/request identifiers are at most 128 characters;
hashed raw runner/account identities are nonempty, well-formed text bounded to 128 JavaScript code
units and 512 UTF-8 bytes. They retain their exact spelling and existing hash domain, without
trimming, case folding or Unicode normalization. Observation hashing adds no business charset rule;
existing runner/account validation and internal login placeholders remain compatible. Bad caller
input refuses locally without changing evidence or degrading the source. UUIDs are 36, digests 64 and
canonical uint64 revision strings 20. Private diagnostic reads use 64-row keyset pages with one
lookahead (at most 266,240 record bytes), not a complete history materialization. Counters and
preimages are checked while SQLite holds the writer lock. There is no eviction, automatic reset,
compaction or cascading foreign key for these records.

These are permanent lifetime limits for the whole control-plane database. A fresh grant plus its
dispatch usually consumes two intents, so 4,096 intents typically permit about 2,048 such lifetime
pairs, including failed or cancelled attempts. Other observations, limits and faults can stop new
admission earlier. Once saturated/degraded, NEW grant authorization and Add Account/adoption
dispatch admission refuse permanently across all runners of that control plane. There is no
supported reset or recovery operation; existing-grant revocation, binding and completion continue
under the documented durability requirements. This permanent availability risk requires explicit
consideration at later human merge consent. No reset, eviction, quota increase, complete history or
physical retirement eligibility is introduced here.

Saturation, revision exhaustion or an audit-write failure rolls evidence back to a savepoint and
commits a sticky degraded fence in the outer grant transaction. New grant authorization and new
dispatch then refuse explicitly. In particular, Add Account cannot turn an expected grant's audit
failure into its old-peer/non-human/no-scope compatibility fallback. Those legitimate fallbacks
remain as before. Binding/completion of previously authorized work, supersession and revocation
retain their security semantics under incomplete/degraded history. They cannot manufacture a new
RPC admission, retire any consumer or erase an outstanding intent. A missing/corrupt source is
disabled rather than repaired. If the database cannot commit the security mutation itself, the
caller receives failure, never claimed revocation success.

First installation inspects source-table/epoch-marker footprints before creating them and installs
them atomically under FULL. An initially empty database records `new-source-incomplete`; a
preexisting database records `legacy-incomplete`, with no complete historical backfill. A partial
installation, missing/malformed/mismatched epoch or unknown schema disables admission and is not
regenerated. Reconnecting cannot replace the source owner/epoch. A coordinated rollback/loss of all
installation evidence cannot be distinguished from a pre-install database: this is explicitly
**not** rollback detection, a restored independent anchor, HOME genesis or continuity proof. No
source from this slice can ever establish physical retirement eligibility.

New evidence allowlists only CP instance/store epoch, grant/request/profile identifiers, provider,
operation, revision, ticket and observation status. Runner/account identifiers are domain-hashed.
Actor identities, labels, paths, credentials, codes, full command bodies and error text are omitted.
The original grant table remains the authoritative permission/audit record. Reply/timeout/not-sent
observations never settle the retained publication intent or prove process exit. Private status,
events and structured observation-failure logs help diagnose refusal without a new public API.

Synthetic verification covers the actual HTTP Add Account path and adoption producer, independent
SQLite visibility after commit, reopen, rollback/commit/audit faults, stale preimages, outer/NORMAL
refusal, numeric saturation and bounds, missing epochs, revocation/supersession, lost replies and
immutable unresolved intents. Counter-boundary fixtures avoid allocating unnecessary full-size
histories; they are not native races, power-loss experiments, anti-rollback proof or process tests.

Remaining original #3157 integration: durable runner config/account/default/session/history/
switch/recovery/TUI/skill/login/probe/launch/background intents before publication; source barriers
that really fence every producer/outbox; complete historical owner/store/cohort provenance and
exact acknowledgements; verified historical-reader and paused-old-cleanup exclusion; native shared
canonical fencing/private worker capabilities; exhaustive process lifetime proof; terminal CAS,
no-replace descriptor detach and bounded descriptor-relative removal preserving external evidence.
Coordinate lifecycle work with #3228 before touching its owner's paths. None of these gaps is
fulfilled by this producer slice, a grant list, local reservation, released lease or reaper boolean.

## Isolated State Model and Proof Boundary

`apps/runner/src/provider-home-retirement-state.ts` is imported only by its focused test. It has
no filesystem persistence/removal, production import, worker/native operation, process-lifecycle
change or configuration/binding/grant integration. Its in-memory CAS adapter **simulates** durable
records. Neither schema validation, digests, source barriers nor acknowledgements attest actual
host durability, exhaustive owners, process exit or deletion authority. A positive result is named
`terminal_eligible`, not removed. Full #3157 remains incomplete.

The model starts at explicit synthetic genesis: provider/profile/incarnation, root epoch, creator
and store epoch, and creation nonce. Snapshots contain only genesis and the complete bounded event
history; derived state is replayed rather than accepted from caller flags. Genesis itself is a
modeled premise, not evidence that a real HOME was created this way. An untrusted party can invent
a consistent alternate model; that does not prove any external fact.

Each event has a nonce, exact prior revision/digest and strict action schema. Canonical JSON
sorts object keys, preserves array order and refuses unknown schema fields/versions, accessors,
exotic prototypes, sparse arrays and non-JSON values. SHA-256 digests use distinct versioned domains
for genesis, state, roster, manifest, grants, publication, barrier and retirement. Counters use
canonical uint64 decimal strings and refuse overflow. The snapshot revision is the event count;
the smaller finite history bound is reached before that counter's arithmetic limit.

Both a complete snapshot and derived manifest/state must fit 64 KiB. There are at most 256 combined
historical-owner, consumer and intent rows, 256 successful events/nonces, JSON depth 16 and 32,768
visited JSON nodes. Canonicalization charges UTF-8 bytes incrementally before hashing. Reaching any
bound refuses without truncation, eviction or credential cleanup. Small histories can exhaust the
byte bound before the row/event bounds; the model deliberately offers no evidence compaction.

The input contract is synthetic JSON data in the supported Node realm with intact intrinsics,
not arbitrary hostile JavaScript. Native `node:util` Proxy detection refuses direct, nested, array
and revoked Proxies before prototype, length, key or descriptor reflection, without executing their
traps. Accessor descriptors refuse without invoking getters. Array length is checked before key
enumeration; own-key counts are checked before fetching individual descriptors. Ordinary-object
key enumeration still allocates and performs work proportional to the supplied own-key count,
including on rejected objects. Already-allocated input memory is outside these bounds. Output,
visited-node, depth and replay bounds therefore do not bound all input reflection work or establish
a hostile-code sandbox, and replaced intrinsics are outside this contract.

Modeled transitions:

1. **Enrollment.** Owner ids/store epochs persist permanently; reusing an owner id cannot replace
   its store. Every consumer has an enrolled intent before publication. Consumers include accounts,
   defaults, sessions, history, switches, recovery, TUIs, sign-in, launch, skills, probes and background
   work. Enrollment binds current source/grant revisions and issues an incarnation/preimage-bound
   synthetic ticket. Revoking a grant never deletes its owner or outstanding intent.
2. **Publication.** An OPEN owner can publish only the exact pending ticket, current grant and next
   source revision. Two tickets issued against the same source revision cannot both publish after
   one advances that revision. Lost/ambiguous writes leave intents represented until a barrier.
3. **Freeze.** A matching complete roster/manifest/grant/publication/provenance digest and generation
   changes OPEN to FROZEN irreversibly. That generation and census remain fixed. New owners, grants,
   consumer enrollment, publication and process admission are refused after freeze.
4. **Source Barrier.** Each connected, same-store owner supplies its exact previous source digest/
   revision, next source revision, current grant revision and frozen nonce. The barrier resolves
   every one of that owner's intents with the exact ticket: pending work may be aborted or modeled
   committed-and-retired; published work must be retired. It retires the consumer rows and remaining
   modeled grant in the same synthetic transition. This represents a writer/outbox barrier; it does
   not create one in any real database or config writer. No timeout resolves an intent.
5. **Acknowledgement.** Every historical owner must acknowledge the exact root/incarnation/store,
   frozen generation/nonce and roster/manifest/grant/publication/provenance digests, plus its source
   barrier, complete resolution digest and process-history digest. Unknown owners, missing stores,
   disconnected participants, mismatched epochs or incomplete resolutions refuse. Presence can be
   restored only for the same store epoch; this models continuity rather than proving it.
6. **Terminal Eligibility.** All consumers must be retired, all intents aborted/retired, every owner
   connected with a retired grant and matching acknowledgement, and the entire modeled history must
   contain no admitted process start or unknown-history event. Only then can FROZEN become
   TERMINAL_ELIGIBLE, irreversibly. The no-process branch derives from genesis and every modeled
   admission; no independent `noProcesses: true` field or external process-proof boolean is accepted.
   This version deliberately has no positive process-used branch, detach, removal or recovery API.

The synthetic store assigns only after complete validation. A failed CAS/transition changes neither
state nor replay evidence. An exact previously accepted event, including its original preimage, is
an inert lost-reply retry, even after later events; changing its nonce payload/preimage refuses.
An old snapshot must match an independently retained expected anchor on simulated restore. The
adapter cannot authenticate that anchor or detect a real owner restoring both records from backup.

Focused tests exercise positive no-process traces, missing-owner and unresolved-intent schedules,
late publication, source/store rollback, every freeze/ack binding, replay, identity substitution in
modeled records, strict schema/node/depth/byte/row/history/counter bounds and refusal without mutation.
Additional schedules cover pending intents resolved committed-and-retired, cross-owner resolution
refusal and publication after grant revocation. Plain terminal actions independently test sticky
process/unknown-history exclusion; an extra caller `noProcesses` field tests unknown-key refusal.
Small oversized ordinary objects/arrays and trap-counted Proxy inputs exercise the input contract
without claiming a production hostile-input resource boundary.
Existing fast-check generates canonical records, owner/intent schedules and command interleavings
against an independent flag/counter oracle. These tests never create/delete a HOME or establish
native concurrency, crash durability, cohort exclusion or complete provider process containment.

## Source Facts and Supported Sharing

The SSH-account-level root returned by `apps/runner/src/provider-profile-home.ts:13` deliberately survives replacement runners and their owner-namespaced data directories. Multiple control planes may hold profile grants. This is the real shared-HOME scenario; cross-host filesystems and unknown consumers do not become safe because paths match.

Current source at `973d3c31955646a4eb45613f0a16b6d7b2a60773` confirms #3440 retains sign-in and
removed-account payloads and canonical evidence. `profile_retire` still settles grants and releases
its own lease reference before returning; its boolean is not deletion authority. Current profile
markers and registration-scoped grant queries do not carry complete consumer generations.

The following revision-2 references describe **historical pre-retention ordering**, not current
deletion routes. Their source base was `a9caf495a252d0d6c4e14c5cf53a70a4a7339923`; line numbers
are historical. They establish ordering, not a reproduced loss incident:

- `provider-login.ts:1088` acquires/releases or calls profile retirement, then removes the directory at line 1133.
- Login settlement releases at line 967 before duplicate/unused cleanup at lines 970-971. Spawn failure and cancellation do likewise at lines 520-521 and 554-555.
- Pre-acquisition/profile-create failures reach unused cleanup at lines 462 and 482. `cleanupUnusedDirectory` at line 1153 relies on an absent credential filename; that is not ownership proof.
- `provider-home-lease.ts:1286` forgets a successfully released entry. `retireProfileHomeWhileHeld` at line 798 releases before returning its boolean.
- Account removal writes configuration before cleanup (`provider-login.ts:683-695`). Keep that ordering and report retained credentials truthfully.

Planning report626 established ordering, not cross-runner loss. The isolated model's synthetic
schedules are not native cleanup/concurrency reproductions. Directory location, UUID, missing
credential marker, empty grant list and release success never independently authorize deletion.

## Delivered Retention and Unimplemented Physical Boundary

#3440 disabled unproved recursive cleanup on every login/account-removal route. It retains all
legacy, operator-owned, configured/published, foreign, malformed and unknown HOMEs. Revocation,
local reservations, process reaping, skill serialization and configuration-write safeguards remain.
A removed configured account returns `credentialsRetained: true`.

A future positive physical path would need a newly created, completely enrolled cohort, durable
creation provenance, exact private ownership and complete lifetime proof for every consumer.
The model only explores the no-process branch. An actual completed sign-in/reference is insufficient:
`spawn.ts:895-897` documents a detached, scrubbed/unobserved descendant blind spot in existing process
tracking. Unknown or historical readers and paused old cleanup cannot be retroactively fenced by
a marker. Actual provider-used HOMEs require a stronger complete containment contract; none is
implemented here. Failure/duplicate sign-in continues to retain credentials and evidence.

Retention and this isolated prerequisite do not deliver physical cleanup of configured accounts,
real exhaustive dormant-binding accounting, legacy migration or full #3157 closure. The remaining
sections are unimplemented physical-protocol requirements, not authority to change runtime behavior.

## Namespace, Provenance and Old-Binary Exclusion

The physical proposal requires a new nested namespace under the verified shared root:
`<profiles>/.managed-retirement-v1/homes/<incarnationId>`. Sibling `state/<incarnationId>` holds
permanent provenance, fences and canonical journals; `retired/` holds detached payloads. The
incarnation identifies one never-reused physical lifetime independently of profileId. Existing
`<profiles>/<profileId>` and runner-local legacy HOMEs are never migrated or deleted automatically.

Create privately in staging. Record root/parent/HOME device and inode, canonical parent/name, profile/provider, attested instance/initial grant, creation nonce and guard hashes. Write exclusively, fsync, then publish with native no-replace rename. Foreign/preexisting destinations and incomplete provenance retain. Disk provenance is necessary but cannot reconstruct the creating worker's private epoch-bound capability after a crash.

Before exposure, install an immutable incompatible journal barrier inside the payload. A concrete candidate is fixed non-lease bytes `{"kind":"wollipog-managed-home-external","version":1}` plus newline at the canonical recovery filename and the historical lock-directory lease/checkpoint filenames. Store their identities/hashes externally. Never publish a compatible lease there; new code uses the external canonical journal.

Base anchors: `provider-home-lease.ts:252-281` validates required record fields; lines 475-504 read the recovery record or historical lease record; line 817 skips profile access for PROFILE_CHANGE but does not skip journal validation. The candidate lacks required lease fields and must be refused. An arbitrary unknown filename alone is insufficient: canonical-root enumeration at line 432 is conditional on the journal path taken. Verify exact sentinel bytes against each supported historical reader, including legacy profile mutations and packaged workers. These are proof obligations, not completed compatibility tests. An unproved reader cohort means retention/unsupported.

An old process already paused after release does not consult a new fence. Therefore legacy names cannot be made deletable by adding a marker. For new nested names, the base removed-account predicate at `provider-login.ts:1088-1109` accepts only direct children of its fixed profile/account root; existing-account refresh has `persistAccount: false`. Demonstrate those paths cannot target the new namespace, including aliases. Enumerate historical fresh-login cleanup paths; any version that can delete the new namespace without these checks disables retirement for that cohort. No inference from a version number or random UUID is sufficient.

## Publication and Consumer Races

### Bounded Account-Config Publication

The account-config writer captures an immutable config identity, full-config digest, normalized
account preimage and evidence-store epoch/revision. Adoption captures this ticket before awaiting
the HOME marker write. Add/remove capture immediately before synchronous config publication.
Updated writers serialize on an exclusive, identity-checked config-sibling guard and recheck the
ticket before rename. A later cooperating writer invalidates an earlier ticket, including an
accounts A→B→A sequence. This is not a barrier against old runners or operator edits; their history
remains unknown. It attests neither complete producers, exhaustive process containment, a frozen
owner store nor eligibility for physical retirement.

`.<config-name>.account-publications-v1` contains a private versioned header and append-only JSONL
intent/outcome log. A separate private `.<config-name>.account-publications-anchor-v1` binds the
epoch to that directory identity. Missing or substituted evidence refuses mutation instead of
resetting an epoch. Erasing/restoring every artifact is outside this cooperative guarantee: every
record retains `historyIncomplete: true`. Records contain structural binding fingerprints and
before/after digests, never credential contents, labels, raw config or HOME paths.

Before any producer grows, the writer reserves a 64 KiB control/metadata allowance, the complete
temporary config size and two maximum-sized records against a 256 MiB per-config logical budget.
The limits are 4,096 intents, 8,192 records and 32,768 bytes per record, with at most 64 old/new
binding fingerprints per intent. Directory size and control/anchor bytes must fit the fixed allowance.
Unknown entries, oversized controls, malformed/partial history, pending intents and abandoned
guards refuse further mutations. Intent fsync precedes config temporary creation/fsync and atomic
replacement. Published-outcome fsync follows config-parent fsync. The guard spans synchronous
local I/O only, never provider or network waits. There is no PID-based steal, expiry, repair, retry,
compaction, pruning or supported reset.

**Availability risk:** exhaustion or ambiguous I/O can permanently disable NEW account-config
mutations for this config, including add, remove and adoption. Existing inventory/sessions and CP
revocation continue; no evidence or credentials are deleted to restore availability. Unsupported
ownership/filesystem proof, including platforms without the required POSIX checks, refuses mutation.
These limits and indefinite refusal require disclosure in later review, PR and human merge decisions.
Boundary fault tests use synthetic failures; they do not prove power-loss durability or optional
platform support.

**Windows compatibility:** the POSIX-only publication admission would refuse Windows account
add/remove, so Windows uses the native WACW1 account-config backend below. Its positive add/remove
execution comes from the windows-latest Platform Isolation job; this document records no run
result, and the pull request carries the exact-head receipts. Provider profile adoption/markers
remain unsupported on Windows. The existing Windows lease/skill helpers are not account-config
ownership or publication proof. No legacy unenrolled writer or skipped ownership/identity check is
a fallback.

A sanitized refusal can ask an operator to verify existing ownership, restrictive config/parent
permissions and retained publication evidence. It does not change permissions, repair/reset a
store, or establish that permissions alone caused every refusal.

Callers distinguish definitely-unpublished, known-renamed and unknown publication. A successful
rename stays published when subsequent observation or directory fsync fails. Unknown and
known-renamed failures retain intent, temporary/guard and any referenced HOME marker. They must
not infer successful admission from today's config, activate a grant, report account removal or run
grant retirement. Login's local settlement uses `recorded: "unknown"`: the existing grant manager
drops temporary local access, while the callback retains the marker rather than falsely applying
unrecorded rollback. Existing true/false settlement and CP revocation remain effective. No path in
this slice deletes a credential HOME, edits its native lease evidence or authorizes physical cleanup.
All other #3157 producer, lifecycle, process and detach proofs remain undelivered.

The earlier private-only proposal used `preparing -> private -> published` or `private -> retired`;
it was never implemented. The complete contract instead needs durable enrollment **before** each
config/binding/grant publication, followed by irreversible freeze, exact owner-store barriers and
all retirement acknowledgements. A failed/ambiguous write retains its live publication intent.
The model represents these obligations but does not integrate with their real writers.

Route every native acquisition, reentrant reference, probe, skill mutation, marker mutation, exact release, recovery and checkpoint through the same external authority. A competitor winning admission first commits published and prevents retirement. Retirement winning first commits terminal state and denies the competitor before mkdir. Alias resolution must discover and verify the same canonical external authority; unfamiliar or retargeted aliases retain/refuse.

Current `ProviderProfileGrants` is insufficient as an exhaustive consumer ledger: `provider-profile-grants.ts:52` tracks creations, line 71 synchronizes a registration-scoped list and line 107 scans configured accounts. Protocol-v225 `RegisteredMessage.providerProfileGrants` is scoped to reported profiles. No claim that this proves absence of remote/dormant bindings is permitted.

## Exact Worker Authority and Atomic Retirement

Keep the worker's receipt/ack protocol and exact-entry handles (`provider-home-lease-worker.ts:18-22,46-54,77-103`; async registry line 116). Extend them with bounded private create/publish/retire operations and explicit removed/retained/indeterminate results. A path, PID, caller boolean, profile-retire response or disk record is not an exact reference capability.

Use one lock order: permanent external HOME fence, then existing canonical-journal fence. Computation may use snapshots, but every commit must revalidate the complete expected preimage and pinned identities under both locks. Holding a fence for one helper snapshot and releasing it before an unchecked TypeScript mutation is invalid. Profile writes and initialization must join the transaction. Preserve canonical verification, storage budgets and existing helper trust boundaries.

Before terminal CAS prove: the creating worker capability, exact completed acquired tip/hash, one reference, no pending receipt/completion/migration, unchanged private provenance/guard/profile/directory identities, no other grants and no published or unknown consumer. Local refusal must not consume someone else's reference. Keep account reservations until settlement ends. Reap the entire provider tree first; failure retains ownership and payload.

Commit/fsync terminal retirement binding the previous canonical tip/hash, provenance hash, pinned directory identities, exact profile/grant verdict and private detach target. Keep canonical evidence outside the payload. Normal release, stale recovery and compaction must refuse terminal state; none may recreate a retired name or erase its terminal proof.

Use no-follow pinned parent/HOME descriptors and same-filesystem native no-replace detach into the private retirement root. Never issue recursive removal against the original pathname again. Verify the detached identity before descriptor-relative, no-follow traversal; permanently retain external provenance, journal, fence and terminal proof. A substituted original path is never deleted. Unknown entries/identities during traversal stop cleanup; partial removal is indeterminate.

## Crashes, Cancellation and Platforms

Before terminal commit, cancellation retains and releases only the exact reference when release is proved. A poisoned worker or ambiguous release cannot authorize deletion (`provider-home-lease-async.ts:217,288-332,362`). A receipt alone grants no caller-visible success.

After a future terminal commit there can be no rollback or compensation into an ordinary released
lease. Crash before detach leaves credentials in place with admission blocked; crash after detach
leaves the private payload/evidence for inspection. Lost completion or interrupted traversal is
indeterminate/retained; absence of the original path never proves removal. #3440 already stopped
the historical existence-based settlement from claiming an externally moved HOME was removed.
The model enables no crash recovery deletion. A separately reviewed future recovery operation
cannot extend the original #3155 operation deadline or masquerade as cancellation compensation.

Linux may use `renameat2(RENAME_NOREPLACE)` only where the syscall/filesystem and same-filesystem identities are verified. Existing `apps/runner/native/provider-home-lease-io.c:124,197,301` pins ancestry and fences journal operations; its `renameat` at line 295 selects a checkpoint and is not an approved payload-detach primitive. Extend the fixed helper explicitly. Unsupported syscall/filesystem, EXDEV, collision, macOS, Windows and WSL retirement retain until an equally strong native primitive is implemented and tested. Never emulate no-replace using stat-then-rename; do not execute a helper chosen by an agent RPC or configuration value.

## Verification and Delivery

Synthetic credentials and isolated fixtures only. Deterministic barriers must cover competitor-first and retirement-first admission; outstanding local references; pending receipt/ack; success/publication/config-write failure; duplicate/failure/spawn-failure/cancellation/pre-acquisition failure; account removal retention; unknown remote/dormant bindings; crashes around each durable write/detach; ambiguous release; malformed/foreign/hardlinked/symlinked artifacts; retargeted aliases/root/HOME identity; old-reader and paused-old-cleanup exclusion; platform refusal; and exact retired-payload removal preserving a successor and all external evidence. Re-run recovery/compaction tests proving no revival.

Future integration needs frozen-lockfile setup, focused login/profile/lease/worker/native tests,
runner/protocol typechecks and packaged worker/helper/sidecar checks. Recheck fresh open PR overlap
and coordinate the external #3228/#3239 owner before any lifecycle integration. The isolated slice
runs only its focused synthetic/property tests and runner source/test typecheck. No dependencies,
worker clock/SEA asset, deadline, bounds, native ownership or poison/no-replacement behavior change.

Required review uses `request_review_session` (`wollipog review session run`) on the own pushed
PR/exact head, latest Claude Opus/high and read-only snapshot. Follow `using-wollipog`: provide the
brief, receive the continuation when idle, read the validated verdict and report, and independently
adjudicate findings before pushing fixes and requesting delta rounds. Preserve the four-valid-round
epoch/two-counted-attempt-per-round limits and actual admission/cost/refusal receipts; extra rounds
need the exact `review_round_extension` decision. The older bridge and campaign review jobs are retired; upgrade unsupported peers and use review
sessions, never an admission or budget workaround. No alternate native reviewer.
Required exact-head CI, human per-PR merge consent, exact typed parent merge decision, actual
merge-group MERGED and separate human/typed branch-deletion consent remain. Use Refs #3157; closure
stays parent-owned. No stack operations, settings/auth/grant expansion or real-credential retirement.

## Minimum Remaining Path to Full Configured-Account Retirement

Full delivery requires a reviewed durable binding-retirement contract in addition to the partial protocol above:

1. Before a new profile becomes configured or externally bindable, durably enroll every account/session/default/background/remote consumer in a complete generation-bound manifest. Bind local registrations and participating control planes to the external provenance/identity. Missing or legacy consumers retain. Grant lists and runner heartbeats are not completeness attestations.
2. Under the same authority, freeze new bindings/admissions and obtain exact acknowledgements that every enrolled consumer is retired and all provider trees/references are drained. Use short fenced commits; never hold a filesystem lock across network acknowledgement waits. Owner-store barriers must prevent stale outbox/config continuations after acknowledgement, not merely observe their absence. Include dormant persisted sessions, disconnected runners, other control planes and pending config/publication operations. Revoke only through existing authorized actions; do not invent permission to discard dependent bindings. Existing POSIX process tracking's documented blind spot remains insufficient for exhaustive retirement; prove complete containment for all actual users or retain.
3. Bind an exhaustive manifest digest/generation and authorized account-removal intent to the terminal CAS. Racing adoption, reconnect, config writes or new grants must either precede the manifest freeze and be accounted for, or fail after it. Missing acknowledgement, unsupported peer, foreign grant or uncertain release retains indefinitely.
4. Prove mixed-version rollout and legacy-name exclusion. Existing legacy profiles need separately authorized offline ownership/consumer proof or remain retained forever; an online marker retrofit cannot stop a paused old cleanup. Published profiles from the partial revision cannot be reclassified private by an upgrade.
5. Demonstrate positive configured-account physical removal only when these proofs hold, plus deterministic races/failures and truthful retained/indeterminate results. Independently review that full protocol before implementing its new cross-component messages or migration behavior.

These requirements remain on #3157. Approval of the partial slice cannot close the issue or establish that full configured-account retirement is solved. This document requests no new authentication, governance, runtime/resource, artifact-transfer or hosting authority.


### Command-Scoped Profile Adoption Authorization

Pending initial adoptions and retries carry an in-memory, one-shot authorization capability.
A complete authoritative grant snapshot, CP revocation or profile-support transition replaces a
global object generation. Reappearance of the same grant/map entry never makes an old capability
current. At most 32 capabilities are admitted; excess commands refuse before marker work, and a
finally block releases every admitted slot. There is no counter wrap, grant-id tombstone history,
durable authorization claim or new security grant. Unrelated CP updates conservatively fence an
adoption too; a stale command retains current marker/grant state and does not perform rollback.
Activation checks and consumes the current capability synchronously before setting a local grant.
The config preimage remains an independent fence and is not merged or retried.

A definitely-unpublished retry preserves a previously observed exact, still-known grant, including
when a persisted binding/CP grant remains known but marker observation is unverifiable. Retention
does not activate or reconstruct a grant. Unknown marker provenance is not new-grant ownership.
Known/unknown publication failures retain their existing conservative evidence behavior; a stale
authorization never deletes a newer valid CP grant merely to compensate its own failed operation.

Failed adoption no longer dispatches compensating asynchronous marker revocation, even when a
definitely-unpublished write and readable marker suggest this command introduced the grant. That
worker mutation cannot carry the command's CP generation across its await. Retention avoids a
newer same-grant authorization being deleted; it can leave a pending marker until authoritative
CP settlement or independently authorized retirement. This is an explicit proposed behavior change
to two former rollback assertions, not evidence that the old tests passed with new semantics.


### Windows Account-Config Backend Candidate

The native Windows account-config backend uses a separate fixed WACW1 contract. Its trusted
platform prerequisites are the installed Windows kernel and global SystemRoot link, protected
OS Windows PowerShell/.NET installation and OS administrators, analogous to trusting Node/OS.
GLOBALROOT selects the true object-manager root; it is not executable image attestation. No
postlaunch self-report supplies first-launch trust. A compromised/misconfigured trusted OS is
outside this candidate's guarantee and must be disclosed in independent review and merge risk.
The fixed GLOBALROOT SystemRoot anchor and its System32 WindowsPowerShell image are resolved
read-only with realpathSync.native to a bounded local drive-qualified OS root and that SAME
canonical image. Node/libuv uses GetFinalPathNameByHandleW with VOLUME_NAME_DOS here.
Only that canonical absolute image is launched: no PATH/environment/RPC selector, hardcoded
C: installation, alternate launcher or fallback. Resolution failure refuses conservatively.
This is documented API design basis, not actual Windows launch or image-attestation proof.
The observed GLOBALROOT spawnSync EINVAL does not establish its exact failing Win32 call.

SystemRoot/WINDIR come from that validated root; PATH is explicitly empty. libuv supplies
other mandatory Windows compatibility variables from the parent when omitted, so the JS
dictionary is not the complete effective environment. CLR/DOTNET/COMPLUS/PS/Node startup
hooks remain absent; no runtime compiler, module autoload/profile or ExecutionPolicy change
is used. Build-only TEMP/TMP and fixed native payload fields retain their existing controls.
Two read-only metadata resolutions add no process/temp producer; their OS-call duration is
outside the existing child termination control, with no hard total metadata-call deadline.
The source/SEA engine and DLL remain build-hash-bound. One passing windows-latest Platform
Isolation job, which runs the 14 selected source cases and the actual SEA verification, is the
required Windows receipt (a human decision replacing the earlier two-job requirement); pure validation/env assertions do
not replace native success, architecture, death, sharing or durability evidence.

Inside that trusted engine, all actual config/store file and parent owner SID, DACL, reparse,
hardlink, alternate-stream, fixed-local-NTFS, canonical-path and identity checks remain mandatory
before a config producer begins. No POSIX check is faked or bypassed and no legacy writer is a
fallback.

Config-directory short names require native handle proof. The engine validates ordinary raw DOS
components, pins ORIGINAL raw ancestors with existing reparse/SID/DACL/share checks, and binds
raw parent/config handles to canonical names and file IDs before producers. Config-leaf short
aliases stay unsupported because replacement can invalidate them. Canonical preimage, stamp
and store namespace coalesce directory aliases; immutable Windows-private requestedPath retains
the original witness across asynchronous work. Publication revalidates that raw chain. The
Windows-only native-realpath caller comparison is preliminary, never admission proof, and its
metadata duration is outside child termination controls. No hard total-call bound is claimed.
One extra read pin permits delete sharing for replacement, not write sharing, and closes with
the command. No producer, global map/cache/history, HOME canonicalization or ACL repair is added.

The source regression queries a genuine directory alias once through the fixed fixture-only
helper, then checks parent/file identity, canonical coalescing and default publication. Alias
absence fails proof without a fake, skip, fallback or OS setting change. The query is absent from
production/SEA admission. Raw dot refusal reuses that owned fixture. The selected names, assertions,
HOME strings and all root/entry/byte/process/time limits remain; runtime/SEA/durability proof
still requires actual receipts.

Config payloads are bounded at 2 MiB, assemblies/engine at 1 MiB and IPC at 8 MiB.
Eight fixed store/control/pending names are reserved before growth; no unknown prefix entry,
partial store or coexisting POSIX store is adopted. The retained 4096-intent/8192-record,
32768-byte-record/256 MiB logical limits and 64 KiB control reservation remain, with no reset.
These are application-managed logical budgets, not a quota on the OS or filesystem internals.

Native publication records intent before temp growth, then writes and flushes a private pending
file opened WRITE_THROUGH. Rename uses that SAME handle and the pinned parent handle through
`NtSetInformationFile`, so the target name stays relative to that handle; the Win32
`SetFileInformationByHandle` wrapper refused every such rename on windows-latest. Store-slot renames
use FileRenameInformation without replacement. The config replacement uses FileRenameInformationEx
with REPLACE_IF_EXISTS|POSIX_SEMANTICS, because the command's own delete-sharing read pin keeps the
old config open and NTFS refuses an ordinary replacement of an open target with access denied.
A handle another process holds without delete sharing still refuses the replacement. Microsoft documents NTFS metadata flushing, including rename, for write-through
requests; this is the implementation design basis under ordinary OS/storage assumptions and
the documented hardware caveat, not synthetic power-loss proof. No path-based fallback,
unsupported ReplaceFile write-through, TxF, ACL repair or administrator volume flush is used.
Postattempt uncertainty stays unknown; successful rename followed by observation/outcome
failure stays published-but-unconfirmed. Evidence is retained and never replayed automatically.

Capture is read-only and binds native parent PID/creation time; publication checks that exact
parent and observes liveness at boundaries. Those checks and the 10-second termination control
are not an atomic process-death barrier or hard whole-infrastructure/process-tree guarantee.
Same-user legacy writers, operator edits and trusted administrator interference still prevent
complete producer/history or physical-eligibility proof. Foreign config/store mutation admission
is refused. Native evidence never authorizes HOME deletion or restores revoked grant knowledge.

Windows source verification must run the actual default publisher/supervisor paths and native
enrollment assertions; packaged verification executes the actual SEA's unchanged fixed engine
asset and DLL. Test-only fixture/fault assembly is separate and never embedded in the SEA.
All native outcomes, compiler/build identities, real OS exits, selected case names/counts and
remaining architecture/launcher/sharing limits require actual receipts. Source selection or a
filtered/skipped job is not passing proof. The existing OS matrix and 25-minute deadlines remain.
This document supplies no Windows build/test/CI result. The windows-latest job's exact-head
receipts and a fresh independent review are recorded on the pull request, not here.
