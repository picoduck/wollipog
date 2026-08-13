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

Conductor MCP sessions likewise do not duplicate the active credential. The runner writes one
mode-0600 `<dataDir>/credentials/active-runner-token` file, generates per-session MCP configuration
containing only `MANAGER_TOKEN_FILE`, and refreshes that configuration before every launch/resume.
Startup removes legacy per-session MCP JSON that may have embedded `MANAGER_TOKEN`. The MCP process
still understands the legacy environment variable for rolling compatibility, but current runner
launches use only the protected file reference.

## Backup and operational boundary

The control-plane database contains credential hashes and ownership metadata, not recoverable
runner plaintext. Runner hosts contain the protected active token and any provider API values named
by local configuration, so their state directories and host environments remain sensitive. A
database restore cannot reveal the runner secret; rotate or reissue when the runner copy is lost.
