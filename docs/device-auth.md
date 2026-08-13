# Per-Device Authentication (REST + `/ui`)

Every dashboard client authenticates every UI-facing request. Loopback is a network boundary, not
an identity boundary: another process or browser page on the same machine must not inherit owner
access merely because its socket peer is `127.0.0.1`.

- REST `/api/*` requests send `Authorization: Bearer <token>`.
- `/ui` WebSocket connections send `?token=<token>` because browsers cannot set WebSocket request
  headers.
- `/runner` keeps its separate runner-registration protocol. `/healthz`, static assets, and exact
  public transcript capability URLs are the only intentional UI-auth exceptions.
- The server stores ordinary paired-device tokens only as SHA-256 hashes. The local startup
  credential is a separate bootstrap credential and is never inserted into the device table.

## Local Startup Pairing

At first start, the control plane creates a 256-bit local dashboard credential next to its database:

```
<CONTROL_PLANE_DB>.local-device-token
```

Set `CONTROL_PLANE_LOCAL_TOKEN_FILE` to choose a different path. Relative paths resolve from the
control-plane process's working directory (`pnpm dev` and `pnpm dev:all` launch it from
`apps/control-plane`). The file contains one 43-character base64url token followed by a newline.

Creation uses a same-directory temporary file and a no-replace atomic publication. Existing
non-regular files, symlinks, and malformed credentials fail closed. On Unix, the directory and file
are restricted to `0700` and `0600`; the server also repairs a permissive file mode when possible.
Windows does not expose the same POSIX mode model, so access follows the user's profile and
filesystem ACLs. The credential is plaintext because the startup URL must be recoverable; any
process that can read this file can act as the local owner.

The startup pairing URL is:

```
http://127.0.0.1:4317/#pair=<token>
```

Normal startup prints it only when stdout is an interactive terminal, so service supervisors and
piped logs do not accidentally retain the secret. To recover it explicitly without starting a
second server:

```bash
pnpm --filter @wollipog/control-plane start -- --print-pair-url
```

This command is read-only: start the control plane once so it can create the protected credential,
then use the command to reprint the existing URL. It fails instead of minting an unrelated
credential when the configured database or token-file coordinates are wrong.

For Vite development, open `http://127.0.0.1:5173/#pair=<token>` using the fragment from that
command. Opening a pairing URL stores the credential in `localStorage` (`wollipog.deviceToken`,
with an in-memory fallback) and immediately removes the fragment from the address bar. During the
migration window the app copies `mam.deviceToken` forward new-first, while later writes use only the
Wollipog key.

The packaged desktop app uses a deterministic app-data token path for its managed sidecar and
adopts that credential through native IPC before the first API request or WebSocket connection.
When it attaches to an externally started control plane, it does not read or adopt a stale managed
credential; pair the desktop through the external server's startup URL instead.

The local startup credential is accepted only on a direct loopback socket with no forwarding or
client-IP headers. It resolves to the local owner but has no paired-device row and cannot be used
remotely, even when the server binds beyond loopback. Dev-runner bootstrap and bundled local-runner
provisioning authenticate with this credential (or the desktop's currently paired credential for
an external control plane) without putting it in JSON bodies, child environments, or normal logs.

To rotate the local startup credential:

1. Stop every control-plane process using that database.
2. Move the token file to a protected backup location.
3. Restart the control plane and open its new startup pairing URL.
4. After verifying the new credential, securely remove the backup.

Browsers using the old startup credential lose access immediately. A managed desktop adopts the
replacement on its next launch. Ordinary paired-device credentials are independent and remain
valid.

## Pairing Other Devices

In **Machines → People & Devices** (owner/admin only), choose an active member and name the device.
The control plane mints a 256-bit token, stores only its SHA-256 hash, and shows the plaintext once:

```
http://<host>:<port>/#pair=<token>
```

The link is offered only when the control plane serves the built dashboard and is reachable beyond
loopback. Otherwise the panel supplies the fragment and explains which prerequisite is missing.
Opening it uses the same store-and-scrub flow as local startup pairing.

Revocation is loopback-only and requires an authenticated local request. It deletes the device row,
removes associated push subscriptions, and immediately closes that device's live `/ui` sockets.
Role changes and membership suspension are resolved on every request. `lastSeenAt` is updated at
most once per minute.

## Serving the Web App

The control plane serves the built dashboard from its own origin when a bundle is present. Bundle
lookup order (`web-dist.ts`) is `$WOLLIPOG_WEB_DIST` → `<executable directory>/web` for packaged builds
→ `<cwd>/apps/web/dist` → `<cwd>/../web/dist`. A candidate must contain `index.html` and must not
contain `package.json` or `src/`.

The served `index.html` receives `window.__MAM_SAME_ORIGIN__` at request time. Vite and Tauri builds
without that marker use `http://127.0.0.1:4317`. Unknown client routes fall back to the app shell,
but missing assets and `/api`, `/ui`, or `/runner` routes fail honestly. Any shell URL carrying a
`token` query parameter redirects to its clean path; pairing secrets belong in `#pair=` fragments,
which are not sent to the server.

To serve the dashboard to a phone:

```bash
CONTROL_PLANE_HOST=0.0.0.0 pnpm --filter @wollipog/control-plane start
```

Build the web app first with `pnpm --filter @wollipog/web build`, then create a paired device from the
authenticated local dashboard.

## Enforcement Details

- Authentication uses Fastify's matched route pattern, not the raw URL, so percent-encoded paths
  cannot bypass the `/api/*` gate.
- A bearer credential is required even on loopback. A foreign browser origin without a credential
  therefore fails before a mutation can run; a valid credential stands in for Origin because
  possession is the authorization proof.
- Requests with `Forwarded`, common `X-Forwarded-*`, or common client-IP headers cannot use the
  local startup credential. The server trusts no reverse proxy. Deployments behind a proxy must
  pair each client and use ordinary device credentials.
- REST accepts credentials only from the bearer header. `?token=` is accepted only by the `/ui`
  WebSocket upgrade and is redacted from request logs. Encoded query-key spellings receive the same
  leak detection and redaction.
- Static content remains public so a browser can load the app shell before adopting a fragment,
  but it receives no API or live-stream access without a credential. A stale or planted bundle may
  try to read browser storage, so bundle provenance remains part of the deployment trust boundary.

Scheduled actions use this same authenticated boundary for remote CRUD. See
[durable automations](./automations.md) and [multi-user identity](./multi-user-identity.md).
