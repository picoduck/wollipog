# Host Administration CLI

`wollipog admin` administers a control plane from an SSH terminal on the machine that runs it. It
is the supported path for headless hosts where nobody can open the trusted-loopback dashboard: it
recovers the startup pairing link, reports operational status, lists users, and creates, lists, and
revokes paired-device credentials without a browser tunnel and without touching SQLite directly.

The command group ships in the same standalone `wollipog` executable as the session and worktree
commands (see [agent control](./agent-control.md)). It requires a control plane at protocol v114 or
newer; older control planes are rejected with a clear message before any administrative request.

## Authority and Fail-Closed Rules

Host administration is equivalent to local owner access. It authenticates with the control plane's
protected bootstrap credential file (see [device auth](./device-auth.md)) over a direct loopback
connection, which the control plane already treats as the local owner. Nothing here opens the
trusted-loopback administration routes to ordinary paired-device tokens, and the CLI refuses to run
in every situation where that boundary would weaken:

- **Remote targets.** `--url` (default `http://127.0.0.1:$CONTROL_PLANE_PORT`, port 4317) must be a
  literal loopback address: `localhost`, `127.x.x.x`, or `[::1]`. DNS names are refused even when
  they look local (`127.evil.example`, `foo.localhost`), because the credential would be sent to
  whatever they resolve to. Any other target exits with code 2 before the credential file is read.
- **Unsafe credential files.** The credential is opened without following symlinks and refused when
  it is a symlink, not a regular file, group- or other-accessible, owned by another account, or
  malformed. Repair the file (`chmod 0600`, correct owner) or run the CLI as the service account.
- **Version skew.** `GET /api/compatibility` must report protocol v114 or newer.
- **Ordinary remote tokens.** `GET /api/admin/status` is served only for the bootstrap credential on
  trusted loopback; a paired device with the owner role is refused even on loopback.

The credential file is located, in order, from `--token-file`, `CONTROL_PLANE_LOCAL_TOKEN_FILE`,
`$CONTROL_PLANE_DB.local-device-token`, and finally `data/control-plane.db.local-device-token`
relative to the current directory, mirroring the control plane's own defaults. Run the CLI as the
account that owns the control-plane data directory.

## Commands

```text
wollipog admin pairing-url [--json]
wollipog admin status [--json]
wollipog admin user list [--json]
wollipog admin device list [--json]
wollipog admin device create --name <name> [--user <user-id>] [--origin <public-origin>] [--output <file>] [--json]
wollipog admin device revoke <device-id> [--yes] [--json]
wollipog admin runner-credential list [--json]
wollipog admin runner-credential issue --runner <runner-id> [--label <label>] [--output <token-file>] [--json]
wollipog admin runner-credential rotate --runner <runner-id> [--label <label>] [--output <token-file>] [--json]
wollipog admin runner-credential revoke --runner <runner-id> [--yes] [--json]
```

Common options: `--url <loopback origin>`, `--token-file <path>`, `--json` for stable output.
Exit code 0 is success, 1 is an operational failure, and 2 is a usage or fail-closed refusal.

### `admin pairing-url`

Prints the loopback startup link `http://127.0.0.1:<port>/#pair=<token>` from the protected
credential file. It is read-only and needs no running control plane, so it is the supported
equivalent of the control plane's `--print-pair-url` recovery flag. Like that flag it reveals a
durable credential on explicit invocation; do not pipe it into logs.

### `admin status`

Reports, without secrets: control-plane version, protocol and API versions, health and uptime, bind
host, port, and mode (`loopback`, `wildcard`, or `address`), tailnet-only mode, the configured
public origin, whether the web bundle is served and which addresses pairing links would use,
database and artifact-store readiness, the local credential file audit (type, symlink, mode,
owner), registered and online runners with their protocol versions, the paired-device count, and a
`warnings` list covering plain-HTTP origins, missing public origin beyond loopback, unsafe credential
files, offline runners, and protocol mismatches. `--json` returns the `HostAdminStatusView` shape
from `@wollipog/protocol`.

### `admin user list` and `admin device list`

List organization members and paired devices for the local owner's organization. Device rows show
the device id, name, user, role, creation time, and last-seen time.

### `admin device create`

Mints a paired-device credential for the local owner (or `--user <user-id>`, who must be an active
member) and prints one complete pairing link suitable for a browser or for **Connections →
Instances → Add Remote Instance** in the desktop app. The origin is chosen in this order:

1. `--origin`, validated as a bare absolute `http(s)` origin;
2. `CONTROL_PLANE_PUBLIC_ORIGIN` as configured on the control plane;
3. the first reachable bind address when the control plane is bound beyond loopback, with a
   plain-HTTP warning;
4. `http://127.0.0.1:<port>`, with a warning that the link only works on this machine.

Before the link is handed out it must be usable by at least one advertised consumer: a browser
needs the control plane to serve the built dashboard bundle, and the desktop app accepts plain HTTP
only for loopback or a literal Tailscale address (anything else must be HTTPS). A link neither can
open, such as plain HTTP to a LAN address with no dashboard bundle, is refused and the just-minted
device is revoked; the readable output and the JSON `consumers` field say which consumer applies.

The token is returned exactly once and only its hash persists. By default the link prints only
when stdout is an interactive terminal; a piped stdout is refused before any device is minted.
`--output <file>` instead creates a new mode-0600 file atomically (an existing path is never
overwritten) and prints only the path, which is the right choice for automation and for handing the
link to another channel. The output path is checked before the device is minted, and if delivery
still fails afterwards the CLI revokes the new device (or tells you the exact revoke command when it
cannot), so a token whose only plaintext was lost never stays active. The secret never appears in
process arguments, request URLs, or stderr.

### `admin device revoke`

Deletes the device row, removes its push subscriptions, and immediately closes its live `/ui`
sockets; later requests with that token fail. Interactive use asks for confirmation; non-interactive
use must pass `--yes`.

### `admin runner-credential`

These commands drive the existing owner/admin runner-credential routes with their activation and
cutover semantics (see [runner credentials and secrets](./runner-credentials-and-secrets.md)):

- `list` shows every credential's runner, id, status (`pending`, `active`, `revoked`, with a
  `legacy` marker), label, and timestamps. No secrets.
- `issue --runner <id>` mints a pending credential for a runner id that has none. It activates on
  the runner's first registration with that exact id and expires if unused for 24 hours. A runner
  that already has an active credential is refused; rotate it instead.
- `rotate --runner <id>` mints a pending replacement while the current credential stays active; the
  runner cuts over when it registers with the new token, and the old credential is then revoked.
  There is no planned disconnect.
- `revoke --runner <id>` revokes active and pending credentials and closes the runner socket
  immediately. Interactive use asks for confirmation; non-interactive use must pass `--yes`.

`issue` and `rotate` return the token exactly once, under the same rules as device links: shown only
on an interactive terminal, or written atomically to a new mode-0600 `--output` file that the runner
can consume directly with `--token-file <file>` or `RUNNER_TOKEN_FILE`. The output path is checked
before minting. If delivery fails before any output began, the pending credential is left alone:
nobody holds its plaintext, it expires unused after 24 hours, and running `issue` or `rotate` again
replaces it. It is deliberately not revoked, because a revoke also closes the runner socket and would
disconnect a runner that still has a working credential. If the failure happened after output began
(a broken terminal pipe, for example), the CLI says the token may have been partially delivered and
that the pending credential stays usable until it expires, and prints both ways to resolve it: run
the command again to supersede it, or revoke it. `--runner` must be the exact id; padded, dot-segment,
or malformed ids are refused rather than normalized. Any option written without a value
(`--runner --yes`, `--output --json`, or `--output=` from an unset shell variable) is a usage error
rather than a silent fallback. Tokens never
appear in argv, unit files, or logs.

## Public Dashboard Origin

Set `CONTROL_PLANE_PUBLIC_ORIGIN` on the control plane to the origin remote clients actually reach,
for example `https://wollipog.example.ts.net` behind Tailscale Serve or an HTTPS reverse proxy. It
must be a bare `http(s)` origin without path, query, fragment, or embedded credentials; an invalid
value stops startup. A plain-HTTP origin beyond loopback is accepted but logged as a warning and
repeated by `admin status`, because pairing tokens and session data would travel unencrypted.

The origin is reported by `admin status`, returned as `pairing.publicOrigin` on `POST /api/devices`,
and used by `admin device create`. Existing device and runner credentials are unaffected by setting
or changing it.

## Typical Headless Bootstrap Over SSH

```bash
# On the control-plane host, as the account that owns the data directory.
export CONTROL_PLANE_DB=/srv/wollipog/control-plane.db
wollipog admin status
wollipog admin device create --name "Laptop browser" --output ~/laptop.pair
# Move ~/laptop.pair to the laptop over an encrypted channel, open the link, then delete the file.
wollipog admin device list
wollipog admin device revoke dev_1a2b3c4d
# Colocated or remote runner credentials, written straight into the runner's token file.
wollipog admin runner-credential issue --runner rack-2 --output /srv/wollipog/runner/token
wollipog admin runner-credential list
```

Service installation, `admin doctor`, and upgrade or rollback tooling are tracked separately; until they ship, supervise the control plane and runner with the operating
system's service manager as described in [automations](./automations.md#always-on-deployment-and-laptop-off-limits).
