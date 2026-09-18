# ADR 0012: Enforce the Managed Worktree Veto With a Hook, Not With the Permission Mode

- Status: Accepted
- Date: 2026-09-18
- Supersedes the enforcement mechanism introduced by PR #1256 (commit 8b790255)

## Context

A runner-created session worktree must not be removed, retired, or corrupted by the provider: the
runner owns its lifecycle, and `discard_worktree` exists so retirement can wait for the provider to
exit and then apply the managed safety checks. `commandTargetsManagedWorktree` is the semantic
matcher that recognises such a command. Enforcing it is a **security** property — it must hold in
every permission mode, including Full Access, and Claude's automatic classifier must never be able
to approve past it.

PR #1256 could only enforce it where Claude consults the runner. Claude opens its stdio control
channel (`--permission-prompt-tool stdio`, `control_request`/`can_use_tool`) only in `default`, and
in `auto` only for what its own classifier does not decide; in the fixed-rule modes there is no
channel at all. So #1256 forced every non-`plan` mode to interactive `default`
(`protectedClaudePermissionMode`) and emulated three modes in the runner: allow-all for Full Access,
allow-the-four-edit-tools for Accept Edits, deny for Don't Ask.

The consequence (#1313) was that Auto, Ask Every Time, and every non-edit tool under Accept Edits
became an approval card. Almost every session in a worktree-per-issue workflow has a managed
worktree, so Auto was effectively switched off everywhere and Orchestrator children relayed every
routine command to their parent.

## Decision

Enforce the veto with a runner-owned `PreToolUse` **managed worktree guard** hook, and launch Claude
in the mode the user selected whenever that guard is in place.

- The guard is a runner re-entry mode, `--managed-worktree-guard`. It reads the hook JSON from
  stdin, loads the session's protections from a per-session `0600` file whose path arrives as an
  explicit `--protections` argument (with the settings `env` marker as fallback), evaluates
  `commandTargetsManagedWorktree` for `Bash`, and prints the deny document with the same refusal
  message the control channel uses. It does no network, control-plane, or credential work.
- `protectedClaudePermissionMode(mode, protectionsPresent, guardActive)` mediates only when
  protections exist AND the guard is not active. With the guard active there is no mode
  replacement, no emulation in the `control_request` handler, and no mediation notice.
- The control-channel refusal stays in the handler as defense in depth for `default`/`auto`.
- `commandTargetsManagedWorktree` itself is unchanged (its false positives are #1301), and the
  `plan` path is untouched.

## Measurements (claude 2.1.270, this machine, 2026-09-18)

A `PreToolUse` command hook supplied through `--settings`:

- is invoked for every Bash call in `auto`, `acceptEdits`, and `bypassPermissions`;
- blocks the call, with the reason surfaced to the model, when stdout is
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
  "permissionDecisionReason":"…"}}` (verified in `auto` and `bypassPermissions`; `acceptEdits`
  verified previously);
- blocks the call when it exits 2 with a message on stderr (verified in `auto` and `acceptEdits`) —
  this is what makes fail-closed possible;
- receives JSON on stdin including `tool_name`, `tool_input.command`, `cwd`, and `permission_mode`;
- can carry `"matcher": "Bash"` without losing any Bash call;
- and a call the hook does not deny proceeds under the selected mode's own semantics (in `auto` the
  classifier ran `git status` with no prompt).

Two `--settings` arguments do NOT merge: only the last file's hooks apply.

## Fail closed, and the fail-safe

Two different failure domains, two different answers:

1. **The guard runs but cannot decide.** Malformed stdin, a missing/unreadable/malformed
   protections file, a Bash call with no command text or cwd, no protections argument at all, or any
   exception: exit 2 with the refusal on stderr, which blocks the tool call.
2. **The guard cannot be provisioned at all.** Non-native (WSL/container) context, a non-host
   execution target, an unquotable path, or a write failure: the driver falls back to EXACTLY the
   #1256 mediation. There is never an unprotected native launch. "Guard active" is established at
   provisioning time and is observable in the launch argv, never inferred.

## Settings merge

Because only the last `--settings` applies, the guard and the manager policy hooks (DRIVERS.md
§2.3.1) share ONE per-session settings document, guard first in `PreToolUse`. The guard is present
whenever protections exist and it is provisionable — including when manager hooks are disabled,
unsupported for the mode, skipped for the Orchestrator preset, or their circuit is open. While the
circuit is open the live file is swapped for a guard-only copy and the `--settings` argument is
kept; the heal template restores the combined document when the transport is eligible again.
Nothing secret is written into the guard-only document.

A user-supplied `--settings` in the agent catalog is therefore shadowed for guarded launches. That
is not new — it already happened for every launch that provisioned manager hooks — but it now
applies to more launches. Restoring user settings under a runner-owned settings file is out of
scope here and needs its own decision.

## Live protections

The protections file is written at every Claude spawn and refreshed synchronously from the session
store's `worktrees` patch observer, so creation, activation, attach, and discard are all reflected
immediately — a worktree created mid-turn is protected from the guard's next invocation (#1303).
A session that owns no worktree at spawn time has no guard in its running process and keeps the
mediated behaviour until its next spawn; that window is deliberate and fail-safe, because mediation
is the stricter of the two.

## Consequences

- Auto, Accept Edits, Ask Every Time, Full Access, and Don't Ask behave in a worktree session
  exactly as they do without one, apart from the refusal of protected targets.
- Orchestrator children in Auto no longer relay routine commands to their parent.
- Native TUI launches were never protected by #1256 (its mediation is driver-side, and a TUI has no
  runner control channel). They are not made worse: a TUI replays the session's persisted args, so
  it carries the guard whenever a structured launch persisted the settings argument and the file is
  still present, and `agentTuiLaunch` now drops a `--settings` pair whose file is gone — `claude`
  refuses to start with "Settings file not found", and a TUI never re-runs launch provisioning.
- One extra short-lived process runs before each Bash call in a guarded session.
- Native hooks remain a cooperative same-user governance mechanism, not an OS isolation boundary,
  exactly as §2.3.1 already states.
