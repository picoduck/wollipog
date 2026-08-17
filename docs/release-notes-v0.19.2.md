# Wollipog v0.19.2 — Windows Local Runner Reconnect Hotfix

Wollipog v0.19.2 fixes the bundled local runner startup failure that could leave **Reconnect This
Machine** spinning indefinitely on Windows.

- Protected runner ownership and credential files are now flushed through a write-capable Windows
  handle, as required by `FlushFileBuffers`.
- Durable publication and replacement paths both use the corrected file-handle mode.
- The native platform workflow now runs the complete runner data-directory suite on real Windows
  and macOS GitHub runners, including the affected end-to-end publication path.
- Cross-platform temporary paths are canonicalized so native durability assertions compare the
  same paths production uses.

This hotfix does not change runner protocol v77, require a data migration, or change the existing
runner-ownership model. Install v0.19.2 over v0.19.1 and reconnect the local machine normally; no
terminal or configuration-file repair should be required.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

The release workflow builds all six supported native targets. Its final verification fails unless
the draft holds exactly 27 assets: 14 desktop bundles, 12 runner names, and `SHA256SUMS`, with
canonical and compatibility runner names verified byte-identical. Publishing the verified draft remains a
manual operator step.
