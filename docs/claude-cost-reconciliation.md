# Historical Claude cost reconciliation

This operator API repairs supported historical Claude accounting from explicitly authorized,
accounting-only evidence. It never scans provider home directories, imports transcripts, or
automatically rewrites existing costs. Organization owners and admins with access to the session
may preview and apply; agent credentials and other human roles cannot.

## Evidence requirements

Before importing, verify the source's authority and scope yourself. The source SHA-256 is a
provenance reference to the accounting export you verified, not a signature or proof that the
submitted amounts are authentic. Setting `importAuthorized: true` attests that this accounting
import is authorized; applying requires separate approval of the exact preview digest.

Each record identifies the original event, hashed provider conversation and process identities,
and cumulative query-tree cost at its start and end. Query-tree scope includes delegated work and
internal calls. Parent-included child UI rows and independently billed records cannot be treated
as root query-tree costs. Do not infer boundaries from subscription utilization, main-loop tokens,
the current session model, or a cumulative total without a verified starting checkpoint.

Use `origin` or `reset` only for a proven new zero baseline with new conversation/process identities.
`continue` remains in the same process. `resume` starts a new process in the same conversation;
`fork` starts a new process and conversation with a verified inherited prefix. Adjacent cumulative
checkpoints must agree, and intervening independently billed/root accounting records cannot be omitted.
A fresh proven origin/reset can allow partial recovery after an unresolved earlier boundary.

The record's `model` identifies its original ledger attribution. For an independently verified
single-model query tree, scalar costs suffice. Otherwise supply complete `startByModelUsd` and
`endByModelUsd` maps whose sums equal the scalar costs; incomplete or decreasing model counters
remain unresolved. Original token attribution stays unchanged even when cost moves between models.

The original observation receipt must identify the frozen organization, owner, runner, workspace,
agent, model, and UTC hour. New accepted legacy events retain this receipt. For older events without
one, supply an `attribution` from a trusted accounting export, never reconstructed from current
ownership or settings:

```json
{
  "organizationId": "org_example",
  "ownerKind": "user",
  "ownerId": "user_example",
  "runnerId": "runner_example",
  "workspaceId": "",
  "agentId": "claude",
  "driver": "claude-code",
  "model": "claude-example",
  "bucketTs": 1789862400000,
  "granularity": "hour"
}
```

`granularity` identifies the currently retained original contribution (`hour`, `day`, or
`pruned`). Internally retained receipts track rollup and are removed when their aggregates are pruned. Both hourly and daily rows
without a known locator are ambiguous. Pruned contributions, missing replay coverage, already
corrected events, and ambiguous boundaries remain unchanged with reasons in the preview.

Whole micro-USD evidence remains supported. Fractional records additionally require a verified
original `rounding` checkpoint from an accounting receipt/export:

```json
{
  "rounding": {
    "originalMicro": 10001,
    "beforePicousd": 0,
    "afterPicousd": -400000
  }
}
```

This synthetic checkpoint describes an original cost of USD 0.0100006: ingestion allocated
10,001 micro-USD and retained a remainder of -400,000 pico-USD. `originalMicro` is the actual
integer ledger contribution, not independent rounding of the displayed provider amount.
Both remainders must be integers in [-500000, 500000). Adjacent original rounding checkpoints
must agree; the proof must match the immutable event and any retained receipt. Older records
may import this proof with their trusted original attribution. Missing proof stays unresolved.

The supported precision matches ingestion: whole micro-USD plus a pico-USD remainder. Cumulative
query-tree and per-model checkpoints are compared at that precision. Preview shows raw costs,
original/proposed integer ledger allocations, session remainder changes, and the allocation policy.
Apply preserves unrelated integer contributions. It settles net rounding units only within the
corrected rows, in evidence/model order, from the last affected model with positive verified cost.
A correction needing a negative or unavailable retained contribution stays unresolved.
Per-model/time-bucket totals remain integer micro-USD; session totals additionally retain their
pico-USD remainder. Ancestor budget charges release only the proven exact correction while
preserving existing peak and reservation floors. Audit records the allocation and both delta parts.
Requests reject unknown fields and accept at most 200 accounting records and 20 models per map.
Never include prompts, transcript text, credentials, paths, or arbitrary provider payloads.

## Preview, approve, apply, and audit

Use the normal human-authenticated control-plane HTTP client. The following is synthetic evidence;
replace coordinates and amounts only with verified accounting records:

```json
{
  "sessionId": "session_example",
  "eventEpoch": 0,
  "historyEpoch": 1,
  "importAuthorized": true,
  "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "records": [
    {
      "eventId": 101,
      "conversation": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "process": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "boundary": "origin",
      "startUsd": 0,
      "endUsd": 0.01,
      "model": "claude-example",
      "scope": "query-tree"
    },
    {
      "eventId": 102,
      "conversation": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "process": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "boundary": "resume",
      "startUsd": 0.01,
      "endUsd": 0.02,
      "model": "claude-example",
      "scope": "query-tree"
    }
  ]
}
```

`eventEpoch` is the session's accounting epoch, the value the correction export reports. It is
usually the session's event epoch. A crash-recovery renumbering advances the event epoch for
dashboards but leaves the accounting epoch alone, because it keeps every event and id
(see [Control-plane database durability](control-plane-database-durability.md)).

1. POST this evidence to `/api/usage/claude-reconciliation/preview`. Preview is read-only. Inspect
   original/proposed totals, per-model proposals, original event timestamps, source digest,
   unresolved records/reasons, and runner/budget effects.
2. Review the exact evidence and returned `digest`. POST to
   `/api/usage/claude-reconciliation/apply` with
   `{ "evidence": <the same object>, "approvedDigest": "<preview digest>", "approved": true }`.
   A changed ledger invalidates the approval; obtain and review a fresh preview.
3. Read `GET /api/usage/claude-reconciliation/audit?sessionId=<id>` to verify the latest 20
   append-only reconciliation receipts, actor, source, evidence, delta, revision, and result.
   Original events remain immutable; receipts describe the correction.

Observation receipts are removed with their original events or pruned aggregate contribution.
Reconciliation audit receipts live with the session and are removed when that session is deleted.

Apply commits session, model, retained bucket, parent budget charge, audit, and deduplication changes
in one SQLite transaction. A retry with the exact evidence and approved digest is idempotent.
Unresolved records remain unchanged; tokens, cache savings, unrelated costs, replay watermarks,
provider baselines, checkpoint approvals, and existing approval cards remain intact.

The session's runner must support protocol 210 before a correction can apply. Its durable
`costReconciliationRevision` and cumulative correction delta let a newer acknowledged amount decrease once without allowing an
old snapshot to resurrect the overcount or apply the same subtraction twice. Applying the delta
relative to the runner's acknowledged correction preserves usage accrued before delivery. A disconnected runner
produces `synchronized: false` after a successful commit; reconnect or retry the exact apply to
resend the latest revision and total. Do not downgrade a runner managing a reconciled session:
an older runner's cost snapshots for the affected session are fenced until it is upgraded.
Unrelated sessions still reconcile, and Stop/archive enforcement remains active. A runner
acknowledging a revision ahead of a restored control-plane database is fenced per session too,
rather than guessing the missing correction. New forks start with their own correction identity.

Corrected totals feed subsequent session/checkpoint/daily budget checks. Proven excess historical
child charges are released, while active child reservations remain. Applying a correction does
not resume a paused session or clear an existing approval; use the normal reviewed Continue flow.

## Recover after a control-plane database restore

A runner may already have acknowledged corrections absent from a restored database. The server
durably retains the highest valid acknowledgement reported by the owning runner. Affected accounting
remains fenced; stale lower snapshots cannot clear it. Unrelated sessions and Stop/archive enforcement
continue. A revision or scalar runner total alone is insufficient evidence for recovery.

Before restoring, retain the complete accounting export returned by
`GET /api/usage/claude-reconciliation/export?sessionId=<id>` with your trusted backup. The bounded
export includes original digests, deltas, evidence, corrected event identities, and pre-correction
ledger checkpoints. Exports include at most 20 contiguous revisions and recovery imports at most
1,000 evidence records. Keep the latest export covering every acknowledged runner revision.
Treat its SHA-256 as a provenance reference, not proof of authenticity; verify the backup/export's
authority yourself. Automatic export refuses incomplete or pre-feature receipts without checkpoints.
For older receipts, recovery requires those checkpoints from a verified accounting backup instead.

For each revision, `beforeLedger` contains the original usage-ledger `revision`, `costMicrousd`,
`remainderPicousd`, `coveredThroughSeq`, and maximum original session-event `eventSeq`. These are
accounting coordinates and amounts, not the runner's correction revision. They establish whether the
restored ledger still contains the unapplied contributions. Recovery validates any later accepted
provider-reported events and retained receipts against that checkpoint. Unpriced/estimated suffixes,
snapshot-only catch-up, missing/pruned contributions, changed history scopes, conflicting prefixes,
or unavailable proof remain unresolved. Never manufacture a checkpoint from the current total.

1. Verify the trusted export and restore scope. Add `importAuthorized: true` and `sourceSha256`
   to its top-level object; do not add prompts, transcripts, paths, or arbitrary provider payloads.
2. POST it to `/api/usage/claude-reconciliation/recovery/preview`. Inspect `databaseRevision`,
   `runnerAcknowledgedRevision`, `targetRevision`, projected costs, recovered revisions, and
   unresolved dependencies. The preview simulates changes under a rolled-back SQLite savepoint;
   it leaves accounting, budget charges, audit, and deduplication state unchanged.
3. Only if the entire missing chain is recoverable, separately approve that exact `digest` and POST
   `{ "evidence": <same object>, "approvedDigest": "<digest>", "approved": true }` to
   `/api/usage/claude-reconciliation/recovery/apply`. Ledger changes, new usage, or a newly observed
   higher acknowledgement invalidate the preview. The whole replay and recovery receipt commit
   atomically, retaining original correction identities and preserving post-checkpoint usage.
4. Verify `/api/usage/claude-reconciliation/audit?sessionId=<id>`: `reconciliations` retains the
   correction chain and `recoveries` records the operator, export provenance, recovered revisions,
   and result. Exact retries do not repeat corrections. A committed recovery with
   `synchronized: false` needs normal reconnect or exact retry to resend the latest revision/delta.

Recovery retains the original cumulative correction delta, even if newer usage changes where an
integer rounding unit is allocated. Already acknowledged corrections are never subtracted again;
older snapshots receive only unacknowledged corrections. The fence clears through normal supported
runner synchronization once every observed acknowledgement is covered. Do not reset runner revisions,
bypass the fence, or automatically resume paused work/clear approvals.

The additive accounting tables preserve older history and whole micro-USD reconciliation. Runners
supporting protocol 199 already accept fractional USD deltas, but protocol 210 is now required
for content-bound correction acknowledgements and metadata repair.
Do not downgrade the control plane after fractional corrections: older code does not read the new
precision receipts. Observation/recovery/precision metadata follows session deletion.

For operations, query structured HTTP events `claude_cost_reconciliation_applied`,
`claude_cost_reconciliation_recovery_applied`, and `claude_cost_reconciliation_recovery_rejected`
by `requestId`. Applied events include `revision`, `applied`, and `synchronized`, with `entryPoint: http`;
they exclude imported evidence and actor details. Existing runner fencing emits
`cost_reconciliation_revision_unavailable`. Use preview reasons and scoped audit for diagnosis;
no metrics backend or new external dependency is introduced.

## Content-bound acknowledgements and upgrades

Protocol 210 binds each correction prefix to a SHA-256 identity of its session/history scope,
ordered original audit digests, and exact micro/pico-USD deltas. A revision number is not proof
of correction content. Snapshots report the identity and cumulative applied adjustment; synchronization
also names the runner's expected prior coordinate. A matching number with different content,
missing identity, unknown repair generation, or missing prefix stays fenced. A skipped revision is
applied only from the runner's matching prefix, preserving usage accrued since the correction.
Equal/stale observations stay read-only unless they establish a new durable conflict.

Upgrade both peers before new corrections. Previously reconciled runner metadata has numeric
coordinates without identities; it must use the verified repair procedure below before synchronizing.
Never automatically adopt the server's identity for an old number. Forks start with fresh accounting
metadata; continuation/restart retain the existing coordinate and repair generation, including a
Restart using a changed agent driver on the same Wollipog session ID. Accounting belongs to that
session's lifetime, while provider conversations may start fresh. Control-plane
or runner downgrade after content-bound corrections or repairs is unsupported. After restore, recover
the verified original chain before ordinary corrections; a same-number conflicting chain cannot be
resolved by guessing which total is newer.

## Repair invalid acknowledgement metadata

This procedure repairs metadata only. It neither reconstructs missing costs nor edits valid usage,
correction audits, tokens, budget floors, replay coverage, or approval cards. It is suitable, for
example, when a verified owning-runner baseline matches the complete authoritative accounting
checkpoint but its correction revision was corrupted to 9007199254740991. A lower snapshot alone
never clears that observation. Verified repair can compare and swap the runner's current sane lower
coordinate while auditing the older corrupt observation separately. Genuine missing corrections must
use restore recovery first.

1. Independently verify the complete authoritative accounting state and the owning runner's current
   accounting-only metadata. A current database export or a runner scalar alone cannot establish
   that a newer correction is missing. Verify the trusted source before authorizing its import.
2. `GET /api/usage/claude-reconciliation/repair/export?sessionId=<id>` returns the current session,
   event/history scope, correction coordinate, and ledger checkpoint. Compare these to your trusted
   accounting source. Its checkpoint must match the retained ledger exactly, including tokens,
   rounding carry, coverage, and sequence. The runner baseline must match at pico-USD precision and
   retain the same cumulative adjustment. Changed monetary baselines remain unresolved.
3. Submit the verified checkpoint to `POST /api/usage/claude-reconciliation/repair/preview`, adding
   `importAuthorized: true`, the verified source's `sourceSha256`, and `runner` containing its
   expected `revision`, optional `identity`/`repairId`, `deltaUsd`, `costUsd`, `tokensIn`, `tokensOut`,
   `seq`, and `historyEpoch`. These two fields use the negotiated wire history coordinates from the
   owning runner's projected snapshot, not the raw local event sequence or `logEpoch`. The runner
   compares the same projection when applying the repair. Unknown fields and content-bearing imports are rejected. The preview
   is read-only and explains the target coordinate, remaining evidence, and runner effects.
4. Approve the exact preview and post `{ evidence, approvedDigest, approved: true }` to
   `/api/usage/claude-reconciliation/repair/apply`. Approval commits a durable audited intent,
   not clearance of the fence. `synchronized` means a frame was sent, not that repair completed.
5. The owning runner compares its full expected state before atomically changing only correction
   metadata and recording the approved repair digest. Concurrent usage or metadata changes refuse
   that command. It publishes the new coordinate and repair generation; the control plane then
   atomically confirms the audit and replaces its corrupt observation. Unconfirmed sessions stay
   fenced, while unrelated sessions and Stop/archive enforcement remain available.
6. Read `GET /api/usage/claude-reconciliation/audit?sessionId=<id>`: `repairs` records the approving
   actor, provenance, intent and `confirmed` status. Exact retries resend the latest still-valid
   intent; reconnect/restart also retries it. Superseded intents cannot be replayed. Metadata or
   accepted accounting changes require a fresh preview. Repair never automatically resumes work.

The repair digest remains a durable generation on both peers, including revision zero. Old
snapshots cannot re-create the cleared high-water mark; old pricing frames cannot undo the repair.
Missing or conflicting generations remain fenced. If a failure occurs after one side commits,
reconnect or retry completes the handshake without subtracting a correction again. All local
multi-row database writes are transactional. No cross-process transaction is assumed.

Repair uses existing human owner/admin session authorization and explicit source verification.
The source SHA-256 is an attestation reference, not a signature. This API is not permission to
clear arbitrary observations: insufficient or conflicting proof remains unresolved. Existing
20-revision/1,000-record restore limits remain unchanged. No live accounting is modified by an
upgrade alone, and no provider directories, prompts, transcripts, credentials, or current settings
are scanned. Structured HTTP events report `claude_cost_acknowledgement_repair_approved` or
`claude_cost_acknowledgement_repair_rejected` without importing evidence into logs.
