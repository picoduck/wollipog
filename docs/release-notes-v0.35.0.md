# Wollipog v0.35.0

Wollipog v0.35.0 refreshes automations, multi-agent runs, and Pods; improves provider
accounts and recovery; expands reviews and GitLab campaign tools; and makes archived sessions
easier to browse. These notes cover changes since v0.34.0, including both v0.35.0 release
candidates and the archived-session filter hover fix merged after rc.2.

## Install and Update

Download the desktop installer for your platform from this release's assets. Existing desktop
installations can discover this stable release through Settings → About and use
**Install and Restart** where supported. Linux package installations link to the release page.

Headless installations can select this exact release after publication:

```bash
wollipog update --release v0.35.0
# For non-interactive upgrades:
wollipog update --release v0.35.0 --yes --json
```

Plain `wollipog update` selects the latest stable release. This release replaces v0.34.0
as latest stable. Installations running either v0.35.0 release candidate can update to v0.35.0;
prerelease opt-in is not required to discover this stable version.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol advances beyond v228, which v0.34.0 used. New review,
campaign, recovery, and retention features require compatible runners; updating only the
control plane does not supply runner capabilities or install a reviewer.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.35.0 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

**Runner-log retention changes in this release.** Organizations with archived-history retention
already enabled automatically trim capable runners after completed control-plane pruning,
including sessions pruned before the upgrade, without a new switch or another 24-hour arming
delay. Off remains off. Preserve a runner data backup or disable the organization policy before
upgrading if full logs must be retained. Reprocess cannot restore a trimmed full log. Manifest
format 2 is intentionally refused by older runners: rollback requires stopping the runner and
restoring pre-upgrade runner data with the old binaries. See
[archived-history retention](https://github.com/picoduck/wollipog/blob/v0.35.0/docs/archived-history-retention.md#runner-logs-and-upgrades).

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

## Accounts and Provider Sessions

- Set up managed provider profiles and recover existing profiles from refused sessions. Busy
  provider accounts can wait for availability, and recovery is offered from refused agent TUIs.
  Device-code sign-in cards include **Copy Device Code**.
- Copy an existing Codex API-key sign-in into a new managed profile. Removing an account explains
  that the stored sign-in is retained.
- Restarted Claude sessions resume conversations. Ordinary agent TUIs use the session's provider
  account, structured sessions lease the provider HOME where the provider writes, and account
  configuration publications are fenced against competing writers.
- Codex children can run commands when their sandbox cannot nest inside the runner's sandbox.
  Provider compatibility includes Pi 1.4.0 RPC handling and updated Codex request handling.

## Campaigns and Reviews

- People can change a running Orchestrator's child harness, model, effort, follow-up threshold,
  and completion settings. Personal reviewer choices and round budgets can be configured.
- Campaign tools support closing and scoping GitLab issues; review sessions support GitLab merge
  requests. Legacy review jobs have been retired in favor of review sessions.
- Full Control handles eligible closure and implementation questions without waiting on its own
  unanswered questions. Human scope changes and revocations remain enforced. Follow-up publication
  and closure checks bind prompt identity and content and recheck forge state.
- Codex review sessions exclude repository skills. These changes do not establish unattended
  Full Control production readiness; complete execution and evidence paths still need verification.

## Session Browsing and Lifecycle

- Archived Sessions uses a search-first toolbar, a filters sheet, and fixed two-line rows.
  Returning from a session restores the archive browsing context. Filter controls retain their hover edges.
- Touch screens regain one-tap copying of user messages. Session previews center transcripts like
  open sessions, and full-area empty states are centered in the space they fill.
- Worktree switches show their relaunch state and automatically continue the session afterward.
- Handoff holds show outstanding work, start times, and full counts, exclude ended jobs, and offer
  **Proceed Now**. Terminated background jobs remain ended after provider relaunch.
- Side chats stay alive until their first message and stop when their parent is archived.
- Sessions record who launched them so per-user settings and budgets apply. Artifact upload
  preferences also apply to personal-organization sessions.

## Reliability and Dependencies

- Runner registration avoids full session scans, batches queued runtime updates, and commits
  heartbeats without a WAL flush, reducing database work on frequent runner activity.
- Secret fields stay out of the DOM, and password controls reject value props. Dependencies
  include patched transitive fast-uri and zod releases plus Tauri updates.
- Shared SSH reconnect handling, bounded bundled-runner setup waits, and clearer rejected async
  question feedback improve recovery and diagnostics.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is published as the latest stable release.
