# Wollipog v0.38.0-rc.2 — Release Candidate

The second release candidate for v0.38.0 improves model selection, Antigravity startup, campaign scheduling, and headless updates. These notes cover changes since [v0.38.0-rc.1](https://github.com/picoduck/wollipog/releases/tag/v0.38.0-rc.1).

## What Changed

- Launch settings can follow the **Latest** model in a family across compatible sessions and automations. Model settings open **Effort** and **Speed** in separate selectors.
- Google Antigravity sessions can start when a configured MCP server uses a transport that the provider does not support.
- Registered Locations stay eligible after the runner reports its latest inventory.
- Assistants can configure scheduled campaigns using the settings the server accepts. The schedule preview shows the effective launch settings to its owner.
- Authenticated headless downloads can write into reserved staging files and preserve the control-plane executable's permissions.
- Release builds prepare one draft before the native jobs start, so all six targets upload to the same release.

## Install the Prerelease

Download the desktop installer for your platform from the release assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This setting defaults off. The desktop app links to the release page for `.deb` and `.rpm` installations.

Headless installations can select this version with `wollipog update --release v0.38.0-rc.2`. Plain `wollipog update` continues to select the latest stable release.

## Upgrade and Rollback

Upgrade the control plane before standalone or remote runners. Before upgrading, stop processes that share a mutable data directory and back up the control-plane database, runner data, and configuration. Retain the previous binaries. To roll back, stop the candidate processes, restore the backup, and start the previous binaries.

If your organization has archived-history retention enabled, capable runners trim full logs after completed control-plane pruning, including for previously pruned sessions. Back up the runner data or disable the policy before upgrading if you need to preserve full logs. Reprocess cannot restore trimmed logs, and older runners refuse manifest format 2. See [Archived-History Retention](https://github.com/picoduck/wollipog/blob/v0.38.0-rc.2/docs/archived-history-retention.md#runner-logs-and-upgrades).
