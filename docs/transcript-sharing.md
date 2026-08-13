# Expiring transcript share links

The session action menu can freeze an operational transcript behind a read-only capability link.
Shares use the same versioned least-data projection and best-effort redaction as authenticated
[transcript exports](./transcript-exports.md). They are cached-control-plane snapshots, may be
partial, and may still contain secrets, source code, personal data, or other sensitive text. Review
the exact session content before issuing a link.

## Issuing and managing links

Any human member who can read a session can list its shares. Owners, admins, and scoped operators
can create and revoke them; viewers remain read-only. Conductors are not allowed to manage shares.
The authenticated routes are:

- `GET /api/sessions/:id/transcript-shares`
- `POST /api/sessions/:id/transcript-shares` with an integer `expiresInSeconds`
- `DELETE /api/sessions/:id/transcript-shares/:shareId`

Expiry must be between five minutes and 30 days. Creation synchronously freezes the current SQLite
event-cache high-water, applies the existing 10,000-event, 16 MiB raw-source, and 8 MiB rendered
bounds, and persists the canonical projection exactly once. Later events, renames, reprocessing, or
ownership changes cannot alter the issued view. Deleting the source session or organization
invalidates its shares. A new owner can revoke existing shares; a former owner who loses session
access cannot manage them.

The 256-bit plaintext capability is returned once and stored only as a SHA-256 hash. The UI creates
one of four finite expiries and lists active, expired, and revoked metadata. Revocation is one-way
and idempotent; it immediately erases the persisted projection bytes. Expiry is enforced on every
read and also erases bytes during access, listing, creation, or control-plane restart.

## Recipient boundary

The link uses `#share=<capability>`. URL fragments are not sent in HTTP requests. Before any normal
application boot, the web client moves the capability out of the address bar, retains it only in
the current history entry, and mounts a separate read-only application. Share mode does not mount
the normal store, `/ui` WebSocket, push lifecycle, pairing flow, navigation, or mutation controls.

The isolated page sends the capability only as `Authorization: Wollipog-Share <capability>` to the exact
`GET /api/public/transcript-share` route. This is the only API read exempt from paired-device auth;
`HEAD`, mutations, subpaths, ordinary APIs, and the conductor allowlist remain unchanged. The
`Wollipog-Share` scheme cannot authenticate as a device `Bearer` credential. During the
compatibility window, the exact legacy `MAM-Share` scheme remains accepted for links opened by an
older dashboard. Unknown, malformed,
expired, revoked, deleted, and corrupt shares all return the same content-free `404`.

Public responses use `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`, `Vary:
Authorization`, `Referrer-Policy: no-referrer`, `nosniff`, and a deny-all document/frame CSP. The
recipient renders message text as plain React text in `<pre>` elements; transcript HTML, Markdown,
links, and images never become active content. Active capability metadata is resolved before the
large projection is loaded, and active responses have per-capability and global one-minute budgets
to bound repeated 8 MiB reads. Random unknown tokens do not consume the valid-content budget.

When the dashboard itself is served from the control plane, created links use that browser origin.
Desktop and development builds may use an explicitly configured non-loopback control-plane origin,
but the UI refuses to create a link when it knows only loopback, a wildcard bind, `tauri.localhost`,
or an invalid origin. This avoids sending a recipient to an unrelated service on the recipient's own
localhost. Open the dashboard through the reachable LAN, Tailscale, or reverse-proxy origin before
creating the link.

## Storage, audit, and backup

At most 20 active links may exist per session. Active immutable projections are additionally capped
at 32 MiB per session and 256 MiB per organization. Revocation and expiry release those byte quotas
immediately. Only the 100 most recent terminal metadata rows per session are retained, while every
active row remains visible and revocable. These limits prevent repeated 8 MiB snapshots from growing
SQLite without bound.

Create and revoke use the existing content-free mutation audit. Audit rows identify the exact share
on revocation but never record the capability, hash, projection, headers, body, or URL fragment.
Public reads are not recipient-tracked.

The SQLite database and its backups contain active plaintext redacted projections. Hashing the
capability protects access credentials, not snapshot contents. Protect and encrypt backups as
sensitive data. Public capability sharing remains transcript-only. Authenticated raw workflow
artifact downloads have their own explicitly unredacted boundary; see
[raw workflow artifact exports](./artifact-exports.md).
