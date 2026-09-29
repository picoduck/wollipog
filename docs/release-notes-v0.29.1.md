# Wollipog v0.29.1 — Phone Focus and Test Reliability

Wollipog v0.29.1 keeps the phone keyboard closed when opening Add and Modes if
the first available action is a text field. It also refreshes Windows settings
screenshots and improves automated checks for session display and missing DOM
elements.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. The
runner protocol stays at v192, so v0.29.0 runners and control planes remain
compatible with this release.

Before upgrading, stop Wollipog processes that share a mutable data directory
and back up the control-plane database and runner data. Retain the v0.29.0
binaries and configuration as the rollback baseline. If rollback is required,
stop all v0.29.1 processes before restoring the backup and starting the retained
binaries.

The control plane continues to advertise the `wollipog-control-plane` service
identity. Desktop v0.15.0 and later accept both the current and legacy service
identities. Older clients may report
`The address is not a Wollipog control plane.` and must be upgraded before connecting.

Desktop apps from v0.28.0 onward offer this release through Settings → About
once it is published.

## Fixes and Verification

- On phones, opening Add and Modes no longer focuses a text or number field
  immediately when it is the first enabled control. This prevents the software
  keyboard from covering the sheet.
- Refresh the Windows settings screenshot baselines to match the current
  design.
- Check that followed session output stays at the tail through painted frames
  as content grows.
- Make missing-element assertions fail promptly with a short description of
  the element, so a failing DOM test can report its result without exhausting
  memory while formatting the element tree.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
