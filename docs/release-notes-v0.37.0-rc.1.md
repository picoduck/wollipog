# Wollipog v0.37.0-rc.1 — Release Candidate

This first release candidate for v0.37.0 adds provider-account priority controls and configurable automation campaigns, and improves worktree recovery and approval reviews. These notes cover changes since v0.36.1.

## Install the Prerelease

Download the desktop installer for your platform from this release’s assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This preference defaults off, including after manually installing a prerelease. Where supported, **Install and Restart** installs the offered update. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication:

```bash
wollipog update --release v0.37.0-rc.1
# For non-interactive upgrades:
wollipog update --release v0.37.0-rc.1 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate leaves v0.36.1 as latest stable.

## Provider Accounts and Usage

- Configure versioned provider-account policies with priority order and see the account expected for a launch. Agents can explicitly select an eligible provider account for sessions and multi-agent runs.
- Keep last-known usage visible when refresh fails, and request a Claude subscription usage refresh. The subscriptions view lists each subscription once across machines.
- Decision Model costs use the live rate table. Automatic usage balancing is not included.

## Campaigns and Review

- Launch configurable Orchestrator campaigns from automations.
- See excluded locations and the reasons locations cannot join a campaign before starting. Locations whose runners cannot perform required campaign gates are excluded from its boundary.
- Owner scope approvals remain available through unrelated decisions and appear under **Waiting for You**. GitLab issue references nested within scope requests are accepted.
- Approval reviews show named forge checks, request context, and the request’s own diff. Refused merge consumption identifies the approved enqueue command.
- Review any owned worktree’s pull request without selecting that worktree first. Follow-up reviews show what merging the base dropped, and review-round limits are documented more clearly.

## Worktrees and Session Recovery

- Location switches preserve existing work and run setup in the target worktree. Moving to the current worktree no longer holds a session unnecessarily.
- Worktree identities are unique per repository. Reused worktrees retain pull request tracking, and retirement and forced-removal safeguards preserve other sessions’ work.
- Git conflicts no longer crash isolated sessions; documented Git limitations still apply.
- Windows process-tree shutdown, Claude relaunch after worktree retirement, and one-shot Claude calls recover more reliably.
- Transcript messages show full dates and times, and completed merge holds count toward waiting time.

## Upgrade and Rollback Guidance


Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v335; new account, worktree, and review capabilities requires compatible components. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.37.0-rc.1 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.37.0-rc.1/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

The release workflow builds all six supported native targets and verifies exactly 47 signed release assets: 14 desktop bundles, 12 runner names, 6 headless control-plane executables, the web bundle, `SHA256SUMS`, 12 updater signatures, and `latest.json`. Final verification checks inventory, signatures, compatibility-copy equality, and publisher digests.

This candidate remains a prerelease. Stable v0.37.0 requires a separate version-checked build and exact-commit regression certification; changing the prerelease flag cannot graduate the signed RC packages to stable. These changes do not establish unattended Full Control production readiness or waive human-owned approval gates.
