# Content-addressed workflow artifact storage

Workflow and large session-event artifact bytes are stored outside SQLite under a SHA-256-addressed sidecar root. The
default root is `<CONTROL_PLANE_DB>.artifacts` beside the database; set
`CONTROL_PLANE_ARTIFACT_DIR` to place it on a different persistent volume. SQLite remains the source
of truth for artifact ownership, provenance, MIME/encoding contract, exact byte size, digest, and
the sidecar key.

## Write and read integrity

- Incoming artifact text or canonical base64 is decoded once; prompt-image uploads enter as already
  bounded raw bytes. Exact byte count and SHA-256 must match validated metadata before any row is
  committed.
- Blob writes use a private temporary file, flush it, and atomically publish it without replacement into
  `sha256/<first-two-hex>/<full-sha256>`. Existing keys are read and verified instead of overwritten;
  identical content deduplicates across artifacts.
- A durable pending-write row exists before the sidecar write. If the process stops after the rename
  but before artifact metadata commits, startup removes the unreferenced blob. A failed metadata
  insert also attempts immediate cleanup.
- Reads accept only lowercase 64-hex keys, reject symlinks/non-files, require the exact metadata
  size, and recompute SHA-256 before returning bytes. Missing, truncated, replaced, or tampered blobs
  fail closed; raw export never falls back to an unrelated file or inline request value.

## Migration and deletion

Startup adds the content key column additively and migrates legacy inline artifact rows one at a time, so
memory use is bounded by the largest allowed artifact. Valid bytes are written first and SQLite is
cleared only in the committing transaction. A corrupt legacy row is left inline rather than
destroying its only recoverable copy; existing validation/export paths continue to reject it.

Eligible legacy session events are migrated separately, also one row at a time. Their complete
large text moves into ordered at-most-8-MiB artifact chunks while SQLite retains a bounded preview
and integrity references. Startup also removes event artifacts left by a crash before their event
row committed. See [large session-event payloads](./large-event-payloads.md).

Artifact deletion enqueues its content key transactionally. Bounded maintenance removes the file
only after confirming that no artifact row still references the digest, so deduplicated content
survives until its final reference is gone. Failed filesystem cleanup remains queued for a later
pass and startup recovery.

Raw prompt-image uploads are preparation leases, not permanent artifacts merely because their
bytes were accepted. Identical uncommitted bytes for the same Session reuse one metadata row and
renew its lease, so retries do not create unbounded duplicates. A successful queued edit commits
its prepared images; prompt, steering, event, and workflow associations independently protect the
images they reference. Maintenance expires an uncommitted, otherwise-unreferenced preparation
after eight days—one day beyond browser queued-edit recovery—and then uses the same retryable blob
garbage collection path. When a recovered queued edit is instead kept with **Use as New Message**,
the browser authenticated-exports and verifies every prepared image before storing self-contained
raw bytes in the ordinary local draft. The recovery remains available if any export fails, while a
successful conversion no longer depends on the bounded preparation lease.

## Backup and operations

Treat the database and artifact sidecar as one backup unit. For a consistent offline backup, stop
the control plane, copy the SQLite database (including WAL files if present) and the entire configured
artifact root, then restore both to their corresponding paths. A database restored without its
sidecar retains metadata but artifact reads and exports fail closed as missing. A sidecar restored
without its database is not discoverable or authorized and can be removed only through deliberate
operator recovery/cleanup.

The sidecar contains unredacted source, prompt images, large diffs and command output, screenshots, logs, and verdict bytes. Protect it with the
same access, encryption-at-rest, retention, and disposal controls as the control-plane database.
