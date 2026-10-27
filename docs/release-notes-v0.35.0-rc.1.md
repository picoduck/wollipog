# Wollipog v0.35.0-rc.1 — Release Candidate

This first candidate for v0.35.0 refreshes automations, multi-agent runs, and Pods;
improves review sessions and provider-HOME recovery; adds GitLab campaign merge tools;
and extends optional history retention. These notes cover changes merged since v0.34.0.
It is intended for people who choose to try an early version and report problems.

## Install the Prerelease

Download the desktop installer for your platform from this release's assets. To receive
prerelease update offers in the desktop app, enable **Pre-Release Updates** in Settings → About.
This preference defaults off, including after installing a prerelease manually.

Headless installations can select this exact release after publication:

```bash
wollipog update --release v0.35.0-rc.1
# For non-interactive upgrades:
wollipog update --release v0.35.0-rc.1 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate
does not replace v0.34.0 as the latest stable release.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol advances from v228 to v239. New review, campaign, recovery,
and retention features require compatible runners; updating only the control plane does not
supply runner capabilities or install a reviewer.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.35.0-rc.1 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

**Runner-log retention changes in this candidate.** Organizations with archived-history retention
already enabled automatically trim capable runners after completed control-plane pruning,
including sessions pruned before the upgrade, without a new switch or another 24-hour arming
delay. Off remains off. Preserve a runner data backup or disable the organization policy before
upgrading if full logs must be retained. Reprocess cannot restore a trimmed full log. Manifest
format 2 is intentionally refused by older runners: rollback requires stopping the runner and
restoring pre-upgrade runner data with the old binaries. See
[archived-history retention](https://github.com/picoduck/wollipog/blob/v0.35.0-rc.1/docs/archived-history-retention.md#runner-logs-and-upgrades).

Managed provider profiles retain their compatibility boundary: a profile-bearing HOME cannot
be used by a control plane older than protocol v225. Adoption and access grants remain explicit;
recovering a lease does not authorize another control plane to use the account.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients
may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Automations and Workflow Runs

- Browse scheduled and paused automations in compact rows with schedules in words and an
  enabled switch. Open an automation on its own page to edit its rules, pause it, or delete it.
- Preview a schedule and its next run, choose from examples, and search time zones by their
  current names. Validation identifies the field that needs attention.
- Create signed triggers in a dialog that shows the address and one-time secret. Manage outbound
  event subscriptions in their own tab with delivery results and rotate or revoke actions.
- Read run history as a table, inspect receipts in Run Details, and follow workflow steps beside
  the working agent. Follow up with run agents or stop work through named confirmations.
- Sessions can request human-approved automations. Saved retired exec agents remain unavailable
  when an automation is edited.

## Multi-Agent Runs and Pods

- Start a comparison or workflow from a task-first dialog with healthy agents preselected and
  clear location, role, and error information. Run lists identify the type, agents, and work
  needing attention.
- Compare agents in member columns beneath one task strip, or use member tabs on phones.
- Create Pods from eligible sessions, work in member columns beside a shared huddle, and manage
  members through their menus. Phones use Huddle and Member tabs.
- Move a Pod's automatic turns and merge work into dialogs, show recent merges in words, and
  identify the Pod in its close confirmation.

## Reviews and Campaign Tools

- Review sessions are the default cross-model review route on supported runners. The review
  panel shows rounds, findings, staleness, and run phases; completed reviews deliver a
  continuation and nest beneath their requesting session.
- Review sessions charge campaign allowances when applicable and use explicit decisions for
  extra rounds. Reviewer admission uses static trust checks, while launches protect reviewer
  installations and retain process-lifecycle proof. Discovery failures report their component
  and refusal reason.
- Campaign work items accept GitLab issue and merge-request references. Campaign Status shows
  pipeline and merge-train state; tools can wait for those results, merge through a typed merge
  decision, and retire worktrees after a squash merge with separate branch-deletion approval.
- Full Control roots can use runners their human can access. Launch starts from the task, and
  orchestration handles eligible decisions while credential requests become blocked work.
  These changes do not establish unattended Full Control production readiness: the complete
  execution, evidence review, and managed-usage path still requires verification.

## Security

- Updates the desktop's `ctutils` dependency from 0.4.2 to 0.4.4 to address non-constant-time
  mask generation and comparison behavior reported in
  [RUSTSEC-2026-0385](https://rustsec.org/advisories/RUSTSEC-2026-0385.html).

## Recovery, Retention, and Reliability

- Provider-HOME recovery reports specific refusal causes and process diagnostics. Supported
  Linux recovery can use recorded cgroup evidence for abandoned leases, and state-doctor tools
  cover legacy and native homes while preserving evidence when ownership is uncertain.
- Supported Linux runners contain provider descendants in cgroups and retain provider-HOME
  references until their process trees are proven gone. Review-writer recovery distinguishes
  contained writers from legacy records instead of clearing records without proof.
- Organization retention can trim runner session logs after archived history is pruned. Separate
  opt-in policies cover completed workflow events and host mutation-audit archives. Database
  vacuuming can reclaim free pages in paced, opt-in steps.
- Account checks prefer available native harnesses, lower Claude usage readings can be applied
  after a confirmed quota reset, and in-place handoffs use current repository files.
- Operator-scoped shared runtime directories support Linux projects without making one
  session's private runtime directory the shared location.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is intended for publication as a prerelease, never as the latest stable release.
