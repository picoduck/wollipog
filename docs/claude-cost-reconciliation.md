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

This initial evidence schema accepts only amounts exactly representable in whole micro-USD.
Historical fractional micro-USD records require original carry attribution that older ledgers
discarded; they remain unresolved rather than altering another record's rounding carry.
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

The session's runner must support protocol 198 before a correction can apply. Its durable
`costReconciliationRevision` and cumulative correction delta let a newer acknowledged amount decrease once without allowing an
old snapshot to resurrect the overcount or apply the same subtraction twice. Applying the delta
relative to the runner's acknowledged correction preserves usage accrued before delivery. A disconnected runner
produces `synchronized: false` after a successful commit; reconnect or retry the exact apply to
resend the latest revision and total. Do not downgrade a runner managing a reconciled session:
an older runner's snapshots are rejected until it is upgraded.

Corrected totals feed subsequent session/checkpoint/daily budget checks. Proven excess historical
child charges are released, while active child reservations remain. Applying a correction does
not resume a paused session or clear an existing approval; use the normal reviewed Continue flow.
