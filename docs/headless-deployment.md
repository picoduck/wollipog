# Headless Deployment (Linux systemd)

`wollipog service` installs the control plane and an optional colocated runner as durable Linux
systemd services on an always-on machine you administer over SSH, then keeps them inspectable and
recoverable from that same terminal. It pairs with the [host administration CLI](./host-administration.md)
(`wollipog admin`) for credentials and status. Linux with systemd is the first supported platform;
macOS launchd and Windows services are reported as unsupported rather than implied to work.

## What you get

- Two independent units, `wollipog-control-plane.service` and `wollipog-runner.service`, so either
  can be restarted or upgraded on its own. The runner unit starts after the control plane and
  connects to it over loopback (`ws://127.0.0.1:<port>/runner`); no inbound runner port exists.
- `Restart=on-failure` with `RestartSec=5s` and a start-limit window of 10 starts per 300 seconds,
  so a crash loop backs off instead of spinning.
- `KillMode=control-group`, `SendSIGKILL=yes`, and `TimeoutStopSec=30s`: the runner gets the
  graceful interval its descendant-containment contract needs (see
  [SSH runner lifecycle](./ssh-runner-lifecycle.md#required-descendant-containment-for-standalone-services)),
  and anything it could not drain is still terminated with the control group.
- Dedicated, restrictive locations for configuration, the SQLite database, artifacts, logs
  (journald), and credentials. System mode runs both units as an unprivileged account
  (`wollipog` by default, created if missing) with `ProtectSystem=strict` for the control plane and
  its writable set limited to its own data directory.
- A health check on `/healthz` during install and restart, and runner registration confirmed
  through the loopback admin API.
- An uninstall that preserves databases, artifacts, configuration, and credentials unless you
  explicitly purge them.

Reinstalling never rewrites an existing `control-plane.env`, `runner.config.json`, or runner token
file, so unit definitions can be regenerated without rotating any credential or moving the database.
Existing settings also win over flags: a reinstall checks health on the port recorded in
`control-plane.env` and waits for the runner id recorded in `runner.config.json`, and reports any
conflicting `--port`, `--host`, `--public-origin`, `--web-dist`, or `--runner-id` as ignored. Edit
the files and restart to change settings.

## Layout

| | User mode (`--user`, the default when not root) | System mode (`--system`, the default as root) |
| --- | --- | --- |
| Units | `~/.config/systemd/user/` | `/etc/systemd/system/` |
| Configuration | `$XDG_CONFIG_HOME/wollipog/` (default `~/.config/wollipog/`) | `/etc/wollipog/` |
| Data | `$XDG_DATA_HOME/wollipog/` (default `~/.local/share/wollipog/`) | `/var/lib/wollipog/` |
| Account | the invoking user | `wollipog` (or `--account <name>`) |
| Logs | `journalctl --user -u <unit>` | `journalctl -u <unit>` |

Inside the data directory: `control-plane/control-plane.db` (with its `.artifacts` directory and
`.local-device-token` beside it) and `runner/`. Inside the configuration directory:
`control-plane.env` (mode 0600, every control-plane setting), `runner.config.json`, and
`runner.token` (mode 0600, the runner's one-time credential written by install).

The generated units state the account and the data locations they use; read them before enabling
in an environment with its own conventions.

`WOLLIPOG_SYSTEM_PREFIX` relocates the whole system layout under a directory; it exists for tests
and image builds, never for a real install. It must be an absolute path, and every `service`
command reports the relocation (`Relocated:` in `status`, a warning in `install`, `relocatedPrefix`
in JSON), so a stray value can never silently redirect an installation.

## Install

On a clean Linux machine, without cloning the repository or installing Node.js:

```bash
# 1. Verified release assets: runner + CLI, the headless control plane, and the dashboard bundle.
curl -fsSL https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install-runner.sh | sh -s -- --control-plane

# 2. Colocated control plane + runner as user services (needs lingering to survive logout):
wollipog service install --public-origin https://wollipog.example.ts.net

# or as system services under a dedicated account:
sudo wollipog service install --system --public-origin https://wollipog.example.ts.net
```

The installer places `wollipog`, `wollipog-runner`, and `wollipog-control-plane` in `~/.local/bin`
and a fresh dashboard bundle in `~/.local/bin/web`, each verified against GitHub's publisher
digest and the release's `SHA256SUMS`. Public dashboard assets live separately from the private
`~/.local/share/wollipog` data root.

The installer first creates `~/.local/bin` and any missing `~/.local` under the caller's ambient
umask. It later creates a missing `~/.local/share` under scoped umask `022` (mode `0755`) and a
fresh `~/.local/share/wollipog` data root under scoped umask `077` (mode `0700`). Scoped directory
creation leaves the caller's umask unchanged; existing home, shared-directory and data-root modes
and owners are preserved. For example, an otherwise ordinary fresh install under umask `077`
can create `~/.local` and `~/.local/bin` as `0700`; later creation of `~/.local/share` under scoped
`022` does not change those existing ancestors or guarantee access for another account.
Generic upgrade admission remains strict and refuses an existing root with an unsupported owner,
mode or ancestor; installation does not repair it.

`service install` finds the control plane and the public bundle beside the CLI on its own;
`--control-plane-bin`, `--runner-bin`, and `--web-dist` remain available for other layouts.
For system services, the selected account must be able to traverse the executable and dashboard
paths and read the public assets. A private home or binary ancestor still blocks that account.
Use operator-managed executable and dashboard locations accessible to the selected account and
pass the corresponding options; keep private data and credentials private.

An existing legacy bundle at `~/.local/share/wollipog/web` retains its installer asset-refresh
behavior when no installer-owned sibling bundle exists. Existing service environments are never
migrated or rewritten. If both layouts exist, the installer updates its owned sibling bundle
and reports that the legacy bundle and service environment remain unchanged; a preserved
`WOLLIPOG_WEB_DIST` may still select the legacy bundle. Generic upgrades continue to update the
configured bundle. A legacy bundle behind a private data root is not made accessible to a
different account automatically.

The sibling layout has a durable `.wollipog-web-layout-v1` provenance file beside the bundle,
outside both `web` and `web.previous`, so normal asset-generation swaps and rollbacks preserve
it. An unrelated pre-existing sibling path, invalid provenance or existing installer lock causes
a refusal rather than adoption or cleanup. Installer publication failures restore the owned
dashboard generations where possible; if restoration fails, the diagnostic names retained
evidence for manual inspection before retrying. Do not run installer publication and a generic
upgrade concurrently.

Other options: `--control-plane` / `--runner` to install one component only; `--host <bind>` and
`--port <n>` (default `127.0.0.1:4317`); `--tailnet-only`; `--runner-id <id>` (default hostname);
`--workspace <dir>`; `--no-start`; `--no-linger`; `--json`.

Install runs the following steps, in order: create directories, write the env file
and configs (only if absent) and the units, `daemon-reload`, `enable`, enable lingering (user mode),
start the control plane, wait for `/healthz`, mint the colocated runner's credential into
`runner.token` through the loopback admin API (only if the file is absent), start the runner, and
wait for it to register as online. Any failure stops the sequence with the command to inspect.

User services stop at logout unless lingering is enabled; install runs `loginctl enable-linger` and
warns when that needs an administrator. `--no-linger` skips it.

`--no-start` writes and enables the control-plane unit without starting anything. Because the
runner's credential can only be minted from a running control plane, the runner unit is written
but left disabled until `runner.token` exists; run install again without `--no-start`, or issue a
credential to that path and enable the unit. `--runner` alone requires a control plane installed
on the same host (or an existing `runner.token`); for a remote control plane, issue the credential
there with `wollipog admin runner-credential issue --output`, place it at the token path, and set
`controlPlaneUrl` in `runner.config.json`. Install never changes the permissions of directories
that already exist, so using your home as the default workspace keeps it private.

## Operate

```bash
wollipog service status [--json]        # unit states, health, registered runners, locations
wollipog service restart control-plane  # or: runner
wollipog service logs runner --follow   # journald, exact unit only
wollipog admin status                   # operational facts from the control plane itself
wollipog admin device create --name "Laptop" --output ~/laptop.pair
```

After `service install`, `wollipog admin` finds the installed database and port from
`control-plane.env` automatically, so no environment variables are needed after an SSH login.
Explicit `--url`, `--token-file`, or `CONTROL_PLANE_*` variables still take precedence.

## Exposure: Tailscale or HTTPS

Keep the control plane bound to loopback and expose it through Tailscale or an HTTPS reverse proxy.
Set `--public-origin https://...` so pairing links embed the address remote clients reach: both
`wollipog admin device create` and the dashboard's People & Devices card then hand out
`<public origin>/#pair=<token>` instead of guessing from the bind address, which is the only link
that works for a loopback-bound control plane behind a proxy. A bind
beyond loopback without an HTTPS public origin, or a plain-HTTP public origin beyond loopback, is
accepted only with an explicit warning: pairing tokens and session data would travel unencrypted,
and the desktop app refuses plain HTTP to anything other than loopback or a literal Tailscale
address. A browser on such a plain-HTTP page also cannot review artifact-backed UI evidence: the
review card checks each artifact against its digest before showing it, and browsers allow that check
only on HTTPS or localhost pages (see
[What the Human Reviewer Sees](agent-control.md#what-the-human-reviewer-sees)). Remote review,
including from a phone, needs one of the HTTPS routes below.

- **Tailscale Serve:** `tailscale serve --bg https+insecure://127.0.0.1:4317` is not needed; use
  `tailscale serve --bg 4317` to publish the loopback control plane at your tailnet HTTPS name, and
  pass that name as `--public-origin`.
- **Reverse proxy:** terminate TLS in Caddy or nginx, forward to `127.0.0.1:4317`, and make sure
  WebSocket upgrades for `/ui` and `/runner` are proxied. Never expose runner or ACP ports.

## Backups and recovery

The SQLite database and the artifact directory beside it are one consistency unit: back them up
together with SQLite-aware tooling (`VACUUM INTO` or the online backup API), never by copying a live
database, and keep them on persistent local storage, not a network filesystem. Exactly one control
plane may own a database file. An OS crash or power loss can roll back only the newest streamed
runner events, which the runner's log restores; see
[control-plane database durability](./control-plane-database-durability.md). Configuration and credential files (`control-plane.env`,
`runner.config.json`, `runner.token`, the `.local-device-token`) are small; back them up with the
same care as the database, because they are what a restored host needs to rejoin without re-pairing.

Recovery commands from an SSH session:

```bash
wollipog admin doctor                                # pass/warn/fail checks with remedies; exit 1 on any failure
wollipog service status                              # what is running, what is enabled, health
wollipog service logs control-plane --lines 500      # why it is not
wollipog service restart control-plane               # bounded restart with health wait
wollipog admin pairing-url                           # recover the local startup pairing link
wollipog admin runner-credential rotate --runner <id> --output <token-file>   # replace a lost runner token
wollipog service install --control-plane-bin ... --runner-bin ...             # regenerate units, keep config
```

Reinstall is the supported way to regenerate unit files; executables are upgraded with
`wollipog service upgrade` (below).

## Upgrade and rollback

```bash
wollipog service upgrade                 # latest published release
wollipog service upgrade --release v0.23.0   # an exact tag; with GH_TOKEN a draft made for that tag works too
wollipog service upgrade --yes --json    # non-interactive, for automation
wollipog update                          # concise alias for service upgrade
```

Upgrade resolves the release (latest, or an exact tag) from GitHub, downloads the runner and
control-plane executables for this host's target and the web bundle into a staging directory under
the data directory, and proves every byte: each asset must carry a GitHub publisher digest that
matches the downloaded SHA-256, and the release's `SHA256SUMS` entry must agree with it (a release
without a manifest is refused). Each staged executable is run with `--version` and must report the
release version. Only then are the executables swapped in atomically (the previous generation is
kept as `<path>.previous`, and the previous `web/` directory beside the new one), the `wollipog`
command and any other sibling that was a hard link or copy of the runner are refreshed from the new
runner, the control plane is restarted and must become
healthy and report the new version through the loopback admin API, and the runner is restarted and
must re-register as online (on a runner-only host, whose control plane is elsewhere, the runner unit
must become active instead). A control plane that serves the dashboard is only upgraded to a
release that also carries the web bundle. A staging or verification failure before the swap leaves
the installation unchanged. If the swap, service restart, or readiness checks fail, the previous
executables and bundle are moved back (anything the upgrade introduced without a previous
generation is removed), the services are restarted again, and the command exits 1 naming the
failure and any step of the rollback that did not succeed. A cleanup error after a healthy upgrade
is reported separately, as described below. Configuration, credentials, and stored application
data are unchanged; temporary upgrade staging follows the ownership rules below. `--force`
reinstalls the current release. A private repository needs `GH_TOKEN` (Contents: read) in the
environment.

### Generic Upgrade Staging Prerequisites

The staging contract below was introduced by PR #2656 and hardened by PR #2659
(commit `9ca5a3387b8a69539343608409badd15c42011d3`). Older updater binaries may behave
differently. It applies to `wollipog service upgrade` and `wollipog update`, separately from
standalone installer downloads, SSH runner caches, and native helper or lease caches.

Admission requires Linux with an available effective UID, no-follow directory opens, and usable
filesystem identities. The data directory, `upgrades/` parent, and attempt directory must report
an accepted filesystem type: the ext2/3/4 family, XFS, Btrfs, tmpfs, or overlayfs. Other types,
including network filesystems, are refused. This allowlist is an identity profile, not a
durability guarantee or protection against a hostile process running under the same UID.

The data directory must already exist at a canonical absolute path without symlink components,
with exactly mode 0700. In user mode it must belong to the invoking effective UID. System mode
requires root and the installed service account's UID; the data directory may belong to root
or that service account. Staging directories must belong to the updater's effective UID
(root in system mode) with exactly mode 0700; newly created staging files start at mode 0600.
Existing directories are checked, never automatically repaired.

Every ancestor must have a usable nonsymlink directory identity and a trusted owner: root or the
invoking effective UID, plus the installed service UID in system mode. Setuid/setgid ancestors
are refused. A group- or other-writable ancestor is accepted only when it is sticky and its
immediate child has a trusted owner. Unavailable identity, unexpected ownership or permissions,
or substitution of a checked path causes refusal.

### One Staging Slot and Download Bounds

The updater exclusively reserves `<data-dir>/upgrades/download-attempt-v1`; release tags do not
get separate slots. Before reservation, the `upgrades/` parent must have a complete empty
inventory. An existing slot blocks both same-tag and different-tag attempts, including when
initialization was interrupted before a complete `owner.json` was written. A live attempt,
legacy release-tag directory, foreign entry, or unknown inventory also blocks admission.
Repeated retries, a different release tag, and `--force` do not clear it. These admission
refusals happen before any selected asset body is downloaded or installed.

One attempt admits one to four distinct selected assets: `SHA256SUMS`, the installed components'
host-target executables, and the web archive when needed. Each must have a valid publisher
SHA-256 digest and a positive safe-integer declared byte size; their sum must also be a safe
integer. Each asset can start only once in that attempt. The download sink refuses bytes beyond
that asset's declared size, and requires the final length to match. Publication at the final
staged name happens without replacement only after publisher digest verification and, for
executables and the web archive, agreement with `SHA256SUMS`. Stream, length, or digest failure
cannot promote the partial download.

This bounds downloaded asset bytes by the validated selected-release sizes. It is not a fixed
practical disk quota: declared sizes can be large. It does not bound extracted web archive bytes
or preexisting legacy/foreign staging. Unknown contents are preserved rather than traversed and
deleted to make space.

### Refusals, Preservation, and Cleanup Outcomes

Only the current process's ownership receipts, pinned identities, unchanged owner record, and
complete known-entry inventories authorize its staging cleanup. An `owner.json` left by a
previous process is evidence for inspection, not authority for a later process to delete or
take over that slot. Names, partial suffixes, timestamps, and PIDs alone prove neither ownership
nor inactivity.

Catchable failures remove only proven current-attempt objects. Foreign or unknown entries,
incomplete inventory, changed owner bytes, unexpected symlinks or hardlinks, substituted paths,
and unavailable identity stop cleanup and preserve uncertain evidence. Extracted web staging
that has not been moved into the installation is retained; the updater does not recursively
delete that tree. Abrupt process death may leave the exclusive reservation occupied. Safety
across attempts comes from refusing another reservation, not from assuming normal-exit cleanup
ran or reclaiming an apparently old slot.

The original download writer is closed before final staged publication and executable probing,
with the same inode pinned through a checked read-only handoff. Numeric descriptor authority
is retired before each Linux close attempt, even if close reports an error. The updater does
not retry that number, which may already have been reused. A writer-close error prevents
publication; uncertain cleanup reports an error. A final close error can occur after staging
names have already been removed, so a diagnostic does not prove that every staging object remains.

Read the outcome before deciding what to recover. A pre-swap staging refusal leaves installed
executables and rollback generations unchanged. An error stating that the upgrade
`completed and is healthy, but ...` means installation and health checks succeeded and cleanup
reported a problem; the command exits nonzero without rolling back that healthy generation.
Inspect service status and the reported version rather than treating this as proof that the
old version is still installed. Retained staging can block the next upgrade even while the new
services are healthy.

### Operator Inspection and Separately Authorized Recovery

1. Record the exact refusal and use the existing read-only `service status` and service-log
   commands to establish the installed version and health. Confirm the selected user/system
   layout and data directory; protect credentials and private paths when sharing diagnostics.
2. Inspect directory metadata and a bounded inventory without following symlinks, executing
   staged files, or extracting archives. Check the canonical path, owners, modes, filesystem
   types, slot contents, and any owner record. Do not mistake an interrupted or complete marker
   for proof that cleanup is safe. If inspection is partial or identities cannot be established,
   leave the evidence intact.
3. Independently establish whether an updater still owns or uses the slot. An old timestamp,
   a missing PID, or service health alone does not establish that no upgrade is in flight.
   Coordinate with the operator responsible for the host; preserve live attempts.
4. If recovery is needed, obtain separate operator authorization for the exact inspected
   objects and proposed intervention. Any manual retirement or filesystem/layout correction is
   outside automatic updater authority and must follow the operator's reviewed recovery plan.
   Preserve installed and previous generations, configuration, credentials, databases, artifacts,
   and uncertain evidence. This guide supplies no deletion, takeover, or permission repair recipe.
5. Retry only after the operator confirms the staging prerequisites and empty parent inventory
   are restored safely. An agent hosted by the target stack must not upgrade or restart that
   stack; an independent operator must perform and verify such work.

## Uninstall

```bash
wollipog service uninstall            # stops, disables, removes the two units; keeps all data
wollipog service uninstall --purge    # additionally deletes data and configuration after a second acknowledgement
```

Both ask for interactive confirmation; non-interactive use passes `--yes` and, for purging,
`--yes-purge` as a separate acknowledgement. Only `wollipog-control-plane.service` and
`wollipog-runner.service` are touched, and nothing is removed unless stopping and disabling them
succeeded first, so data is never purged underneath a still-running control plane.

## Continuous verification

Beyond the unit tests, `scripts/systemd-service-e2e.sh` runs `wollipog service` against a real
systemd in system mode on a disposable Ubuntu VM (the "Systemd Service" GitHub Actions check, run
whenever the service code changes): install creates the account, units, and 0600 credentials and
brings both units up with the runner online; a SIGKILLed control plane is restarted by systemd
and the runner re-registers; with both units stopped, starting only the runner pulls the control
plane in first; `systemctl stop` completes inside `TimeoutStopSec` with `Result=success`; and
`uninstall --purge` leaves nothing behind. The script refuses to run on a host that already has
Wollipog units or data.

`scripts/upgrade-e2e.sh` (the "Upgrade End-to-End" workflow) goes one step further with real
releases: it installs a release headlessly with `install-runner.sh --release <tag> --control-plane`,
brings it up in system mode, runs `wollipog service upgrade --release <tag>` to another release, and
checks the new executables, the retained previous generation, the refreshed `wollipog` alias, the
version reported over the loopback admin API, the runner re-registering, and that configuration and
credentials did not change. It then blocks the control plane's port and forces an upgrade to prove
the rollback restores the previous bytes, checks that upgrading to the current release is a no-op,
and purges. It runs automatically when a release is published (from the previous published release)
and on demand for any pair of tags, including a draft created for a real tag before it is published
(a branch-dispatched `v0.0.0-test.<run>` throwaway cannot be used: its executables report the
source version, not the tag).

## Native services versus dashboard-managed SSH runners

A runner installed by `wollipog service` is externally managed: systemd starts it at boot, restarts
it after failure, and stops it at shutdown, independently of any dashboard. A dashboard-managed SSH
runner (see [SSH runner lifecycle](./ssh-runner-lifecycle.md)) is supervised through a tunnel owned
by the control plane's dashboard session and exits when that tunnel does; it is not independently
durable. Use a native service for the always-on colocated runner and for any remote machine that
must survive logout and reboot; use dashboard-managed SSH runners for interactive, short-lived
boxes. The dashboard shows both, but only sends tunnel actions to runners it supervises.
