# Runner credentials and runner-local secrets

Runner authentication is scoped to one exact runner id. The control plane returns a 256-bit
`wollipogr_...` plaintext secret only in an owner/admin issue or rotate response and stores only its
SHA-256 digest. Credential metadata records the full organization/owner scope, creator, label,
status, and bounded timestamps; list responses and runner views never contain plaintext.

Existing exact-runner credentials with the legacy `mamr_` prefix remain valid. Authentication
compares only the SHA-256 digest of the complete opaque token, so the producer cutover does not
rewrite database rows, rotate credentials, or disconnect an active runner. The desktop and
development bootstrap continue accepting both exact prefixes followed by the same 43-character
base64url secret. After a legacy credential authenticates successfully, the control plane emits one
value-free migration warning per runner for that process lifetime; rejected credentials cannot
produce the warning.

## Issue, activate, rotate, and revoke

The owner/admin REST surface is:

- `GET /api/runner-credentials` — organization credential metadata only;
- `POST /api/runner-credentials` — issue a 24-hour pending credential for an unregistered id or
  an existing runner that has no credential during fail-closed fleet migration;
- `POST /api/runner-credentials/:runnerId/rotate` — issue a replacement pending credential while
  retaining the current active credential;
- `DELETE /api/runner-credentials/:runnerId` — revoke active and pending credentials and close the
  runner socket immediately.

Issue and rotate replies are `private, no-store` and return plaintext once. Reissuing before first
registration replaces a lost pending plaintext. The first successful `/runner` registration with
the exact id activates the pending credential and persists runner metadata in the same SQLite
transaction. Rotation therefore has no planned disconnect: the old credential remains active until
the replacement registers, then becomes revoked. Pending credentials expire after 24 hours.

Authentication is rechecked against the active digest on every runner WebSocket frame. Conductor
REST claims additionally require an active credential for the exact session runner and the existing
live-session route allowlist. Revocation, runner deletion, or id reuse cannot inherit a prior secret
or ownership scope. Cross-organization lifecycle requests return the same not-found response as an
unknown runner.
The database retains the 64 most recent ordinary revoked credentials per runner plus the single
legacy-migration row; older unusable hashes are pruned so reconnect/redeploy loops cannot grow the
database or organization list response without bound. The immutable mutation audit remains the
long-lived attribution record.

The onboarding dialog generates the credential only after the user chooses the exact runner id.
Changing the id invalidates the displayed secret. Store it once in a protected file and start the
runner with `--token-file <path>` or `RUNNER_TOKEN_FILE`; generated JSON contains no token.

Legacy acceptance is not removed on elapsed time alone. Removal requires all supported rollback
versions to accept `wollipogr_`, no supported control-plane producer to issue `mamr_`, an explicit
rotate or reissue sweep covering every active and pending runner credential, and a release soak with
no authenticated legacy-credential warnings. Until that evidence is recorded, both strict
acceptors and the post-authentication warning remain compatibility requirements.

Existing single-runner installations may set `CONTROL_PLANE_TOKEN` during upgrade. At startup the
control plane can create one exact-id active credential for that sole existing runner, then uses the
same digest-based path. A database containing multiple runners fails closed: copying one fleet
digest to several ids would preserve cross-runner impersonation, so the operator must issue each
runner a new one-time credential before reconnecting it. The legacy token is never accepted for an
unknown/new id and cannot reseed a runner after revocation. Remove the migration variable after the
remaining runner has moved to its runner-specific credential.

## SSH-managed boxes

Each bootstrap gets a fresh pending credential. The control plane sends plaintext only over SSH
stdin into a mode-0600 immutable `.agent-manager/credentials/<credential-id>` file and launches the
runner with that filename. A superseded deployment cannot overwrite a newer credential path, a
bounded timeout terminates a stuck transfer, and files older than seven days are swept. Activation
occurs only when the intended runner registers, so an unsuccessful bootstrap does not revoke the
currently working credential.

New dashboard-managed boxes also receive a server-derived
`.agent-manager/runner-data/<box-id>` root through `--data-dir`. The value is persisted with the box,
is shell-quoted by the launcher, and is never supplied by the browser. Boxes created by older
control planes retain a `NULL` layout marker and continue to name the historical
`.agent-manager` root; they are not silently reinterpreted as isolated boxes.

An owner or administrator can authorize migration for one of those legacy boxes from **Manage
Machine → Legacy Runner Data** only after confirming that every old runner using the SSH account is
stopped. Active sessions on every known legacy box sharing the exact SSH target and port require the
existing explicit force confirmation. The orchestrator serializes that account, supersedes every
sibling's reconnect timer, stops and awaits every managed child, and only then records a random
adoption epoch with actor, role, and timestamp. A partial stop failure records no authority and
retains the exact failed child. A control-plane restart rehydrates the pending epoch, but only the
matching current launch receives `--adopt-legacy-data-dir`; siblings remain parked until exact
registration completes. The first matching registration retains the audit and releases siblings
through owner-aware isolated namespaces. The UI/API expose only bounded account pending/adopted
state and timestamps, never credential material or parsed stderr, and never offer a second adoption
for an already-owned account. The account audit is independent of box deletion and records the exact
completion credential and attested binary identity; a pending adopter cannot be deleted. Any
isolated, adopted-account, or `--adopt-legacy-data-dir` launch
requires a remotely SHA-256-attested, full-digest-addressed current runner binary; the mutable
legacy fallback is rejected before credential issue because an older parser may ignore ownership
flags.
Completion additionally requires that current-binary proof and the exact credential minted for the
launch. An explicit adoption attempt against a root already owned by another runner fails closed
instead of recording a migration in that runner's replacement namespace.

## Agent and conductor secrets stay runner-local

An agent `env` entry may be a literal string for compatibility or a host reference:

```json
{
  "env": {
    "API_TOKEN": { "fromEnv": "MY_AGENT_API_TOKEN" }
  }
}
```

Reference names are validated and resolved from the runner host immediately before every new,
resume, recovery, adoption, or fork launch. Neither values nor reference names are sent in runner
metadata. Session specifications and runner session metadata persist `env: {}`. Startup migration
scrubs pre-v54 environment values from control-plane durable commands, runner metadata, and local
session snapshots; commands that have not begun are rejected instead of being replayed with removed
secrets. Native and WSL launches pass resolved values through the child environment, never argv.

Conductor MCP sessions likewise do not duplicate the active credential. Before opening any mutable
store, the runner takes an exclusive process lease on `dataDir` and checks a protected owner marker
bound to the runner id and the control plane's durable instance id. A frozen v1 marker retains the
normalized endpoint used when that compatibility marker was first published, and both current and
rollback runners write the shared lease with its v1 hash. A live process therefore fails before a
runner from either generation can stage a credential or open a session store. The stable marker
remains after shutdown, so a different runner or control plane cannot later adopt the same root
silently. Instead, a different owner is placed deterministically below
`<dataDir>/runner-instances/<owner-hash>`. This also lets a managed machine that is removed and later
added with a new runner id start cleanly without taking over the old sessions. Operators may still
use `--data-dir` or `RUNNER_DATA_DIR` for an explicit root.

When rolling back to the preceding endpoint-owned runner generation, use the endpoint and runner
configuration that originally published the v1 marker. A current runner may move endpoints because
its stable ownership no longer depends on the address, but the v1 marker is deliberately not
rewritten: after such a move, the rollback-era endpoint/configuration is required to reopen the
same root while preserving cross-version mutual exclusion. This compatibility applies to the owner
of the requested root. A second runner placed below `runner-instances/<stable-owner-hash>` cannot be
reopened there by the preceding generation, whose namespace hash used the endpoint instead of the
attested control-plane identity. Rolling that runner back starts a separate endpoint-hashed namespace
and does not expose its current sessions; keep the current binary available to recover them, or give
each rollback-sensitive runner its own explicit data root.

The active credential is mode 0600 at
`<dataDir>/credentials/instances/<owner-hash>/active-runner-token`. Per-session Conductor MCP
configuration lives under `<dataDir>/conductor/runner-instances/<owner-hash>`, contains only
`MANAGER_TOKEN_FILE`, and is refreshed before every launch or resume. Startup sweeps only that
attested leaf; it never removes top-level legacy per-session MCP JSON that may have embedded
`MANAGER_TOKEN`. The MCP process still understands the legacy environment variable for rolling
compatibility, but current runner launches use only the protected file reference.

An empty pre-marker data root is claimed automatically. A populated pre-marker root fails before
publishing a lease or changing any byte because a still-running old binary cannot honor the new
lease. After stopping every pre-upgrade runner that uses the root, an operator may authorize exactly
one migration by adding the CLI-only `--adopt-legacy-data-dir` flag. The durable owner marker records
that authorization and its timestamp, so subsequent starts do not need the flag. Environment and
configuration-file equivalents are intentionally unavailable: migration must be a deliberate,
auditable startup action. For a configured runner, stop its service and run its normal command once
as `wollipog-runner --config <path> --adopt-legacy-data-dir`; config-less launchers append the same
flag to their otherwise unchanged command.

The explicit flag can also adopt a v1 endpoint-owned root whose marker still matches the configured
runner id and endpoint when its prior scoped credential is unavailable or no longer accepted. The
operator's stop acknowledgement is the authority in that recovery case; without the flag, startup
leaves the v1 root untouched and uses a separate stable-owner namespace. A mismatched v1 marker is
never adopted.

During the authorized migration, startup copies the protected legacy
`<dataDir>/credentials/active-runner-token` bytes to the scoped path before recording ownership and
leaves every legacy file intact for rollback. The newly issued launch token remains staged until
registration, so ordinary credential rotation does not make an upgrade unreadable. A populated root
from a runner that never registered still requires explicit authorization because its session and
other mutable state cannot prove that an old process has stopped.

An abandoned same-host process lease is reclaimed only after its recorded process is no longer
alive. A separate atomic recovery guard serializes stale reapers; if recovery itself is interrupted,
startup fails closed until an operator verifies no runner is active and removes the named guard.
Leases from another host and malformed lease metadata fail closed. Owner, lease, recovery-guard,
and migrated credential publication is crash-durable on platforms that support directory flushes:
new directory entries are flushed in order, file contents are flushed before the exclusive hard
link, and the containing directory is flushed after link and cleanup. Windows errors that precisely
indicate unsupported directory open/flush behavior are tolerated; permission, I/O, and bad-handle
errors still fail closed. Other durability failures abort startup before mutable stores open.

The ownership boundary covers runner-managed sessions, native worktrees, admission records,
durable-command and session-command receipts, checkpoint ownership, cleanup journals, registry
approvals, Claude hook launch files, Conductor launch files, and native isolated provider-state
partitions because their production constructors all receive the claimed data root. Provider CLI
installation, discovery, and login bytes remain operator-owned files. Mutable native provider,
Seatbelt, Windows Job, ACP, and Agent TUI launches are serialized across control-plane owners by a
process-lifetime lease beneath the canonical effective `HOME`. Direct WSL provider mode fails closed
because its external lock cannot safely prove Windows process liveness; use bwrap or a dedicated
distro/OS account. Container and cloud provider homes are independent.

The runner scrubs obsolete Conductor configs only inside its owned
`<dataDir>/conductor/runner-instances/<owner-hash>` directory.
It deliberately does not sweep the former shared home-level Conductor directory because those files
cannot be attributed safely while an older runner may still be using them. After stopping every
pre-migration runner for the account, use `--state-doctor inventory` and the explicit
`quarantine-conductor` action. The doctor prints redacted counts rather than contents. Its
`adopt-checkpoints` and `adopt-provider-state` actions copy legacy state into the attested namespace
without deleting sources; `quarantine-wsl` atomically moves the ambiguous shared provider/worktree
roots aside. Mutations require `--ack-all-legacy-runners-stopped` and refuse an active data lease.
Quarantining those whole roots also makes any stored legacy WSL session that names one of their
worktrees unavailable until the root is restored or the session is explicitly migrated; inventory
and back up the shared roots before acknowledging that operation.
A stale provider-home lease is reclaimed automatically only when the record names this same
attested owner on this same hostname and its recorded process is no longer alive. The reclaim
replaces only the marker and never moves or removes the lock directory itself, because that
directory's continued existence is what excludes every other owner: no window may exist in which the
canonical path is absent, or a different owner could publish a lease without ever observing the
record it was supposed to fail closed on.

The right to retire one specific record is claimed through a `reclaim-<lease-id>` guard directory
created inside the lock. Unlinking the marker is a pathname operation, so without that claim a
reclaimer still holding a stale snapshot would delete a marker a rival reclaim had already
published and both would believe they hold the lease. The record is re-read under the guard and
must still match the inspected lease id, because holding the guard does not exclude a reclaim that
already retired that record and released. The guard lives inside the lock so that an interrupted
reclaim leaves an entry every acquirer already fails closed on, rather than inert litter beside a
lock that would otherwise read as healthy; recovery then fails closed, naming the guard to remove,
until an operator verifies no runner is active.

A symlinked lock is refused outright rather than followed out of the canonical HOME. A record from
another attested owner, another host, a live process, an incomplete lock, or unexpected directory
entries still fails closed with manual quarantine guidance. Remove one of those only after proving
no provider process is using that HOME.

Automatic same-owner reclaim does not prove that a detached provider tree from the crashed instance
has exited, only that the runner that recorded the lease is gone. That residual exposure is confined
to a single attested owner on one host, which is the trust domain that already shares the HOME.

## Backup and operational boundary

The control-plane database contains credential hashes and ownership metadata, not recoverable
runner plaintext. Runner hosts contain the protected active token and any provider API values named
by local configuration, so their state directories and host environments remain sensitive. A
database restore cannot reveal the runner secret; rotate or reissue when the runner copy is lost.
