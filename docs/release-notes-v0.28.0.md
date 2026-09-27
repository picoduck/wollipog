# Wollipog v0.28.0 — Desktop Updates, Safer Execution, and Durable Work

Wollipog v0.28.0 can update the desktop app in place from a published release. It also adds
installation-aware harness selection, an opt-in Skills Library, stronger container and managed
worktree boundaries, and more reliable orchestration and background work. Session history, review,
authentication recovery, and viewer permissions received a broad set of usability and reliability
improvements.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v174 to v192 through capability-gated messages. Current runners are needed for the new harness
installation selection, Skills Library adoption, session artifacts, background-job controls, and
Agent Control recovery behavior. Older runners can still connect but cannot provide capabilities
they do not advertise; affected operations fail closed.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.27.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.28.0 processes before restoring the backup
and starting the retained binaries.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

Desktop builds from this release check the latest published release for updates. An update install
restarts the app and follows the normal work-in-flight guard. Linux package installs and builds
without an update key instead link to the release page. The first app version with this updater
must be installed manually from the release page or installer.

## Desktop Updates and Harness Installations

- Check for a newer published desktop release and install supported signed update packages from
  Settings. Automatic checks can be turned off without disabling manual checks.
- Discover multiple harness installations per target, show their provenance and update status, and
  bind saved agent choices, usage probes, and external-session adoption to the selected installation.
- Revalidate native executable identity before launch and give installation-appropriate update
  guidance instead of assuming a package-manager install.
- Restore desktop identity requests when connected to a remote control plane, and identify the
  available subscription account during authentication recovery.

## Skills Library and Session Artifacts

- Offer Wollipog's built-in skills as opt-in recommendations and show when a recommended skill has
  not yet been assigned. Display skill invocations by name in the transcript.
- Adopt Git-imported skills with guarded updates and drift reporting on macOS, Windows, Linux, and
  supported Windows-hosted WSL targets. Surface edited or unavailable copies instead of silently
  replacing them.
- Add bounded video session artifacts and accept attached artifacts as UI evidence without an
  external URL. Validate WebM content before upload and keep review evidence on the in-app review
  surface.

## Safer Execution and Clearer Permissions

- Revalidate Docker and Podman engines and target configuration before secret-free container
  launches. Reject implicit host mounts, device or IPC defaults, client proxy inheritance, and
  other unsafe target defaults rather than falling back to an unverified environment.
- Guard Claude file edits against managed-worktree Git state and refuse manager policy hooks in
  unsupported isolation modes with a launch notice.
- Disable session, archive, review, Git, and background-job controls when a viewer lacks permission,
  while keeping the unavailable action and its reason visible where helpful.
- Mask personal identifiers by default in app-controlled UI, with deliberate reveal controls.

## Orchestration, Background Work, and Recovery

- Let eligible Claude Code Orchestrators review child UI evidence through the governed decision
  path, while preserving human review where policy requires it.
- Preserve async questions and owed decision resumes across campaign continuations, runner
  reconnects, and worktree recovery. Show held children and explain the action needed to resume
  them to the person reading the notice.
- Re-send unacknowledged Agent Control credential registrations and report the underlying relay
  failure instead of a generic malformed-response error.
- Stop one managed background job from outside its session, record who stopped it, preserve queued
  work across explicit restart, and avoid continuing work the model itself stopped.
- Recover sessions with invalid selected worktrees, keep pending spawn approvals alive through slow
  retries, and preserve attachment placement and transcript history across replay and paging.

## Session and Review Usability

- Page session events forward from the cursor and retain attachments and earlier activity through
  history resets and scroll-position changes.
- Keep the Sessions view toggle stationary when **Apply New Order** appears, improve status and
  unavailable-action contrast, and make review checkboxes show their disabled state.
- Retry retained attachment fetches after transient failures and keep UI evidence review available
  when a saved Claude alias is no longer in the catalog.
- Correct queued-prompt and background-job status so the UI distinguishes held work from an active
  turn and shows stop provenance.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
