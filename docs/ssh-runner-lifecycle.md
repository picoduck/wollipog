# SSH runner lifecycle and durable-service design

## Shipped policy: supervised tunnel mode

An SSH-managed box currently runs in **supervised tunnel mode**. The control plane owns one local
`ssh` child per box. That process creates the reverse tunnel and executes the runner as its remote
command. The runner therefore lives exactly as long as that SSH connection:

- a transient network failure or SSH exit stops the remote runner;
- the control plane marks the box offline and, when auto-reconnect is enabled, retries with bounded
  exponential backoff;
- a manual reconnect or update supersedes the previous deployment epoch, kills its SSH child, and
  starts a fresh bootstrap;
- control-plane shutdown intentionally stops every owned SSH child and its remote runner;
- durable session metadata remains on the runner host, so a later bootstrap can hydrate and resume
  supported provider sessions, but work in a process that was interrupted is not promised to keep
  running while the tunnel is absent.

This is deliberate ownership, not a service-manager guarantee. The dashboard must not describe an
SSH box as unattended or laptop-off capable while it uses this mode.

Reconnect and update requests fail with HTTP 409 while the box has any non-terminal session,
including idle or input-required process state. An operator must first let those sessions settle or
explicitly repeat the request with `{ "force": true }`; forced replacement interrupts the existing
runner process and relies on the ordinary snapshot/reconnect recovery boundaries above.

The same boundary applies to [durable automations](./automations.md): an always-on control plane can
keep its dashboard-supervised tunnel alive, but does not make that runner independently durable.
When the owning control plane or tunnel exits, schedules wait, expire, or select an explicitly
configured compatible alternate according to their runner policy.

## Deployment and rollback contract

Bootstrap detects one of four shipped Unix triples: Linux or macOS on x86-64 or ARM64. It resolves
the exact packaged release artifact (or an explicitly staged operator build), carries the verified
full SHA-256 through deployment without hashing the large binary again, and compares the short
content identity with the box's persisted `deployed_version`.

Resolved runner artifacts are published under an immutable full-digest path,
`.agent-manager/runners/<sha256>/wollipog-runner`. Bootstrap remotely verifies that exact path with
`sha256sum` or `shasum`; persisted deployment metadata and the mutable legacy executable are never
treated as proof. Missing or mismatched bytes upload to a random attempt-private sibling, are
hash-checked before atomic promotion within that digest directory, and are verified again before
credentials are minted. Superseded different-digest promotions cannot overwrite each other, and
same-digest writers are byte-identical. Hour-old abandoned staging files are swept with a quoted
`find -name` pattern that is safe in bash, sh, and zsh login shells. Each bootstrap
mints a pending credential for the exact box runner id. Its plaintext is streamed over SSH stdin
into an immutable `.agent-manager/credentials/<credential-id>` path created under `umask 077`, set
to mode 600, and atomically installed without following symlinks. The runner starts with that path
via `--token-file`; the old active credential remains usable until the new connection registers and
activates the pending credential. A delayed superseded bootstrap cannot overwrite the newer path,
and credential files older than seven days are swept. The secret is never placed in argv.

New boxes are launched with a persisted, server-derived
`.agent-manager/runner-data/<box-id>` data directory so unrelated managed boxes on one SSH account
cannot claim each other's mutable runner state. Existing box rows keep the historical root. Their
owner/admin-only **Adopt Legacy Data** action requires an exact acknowledgement that all legacy
runners on the SSH account are stopped. Admission, force confirmation, lifecycle serialization,
timer supersession, and awaited child stops cover every known legacy box with the exact persisted
SSH target and port. Any partial stop failure leaves no authorization and retains the failed child;
successfully stopped siblings stay parked for a safe retry. Pending authorization survives a
control-plane restart and fences sibling relaunches until the matching current launch registers.
Completion releases siblings through the current owner-aware binary, which selects isolated owner
namespaces. Account-level pending/adopted state is projected without secrets; a sibling never offers
or persists a second, unfinishable adoption. Its canonical audit is stored independently by trimmed
SSH target and port, so completed ownership survives deleting the adopter and control-plane restart.
The active adopter cannot be deleted while authorization is pending. Legacy bytes remain in place
throughout migration.
All isolated, pending-adoption, completed-adoption, and same-account sibling launches reject the
best-effort pre-existing-binary fallback because an older runner can ignore ownership flags.
Adoption completion is fenced by remote content proof, the durable epoch, and the exact launch
credential. A foreign owner marker makes explicit adoption fail closed at every pre/post-lease
observation; ordinary owner-aware startup continues in its isolated namespace.

If artifact resolution fails, bootstrap may use an already-deployed executable only when its
`--version` probe succeeds. It never overwrites or deletes that rollback binary on a failed download.
The local artifact cache keeps the current release and one previous known-good release; older
release directories are pruned only after a successful current resolution. Explicit staged builds
are outside this managed retention policy.

## Optional durable-service mode: approved design, not yet shipped

Durable unattended operation must be an explicit second lifecycle mode, not a hidden change to the
current SSH contract. Its implementation is gated on all of the following:

1. **Reachability:** the box must have a stable authenticated `wss://` control-plane URL. A runner
   service cannot depend on the dashboard-owned reverse tunnel after that SSH process exits.
2. **Per-box credentials:** installation mints or supplies a revocable runner credential scoped to
   one box. The service receives only a mode-0600 token file; credentials never appear in a unit,
   plist, command line, log, or generated config.
3. **Explicit ownership:** the box record stores `supervised_tunnel` or `durable_service`. The UI
   states who starts/stops the runner and never sends tunnel reconnect/update actions to a service it
   does not own.
4. **Native service managers:** Linux uses a user or system `systemd` unit according to an explicit
   operator choice; macOS uses a `launchd` agent/daemon. Install, status, restart, rollback, and
   uninstall commands are platform-specific argv/templates, not shell-concatenated user input.
5. **Atomic upgrades:** upload and verify a versioned binary first, switch the service target only
   after verification, restart, wait for registration/health, and automatically restore the prior
   target if the new runner does not become healthy within the bounded rollout window.
6. **Session safety:** update/restart requires active work to settle or an explicit forced action.
   Service-manager restart and control-plane reconnect are distinct states in the audit log.
7. **Recovery:** startup reconciliation compares desired and observed artifact identities, service
   state, runner protocol, and last registration. Repeated failure stops automatic rollout without
   deleting the previous binary or credential.

The future UI should offer service installation only after a reachability probe and credential
preflight pass. Until those prerequisites and platform integration tests exist, supervised tunnel
mode remains the only dashboard-managed SSH mode. Operators may independently run a standalone
native runner as a service against a reachable control plane, but that process is externally managed
and does not become an SSH-managed box automatically.

### Required descendant containment for standalone services

A standalone service must give the runner time to complete its own `SIGTERM`/`SIGINT` shutdown and
must retain the runner's descendants inside the service-manager boundary until that drain finishes.
The runner snapshots provider descendants by PID plus process start identity, terminates even children
that create a new POSIX process group or session, and reports a non-empty boundary instead of releasing
provider-HOME ownership. A service manager remains the crash boundary if the runner itself is killed
before that code can run.

For Linux `systemd` services, use `KillMode=control-group` (the default), keep `SendSIGKILL=yes`, and
set `TimeoutStopSec=15s` or longer. Do not use `KillMode=process`, `KillMode=mixed`, or `SendSIGKILL=no`:
those settings can leave a `setsid` descendant outside the runner's graceful path after a crash.

For macOS `launchd` jobs, leave `AbandonProcessGroup` unset or `false` and set `ExitTimeOut` to at least
15 seconds. The timeout lets the runner verify its identity-tracked descendant boundary before launchd
forces the main process down; the non-abandoning default also cleans ordinary same-group children if the
runner crashes. Because launchd's fallback is process-group based, operators must investigate any runner
diagnostic that says the descendant boundary was not empty before starting a replacement against the same
provider home.

On Windows, native provider processes are always placed in a non-breakaway, kill-on-close Job Object.
The Job launcher watches the runner owner as well as the provider, so runner termination closes the Job
and the kernel terminates every associated descendant, including nested Jobs.

## Verification matrix

Repository tests deterministically cover:

- Linux and macOS x86-64/ARM64 triple selection;
- option-safe SSH argv and quoted workspace arguments;
- epoch-isolated staging, complete-file atomic promotion, and rollback identity;
- zsh-safe stale-stage cleanup;
- immutable credential-path `umask 077` construction, activation cutover, stale-file cleanup, and
  absence of token argv;
- isolated per-box data-dir launch arguments plus restart-safe, epoch-fenced legacy adoption;
- rejection before authorization when the supervised child cannot be stopped;
- concurrent refresh sharing and reconnect/update supersession guards;
- full-digest reuse plus current-and-one-rollback cache retention;
- authenticated `gh` fallback and atomic partial-file promotion in all release installers.

No live Linux or macOS SSH host was available for this slice. Those live rows remain unverified; the
tests exercise their exact command and artifact contracts without claiming live platform coverage.
