# Wollipog v0.19.1 — Desktop Runner Repair Hotfix

Wollipog v0.19.1 fixes the packaged desktop recovery path for an offline bundled local runner.

- **Repair Credential…** now uses the desktop-managed reconnect operation for the exact configured local runner.
- Wollipog provisions and stores the replacement credential, replaces the managed child, and retains the runner identity without exposing Node.js, pnpm, configuration, credential, or terminal steps.
- External native runners keep the existing manual credential workflow.
- Browser dashboards, remote instances, unavailable desktop bridges, and runner-id mismatches remain excluded from desktop process management.
- A failed desktop-status read now reports a managed-runner error instead of falling back to developer setup.

This hotfix does not change runner protocol v77 or require a new data migration. The v0.19.0 runner-ownership upgrade and rollback guidance remains applicable.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report
`The address is not a Wollipog control plane.` and must be upgraded before connecting.

The release workflow builds all six supported native targets. Its final verification fails unless
the draft holds exactly 27 assets: 14 desktop bundles, 12 runner names, and `SHA256SUMS`.
Publishing the verified draft remains a manual operator step.
