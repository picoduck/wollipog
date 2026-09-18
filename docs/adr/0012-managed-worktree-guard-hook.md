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
  replacement, no emulation in the `control_request` handler, and no mediation notice. Whether a
  running child is mediated, and which mode is emulated for it, is bound when it is spawned (#1303).
- The control-channel refusal stays in the handler as defense in depth for `default`/`auto`.
  Amended by #1333: with the guard active, a top-level Bash request is judged there from a
  placeless directory, so the channel adds only the refusals that hold wherever the shell is.
  The `can_use_tool` request carries no cwd and Claude's Bash tool keeps its own directory, so
  judging relative operands from the session directory refused `cd ..` from any subdirectory,
  and inferring the directory from command text does not converge (renaming the shell's own
  directory defeats it). The hook receives the real directory and is the authority for those.
  Subagent requests and mediated launches keep the session-directory check.
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
2. **The guard cannot be proven to start.** Claude blocks only on exit code 2; a sidecar that
   fails to START exits 1 and the tool call proceeds. That was a real hole: the development runner
   re-enters itself with `--import tsx`, and a hook inherits CLAUDE's working directory, so the
   bare specifier failed to resolve with `ERR_MODULE_NOT_FOUND` and every command was waved
   through. Two answers: `cwdIndependentExecArgv` makes bare loader specifiers absolute in the
   runner's own module graph, and `verifyManagedWorktreeGuardLaunch` runs the real sidecar once per
   distinct launch command (from a foreign cwd, with a probe-owned protections file, demanding the
   real refusal document) before anything relies on it. A failed self-test means no guard, hence
   mediation; it is retried after a cooldown rather than on every launch.
3. **The guard cannot be provisioned at all.** Non-native (WSL/container) context, a non-host
   execution target, an unquotable path, or a write failure: the driver falls back to EXACTLY the
   #1256 mediation. There is never an unprotected native launch. "Guard active" is established at
   provisioning time — argument quoting, the settings write, AND the launch self-test all have to
   succeed — and is observable in the launch argv, never inferred.

## Settings merge

Because only the last `--settings` applies, the guard and the manager policy hooks (DRIVERS.md
§2.3.1) share ONE per-session settings document, guard first in `PreToolUse`. The guard is present
whenever it is provisionable — since #1303 even while the session owns no worktree — including
when manager hooks are disabled,
unsupported for the mode, skipped for the Orchestrator preset, or their circuit is open. While the
circuit is open the live file is swapped for a guard-only copy and the `--settings` argument is
kept; the heal template restores the combined document when the transport is eligible again.
Nothing secret is written into the guard-only document.

A user-supplied `--settings` in the agent catalog is therefore shadowed for guarded launches. That
is not new — it already happened for every launch that provisioned manager hooks — but it now
applies to more launches. Restoring user settings under a runner-owned settings file is out of
scope here and needs its own decision. Until then, #1303 does NOT widen the shadowing: a launch that
owns no worktree and carries its own `--settings` stays unguarded (see "Live protections"). That
includes launches with manager hooks, whose open circuit would otherwise leave a guard-only
document shadowing settings that previously applied.

## The guard's own state

The protection list lives in a file, and the provider runs as the runner's OS user, so it can
reach that file. Under #1256 the list lived in runner memory and could not be edited at all. This
is a real reduction in integrity that cannot be fully repaired without an OS boundary (#1302).
What is done instead:

- **Veto.** Every tool call that references the runner's hook state directory is refused — by the
  guard hook and, for `default`/`auto`, by the control-channel handler, through one shared
  function. Bash commands are matched on raw text and on every `cwd`-resolved operand; the file
  tools (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Read`) and the search tools (`Grep`, `Glob`,
  whose absent `path` means the working directory, and whose glob pattern contributes its static
  prefix) are matched on their resolved path and are part of the hook matcher. Reads are refused
  too: the provider has no need of them. "Resolved" means `~`, `~name`, `~+`, and `$HOME` are expanded and the
  nearest existing ancestor is passed through `realpath`, so a home-relative spelling or a symlink
  planted in the workspace is judged by where it lands. Third-party MCP filesystem tools are not
  classifiable by name and remain outside the veto, like any other indirection.
- **One carve-out: inspecting an ancestor.** A Bash operand that merely CONTAINS the directory is
  allowed when the whole command is `ls` without a recursive option or `stat`, and nothing else
  (#1334). Such a command may NAME the hook directory; it never enumerates what is in it. The
  file tools stay refused on an ancestor, so the path-level predicate keeps its old meaning.

  `du` and `find` are deliberately outside the carve-out, though #1334 lists both among the
  commands that should be allowed. Each walks the tree it is given, and each can be pointed at a
  file through an option value, which is not an operand and so is never compared against the guard
  state. Three of the bypasses found while reviewing #1334 came out of bounding `find`'s walk, and
  two more out of `du`'s file-valued options — the last of them a bare option value naming a symlink
  to the protections file, which no check on the option's spelling can see. `ls` and `stat` neither
  descend nor take an option that names a file to open, so they need no depth reasoning and no
  option parsing. A bounded `du` or `find` belongs in its own change, with that reasoning as the
  subject.

  The carve-out fails closed, because a command-text classifier is easy to talk past. EVERY command
  in the list has to be an inspection, not merely the one holding the ancestor operand: the shell
  carries state across `;` and `&&`, so `hash -p /bin/rm ls; ls -rf <ancestor>` runs `rm`, and a
  bare `PATH=` assignment rebinds a later name the same way. Beyond that, a command is disqualified
  wholesale when it routes or nests commands — a pipe, a command substitution, a subshell, a process
  substitution, a backtick, or an operator the classifier does not model — so a listing piped into
  `xargs rm -rf` is not an inspection. A newline disqualifies it, because the tokenizer treats one
  as whitespace and would join two commands into one. A redirection does not start a new command, so
  its target is judged as a location and never mistaken for the command word, and a leading IO
  number belongs to the redirection rather than to the command. A glob or brace metacharacter
  disqualifies the command, because the shell expands `--recurs{ive,}` into `--recursive` first. So
  does a `NAME=value` assignment, a command word that is not a bare name, since `./ls` is whatever
  was planted there, and an option word carrying a path separator: neither `ls` nor `stat` has an
  option that opens a file, so that refuses nothing either needs, and a path inside an option is
  never waved through. Long options are matched as GNU `getopt_long` accepts them, so `ls --recurs` counts as
  recursive. A working directory inside the guard state disqualifies the command too, since one
  with no operand acts there.

  Where the two directions conflict, it over-refuses. A short-option cluster is scanned for `R`
  without modelling which options take an attached value, so GNU's `ls -IREADME` reads as recursive
  and is refused; a hard-coded list of value-taking options would fail OPEN the day it is wrong.

- **No free advertising.** The protections path is not exported in the settings `env` block (which
  reaches every tool process); it travels only in the hook command inside the 0600 settings file,
  and the guard accepts it only from there — never from the environment.
- **Tripwire.** The runner remembers the SHA-256 of the exact protections document it last wrote
  and compares the file before every rewrite, at spawn and at refresh. A mismatch invalidates the
  guard for that session (mediation from then on) and emits a visible notice.
- **Removal, not emptiness, means invalidated.** An empty list is a valid runner-written state
  (#1303) and is covered by the tripwire like any other document. A guard the runner no longer
  trusts has its list removed, and a missing list fails closed.

This is tamper-EVIDENT best effort of exactly the same strength class as #1256's command-text
matcher: both are defeated by indirection (a script file, an interpreter, an unexpanded variable).
It raises the cost and makes tampering visible; it is not enforcement. Enforcement belongs at the
sandbox boundary (#1302).

Measured on claude 2.1.270: the CLI does NOT re-read `--settings` mid-process. A hook that
replaced the effective settings file with `{"hooks":{}}` on its first invocation was still invoked
for the second and third Bash calls of the same run. So a provider cannot remove the hook from the
process it is running in; the veto on that directory protects the NEXT spawn, and provisioning
rewrites the settings file and its template immediately before every spawn anyway.

## Invalidation

"Guard invalidated" is an explicit state, not an inference. A refresh that cannot be completed —
a tripwire mismatch, a write failure, or an exception — removes the protection list so every later
guard invocation fails closed, marks the session so the next spawn is mediated until a guard
provisions and self-tests cleanly, and emits a visible notice. If the list cannot even be removed,
a running provider would keep trusting stale state, so it is stopped through the ordinary stop
path and the next prompt relaunches it. The compromise marker lives in runner memory: a runner
restart forgets it, and the next spawn re-provisions and re-proves the guard from scratch.

"Next spawn" includes the spawns the driver makes on its own. One-shot turns, resumes, and
persistent-transport restarts reuse the provisioned argv without re-provisioning, so
`prepareClaudeHookArgs` re-checks trust every time: the compromise marker, the tripwire digest, and
a valid list. When any of them fails, the runner-owned settings document is dropped for
that spawn (a guard hook without a list would block every matched tool) and the driver mediates.
The manager policy hooks in the same document are dropped with it, as they are when the hook
circuit is open.

## Live protections

The protections file is written at every Claude spawn and refreshed synchronously from the session
store's `worktrees` patch observer, so creation, activation, attach, and discard are all reflected
immediately — a worktree created mid-turn is protected from the guard's next invocation.

As first shipped, a session that owned no worktree at spawn had no guard in its running process,
and in a noninteractive mode nothing else is consulted, so a worktree it created mid-turn was
unprotected until the next spawn (#1303). Every guardable launch is therefore now provisioned with
the guard over an EMPTY list, over which it holds no opinion beyond its own state, and discarding
the last worktree writes an empty list instead of retiring the guard (retiring it made every later
tool call of the running turn fail closed). The cost is one short-lived process per matched tool
call in every guardable session.

The remaining windows, each until the next spawn: an unguardable launch (below), and a launch that
owns no worktree and carries a user-supplied `--settings` — guarding that one would shadow the
user's settings, possibly dropping their deny rules, which is a change this ADR leaves to its own
decision. The sandbox read-only derivation (#1302) is likewise computed at spawn.

Because the inventory now changes under a running child by design, the driver binds its mediation
decision and emulated mode at spawn, as it already does for the routine-operation supplement; the
control-channel veto keeps reading the live inventory.

## Consequences

- Auto, Accept Edits, Ask Every Time, Full Access, and Don't Ask behave in a worktree session
  exactly as they do without one, apart from the refusal of protected targets.
- Orchestrator children in Auto no longer relay routine commands to their parent.
- Native TUI launches were never protected by #1256 (its mediation is driver-side, and a TUI has no
  runner control channel). They are not made worse: a TUI replays the session's persisted args, so
  it carries the guard whenever a structured launch persisted the settings argument and the file is
  still present, and `agentTuiLaunch` now drops a `--settings` pair whose file is gone — `claude`
  refuses to start with "Settings file not found", and a TUI never re-runs launch provisioning.
- One extra short-lived process runs before each Bash, Edit, MultiEdit, Write, NotebookEdit, Read,
  Grep, and Glob call in a guarded session — since #1303, every guardable session.
- The runner's hook state directory is invisible to the provider: reading it is refused as firmly
  as writing it.
- Native hooks remain a cooperative same-user governance mechanism, not an OS isolation boundary,
  exactly as §2.3.1 already states.
