# Wollipog v0.37.1

Wollipog v0.37.1 improves the Assistant preview, adds approvals for GitHub Actions reruns and release operations, and makes campaign pull request watches more reliable. These notes cover changes since [v0.37.0](https://github.com/picoduck/wollipog/releases/tag/v0.37.0).

## Install and Update

Check for the update in **Settings → About** and use **Install and Restart** where supported. For `.deb` and `.rpm` installations, download the package from this release's assets.

Headless installations can select this release with `wollipog update --release v0.37.1`.

## Wollipog Assistant Preview

- **Settings → Assistant** groups Assistant defaults, connections, and decision grants. Use **Thread Settings** to manage a thread's budget, account, and launch limit. A shared budget covers the thread and the work it launches.
- Open a thread's **Launched Sessions** panel to see the work it launched. The panel starts closed and can be opened from the thread header.
- Use **Change Harness** to switch an Assistant thread between Claude Code and Codex. The Assistant starts a fresh conversation on the selected harness while the thread retains access to its earlier conversation and launched work.
- Grant a thread permission to decide eligible workflow requests within selected projects or campaigns. Review recorded decisions in **Delegated Decisions**. With a UI evidence grant, the Assistant can inspect attached screenshots before approving them.

## GitHub Workflows and Campaigns

- Approve a GitHub Actions rerun for a specific workflow attempt or job. Separate approvals cover creating a stable release tag and publishing its verified draft. Each approval is tied to the exact GitHub target.
- Campaign pull request watches stay active through follow-up turns. When GitHub starts reporting a fresh workflow for the same pull request head, the watcher waits for the new checks before reporting failure.

## Upgrade and Rollback

Upgrade the control plane and dashboard before standalone and remote runners. Update to runner protocol v402 or later on both sides before relying on the new Assistant or GitHub approval features.

Back up the control-plane database, artifact store, and runner data and configuration before upgrading. To roll back, stop the upgraded services, restore the pre-upgrade backup, and start the previous binaries and dashboard. If upgrading from v0.36.1 or earlier, read the [v0.37.0 upgrade notes](https://github.com/picoduck/wollipog/releases/tag/v0.37.0) for the retirement of Pods and Runs and the corresponding database migration.

The control plane advertises the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept the current and legacy service identities. If an older desktop client reports `The address is not a Wollipog control plane.`, update it before connecting.

## Release Assets

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and `SHA256SUMS`. A signed tag run adds 12 updater signatures
and `latest.json` for 47 assets. Publishing the verified draft remains a manual operator step.
