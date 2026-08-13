# Authenticated transcript exports

The session detail menu can download a JSON or Markdown point-in-time transcript through:

- `GET /api/sessions/:id/export?format=json`
- `GET /api/sessions/:id/export?format=markdown`

These are authenticated, session-scoped reads. Owners, admins, and members who can read the session
through their user or team ownership can export it. An inaccessible or deleted session returns the
same `404` as other scoped session reads. The conductor credential is not allowed on this route.
The browser sends the paired-device token in the `Authorization` header, receives a `Blob`, downloads
it through a temporary object URL, and revokes that URL. Tokens never enter an export URL.

## Snapshot and completeness boundary

An export freezes the control-plane SQLite event-cache high-water before reading. Events appended
after that boundary cannot enter the response. The endpoint does not call runner history hydration:
the current runner history RPC is unpaginated, and hydration is not an awaitable single-flight
completeness barrier. Consequently, the export is complete only for the persisted control-plane cache
at that instant and may be partial relative to the runner's full provider transcript. Active, offline,
archived, and empty sessions all follow this same rule.

The server rejects rather than truncates snapshots above 10,000 source events, 16 MiB of raw persisted
event payloads, or 8 MiB of projected/rendered UTF-8. Oversize responses return `413`. Bounded,
seekable runner history belongs to roadmap item 12.

## Least-data projection

JSON uses the versioned, fail-closed shape below; Markdown is rendered from the exact same projection.

```json
{"schemaVersion":1,"source":"control-plane-cache","completeness":"possibly-partial","messages":[{"role":"user","text":"..."},{"role":"assistant","text":"..."}]}
```

Only top-level user and assistant text survives. The projector omits attachments and images, database
and protocol ids, sequence numbers, timestamps, runner/workspace/model/configuration metadata,
thoughts, plans, tools, shell output, file edits and diffs, approvals, questions, reviewer decisions,
checkpoints, usage, status/error events, and parented subagent messages. Assistant stream chunks are
coalesced before text redaction. Adding a new event kind fails the exhaustive projector/test until its
disposition is explicit.

Message text receives deterministic best-effort redaction for common credential shapes and known
machine-local workspace/worktree roots. This is **operational redaction, not secret detection**.
Arbitrary secrets, source code, personal data, or other sensitive text can remain. Treat every export
as sensitive and review it before sending it elsewhere. It is not a public share or a claim that the
content is safe to publish.

Markdown places every message in a dynamically sized code fence so embedded HTML, headings, links,
images, and fence-looking text stay inert in CommonMark renderers. Both formats are attachments with
fixed safe filenames, exact content lengths, `Cache-Control: private, no-store`, and `nosniff`;
Markdown also carries `Content-Security-Policy: sandbox`.

## Sharing boundary

[Expiring transcript share links](./transcript-sharing.md) now persist this exact immutable
projection behind a separately hashed, revocable capability. Public reads never return to live
session events. Raw workflow artifacts use a separate authenticated, unredacted byte-download
boundary; see [authenticated raw workflow artifact exports](./artifact-exports.md).
