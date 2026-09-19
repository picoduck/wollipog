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
  Amended again by #1361: the hook was measured to run for a SUBAGENT's Bash calls too, carrying
  that subagent's real directory, so a subagent's request is judged from the placeless directory as
  well. Only a mediated launch, which has no hook at all, keeps the session-directory check.
  Confirmed from the channel's own side by #1397: a subagent's call does arrive here in
  `default`/`auto`, its frame carries no cwd either, and it is marked by `request.agent_id` rather
  than `parent_tool_use_id`. Captured frames of both kinds now pin this path in the tests.
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

## Measurements (claude 2.1.270 and 2.1.277, this machine, 2026-09-18)

Do `PreToolUse` hooks cover a SUBAGENT's tool calls (#1361)? Measured by running headless Claude in
a throwaway project whose `--settings` hook logged every payload, then comparing each payload's
`cwd` against what that same command's own `pwd` printed. 2.1.270 (the version the measurements
above were taken on) and 2.1.277 (the version installed on this machine) behaved identically, over
repeated runs:

- A hook runs for the Bash calls a subagent makes; no subagent call was missed. Measured both with
  a bare `"matcher": "Bash"` and with the alternation the runner writes
  (`MANAGED_WORKTREE_GUARD_MATCHER`), which behaved identically.
- A subagent's payload adds `agent_id` and `agent_type` to the top-level shape, which is how such a
  call can be recognised in the hook.
- The payload's `cwd` is the directory the subagent's command actually runs in — confirmed call by
  call, with no disagreement.
- That directory is the TOP-LEVEL shell's current directory, not the session directory: after the
  top-level shell did `cd sub`, every subagent call ran in `<proj>/sub`.
- A subagent's Bash shell does not keep its own `cd` between calls; it resets to that inherited
  directory each time (the top-level shell does keep its own).

Hence the session directory could not place a subagent's relative operand either, and the amendment
above. The runs were made in `bypassPermissions`, which never consults the control channel, so they
establish the hook's coverage of a subagent — not what a subagent produces on the channel itself.
That is the next section.

## Measurement (claude 2.1.270 and 2.1.277, this machine, 2026-09-18)

Does a SUBAGENT's Bash call produce a control-channel `can_use_tool` frame in `default`/`auto`,
and what does that frame carry (#1397)? Measured by running headless Claude in a throwaway project
with the exact interactive arg set the driver builds (`--input-format stream-json
--permission-prompt-tool stdio`, plus `--permission-mode auto` for `auto`), answering each frame as
`resolvePermission` does, and joining every frame against the `tool_use` block the model actually
issued — whose own `parent_tool_use_id` names the spawning `Task` call, making "this came from a
subagent" ground truth from the provider's stream rather than something read off the frame. No hook
was installed, so nothing could suppress or fabricate a frame. Both versions behaved identically:

- A subagent's Bash call that needs approval DOES produce a `can_use_tool` frame, in both modes.
- The message envelope is exactly `{type, request_id, request}`. No frame of either kind carried
  `parent_tool_use_id`, on the message or inside `request`.
- A subagent's frame is marked by `request.agent_id` — the same opaque id the hook payload carries
  — and a top-level frame has no such field. That id is not the spawning `Task` tool_use id.
- The request carries no `cwd`. Its only placement field is `blocked_path`, present only when the
  escalation reason is a specific path; it is absolute and resolved from the issuer's real shell
  directory, agreeing with the hook's `cwd`.
- In `auto`, whether the channel is reached at all is the classifier's decision: left alone it
  approved every probe command at both levels, and a `permissions.ask` rule was needed to force the
  escalation. The rule decides whether the CLI asks; it does not shape the frame.

So the branch is live code, not dead code. The decision above is unchanged — a subagent's request
is still judged from the placeless directory — and is now pinned by frames captured from these runs
(`apps/runner/src/drivers/fixtures/claude-can-use-tool-subagent.json`, replayed through the real
driver). What #1397 corrects is the discriminator: `parent_tool_use_id` never identifies a subagent
on this channel, `request.agent_id` does. The placeless judgment stopped keying on the former in
#1373; the one remaining consumer on this path, attention ownership, is unreachable for Claude
today and is kept unchanged rather than re-keyed, because `agent_id` is the wrong id space for it.

## Measurements (codex-cli 0.155.1, this machine, 2026-09-18)

Does Codex offer a provider-side interception point that survives a TUI launch (#1377)? Measured
in a throwaway `CODEX_HOME` against a throwaway repository and worktree, by reading the CLI's own
help and app-server schema (`codex app-server generate-json-schema`) and by running it:

- `hooks` is a stable feature, enabled with no configuration (`codex features list`); its events
  include `PreToolUse`.
- A `PreToolUse` hook receives JSON on stdin with `tool_name` (`Bash` for a shell call,
  `apply_patch` for an edit), `tool_input.command`, `cwd`, and `permission_mode`. It blocks with the
  same `hookSpecificOutput` deny document Claude uses, or with exit 2 and a reason on stderr. The
  model sees `Command blocked by PreToolUse hook: <reason>`.
- `-c hooks.PreToolUse=[…]` installs a hook from argv alone; `hooks/list` reports it with source
  `sessionFlags`. Hooks from different sources merge: a `config.toml` hook and a `-c` hook are both
  listed.
- A session-flags hook reports `trustStatus: untrusted`, and an untrusted hook does not run and
  says nothing: with the override and no bypass, `git worktree remove <worktree>` removed the
  worktree and the hook was never invoked. `--dangerously-bypass-hook-trust` makes it run. No way
  to persist trust for a session-flags hook was found, and a `hooks.managed_dir` passed through `-c`
  loaded nothing.
- With the real sidecar wired in that way, `git status --short` ran and the reproduction's
  `git worktree remove <worktree>` was refused with the managed-worktree refusal, leaving the
  worktree in place.
- A sidecar that cannot start (a bare `--import tsx` resolved from the wrong directory) is shown as
  a failed hook and the command RUNS, exactly the fail-open hole described below for Claude.

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
  allowed when the whole command is made of `ls` without a recursive option, `stat`, `du` with
  value-free options, and `find START... -maxdepth N` whose walk stops at or above the hook
  directory, and nothing else (#1334, #1390). Such a command may NAME the hook directory; `ls`,
  `stat`, and `find` never enumerate what is in it. The file tools stay refused on an ancestor, so
  the path-level predicate keeps its old meaning.

  `du` and `find` came back in a change of their own (#1390), after five of the fourteen bypasses
  found while reviewing #1334 came out of them: three from bounding `find`'s walk, two from `du`'s
  file-valued options — the last a bare option value naming a symlink to the protections file,
  which no check on the option's spelling can see. So neither is parsed in general; each is
  admitted in exact argv shapes only. `du` takes options from a closed list of value-free flags
  spelled in full, plus a numeric `--max-depth=`: no option value can name a file, so none needs
  resolving. `-a`/`--all` is not on the list, because it prints every file and so would enumerate
  the hook directory's protections files; plain `du` prints directories only. `find` takes one or more explicit starts followed by exactly `-maxdepth N`, and `N` may
  not exceed the depth of the hook directory below any related start, measured under every reading
  of it (spelling, physical path, and where a `..` after a symlink really lands), nearest reading
  deciding. A walk to that depth reads the directories above the hook directory and only names the
  hook directory itself; every other `find` word is refused, because a test such as `-empty` opens
  the directory it names at the bound. A `find` with no explicit start walks the working directory,
  which no operand names, so it is refused.

  The trade-off `du` carries, restated as #1334 accepts it: `du` on an ancestor walks the hook
  directory too, so it learns that directory's total size and prints the names of any
  subdirectories in it. It opens no file and reads no contents, and neither does any option it is
  allowed.

  An operand that climbs with `..` is also judged by where the kernel lands. Lexical normalization
  folds `<ancestor>/link/..` into `<ancestor>` before the symlink is seen, although the kernel
  follows `link` first and climbs out of its target, which can be the hook directory itself.

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
  was planted there, and an option word carrying a path separator: none of the admitted forms has an
  option that opens a file, so that refuses nothing they need, and a path inside an option is
  never waved through. Long options are matched as GNU `getopt_long` accepts them, so `ls --recurs` counts as
  recursive. A working directory inside the guard state disqualifies the command too, since one
  with no operand acts there.

  Where the two directions conflict, it over-refuses. A short-option cluster is scanned for `R`
  without modelling which options take an attached value, so GNU's `ls -IREADME` reads as recursive
  and is refused; a hard-coded list of value-taking options would fail OPEN the day it is wrong.
  And `find <ancestor> -maxdepth 1 2>/dev/null` is refused, because the tokenizer drops the adjacency
  that makes `2>` a redirection, so its `2` reads as one more word after the bound.

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

Amended by #1336: **where the runner sandboxes the provider, the sandbox is now the primary
control, and the veto above is defence in depth.** Three attempts to close this gap by command
text (#1371, #1403, and the abandoned draft #1423) took 16 review rounds, and nearly every round
found a new fail-open. The classes command text could not close included walkers it did not model,
`git clean -dfx`, option values the shell rewrites, file-valued options naming a symlink, and
indirection. Under runner `bwrap` and Seatbelt the hook state directory is now hidden from the
provider and from everything it spawns, the guard sidecar included. So the sidecar no longer reads
the list: it asks a per-session Unix socket the runner serves, and the runner judges it with
`runManagedWorktreeGuardDecision`, the same function the file-mode sidecar runs. The launch proves
this from inside its own sandbox before the provider starts, and a guard that cannot reach the
runner fails the launch rather than every tool call. The mechanism, its failure behaviour, and the
per-platform matrix are in docs/agent-control.md ("Runner Hook State at the Sandbox Boundary").

This does not change the veto, the carve-outs above, the tripwire, or anything else in
`provider` mode. `provider` is the default and has no runner boundary, so there the veto is still
the only control over the hook state directory, and #1336 remains open for it. #1398, the
operand-less recursive walk from an ancestor, is closed at the OS level for sandboxed launches only.

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
  runner control channel). As first shipped they inherited the guard only by accident — a TUI
  replays the session's persisted args, so it carried the guard when a structured launch had
  persisted the settings argument and the file was still present, and `agentTuiLaunch` drops a
  `--settings` pair whose file is gone because `claude` refuses to start with "Settings file not
  found". A swept file therefore produced a launch with no guard at all (#1337).

  Amended by #1337: a Claude TUI launch now re-runs launch provisioning, exactly as a
  runner-driven spawn does. `prepareAgentTuiLaunch` provisions a fresh settings document and a
  fresh protection list, then runs the driver's own `prepareClaudeHookArgs` over the result, so
  "guard active" for a TUI is read from the argv it will launch with — the same explicit fact, not
  an inference from the session owning a worktree. The removal command in #1337's reproduction is
  refused from the TUI by the same hook that refuses it in a structured session.

  Where the guard cannot be provisioned (WSL/container path translation, a non-host execution
  target, an unquotable path, a write failure, a failed launch self-test) or is no longer trusted
  (an invalidated guard, an open circuit with no guard-only copy), a TUI has nowhere left to
  stand: the mediation fallback below is driver-side and a TUI runs no driver. So a session that
  owns a runner-created worktree is REFUSED the TUI instead of being opened unprotected, and one
  that owns none opens exactly as before. The #1303 exception is unchanged: a session with no
  managed worktree that carries its own `--settings` is not guarded, and is not refused either,
  because there is nothing to protect.

  A TUI is also the first launch that provisions ALONGSIDE a running provider rather than
  replacing it, and both read the same per-session documents. So its provisioning is marked
  `concurrentLaunch`: it may write and refresh the guard, never retire it. Retiring is what the
  ordinary path does when it knows the live worktree set and can produce no guard — and doing that
  under a running provider removes the very list its loaded hook reads, which fails every matched
  tool call of the turn it is in. The protection list it writes is likewise resolved when
  provisioning runs, not from the launch snapshot, which predates the awaited worktree proof and
  the Orchestrator's scratch and credential work.

  Amended by #1377: a Codex TUI launch is guarded too. Codex's structured protection lives in the
  driver (`buildCodexTurnParams` and its approval decisions) and has no TUI form, but Codex has
  its own `PreToolUse` hook with a Claude-shaped contract (see "Measurements (codex-cli 0.155.1)"
  below), so the same sidecar is installed as a Codex hook through
  `-c hooks.PreToolUse=[{matcher=…,hooks=[{type="command",command="<quoted sidecar>"}]}]`, over the
  same per-session protections file — which the live refresh therefore keeps in step for a Codex
  TUI as well. The tripwire, the compromise marker, and the launch self-test are shared with
  Claude's.

  A session-flags hook is never trusted, and Codex skips an untrusted hook silently, so the
  launch has to carry `--dangerously-bypass-hook-trust`. That flag un-gates EVERY enabled hook for
  the invocation, not just the runner's. So before launching, the runner enumerates the effective
  hook inventory (`codex app-server` → `hooks/list`, replaying the launch's own `-c`/`--config`/
  `--enable`/`--disable` flags in every spelling Codex accepts — `--disable=hooks` turns every hook
  off and `-cVALUE` adds one — plus the guard override, in the directory the TUI resolves
  project-scoped hooks from, which a `-C`/`--cd` in the launch moves) and passes the flag
  only when the runner's hook is present, enabled, and the sole enabled hook that is neither
  `trusted` nor `managed`. Otherwise the TUI is refused for a session that owns a runner-created
  worktree, with an error that names the offending hooks and says to trust (`/hooks`) or disable
  them. The same enumeration is the Codex half of the self-test: a runner hook absent from the
  inventory (`--disable hooks`, a changed config schema, a quoting mistake) is a guard that would
  never have run. Enumeration that fails, times out, or reports a hook discovery error refuses;
  so does a launch carrying a
  `--profile`, which may declare hooks and which `app-server` cannot replay, or a `--remote` or
  `--worktree`, which run the session where a local probe cannot see; so do WSL/container
  contexts, non-host targets, and Windows, where how Codex runs a hook command was not measured.
  A Codex session that owns no runner-created worktree opens exactly as before: nothing is
  written and no probe runs.

  Residual limits of the Codex form:

  - Codex's edit tool is `apply_patch`, whose input is patch text rather than a path, so the
    guard-state file-tool veto does not classify it. Worktree removal is a Bash-level operation
    and is covered; an edit of the protections document through `apply_patch` is not refused, but
    the tripwire makes it evident and invalidates the guard for the next spawn.
  - A Codex TUI opened while the session owned no runner-created worktree carries no hook, so a
    worktree the session creates from inside that TUI is unprotected there until the TUI is
    reopened. (A Claude TUI is guarded over an empty list since #1303; a Codex one is not, because
    that would mean passing the trust bypass on every Codex TUI launch.)
  - The inventory is a check, not a pin: a hook configuration written between the probe's answer
    and the TUI's start is loaded by the TUI under the trust bypass. Codex offers no flag that
    restricts an invocation to the hooks it was shown, so the window cannot be closed from the
    runner, only narrowed. It is accepted because it grants nothing new: a hook appearing in that
    window needs an active writer running as the same OS user, which can already run that code
    directly, while the hooks the trust gate exists for — ones acquired passively, such as a cloned
    repository's project hooks — are present before the probe and are refused.
  - Everything above rests on Codex hook behaviour measured at codex-cli 0.155.1. The inventory
    check fails closed if a later build stops installing the hook, but not if one changes how a
    deny is honoured.
- One extra short-lived process runs before each Bash, Edit, MultiEdit, Write, NotebookEdit, Read,
  Grep, and Glob call in a guarded session — since #1303, every guardable session.
- The runner's hook state directory is invisible to the provider: reading it is refused as firmly
  as writing it. In `provider` mode that refusal is the command-text veto. Under runner `bwrap` and
  Seatbelt it is the sandbox itself (#1336).
- Native hooks remain a cooperative same-user governance mechanism, not an OS isolation boundary,
  exactly as §2.3.1 already states.
