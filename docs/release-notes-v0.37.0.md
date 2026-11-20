# Wollipog v0.37.0

Wollipog v0.37.0 adds provider-account priority, scheduled Orchestrator campaigns, and an Assistant preview. It improves campaign recovery, pull request review, and worktree switching. This stable release covers the changes since [v0.36.1](https://github.com/picoduck/wollipog/releases/tag/v0.36.1), graduating v0.37.0-rc.1 through rc.3 and including the changes that followed. Read the upgrade notes before updating an installation that used Pods or Runs.

## Install and Update

Download the desktop installer for your platform from this release's assets. Existing desktop installations can check for the update in **Settings → About** and use **Install and Restart** where supported. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication.

```bash
wollipog update --release v0.37.0
# For non-interactive upgrades:
wollipog update --release v0.37.0 --yes --json
```

Plain `wollipog update` selects the latest stable release. Desktop installations following the stable channel can update directly from v0.36.1.

## Upgrade Notes

Back up the control-plane database, any separate artifact blob store, and each runner's data and configuration before upgrading. Stop writers before taking a filesystem copy and keep the previous binaries and dashboard bundle. Save any Pod context or run-specific records you still need while the old installation can read them.

### Pods, Workflow Runs, and Multi-Agent Runs

- **Pods** are removed, including Huddle, automatic turns, shared context, and worktree reconciliation. Startup drops Pod definitions, membership, context entries, and orchestration records. Member sessions, worktrees, transcripts, artifacts, and automations remain. [#4697](https://github.com/picoduck/wollipog/pull/4697)
- **Workflow Runs** and the **Run a Workflow** automation action are retired. Startup removes workflow definitions, versions, execution graphs, attempts, and events. Member sessions and session artifacts remain. Existing workflow schedules and execution history stay visible. The schedules are paused, unfinished executions are marked failed, and pending workflow commands are retired. Use **New Automation** to create a replacement that launches an Orchestrator campaign. Other automation actions remain available. [#4698](https://github.com/picoduck/wollipog/pull/4698)
- **Multi-Agent Runs** are retired. Startup removes comparison records and run membership. Members remain available as ordinary sessions with their transcripts. Artifact bytes and blob references are preserved, including run-only artifacts that have no new session owner. Images linked from a session transcript remain readable. To compare agents, start separate sessions with the same prompt. [#4699](https://github.com/picoduck/wollipog/pull/4699)

The **Experimental** settings section is removed. Bookmarks under `/pods` and `/runs` open **Page Not Found** with **Back to Sessions**. Integrations should remove calls to the former Pod, Run, and Workflow APIs, including `/api/pods`, `/api/runs`, `/api/workflows`, and `/api/workflow-runs`. Legacy run and workflow MCP operations such as `create_run` and `create_workflow_run` have also been removed.

### Runner Compatibility and Configuration

The runner protocol moves from **v332** in v0.36.1 to **v395** in v0.37.0. Upgrade the control plane and its dashboard first, then update standalone and remote runners. During that interval, a v332 runner can register with the upgraded control plane and continue using supported session operations. New capabilities still check the connected peer's version. For example, **Priority Order** needs runner protocol v334 or later, and **Switch and Continue** to a control-plane-registered Location needs v395 on both sides. An old runner cannot restore retired APIs or features. Keep mixed versions temporary and update both components before relying on new features. <!-- REHEARSAL: verify -->

- Existing machine provider defaults migrate to **Default Account**. Choose **Priority Order** to opt in. Older dashboards cannot overwrite a Priority Order policy through the old default-account setting. A config-less runner now keeps its provider-account inventory in `provider-accounts.json` in its own data directory. Runners with an existing config file continue to use it. [#4364](https://github.com/picoduck/wollipog/pull/4364), [#4656](https://github.com/picoduck/wollipog/pull/4656)
- On the first upgraded runner start, Wollipog clears legacy launch environment values from readable session `meta.json` files and removes leftover temporary files from recognized metadata writers. Future metadata writes keep the environment empty, and launches resolve it from current runner-local configuration. The startup scrub does not clean older backup copies. Protect those copies and review any credentials that may have been exposed. [#4734](https://github.com/picoduck/wollipog/pull/4734), [#3339](https://github.com/picoduck/wollipog/issues/3339)
- Archived-history retention continues to apply where enabled. Capable runners can trim full logs after completed control-plane pruning, including for previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if you need to retain full logs. **Reprocess** cannot restore trimmed logs, and runners that predate manifest format 2 require the pre-upgrade runner data for rollback. [Archived-history retention](https://github.com/picoduck/wollipog/blob/v0.37.0/docs/archived-history-retention.md#runner-logs-and-upgrades)

### Rollback

Stop the upgraded control plane and runners before restoring the v0.36.1 database, artifact store, runner data, and configuration from the pre-upgrade backup. Start the previous binaries and dashboard against that restored state. The retired tables cannot be recovered by switching binaries, and the headless updater's executable and dashboard rollback does not undo database migrations. Work recorded after the backup will not be present in the restored installation. <!-- REHEARSAL: verify -->

## Provider Accounts and Usage

- Set a **Default Account** or rank accounts in **Priority Order** per provider on a Machine. **New Session** and the automation editor can show the expected choice. Agents can list eligible opaque account references and explicitly select an account for a new session. Agent-facing responses omit raw account IDs and labels. **Switch Accounts at a Usage Limit** remains a separate opt-in setting.
- **Subscriptions** lists each subscription once across Machines. Claude usage can be refreshed on request, and a failed refresh preserves the **Last Known** reading. The badges distinguish **On Pace to Run Out**, **Approaching Limit**, and **Usage Warning**. Decision Model calls use the live rate table for cost recording.
- **Add Account** stays above the **New Session** draft. SSH connection health is reported separately from provider setup readiness, and account-directory errors show the failed check and recovery guidance. Trusted group-writable profile roots can be repaired safely on Linux, and sign-in displays terminal errors more reliably. Compatible peers can complete an account's access grant from inventory even if the sign-in start reply is lost.

## Campaigns and Automations

- Schedule recurring Orchestrator campaigns with separate root and child harness, model, and effort settings. **Run History** links to **Campaign Status**, where owners can inspect waits and cleanup. Concrete Claude model pins are available when advertised by the provider, model pickers distinguish identical display names, and default worker allocations reserve room for reviews.
- See which Locations are excluded before launch and why, including runners that lack required capabilities. Scope requests preserve explicit repository names and issue ranges, including nested GitLab references. Unrelated changes preserve independent owner approvals and unchanged closure approvals. Owners can return eligible resources to the Orchestrator or keep them for their own decision. Full Control can record an owner-confirmed exception to an eligible personal instruction for one campaign, with each affected action still subject to its own gates.
- Pause and resume campaigns from **Campaign Status**. The panel is collapsible and shows settled scope decisions, owner classification, and recovery actions. Full Control session rows and Board cards show campaign state. The **Inbox** surfaces owner handoffs and owed closure reports, including after a campaign root has ended. Invalid typed requests identify the affected field or limit.
- Campaign recovery preserves a verified child report if a later attempt delivered nothing. It can reconcile already removed worktrees and uncertain issue closures when the outcome can be verified. Owners can confirm retirement of certain clean worktrees after automatic cleanup is refused. Trusted temporary branches can use recorded creation receipts for exact-tip cleanup. Approved follow-ups use publication readback and batched owner decisions, including when an allowance changes.
- Orchestrator guidance asks agents to plan and report usage, define a UI evidence rubric, and pause by default after three evidence review rounds to settle disagreements. Byte-identical UI evidence can reuse an eligible review receipt. Finished evidence reviewers are stopped and archived automatically once the stored review is consumed or ended.

## Pull Requests and Reviews

- Pull request summaries and the **Inbox** show merge-queue state. Eligible pull requests offer **Enqueue for Merge** through the existing approval and readiness checks. Durable branch-CI and queue waits report stalls, distinguish same-named jobs across workflows, and retry transient GitHub read failures. Campaign recovery keeps optional-check failures from triggering repairs when required-check evidence is sufficient.
- Approved merge actions show the canonical command, and provider refusals of approved forge actions reach the child and Orchestrator. Proven merges can be reconciled after a superseding request, an external enqueue, or a stopped child when the required receipt or forge evidence is available. Moved heads and changed closing references still require fresh verification.
- Reviews show named checks, request context, and the forge request's own diff, including paginated GitLab diffs. Review any owned worktree's pull request without reselecting that worktree. Maintainers can request managed, read-only contributor reviews for pull requests targeting registered repositories, including forks. Hosted reviews use the base commit's `REVIEW.md` when present.
- Follow-up reviews show what a base merge dropped, and proven protocol-only renumbering does not use a review round. Requesters can stop their reviewer or archive a terminal review while retaining its verdict and findings.

## Sessions, Worktrees, and Runner Reliability

- **Switch and Continue** can move to a verified same-runner Location registered through the control plane. Switching preserves existing work and runs setup in the target checkout. Reused worktrees keep pull request tracking, and a move to the current worktree no longer adds an unnecessary hold. Automatic launches warn when a failed remote check makes a new worktree start at local HEAD.
- Worktree launch and retirement handle stale registrations and failed setup with stronger ownership checks. Git conflicts no longer crash isolated sessions. On Linux, Codex recognizes another bubblewrap namespace denial and can use its existing enclosing boundary when available, preserving the boundary's network and approval policy. Runner command checks cover more shell and working-directory cases.
- Runner restart recovery retains provider process ownership and improves native Orchestrator relaunch. Invalid or competing lease state is handled more safely, and Windows process-tree shutdown and Claude relaunch recover more reliably. Large reconnects spend less time rebuilding campaign state and give credential handshakes room to proceed.
- Transcripts show full dates and times, failed slash commands can be dismissed, and completed merge holds count toward waiting time. The **Inbox** preserves its scroll position when returning to the list. Narrow screens keep approval actions in view and let owners type a **Something Else** answer in the composer. Workspace access can be selected when adding a workspace or changed from the Machine's workspace list.

## Preview

**Wollipog Assistant** is a preview. Automated coverage exercises thread, management, and delivery paths, while the live end-to-end OpenClaw, Discord, and SSH acceptance run remains deferred. [#4468](https://github.com/picoduck/wollipog/issues/4468)

- **Assistants** appears after **Sessions** by default. Threads persist across visits and show owner confirmations and launched work. The navigation count shows threads waiting for an owner response. Destructive thread actions ask for **Approve Once** or **Deny** and describe their effects.
- Owners can choose a subscription in **New Thread** and use **Change Account** at an idle boundary. **Thread Limits** controls budget and launches. New threads inherit the owner's defaults in **Settings → Behavior → Assistant Threads**. Existing threads keep their limits, and managed cross-model reviewer costs are accounted for outside the thread budget.
- Assistant threads and owner-managed connections can manage sessions, Machines, workspaces, campaigns, reviews, automations, and skills within their granted access. A thread can request an owner-approved campaign launch with a separate campaign allowance. The OpenClaw integration supports isolated profiles and routes updates back to their originating Discord work.

## Packaging and Dependencies

The release workflow builds all six supported native targets. It verifies the complete 47-asset signed-tag inventory, including desktop bundles, standalone runners and their compatibility aliases, headless control planes, the web bundle, `SHA256SUMS`, and updater signatures and manifest. Tauri CLI 2.12.5 fixes the RPM version format for prerelease builds. Runtime dependencies are refreshed, including Fastify packages and WebSocket support. The desktop build includes the rustix update for the informational advisory RUSTSEC-2026-0486.

[Full changelog](https://github.com/picoduck/wollipog/compare/v0.36.1...v0.37.0)
