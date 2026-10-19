# Wollipog v0.34.0

This release refreshes Projects, Machines, and New Session; adds durable provider account
profiles and read-only review sessions; and improves campaign, worktree, and upgrade recovery.
These notes cover changes merged since v0.33.0.

## Install and Update

Download the desktop installer for your platform from this release's assets, or use
**Check for Updates** in Settings → About. Supported desktop packages can install the update
with **Install and Restart**; `.deb` and `.rpm` installations link to the release for a manual
upgrade. This release uses the default stable update channel.

Headless installations can update after publication:

```bash
wollipog update
# To select this exact release, including in non-interactive upgrades:
wollipog update --release v0.34.0 --yes --json
```

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol advances from v223 to v228. Provider profiles, review
sessions, and newer campaign tools require compatible components; updating only the control
plane does not supply runner capabilities or install a reviewer.

Existing provider accounts are not automatically adopted as profiles. Adoption is explicit:
after adoption only control planes granted that profile may use its credential HOME. A
profile-bearing HOME cannot be used by a control plane older than protocol v225. Retain that
compatibility requirement when planning a rollback. Windows runners, including their WSL
account homes, retain the existing account-home behavior rather than creating managed profiles.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.34.0 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients
may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Projects and New Session

- Projects now has an overview and independently scrolling list and detail panes. Project
  locations show setup status and **New Session Here**, with secondary actions in one menu.
- Project settings share one save bar, inline errors, explicit access changes, and a memory
  sharing summary that reports each machine's support. Archive, location removal, and project
  deletion confirmations identify the affected items.
- **New Project** warns about duplicate names and hands off to folder selection. **Add Location**
  offers an existing location or a new folder; creation and location requests are safe to retry
  after a lost reply. Folder browsing gains breadcrumbs and preserves the last listing on error.
- New Session places project and location together, lists ready agents first, explains setup
  needs, and groups advanced choices in an Options row that opens when attention is needed.
  Orchestrator policy has its own dialog. Finding existing agent sessions gives each result
  a **Continue Here** action.

## Machines and Provider Accounts

- Connections gains an All Machines overview with capacity and items needing attention.
  Machines appear as rows beside their details, with one header, lifecycle notice, and
  connection details. Machine settings use one form and **Save Changes**.
- Capacity is shown as a meter; workspaces, agents, and provider accounts use compact rows.
  Agent details lead with the required fix, and agents that are not installed are folded away.
  Account labels reject duplicates inline, and removal lives in each account's menu.
- Local setup uses one checklist dialog. Manual runner installation and connection repair have
  shorter guided steps, and SSH setup asks for the target first.
- On supported runners, new provider accounts use stable, host-local profiles that survive
  runner replacement. Owners and admins can explicitly adopt existing accounts or revoke this
  control plane's access. Credentials stay on the host; new sessions bind to the profile identity.
- Linux can recover an abandoned profile lease when lifecycle evidence proves the previous
  process tree is gone and the replacement control plane is granted the profile. Other stale
  leases remain blocked. Removing an account retains its credential HOME; physical cleanup
  remains disabled until retirement authority is proved.

## Reviews and Campaigns

- Sessions can launch a separate read-only reviewer against a runner-owned snapshot of their
  pushed PR head. Review attempts are checked against a structured contract, with round and
  epoch planning. An installed supported reviewer is still required.
- Full Control launch presents a concise server summary and one human authorization, saves
  the campaign budget, and shows effective decision owners and one concurrency value.
  Existing campaigns can be enabled when their prerequisites are satisfied.
- Verified-complete campaigns are informational. Unanswered recovery instructions are reissued,
  and acknowledging a blocked result no longer stops its background work. Background Work
  displays result notices in its shared notice slot.
- Video evidence can use a narrowly isolated, media-only Claude Code reviewer after human
  certification through validation permits and runs. Delegated review binds evidence to
  review windows and receipts; inadequate evidence can return through the typed repair gate.
  These changes do not establish unattended Full Control readiness: the complete live
  execution, review, media, evidence, and managed-usage path must still be verified.

## Runner and Upgrade Reliability

- Isolated sessions can use their other bound managed worktrees and delete their own refs
  through the runner. Rebinds and retirement wait for the active turn, and providers whose
  selected worktree was retired can relaunch. Merged worktree cleanup recognizes the exact
  merged head even when the PR branch has a different name.
- WSL direct provider sandboxes block Windows interop. Packaged lease helpers are verified
  against their embedded assets, and provider HOME workers use monotonic deadlines.
- Headless upgrade staging gains phase diagnostics and safe recovery for blocked staging.
  Pull-request waits report merge-queue state, and merge-group cleanup shares one monitor.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and
`latest.json` for exactly 47 assets. The final workflow verifies inventory, signatures,
byte-identical compatibility copies, and publisher digests before publication.
Publishing the verified draft remains a manual operator step.
This release is intended for publication as the latest stable release.
