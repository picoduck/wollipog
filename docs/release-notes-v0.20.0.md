# Wollipog v0.20.0 — Security and Reliability Hardening

Wollipog v0.20.0 hardens the trust boundaries between the control plane, runners, provider
processes, installers, and the desktop webview. It also closes several failure modes that could
lose a final provider event, resurrect a stopped session, or strand runner work during reconnects.

## Upgrade and Rollback Warning

Upgrade the control plane before upgrading standalone or remote runners. Protocol v84 lets a
runner prove which replacement process crossed a durable Stop fence. Older runners may remain
connected during a rolling upgrade, but Restart fails closed until the runner supplies the v84
launch proof. The desktop bundle upgrades its embedded control plane and local runner together.

Remote runners must now use `wss://` for a non-loopback control-plane address. Plaintext `ws://`
continues to work for loopback development. Operators who knowingly need plaintext transport on a
trusted private network must pass the CLI-only `--allow-insecure-transport` acknowledgement on
every runner start; the exception is deliberately not persisted in runner configuration.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.19.2 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.20.0 processes before restoring the backup
and starting the retained binaries. The v0.19.0 runner-ownership and legacy-adoption boundaries
remain in force.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Security Boundaries

- Reject unsafe forge and review links, validate external links again in the web client, and serve
  the app shell with a hash-based Content Security Policy and `nosniff` protection.
- Require GitHub publisher SHA-256 digests before desktop installers mount, promote, or execute
  downloaded artifacts, while preserving atomic AppImage upgrades.
- Bound runner WebSocket frames, global upgraded connections, per-source unauthenticated
  connections, and pre-authentication time.
- Reject non-loopback plaintext runner transport by default and use secure `wss://` examples for
  remote onboarding and installers.
- Resolve native provider launch commands from runner-local discovery and require the
  control-plane command and arguments to match before any destructive restart work.

## Runner and Session Reliability

- Persist legacy runner events and their hydration cursor atomically so a crash cannot duplicate or
  skip ingestion.
- Fence session-lock refresh and drain cleanup to the exact owner generation.
- Generate collision-free approval fallback IDs and settle a displaced provider request before a
  duplicate ID replaces it.
- Bound every agent NDJSON accumulator to 64 MiB, emit a bounded diagnostic for an oversized
  record, and resynchronize at the next newline.
- Persist Stop intent before delivery, prevent reconnect snapshots or late events from resurrecting
  the session, and require protocol-v84 proof before Restart succeeds.
- Preserve runner socket identity when a send fails so normal disconnect teardown marks the runner
  offline and settles affected sessions.
- Finalize provider children after stdout and stderr close, preserving final messages, usage data,
  authentication results, model discovery, and ACP responses buffered after process exit.

## Desktop Browser Previews

- Permit same-origin and HTTPS frames plus loopback HTTP previews in packaged and development
  desktop Content Security Policies.
- Route **Open Externally** through the native desktop link handler while preserving ordinary
  browser behavior.

## Dependency and Release Gates

The release-gate npm audit reports no known advisories, including the previously reported
high-severity transitive `fast-uri` and `nanoid` findings. One medium-severity Rust advisory in the
transitive `glib` dependency remains tracked, and unrelated major dependency upgrades remain
explicitly deferred under issue #98 rather than being mixed into this hardening release.

Desktop bundles remain unsigned, so operating systems may show an unidentified-developer warning
on first launch. The release workflow builds all six supported native targets. Its final
verification fails unless the draft holds exactly 27 assets: 14 desktop bundles, 12 runner names, and
`SHA256SUMS`, with canonical and compatibility runner names verified byte-identical and GitHub
publisher digests matching the manifest. Publishing the verified draft remains a
manual operator step.
