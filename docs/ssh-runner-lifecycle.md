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

When content differs, upload goes to an epoch-specific sibling path. Only the still-current epoch
may `chmod` and atomically rename that complete file over the live binary. An interrupted or
superseded upload never truncates the working binary. Hour-old abandoned staging files are swept
with a quoted `find -name` pattern that is safe in bash, sh, and zsh login shells. Each bootstrap
mints a pending credential for the exact box runner id. Its plaintext is streamed over SSH stdin
into an immutable `.agent-manager/credentials/<credential-id>` path created under `umask 077`, set
to mode 600, and atomically installed without following symlinks. The runner starts with that path
via `--token-file`; the old active credential remains usable until the new connection registers and
activates the pending credential. A delayed superseded bootstrap cannot overwrite the newer path,
and credential files older than seven days are swept. The secret is never placed in argv.

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

## Verification matrix

Repository tests deterministically cover:

- Linux and macOS x86-64/ARM64 triple selection;
- option-safe SSH argv and quoted workspace arguments;
- epoch-isolated staging, complete-file atomic promotion, and rollback identity;
- zsh-safe stale-stage cleanup;
- immutable credential-path `umask 077` construction, activation cutover, stale-file cleanup, and
  absence of token argv;
- concurrent refresh sharing and reconnect/update supersession guards;
- full-digest reuse plus current-and-one-rollback cache retention;
- authenticated `gh` fallback and atomic partial-file promotion in all release installers.

No live Linux or macOS SSH host was available for this slice. Those live rows remain unverified; the
tests exercise their exact command and artifact contracts without claiming live platform coverage.
