# Managed Provider HOME Retirement Proposal (Refs #3157)

Revision 2; unapproved design, not implemented. Source base: `a9caf495a252d0d6c4e14c5cf53a70a4a7339923`. This replaces the inaccessible temporary proposal. Its old hash is not evidence of review. No real credentials may be retired during implementation or verification.

## Source Facts and Supported Sharing

The SSH-account-level root returned by `apps/runner/src/provider-profile-home.ts:13` deliberately survives replacement runners and their owner-namespaced data directories. Multiple control planes may hold profile grants. This is the real shared-HOME scenario; cross-host filesystems and unknown consumers do not become safe because paths match.

Confirmed source ordering, not a reproduced loss incident:

- `provider-login.ts:1088` acquires/releases or calls profile retirement, then removes the directory at line 1133.
- Login settlement releases at line 967 before duplicate/unused cleanup at lines 970-971. Spawn failure and cancellation do likewise at lines 520-521 and 554-555.
- Pre-acquisition/profile-create failures reach unused cleanup at lines 462 and 482. `cleanupUnusedDirectory` at line 1153 relies on an absent credential filename; that is not ownership proof.
- `provider-home-lease.ts:1286` forgets a successfully released entry. `retireProfileHomeWhileHeld` at line 798 releases before returning its boolean.
- Account removal writes configuration before cleanup (`provider-login.ts:683-695`). Keep that ordering and report retained credentials truthfully.

Planning report626 established ordering, not cross-runner loss. No synthetic concurrency reproduction has been run in this worker yet. Directory location, UUID, missing credential marker, empty grant list and release success never independently authorize deletion.

## Proposed Partial Implementation Boundary

First disable unproved recursive cleanup on every login/account-removal route. Retain all legacy, operator-owned, configured/published, foreign, malformed and unknown HOMEs. Preserve revocation, local reservations, process reaping, skill serialization and configuration-write safeguards. A removed configured account returns `credentialsRetained: true` when its HOME remains.

Permit physical cleanup only for a newly created, never-published managed HOME with durable creation provenance, an uninterrupted worker-private creation capability and its exact sole completed login reference. Ordinary failed login retains credentials written by the provider; duplicate cleanup can remove them only with the same retirement proof. Crashes lose the private capability and retain the payload. Missing proof disables physical cleanup rather than silently weakening this boundary.

This is a partial safety slice. It does not deliver physical cleanup of configured accounts, exhaustive dormant-binding accounting, legacy migration or full #3157 closure. The final section specifies the minimum remaining full-issue contract.

## Namespace, Provenance and Old-Binary Exclusion

Use a new nested namespace under the existing verified shared root: `<profiles>/.managed-retirement-v1/homes/<profileId>`. Sibling `state/<profileId>` holds permanent provenance, fences and canonical journals; `retired/` holds detached payloads. Existing `<profiles>/<profileId>` and runner-local legacy HOMEs are never migrated or deleted automatically.

Create privately in staging. Record root/parent/HOME device and inode, canonical parent/name, profile/provider, attested instance/initial grant, creation nonce and guard hashes. Write exclusively, fsync, then publish with native no-replace rename. Foreign/preexisting destinations and incomplete provenance retain. Disk provenance is necessary but cannot reconstruct the creating worker's private epoch-bound capability after a crash.

Before exposure, install an immutable incompatible journal barrier inside the payload. A concrete candidate is fixed non-lease bytes `{"kind":"wollipog-managed-home-external","version":1}` plus newline at the canonical recovery filename and the historical lock-directory lease/checkpoint filenames. Store their identities/hashes externally. Never publish a compatible lease there; new code uses the external canonical journal.

Base anchors: `provider-home-lease.ts:252-281` validates required record fields; lines 475-504 read the recovery record or historical lease record; line 817 skips profile access for PROFILE_CHANGE but does not skip journal validation. The candidate lacks required lease fields and must be refused. An arbitrary unknown filename alone is insufficient: canonical-root enumeration at line 432 is conditional on the journal path taken. Verify exact sentinel bytes against each supported historical reader, including legacy profile mutations and packaged workers. These are proof obligations, not completed compatibility tests. An unproved reader cohort means retention/unsupported.

An old process already paused after release does not consult a new fence. Therefore legacy names cannot be made deletable by adding a marker. For new nested names, the base removed-account predicate at `provider-login.ts:1088-1109` accepts only direct children of its fixed profile/account root; existing-account refresh has `persistAccount: false`. Demonstrate those paths cannot target the new namespace, including aliases. Enumerate historical fresh-login cleanup paths; any version that can delete the new namespace without these checks disables retirement for that cohort. No inference from a version number or random UUID is sufficient.

## Publication and Consumer Races

Durable state is `preparing -> private -> published`, or `private -> retired`. Published and retired are irreversible in this revision. Commit published state before configuration writes, account reports, adoption, or any acquisition not bound to the creating login's capability. A failed/ambiguous configuration write therefore retains permanently. Reconnect/revocation cannot turn published into private.

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

After terminal commit there is no rollback or compensation into an ordinary released lease. Crash before detach leaves credentials in place with admission blocked. Crash after detach leaves a private payload for inspection. Lost completion or interrupted traversal reports indeterminate/retained; do not infer success from absence of the original path. `homeRemoved` must come from exact removal proof, replacing the current existence-based settlement at `provider-login.ts:489`.

Linux may use `renameat2(RENAME_NOREPLACE)` only where the syscall/filesystem and same-filesystem identities are verified. Existing `apps/runner/native/provider-home-lease-io.c:124,197,301` pins ancestry and fences journal operations; its `renameat` at line 295 selects a checkpoint and is not an approved payload-detach primitive. Extend the fixed helper explicitly. Unsupported syscall/filesystem, EXDEV, collision, macOS, Windows and WSL retirement retain until an equally strong native primitive is implemented and tested. Never emulate no-replace using stat-then-rename; do not execute a helper chosen by an agent RPC or configuration value.

## Verification and Delivery

Synthetic credentials and isolated fixtures only. Deterministic barriers must cover competitor-first and retirement-first admission; outstanding local references; pending receipt/ack; success/publication/config-write failure; duplicate/failure/spawn-failure/cancellation/pre-acquisition failure; account removal retention; unknown remote/dormant bindings; crashes around each durable write/detach; ambiguous release; malformed/foreign/hardlinked/symlinked artifacts; retargeted aliases/root/HOME identity; old-reader and paused-old-cleanup exclusion; platform refusal; and exact retired-payload removal preserving a successor and all external evidence. Re-run recovery/compaction tests proving no revival.

Use frozen-lockfile setup, focused provider login/profile/lease/worker/native tests, runner/protocol typechecks and packaged worker/helper/sidecar checks. Recheck overlaps with PR3406's helper IO/staging work and session-manager changes before implementation. No dependency updates or unrelated refactors.

Required review uses runner-owned request_cross_model_review on the own pushed PR/exact head, latest Claude Opus/high and read-only snapshot, with at most four valid rounds/two launched attempts per round. Independently adjudicate findings and preserve actual admission/cost/refusal receipts. No alternate native reviewer. Required exact-head CI, human per-PR merge consent, exact typed parent merge decision, actual merge-group MERGED and separate human/typed branch-deletion consent remain. Use Refs #3157; closure stays parent-owned. No stack operations, settings/auth/grant expansion or real-credential retirement.

## Minimum Remaining Path to Full Configured-Account Retirement

Full delivery requires a reviewed durable binding-retirement contract in addition to the partial protocol above:

1. Before a new profile becomes configured or externally bindable, durably enroll every account/session/default/background/remote consumer in a complete generation-bound manifest. Bind local registrations and participating control planes to the external provenance/identity. Missing or legacy consumers retain. Grant lists and runner heartbeats are not completeness attestations.
2. Under the same fence, freeze new bindings/admissions and obtain exact acknowledgements that every enrolled consumer is retired and all provider trees/references are drained. Include dormant persisted sessions, disconnected runners, other control planes and pending config/publication operations. Revoke only through existing authorized actions; do not invent permission to discard dependent bindings.
3. Bind an exhaustive manifest digest/generation and authorized account-removal intent to the terminal CAS. Racing adoption, reconnect, config writes or new grants must either precede the manifest freeze and be accounted for, or fail after it. Missing acknowledgement, unsupported peer, foreign grant or uncertain release retains indefinitely.
4. Prove mixed-version rollout and legacy-name exclusion. Existing legacy profiles need separately authorized offline ownership/consumer proof or remain retained forever; an online marker retrofit cannot stop a paused old cleanup. Published profiles from the partial revision cannot be reclassified private by an upgrade.
5. Demonstrate positive configured-account physical removal only when these proofs hold, plus deterministic races/failures and truthful retained/indeterminate results. Independently review that full protocol before implementing its new cross-component messages or migration behavior.

These requirements remain on #3157. Approval of the partial slice cannot close the issue or establish that full configured-account retirement is solved. This document requests no new authentication, governance, runtime/resource, artifact-transfer or hosting authority.
