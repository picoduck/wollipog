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

## Measurements (codex-cli 0.155.1, this machine, 2026-09-19)

What exactly does Codex send for an edit, and does the runner's matcher reach it (#1437)? Measured
the same way — a throwaway `CODEX_HOME` against a throwaway repository — by installing a
`PreToolUse` hook that recorded its raw stdin and driving real `apply_patch` calls through it:

- An edit arrives as `tool_name: "apply_patch"` with the patch document in `tool_input.command`,
  the SAME key a shell call carries its command in. The full key set observed was `session_id`,
  `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `tool_name`,
  `tool_input`, `tool_use_id`.
- Header paths are spelled either absolutely or relatively, and a relative one resolves against the
  payload's `cwd`. Both were produced by the model and both applied.
- The header grammar is the CLI's own, read out of the binary it ships. Four directives name a
  file — `*** Add File: `, `*** Update File: `, `*** Delete File: `, and `*** Move to: ` — and the
  filename is the rest of the line verbatim. `*** Begin Patch`, `*** End Patch`, `*** End of File`,
  and `*** Environment ID: ` name no location. Every content line is prefixed (`+` in an add hunk,
  `+`/`-`/` ` in a change), so a line beginning `*** ` is always a directive and never file content.
- The matcher is respected — `ZZZNOPE` hooked nothing — and Codex answers to a Claude-shaped alias:
  an `apply_patch` call was matched by `apply_patch` AND by `Edit`, while `Bash` matched only the
  shell call. So the alternation written before #1437 already reached the hook, through an alias no
  contract promises; the guard now names `apply_patch` outright.
- `apply_patch` invoked from the SHELL (`apply_patch <<'PATCH' … PATCH`) arrives as an ordinary
  `Bash` call with that whole command as its text, which the Bash classifier already judges.
- A header's filename is not taken quite verbatim, and the trim set is Unicode `White_Space` —
  Rust's, not JavaScript's. Reading back the bytes of the files created: `*** Add File: trailing.txt `
  created `trailing.txt`; `*** Add File: nel.txt<U+0085>` created `nel.txt`, though JavaScript's
  `trimEnd` leaves U+0085 alone; and `*** Add File: bom.txt<U+FEFF>` created `bom.txt<U+FEFF>`,
  though `trimEnd` would have stripped it. Those two code points are the whole disagreement between
  the sets. `*** Add File:  leading.txt` created ` leading.txt`, so a leading space is part of the
  name.
- End to end with the real sidecar: a patch naming a file inside the hook state directory was
  refused with `Command blocked by PreToolUse hook:` and the managed-worktree refusal, and the file
  was not created; against the same payload the pre-#1437 sidecar wrote it. Ordinary edits inside
  the protected worktree (an update and an add) applied unchanged with the guard installed.

## Measurements (codex-cli 0.155.1, this machine, 2026-09-19): guarding every Codex TUI

What does it cost to guard a Codex TUI whose session owns no worktree (#1438)? #1377 declined to,
naming two costs: the hook-inventory probe and the trust bypass on every launch. Measured with the
runner's own probe client and sidecar, in a throwaway `CODEX_HOME` and against this machine's real
one (read-only: `hooks/list` only, counts printed, never commands):

- **The inventory probe** (`codex app-server` → `initialize` → `hooks/list`, then killed) took
  133–143 ms in a throwaway home and 169–175 ms against the real one, over eight and six runs; the
  first run after a pause took about 370 ms. It is paid once per TUI open.
- **The sidecar over an empty list** took 55–63 ms per matched tool call in the development form
  (`node --import tsx`), the same process Claude sessions have paid for since #1303. It allowed
  `git status` and `git worktree remove ../wt`, and refused only a command naming its own state
  file, which is the "no opinion beyond its own state" #1303 describes.
- **A person's own untrusted hook** (a `config.toml` `PreToolUse` command, source `user`,
  `trustStatus: untrusted`) is reported beside the runner's, and the verdict declines the bypass
  and names it. So an always-guarded design that REFUSED on that verdict would take the TUI away
  from such a person even when they own no worktree. That is the regression the amendment avoids
  by opening that launch unguarded instead.
- **Not measured:** whether an authenticated TUI shows anything when started with
  `--dangerously-bypass-hook-trust`. An unauthenticated throwaway home stops at the login screen,
  where the output with and without the flag was identical and mentioned neither hooks nor trust;
  the probe was not pointed at real credentials. This is not a new exposure either way: since
  #1377 every worktree session's TUI already starts with the flag.
- A measurement trap worth recording: a protections file placed in the PARENT of the test `cwd`
  made the sidecar refuse `git status`, because a working directory inside the guard's state
  directory disqualifies every command. The runner's hook directory is `<dataDir>/hooks/<runnerKey>`, a leaf of
  runner state rather than a parent of a workspace, so this is a property of the probe layout.

## Measurements: Codex Permission Profiles (codex-cli 0.155.1, this machine, 2026-09-19)

Can Codex's OWN sandbox deny the hook state directory in `provider` mode, where the runner does not
sandbox the provider at all (#1336 slice 2)? Measured in a throwaway `CODEX_HOME` against a
throwaway repository, with `codex sandbox` (which runs an arbitrary command under the resolved
profile), the `app-server` `command/exec` method (which takes the same `sandboxPolicy` shape a turn
does), and real `codex exec` and TUI turns. Every probe ran from a STRICT ANCESTOR of the denied
directory, and every claim below has a paired control run without the deny entry.

### The mechanism

- Permission profiles are config, not a flag: `[permissions.<id>]` with `extends`, and
  `[permissions.<id>.filesystem]` mapping an absolute path to `"read"`, `"write"`, or `"deny"`. One
  is selected with `default_permissions = "<id>"`. `-P/--permission-profile` exists ONLY on
  `codex sandbox`; `codex exec` and the TUI have no such flag.
- Both keys can be supplied entirely on argv, as one `-c` each, so nothing has to be written into
  the user's `config.toml`:
  `-c 'permissions.<id>={extends=":workspace",filesystem={"<dir>"="deny"}}' -c 'default_permissions="<id>"'`.
- Three built-in base profiles exist: `:read-only`, `:workspace`, `:danger-full-access`. Only the
  first two can be extended — `extends = ":danger-full-access"` is a hard error ("cannot extend
  unsupported built-in profile").

### What a deny entry actually enforces

Under both `:workspace` and `:read-only`, every one of these failed at the OS level, and every one
of them succeeded in the paired control without the deny:

`cat`, `python3 -c open()`, `head -c`, `ls`, `find -maxdepth 999`, `grep -r`, `rg`, `du -a`,
`touch` inside, `mv` of the directory from its ancestor, and `rm -rf`. `git clean -dfx`, run from an
ancestor Git repository that ignores the directory, reported `failed to remove vault/` and left it
in place; the control run removed it. The classes #1334, #1390, and #1398 could not close by command
text are therefore closed by the OS here, without the guard recognising the command.

### The legacy sandbox silently WINS, and drops the profile

This corrects the summary carried into this slice, which said Codex REFUSES to combine the legacy
`sandbox_mode`/`sandboxPolicy` with a permission profile. It does not refuse. It accepts both and
silently ignores the profile:

- `codex exec -s workspace-write` with `default_permissions` set: the denied file was read
  (`TOPSECRET`, exit 0). Without `-s`, the same prompt got `Permission denied`.
- `app-server` `command/exec` with an explicit `sandboxPolicy` — `workspaceWrite`, `readOnly`, and
  `dangerFullAccess` alike — read the file while the profile was the configured default. With
  `sandboxPolicy` omitted, the same command was denied.

A silent fail-open is worse than a refusal: nothing in the launch reports that the deny was
dropped. Anything that wants the deny must stop sending the legacy policy AND verify the result
rather than trusting that the configuration was accepted.

A user's own `sandbox_mode` in `config.toml` does NOT defeat an argv `default_permissions` — the
deny still held. Only an argv `-s`, an app-server `sandboxPolicy`, or
`--dangerously-bypass-approvals-and-sandbox` defeats it.

### The three legacy policies are the three built-ins

`thread/start` reports both the `activePermissionProfile` and the legacy projection of it, so the
equivalence can be read directly rather than inferred:

| Configured | `activePermissionProfile` | Legacy `sandbox` projection |
| --- | --- | --- |
| nothing (Codex's own default) | `:workspace` | `workspaceWrite`, `writableRoots: []`, `networkAccess: false`, `excludeTmpdirEnvVar: false`, `excludeSlashTmp: false` |
| `:read-only` | `:read-only` | `readOnly`, `networkAccess: false` |
| `:workspace` | `:workspace` | `workspaceWrite` with the defaults above |
| `:danger-full-access` | `:danger-full-access` | `dangerFullAccess` |
| `:workspace` + a deny entry | the derived profile, `extends: ":workspace"` | unchanged from `:workspace` |

Adding a deny entry does not move the projection, so the projection is lossy — which is exactly the
property wanted here: the mode is carried unchanged and the deny rides alongside it.

Non-default legacy options have profile equivalents: `network = { enabled = true }` projects to
`networkAccess: true`, and a `deny` entry on `/tmp` reproduces `excludeSlashTmp` and
`excludeTmpdirEnvVar` (plain `:workspace` left `/tmp`, `$TMPDIR`, and the cwd writable; with the
deny, `/tmp` and `$TMPDIR` were both refused while the cwd stayed writable).

### Hooks and MCP servers both run OUTSIDE the sandbox

In ONE run, with the deny active and no `-s`:

- The model's own shell call, reaching the directory indirectly through a script so the classifier
  could not see it, got `/bin/cat: …: Permission denied`.
- The `PreToolUse` hook process, in the same turn, read the file successfully.

So the guard sidecar keeps ordinary file access to its protection list under a Codex permission
profile, and needs no verdict socket the way a runner-sandboxed launch does (#1336 slice 1).

A configured stdio MCP server also read the file successfully, at startup, outside the sandbox.
**The MCP acceptance criterion of #1336 is therefore NOT met by this mechanism** and must not be
claimed: a user-configured MCP filesystem server with a root above the hook directory can still
read it in `provider` mode.

Codex also discloses deny entries to the model: asked directly, it declined before issuing any tool
call, naming the denied path. Indirection through a script still ran and still hit the OS deny.

### Failure modes that matter for a launch

- `default_permissions` naming an undefined profile is a hard startup error. That direction fails
  closed.
- An unrecognised top-level `-c` key is accepted silently. An OLDER codex-cli that does not know
  `permissions`/`default_permissions` therefore ignores both and runs with no deny at all, reporting
  nothing. Mixed-version hosts need an explicit probe, not a version string.
- Inside a profile table, an unknown key is ignored and the deny still applies.
- `"<dir>" = { access = "deny" }` — the shape the app-server's `FileSystemSandboxEntry` suggests —
  parses without error and does NOT deny. Only the bare string form works. Another silent fail-open.

### Per launch path

| Launch path | Sends a legacy policy today | Can carry a profile |
| --- | --- | --- |
| `codex` native driver (`codex exec -s <mode>`) | Yes, `-s` on argv | Yes, once `-s` is dropped (verified: deny held with the profile on argv and no `-s`) |
| `codex-app-server` driver (`turn/start` `sandboxPolicy`) | Yes, in the turn params | Yes, once `sandboxPolicy` is dropped (verified through `command/exec`) |
| Native Codex TUI | No `-s` is passed | Yes (verified from the TUI's own rollout: `Permission denied`, no `TOPSECRET`) |
| Generic `acp` driver | No | No. It spawns the catalog's command and args verbatim and injects no `-c`, so the runner cannot express a deny for an ACP-bridged Codex |

### Measured during review (same build, same day)

- **An exit code does not prove a denial.** A genuine deny inside `codex sandbox` exits 1; an
  undefined profile exits 1; an unsupported flag — what a build predating permission profiles
  produces — exits 2. The launch proof therefore requires a positive denial report from inside the
  sandbox, and anything else is "not enforced". A wrapper imitating an older CLI is refused; the real
  0.155.1 is proven.
- **An inner Node's stdout does not arrive.** A `node -e` inside `codex sandbox`, whose stdout is a
  pipe a Node parent created, ran its script (a file it wrote appeared) but none of its
  `process.stdout.write` output arrived, while `/bin/echo` and `sh`'s `printf` did. The proof uses
  `/bin/sh` and `cat`, with the path passed as an argument and the C locale pinned.
- **`-c sandbox_mode=…` does not defeat the profile**, in the separated or the attached spelling,
  any more than the key does in `config.toml`. Only the `-s` flag and the bypass flag do.
- **A resumed thread takes the configured profile.** A thread sent `dangerFullAccess` on a turn in
  one app-server, then resumed in a fresh one started with the profile, reported the profile as
  active and the `:workspace` projection. Within ONE app-server, `turn/start`'s policy applies to
  "this turn and subsequent turns", so the driver keeps sending the legacy policy on a thread once it
  has sent one.

- **The user's own configuration changes the legacy sandbox, and a profile does not carry it.**
  With `[sandbox_workspace_write] network_access = true` and an extra `writable_roots` entry in
  `config.toml`, `thread/start` reported them in the legacy projection under `-s workspace-write`
  AND under Codex's implicit default, and a real turn wrote into the extra root under both the
  implicit default and the app-server's explicit `{type: "workspaceWrite"}` policy. Under a profile
  extending `:workspace` the projection showed neither, and the same turn could not write there. So
  "the legacy policy IS the built-in" holds only for a user who configured nothing; each launch is
  therefore compared against its own configured projection (read from a throwaway `codex
  app-server` with the launch's arguments, environment, and cwd, on an ephemeral thread) and
  migrates only when that is exactly the plain built-in. A user whose configuration selects a
  profile (`default_permissions = ":read-only"`) is caught the same way, from
  `activePermissionProfile`. The legacy `sandbox_permissions` key does not appear in the projection
  at all; whether 0.155.1 still honours it was not measured.
- **A launch that never sent a legacy mode ran under Codex's own default.** A native TUI and a
  resumed `codex exec` turn pass no `-s`, so what they had is Codex's configured default, not the
  session's structured mode. They are compared with that default and migrate only as `:workspace`.

## Measurements (claude 2.1.278 and codex-cli 0.155.1, this machine, 2026-09-19): the Orchestrator preset

Can the Orchestrator preset carry the guard while keeping every user hook out (#1473)? The preset
excluded user hooks with `--settings '{"disableAllHooks":true}'` (Claude) and `--disable hooks`
(Codex), and both excluded the runner's guard with them.

Claude, in a throwaway project holding a project `.claude/settings.json` `PreToolUse` hook and a
`.claude/settings.local.json` one, with the real user config (twelve enabled plugins, whose
`SessionStart` and `PreToolUse` hooks are the user-scope probe) and, for the user-scope
`settings.json` case, a throwaway `CLAUDE_CONFIG_DIR` whose `SessionStart` hook fires before the
login check. Each run asked for two Bash calls, the second naming `PROTECTED`, against an inline
`--settings` document whose `PreToolUse` hook exits 2 on that word:

| Flags | Hooks that ran | Protected call |
| --- | --- | --- |
| `--setting-sources "" --settings '{"disableAllHooks":true}'` (the old preset) | none | ran |
| `--setting-sources "" --settings <inline guard>` | the inline guard only, twice | blocked |
| `--settings <inline guard>` (sources left alone) | inline, project, local, and plugin hooks | blocked |
| `--setting-sources "" --settings <inline guard + disableAllHooks>` | none | ran |
| throwaway `CLAUDE_CONFIG_DIR`, `--settings <inline>` | user-scope and inline | — |
| same, `--setting-sources ""` | inline only | — |

So `--setting-sources ""` alone drops the user, project, and local sources and the hooks of
plugins enabled there, and the inline document still runs. End to end with the preset's exact
argv (from `orchestratorLaunchArgs`, plus the removal added to `--allowedTools` so that `dontAsk`
could not refuse it first), the runner's real sidecar in a runner-shaped document, and a real
worktree in the list: from a scratch directory, `git -C <repo> status --short` ran and
`git -C <repo> worktree remove --force <worktree>` was refused with the managed-worktree refusal,
the worktree stayed, and a project hook planted in the scratch directory never fired. The same
argv with the old `disableAllHooks` document ran both commands, no hook fired, and the worktree
was gone.

Codex, in a throwaway `CODEX_HOME` with a user `config.toml` `PreToolUse` hook and a trusted
project with a `.codex/config.toml` one, over `hooks/list`:

- `--disable hooks` beside the runner's `-c hooks.PreToolUse=` override lists NO hook: the flag
  takes the guard down with the user's, so the #1438 probe for a preset launch had a fixed answer.
- Without the flag all three are listed, the user's two `enabled`/`untrusted`.
- A per-hook disable exists and can be passed from argv, in ONE spelling. The INLINE TABLE
  `-c 'hooks.state={"<key>"={enabled=false},…}'` lists the named hooks as `enabled: false` and
  leaves the runner's untouched; the dotted `-c 'hooks.state."<key>".enabled=false'` is accepted
  and changes nothing, because the key itself contains dots. A launch that used the wrong spelling
  would have looked configured and been fail-open, so the inventory is read back after the
  override rather than trusted.
- Under `--strict-config`, which the preset passes, both overrides are accepted.
- Not needed here but recorded: `-c 'hooks.state={"<session-flags key>"={trusted_hash="<currentHash>"}}'`
  makes the runner's session-flags hook report `trustStatus: trusted` in the inventory. Whether
  Codex then RUNS it without `--dangerously-bypass-hook-trust` was not measured. If it does, the
  invocation-wide bypass #1377 had to accept could be retired for every Codex TUI, and #1377's
  "no way to persist trust for a session-flags hook" was one spelling short.

End to end against the real `CODEX_HOME` (read-only; credentials used the ordinary way), with
`codex exec`, the preset's shape minus `--disable hooks`, the runner's real sidecar over a real
worktree, a project hook planted in the scratch directory, and the trust bypass: with the project
hook disabled by key the removal was refused (`blocked by PreToolUse hook: Wollipog protects this
runner-owned worktree…`), `git status` ran, the worktree stayed, and the project hook never ran. In
the control WITHOUT the disable override — the bypass alone, which is what the ordinary #1377
rule would pass for a trusted hook — the project hook ran alongside the guard. That is the
isolation the preset promises not to give up, and why an Orchestrator launch demands an inventory
with no enabled hook but the runner's.

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

Amended by #1336 slice 3: **in `provider` mode on native Linux, the files in the hook state
directory are no longer the authority for the guard's verdict.** This is not an OS boundary, and it
does not make the directory unreadable. It removes what reaching the directory used to buy.

The brief for this slice was to reuse slice 1's per-session socket in `provider` mode. Four
measurements (Linux 6.17, node 24.18.1, claude 2.1.278, codex-cli 0.155.1) changed that design:

- **A path socket is forgeable here.** A second process of the same OS user unlinked the `0600`
  socket in its `0700` directory and bound its own listener at the same path; the sidecar's next
  request got the forged answer. Under `bwrap` and Seatbelt the sandbox binds that directory
  read-only, so slice 1 stands. In `provider` mode a path socket would only move the authority from
  the list file to the socket path, in the same strength class as the tripwire.
- **An abstract-namespace socket is not.** The same attempt got `EADDRINUSE`, the runner kept
  answering, there is no entry to delete, and once the runner closed it a request got
  `ECONNREFUSED`, which the sidecar turns into exit 2.
- **The settings documents were never tripwired.** The "Tripwire" bullet above covers the
  protections list only. With the hook `command` rewritten to `/bin/true` in the live file, the heal
  template, and the guard-only copy, and the arguments untouched, `prepareClaudeHookArgs` still
  returned `guardActive: true`: `describeManagedSettings` reads the arguments, never the command.
  The next spawn ran a no-op hook with mediation switched off. So an in-memory list alone would have
  left an equal hole beside it.
- **Claude accepts its settings inline.** `--settings <json>` ran the `PreToolUse` hook, and exit 2
  blocked the call. A project `.claude/settings.json` hook still fired alongside it and a hook from
  an earlier `--settings` argument did not, exactly as with a file: only the last `--settings`
  applies, inline or not.

So, for a native Linux host launch that the runner does not sandbox:

- The list is a map in the runner process, set at provisioning and by the live refresh. No
  protections file is written, and one planted there is never read.
- The hook command carries `--guard-socket @wollipog-guard-<192 random bits>`. The name is generated
  once per session per runner process, never logged, and never written to disk.
- The sidecar sends its payload **and its environment**. Slice 1's server judged with the RUNNER's
  environment, while the file form judges with the sidecar's, which is the provider's (#1324). A
  variable only the provider defines was unresolvable there, and one both define (a leased provider
  home) could place an operand somewhere the command does not run. Both socket forms now judge in
  the sidecar's environment. It is no more trusted than before: either way it is what the provider
  handed its hook.
- Claude's real settings documents (combined and guard-only) are held in memory and one is passed
  inline at every spawn, TUIs included. The persisted argv still names the settings path, so
  provisioning, self-description, the sandbox mask, and the manager hook's files are untouched. What
  is written at that path is the same document without the socket, whose guard would find no list
  and refuse every matched call if it were ever launched. Codex's hook command was already
  argv-only.
- The manager hook's circuit is the one thing still read from disk before a spawn. It chooses
  between the combined document and the guard-only one, and both carry the guard.
- The runner proves the socket once per address with the real sidecar. A socket that cannot be
  created or proven leaves the launch in the file form, as it was before this slice. The proof is
  held on the listening server, not in a set of addresses, so it goes with the server whenever the
  socket closes — session deletion, shutdown, or re-creation under a new name — and a re-created
  socket is proven again (#1476).

What remains, stated plainly:

- **Any local user can ask for a verdict.** An abstract socket has no permission bits and its name
  is listed in `/proc/net/unix`. A caller learns deny or allow for a payload it supplies, which
  reveals which paths are that session's managed worktrees. There is no request that changes
  anything, a request names no session, and each socket answers only for the session it was made
  for. A process of the runner's own user can query every session's socket; nothing can prevent
  that against the same UID.
- The name also appears in that session's provider argv (the inline document), and Claude prints
  the whole hook command into the model-visible error on an exit-2 refusal, so it can reach that
  session's own timeline. The sidecar's own message does not repeat it. Neither discloses more than
  `/proc/net/unix` already does.
- The directory can still be read, walked, and deleted. The #1336 criteria about OS-level denial
  and MCP filesystem tools are NOT met for Claude in `provider` mode. The manager policy hook's
  credential and circuit still live there: a reader gets that credential, and a writer can open the
  circuit and drop the manager hooks for the next spawn, though not the guard.
- A same-user process can still kill the runner (every verdict then refuses), rewrite the runner's
  own code, or remove the worktree directly. No file-level design closes that.
- macOS and Windows have no abstract namespace, and WSL, container, and cloud launches carry no
  guard or a translated one: all keep the file form, whose settings documents are still
  untripwired.

Amended by #1472: **in `provider` mode on native Linux, the manager policy hook keeps nothing in
the hook state directory either.** The two bullets above that say otherwise (the circuit "still
read from disk", and the credential and circuit that "still live there") describe slice 3 as it
shipped and no longer hold for such a launch.

What the four files were for decided the design. The **token** is written by the runner and read by
the hook sidecar, which presents it to the control plane as a bearer credential scoped to exactly
one route, `POST /api/sessions/:id/policy-hook`, for one session. The **ready** file is the
runner's record that the control plane acknowledged that token's hash; the sidecar waits for it so
its first request is never unauthenticated. The **circuit** is written mostly by the sidecar: three
consecutive transport failures open it, after which the sidecar answers "no opinion" instead of
denying every tool call, and the next spawn drops the manager hooks so the provider's native
approval flow takes over. It is a liveness device: without it, an unreachable control plane bricks
the session. The **lock** serializes that read-modify-write between concurrent sidecars, which are
real (measured on claude 2.1.278: three parallel tool calls ran three overlapping `PreToolUse`
hooks). The sidecar is a process the provider starts, as the provider's OS user. So no placement of
the credential keeps it from the provider while the sidecar still has to read it, and a circuit the
sidecar can write is a circuit the provider can write. The only sound move is for the sidecar to
hold neither.

So the runner relays. For a native Linux host launch the runner does not sandbox:

- The credential, its acknowledgement, and the circuit are fields in the runner process. No token,
  ready, circuit, or lock file is written, files left by an earlier file-form provisioning are
  removed, and nothing planted at those paths is read, by the runner or by the sidecar.
- The hook command carries `--policy-relay` and, in the memory-held document only,
  `--policy-socket @wollipog-guard-<name>`: the session's existing abstract verdict socket. The
  sidecar sends the event name and the payload, and prints the hook response the runner returns.
  The runner runs the same evaluation the file-form sidecar runs (`evaluatePolicyHook`), against a
  transport whose state is memory. One event loop serializes the circuit, so there is no lock.
- A guard verdict changes nothing, which is why that socket answers anyone. A relayed event reaches
  the control plane, so a relay request must carry the session's **relay key**: 256 random bits,
  per session per runner process, handed to the provider in its spawn **environment** and never in
  its argv. Measured on claude 2.1.278: a variable in the spawn environment reaches all three hook
  events, as does the inline `env` block. `/proc/<pid>/cmdline` is world-readable and
  `/proc/<pid>/environ` is owner-only, so the key keeps other local users out where the socket name
  cannot. A request without the key gets the event's fail-closed response and reaches neither the
  control plane nor the circuit, so an unauthenticated caller cannot open it.
- The runner's circuit is the one that chooses between the combined document and the guard-only
  one. A circuit file written by the provider selects nothing: it is ignored, not honoured.
- Every failure to get an answer is the event's existing fail-closed response (`PreToolUse` denies,
  the other two do not block), and the sidecar records nothing. There is deliberately no deadline
  on the answer: a `PreToolUse` ask parks for as long as a human takes, and the runner holds the
  connection open. A sidecar that goes away closes it, which stops the runner polling on its
  behalf; closing a session's socket destroys parked connections rather than waiting for them.
- The pre-authorization `start_session` provisioning knows neither the worktree set nor the socket.
  On a relaying runner it keeps the state in memory too, so no credential touches disk on the way
  to a relayed launch. A launch whose socket could not be created or proven keeps the file form,
  exactly as its guard does.

Measured end to end with the runner's own provisioning, the real socket and sidecar, a stand-in
control plane, and claude 2.1.278 in `bypassPermissions`: `UserPromptSubmit`, `PreToolUse`, and
`PostToolUse` all arrived with the runner-held bearer, a policy deny blocked the tool call, and the
hook state directory held only the three settings documents before and after. With an open circuit
and a token planted in the directory beforehand, the result was identical.

What this does not deliver:

- **The provider can still use the hook.** Whatever the sidecar may ask, the process that starts it
  may ask: a process of the runner's user that reads the key from its environment can submit hook
  events for that session, including ones the control plane rejects, and three consecutive failures
  open the circuit. That is the capability the token gave, minus the token. It is now visible
  rather than silent: a circuit the runner opens always carries its timestamp, so the next spawn
  emits the existing `policy_transport` event.
- The key is in the environment of every process the provider starts, its tools and MCP servers
  included.
- A runner restart forgets the credential and the circuit, and closes the socket. A provider that
  outlived it would be denied on every `PreToolUse` until its next spawn, which provisions afresh;
  the guard already behaves the same way there.
- Runner `bwrap` and Seatbelt, macOS, Windows, WSL, container, and cloud launches are unchanged:
  the file form, with the #1447 `managerTransport` grants where a sandbox hides the directory.

The launch self-test (`verifyManagedWorktreeGuardLaunch`) is unchanged and still necessary: it
proves the sidecar STARTS, from a foreign directory, with a probe-owned list. It owns a throwaway
directory, so nothing in the hook state directory can influence it. The socket proof above is the
second half: that a started sidecar reaches this runner.

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

The list is built from the attributed worktrees, which also count the legacy `worktreePath` field as
one synthetic entry. The observer therefore fires as well for a patch that carries only
`worktreePath` or `worktreeBranch` — or `context`, which decides whether the legacy path is the same
worktree as a recorded one — when, and only when, it changes that attributed set (#1474). Those are
every field the attribution reads; selection re-carries the legacy pair constantly, and a field
merely carried protects nothing new. The
unguarded-TUI notice below rides the same refresh, so it is evaluated on the same trigger.

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
  As first shipped, a Codex session that owned no runner-created worktree opened exactly as
  before: nothing was written and no probe ran. #1438 changed that; see the amendment below.

  Amended by #1437: Codex's edit tool is judged too. `apply_patch` is neither a shell call nor a
  path-bearing file tool — it is one freeform patch document whose file headers carry the locations
  it writes — so the veto classified nothing and every `apply_patch` call passed, including one
  writing into the hook state directory. The shared decision now parses those headers
  (`*** Add File: `, `*** Update File: `, `*** Delete File: `, `*** Move to: `, measured from the
  CLI's own grammar; see "Measurements (codex-cli 0.155.1, this machine, 2026-09-19)"), resolves
  each filename against the payload's `cwd` under the same containment rules the file-tool veto
  uses — tilde forms, symlinks, and `..` that climbs through one included — and refuses a patch
  reaching the hook state directory or the Git administrative area of a protected worktree.
  Ordinary files inside the worktree are the session's own workspace and stay writable.

  Two things the cross-model review of #1437 turned up, both measured rather than argued:

  - codex-cli does not take a header's filename quite verbatim, and its trim set is Rust's, not
    JavaScript's. At 0.155.1, `*** Add File: trailing.txt ` created `trailing.txt`,
    `*** Add File: nel.txt<U+0085>` created `nel.txt`, `*** Add File: bom.txt<U+FEFF>` created
    `bom.txt<U+FEFF>`, and `*** Add File:  leading.txt` created ` leading.txt`. So a trailing pad
    names a second location, which is judged alongside the verbatim one, and the pad is Unicode
    `White_Space` — exactly what Rust's `str::trim_end` removes. The two sets differ on precisely
    two code points and both were measured: `trimEnd` leaves U+0085, which codex strips, so
    `*** Delete File: <worktree>/.git<U+0085>` read as an ordinary workspace path while codex
    resolved it to the protected gitdir pointer; and `trimEnd` strips U+FEFF, which codex keeps, so
    using it would have refused `*** Add File: .git<U+FEFF>`, an ordinary workspace file. A LEADING
    space is part of the name either way: stripping it would refuse `*** Add File:  .git/x`, whose
    trimmed spelling only looks like Git administration.
  - The shared physical-path resolver gave up quietly. It climbs to the nearest existing ancestor
    and appends the not-yet-existing remainder, bounded at 256 steps, and on exhaustion returned the
    spelling unresolved — which a classifier then compares textually. A spelling like
    `/proc/self/root<hook state>/<257 new directories>/file` therefore read as unrelated to the hook
    state while the kernel, and any tool that creates missing parents, lands inside it. This
    predates #1437 and applied to Claude's file tools as well (Bash was never affected: its
    classifier matches the directory in the raw command text first). Exhaustion is now distinct
    from "already physical" and every classifier treats it as out of bounds. No location a tool
    legitimately names has that many not-yet-existing components, so nothing real is refused by it.

  A patch whose headers cannot be accounted for is refused rather than guessed at, which is the
  same rule an unreadable command already follows. That covers a document with no envelope, one
  naming no file, one with an empty filename, and — the case the rule exists for — one carrying a
  `*** ` directive this build does not model, since an unknown directive may name a location the
  guard would otherwise skip. The judging lives in `managedWorktreeGuardDecision`, so both
  transports #1336 left in place carry it: the provider-mode sidecar reading the protections file,
  and the sandboxed launch asking the runner's verdict socket. The matcher names `apply_patch`
  outright; Codex also matches that tool through an `Edit` alias, which is how the pre-#1437
  alternation reached the hook at all, but no contract promises it.

  Amended by #1438: a Codex TUI is guarded from the start, over an empty list. A provider loads
  its hooks when it starts, so a TUI opened before the session's first worktree could never be
  given the guard afterwards, and that worktree was unprotected inside it until it was reopened.
  Every Codex TUI launch is therefore provisioned exactly as a worktree session's is — the
  protections file (empty), the launch self-test, the inventory probe, and the `-c` override — and
  the live refresh that already keeps that file in step fills the list in when the first worktree
  appears. This is what a Claude TUI has done since #1303. The cost #1377 deferred this over was
  measured rather than assumed (see "Measurements (codex-cli 0.155.1, this machine, 2026-09-19):
  guarding every Codex TUI"), and is small.

  The #1377 hook-trust rule is unchanged and is applied to every launch: the bypass is passed only
  when the runner's hook is present, enabled, and the sole enabled hook that is neither `trusted`
  nor `managed`. What differs with nothing to protect is the consequence of failing it. A session
  that owns a worktree is still REFUSED the TUI. One that owns none is opened as it was before
  #1438 — the same argv, no override, no bypass, so a person's own untrusted hooks stay gated
  exactly as Codex gates them — because refusing a TUI to protect nothing would take the TUI away
  from everyone who keeps an untrusted hook, a profile, or a `--remote`. The same holds for every
  other reason the guard cannot be provisioned.

  That leaves a TUI running without the guard, which the first worktree cannot reach. It cannot be
  repaired from outside the process, so it is announced instead: a launch reports whether the guard
  really is in its argv, the runner remembers each open agent TUI that lacks it, and the first time
  such a session owns a runner-created worktree — from the `worktrees` patch observer, or at open
  for one created while the launch was being prepared — the session shows a notice, once per TUI,
  naming the reason and saying to close the TUI and open it again. Reopening provisions with the
  worktree present, which guards or refuses. The registry is provider-independent, so it also
  covers the Claude launch "Live protections" leaves unguarded (no worktree and a user-supplied
  `--settings`). It lives in runner memory: a runner restart ends every TUI it hosts, so there is
  nothing to remember across one.

  Residual limits of the Codex form:

  - The notice is tamper-evident best effort like everything else here: it tells the person, and
    does not stop the unguarded TUI from touching the new worktree in the meantime.
  - The inventory probe and the trust bypass now apply to every Codex TUI launch, so the
    check-not-a-pin window below does too, including for sessions that own no worktree. It grants
    nothing new there for the same reason it grants nothing new anywhere else.
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

  Amended by #1473: **the Orchestrator preset is guarded, for both providers, and its list is
  every runner-created worktree on the runner.** The preset excluded user hooks in a way that
  excluded the guard too — `--settings '{"disableAllHooks":true}'` for Claude, `--disable hooks`
  for Codex — so an Orchestrator could `git worktree remove` a child's runner-created worktree
  unrefused, and since #1438 every Codex Orchestrator TUI open paid the inventory probe for an
  answer the flag had fixed. The alternative the report allowed, declaring the preset unguarded,
  was rejected because an Orchestrator is exactly the session that runs shell commands beside
  other sessions' worktrees, and the guard is the only thing between a mistaken removal and the
  loss of a child's work. What changed, each measured (see "Measurements … the Orchestrator
  preset" above):

  - **Claude.** The preset no longer passes a settings document of its own; `--setting-sources ""`
    alone keeps user, project, local, and plugin hooks out while the runner's document still
    runs. The resume strip (`stripOrchestratorLaunchArgs`) now keeps the runner-owned settings
    document, recognised by its self-description, because on a structured launch hook provisioning
    runs BEFORE the preset's arguments are rebuilt and the strip used to remove the guard's
    document along with the rest — so even the non-strict preset, which never carried
    `disableAllHooks`, was unguarded on structured spawns. The ACP form
    (`orchestratorAcpSessionMeta`) keeps `settings: { disableAllHooks: true }`: the guard has no ACP
    transport at all, so there is nothing for that setting to exclude, and an ACP Orchestrator
    stays unguarded like every other ACP launch.
  - **Codex.** The structured launch keeps `--disable hooks` — it carries no guard hook, its
    protection is driver-side, and nothing there needs hooks on. A Codex Orchestrator TUI drops
    the flag for its own argv only, enumerates the inventory, disables every enabled hook that is
    not the runner's by key for that invocation (`-c hooks.state={…}` in the inline-table spelling
    that works), enumerates again, and requires that NO other hook is enabled — trusted ones
    included, which the ordinary #1377 verdict admits and the preset's isolation does not. Only
    then does it carry the bypass. A launch that cannot prove it is opened exactly as the preset
    wrote it, `--disable hooks` and all, and is refused when there is a worktree to protect, by the
    unchanged #1337 rule. The probe is no longer paid for a fixed answer: with hooks on, its
    answer decides.
  - **The list.** A guard over the Orchestrator's OWN worktrees protects almost nothing, because
    an Orchestrator rarely owns one. Its descendants' worktrees are what it runs beside, and the
    runner has no record of descent: `parentSessionId` is control-plane-attributed and never sent
    to a runner. So an Orchestrator launch's list (`managedWorktreeGuardProtections`) is every
    runner-created worktree of every session on this runner — a superset of its descendants on
    this runner, never an attached operator worktree — and a change to ANY session's inventory
    refreshes every Orchestrator's list as well as that session's. The over-protection refuses
    nothing real: an Orchestrator retires worktrees through the control plane, never by hand. The
    same set feeds the driver's control-channel veto for an Orchestrator; the sandbox read-only
    derivation keeps the session's own set, because it is a list of mounts. Descendants on ANOTHER
    runner are not on this runner's filesystem and are not covered, which is the same limit every
    guard here has.
- One extra short-lived process runs before each Bash, Edit, MultiEdit, Write, NotebookEdit, Read,
  Grep, Glob, and — for Codex since #1437 — `apply_patch` call in a guarded session; since #1303,
  every guardable session.
- The runner's hook state directory is invisible to the provider: reading it is refused as firmly
  as writing it. Under runner `bwrap` and Seatbelt the refusal is the runner's own sandbox (#1336
  slice 1). In `provider` mode it is Codex's permission profile for a Codex launch (#1336 slice 2),
  and the command-text veto for a Claude one. The veto remains defence in depth wherever an OS
  boundary carries the directory, and the only control over READING it where none does.
- In `provider` mode on native Linux the directory no longer decides the guard's verdict (#1336
  slice 3): the list and Claude's settings documents live in runner memory, and the sidecar asks an
  abstract-namespace socket that a same-user process cannot take over. Any local user can query
  that socket for a verdict, and nothing else.
- There, the manager policy hook's credential, acknowledgement, and circuit live in runner memory
  too (#1472), and the sidecar relays each event over the same socket with a key from its spawn
  environment. Reading the directory yields no credential, and a circuit written into it is ignored.
- A Codex launch in `provider` mode sends a permission profile and NO legacy sandbox policy, because
  Codex silently ignores the profile when both are present. A launch migrates only when its own
  configured sandbox is exactly the plain built-in its profile extends, which each launch reads
  from Codex rather than assumes; `danger-full-access`, the Orchestrator preset, an ACP-bridged
  Codex, non-Linux and non-native launches, and any launch whose user configuration adjusts its
  sandbox keep their legacy policy and are documented as unenforced. Each launch then proves the
  deny through its own profile arguments, requiring a positive denial report, which is also what
  catches a codex-cli too old to know the keys — it would otherwise ignore them in silence.
- MCP servers run outside Codex's sandbox and still reach the directory, so #1336's MCP acceptance
  criterion is NOT met in `provider` mode and the issue stays open for it.
- Native hooks remain a cooperative same-user governance mechanism, not an OS isolation boundary,
  exactly as §2.3.1 already states.
