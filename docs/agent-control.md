# Agent Control CLI and MCP

Wollipog protocol v100 gives each native host session a purpose-specific control credential. The
runner sends only its SHA-256 digest to the control plane and waits for an exact positive
acknowledgement before the CLI or MCP server makes its first request. Stopping the session makes
the credential unusable; deleting it cascades the hash row and removes runner-local state.

The credential transport follows the runner's execution-isolation boundary:

| Execution path | Credential location and transport |
| --- | --- |
| Native host, `provider` isolation | **Runner memory only.** Provider-spawned CLI/MCP re-entries carry a random relay key and session-bound loopback endpoint. The runner pins the control-plane origin, supplies its memory-held bearer and exact-session actor header, and returns the response. The key is not accepted by the control plane. |
| Native host, `bwrap`, Seatbelt, or Windows Job isolation | Mode-0600 runner-state token and exact-hash acknowledgement files, passed by path to the re-entry. |
| Verified Direct WSL Orchestrator | The Windows runner owns and rotates the registered credential; the provider sees only the mode-0600 copy inside its private bwrap `/tmp`, through the attested target-local bridge described below. |
| Container, cloud, generic Direct WSL, and other non-host paths | Agent Control is not injected. |

Provider-mode provisioning removes any token or acknowledgement file left at the session paths
before launch. Reading, replacing, or deleting those paths therefore cannot reveal or select the
credential the runner registered. The opaque relay key intentionally reaches the same Agent
Control surface the CLI/MCP exposes; the control plane still enforces its closed method/route
allowlist. The key cannot authenticate a direct control-plane request or outlive the runner
listener. Launch and resume re-register the
memory-held credential behind a fresh positive-acknowledgement fence. A runner restart forgets it,
mints and registers a new credential during the next launch, and publishes a new relay endpoint.

The runner injects these non-transcript environment values at launch:

- `WOLLIPOG_CONTROL_PLANE_URL`: HTTP origin for the session's control plane.
- `WOLLIPOG_SESSION_ID`: the principal and ownership scope of every request.
- `WOLLIPOG_SESSION_TOKEN_FILE`: protected bearer source outside native provider mode; never pass
  its contents in argv.
- `WOLLIPOG_SESSION_CREDENTIAL_READY_FILE`: file-mode runner/control-plane registration fence.
- `WOLLIPOG_AGENT_CONTROL_RELAY_ENDPOINT`: native provider-mode, session-bound runner listener.
- `WOLLIPOG_AGENT_CONTROL_RELAY_KEY`: native provider-mode opaque relay authorization; it is not a
  control-plane credential.
- `WOLLIPOG_CLI`: standalone executable location.
- `WOLLIPOG_CLI_ARGS`: JSON-encoded re-entry arguments for development/non-SEA launches.

The standalone installer publishes the same verified SEA bytes as both `wollipog-runner` and
`wollipog` (`wollipog.exe` on Windows). The invocation name selects the user-facing CLI; no Node
runtime or second download is required. A paired-device client may instead set
`WOLLIPOG_CONTROL_PLANE_URL` plus `WOLLIPOG_TOKEN` or `WOLLIPOG_TOKEN_FILE`. Device calls remain
human-principal requests and do not send an agent-session claim header.

## Commands

```text
wollipog session list [--archived] --json
wollipog session get ID --json
wollipog session events ID [--after SEQ] [--limit COUNT] --json
wollipog session create --runner ID --agent ID (--workspace ID | --path PATH) [--prompt TEXT] [--model MODEL] [--effort EFFORT] [--cost-budget USD] [--max-tool-calls N] [--max-child-sessions N] --json
wollipog session prompt ID TEXT --json
wollipog session wait ID [--for STATE,...] [--timeout MS] [--interval MS] --json
wollipog session stop ID --json
wollipog session restart ID --json
wollipog session archive ID --json
wollipog session guardrails ID [--cost-budget USD] [--max-tool-calls N] [--max-child-sessions N] --json
wollipog worktree create [--session ID] --branch NAME [--base REF] --json
wollipog worktree attach [--session ID] --path PATH --json
wollipog worktree select [--session ID] --path PATH --json
wollipog worktree discard [--session ID] --path PATH --json
wollipog artifact attach --file PATH [--name NAME] [--session ID] --json
wollipog decision request --request-id ID --resource-key KEY --snapshot JSON --json
wollipog decision get OCCURRENCE_ID --json
wollipog decision consume OCCURRENCE_ID --snapshot JSON [--action JSON] --json
wollipog decision reconcile OCCURRENCE_ID --snapshot JSON --json
wollipog admin <pairing-url|status|user list|device list|device create|device revoke|runner-credential ...> [--json]
wollipog service <install|status|restart|logs|upgrade|uninstall> [options]
wollipog doctor
wollipog update
wollipog pair <create|list|revoke|url> [options]
wollipog help [doctor|update|pair|service|admin|session|worktree|artifact|decision]
```

`wollipog admin` is host administration for an SSH operator on the control-plane machine. It
authenticates with the control plane's protected local credential over loopback instead of a
session or device token and is documented in [host administration](./host-administration.md).
`wollipog service` manages the Linux systemd deployment; see [headless deployment](./headless-deployment.md).
The concise `doctor`, `update`, and `pair` commands delegate to `admin doctor`, `service upgrade`,
and the corresponding `admin device` or `admin pairing-url` commands. They preserve the canonical
validation, confirmation, secret-output, JSON, and exit-code behavior. Run `wollipog help` for a
workflow-oriented overview or `wollipog help <topic>` for complete topic commands and options.

An injected session defaults worktree commands to its own id and cannot override that target.
Paired-device callers may supply `--session`. A create without `--base` fetches and
resolves the remote default branch. Create, attach, and select return the selected absolute path;
the already-running provider process keeps its original operating-system cwd, so it must use the
returned path explicitly during that turn. A later resume or restart launches in the selection.
Discard is intentionally fail-closed: it removes only a runner-owned tree with a clean status and
no commits ahead of its configured upstream. An unchanged recorded branch without an upstream may
instead prove that its stable HEAD is contained by the current remote-tracking default branch. If a
provider still owns the path, the result reports a durable deferred retirement; the runner resumes
it automatically after provider exit. If a merged pull or merge request's remote
branch has already been deleted, its forge-verified head OID can replace the missing upstream proof
only when it exactly matches the local branch head. Attached, active, dirty, other upstream-less,
unpushed, branch-drifted, and Git-unavailable worktrees are retained. The runner applies the same
checks during startup and periodic reconciliation after a linked change request is definitively
merged or closed; an unavailable forge keeps the durable open linkage unchanged.

Discard is the only supported way to retire a runner-owned worktree. `git worktree remove` bypasses
every check above and leaves the session selecting a path that no longer exists, so agent cleanup
workflows must not use it for a session-linked path. Provider approval also refuses raw Git and
filesystem retirement aimed at runner-owned paths while ordinary work beneath those roots remains
available. A deferred worktree is reported with the provider boundary it is waiting for; that is a
durable retirement request, not a failed cleanup or an invitation to force-remove the path.

A session's own default worktree is also pinned to its `agent/<session-id>` branch, because that
branch is re-proved before every turn (below). The same guard refuses a Git command run inside it
that would switch, detach, or rename that branch — `git checkout -b`, `git switch -c`,
`git switch <other-branch>`, `git branch -m`, `git stash branch`, and `gh pr checkout` — and
points the agent to `wollipog worktree create --branch <name>` instead. Restoring files and
switching back to the session's own branch stay available, and a worktree the session created for
another branch is not pinned.

Because a worktree can still disappear outside Wollipog, every launch that carries a persisted
worktree re-proves it immediately before the provider process is created — start, resume, worktree
rebind, and queued app-server recovery alike, and on every execution target, since container
placements bind-mount that same host directory and cloud placements snapshot it. A conversation
fork re-proves the source worktree before constructing its temporary provider. The path must still
be registered with the session's repository, healthy, on the recorded branch, and inside the
permitted boundary. A worktree that is missing, unregistered, unhealthy, moved, or branch-drifted
fails that one session with a durable error naming the invalid path; the runner never substitutes
the primary workspace, and no worktree lease, provider-home lease, or provider process is taken
before the check runs. A launch refused this way retains the worktree rather than reaping it: a
tree whose identity the runner just declined to confirm may hold work the session never made.

A session row written before the runner recorded `worktreeBranch` has no stored identity, so these
checks derive one from the layout that named the worktree. Worktree reconciliation records that
identity on such a row once it can confirm the worktree still carries it — and deliberately records
nothing when it does not, because persisting a branch someone switched to would bless the drift and
retire the check that catches it.

Shells, the Native TUI, and the Files browser resolve the same selection and re-prove it the same
way before opening. They skip only the Project Locations boundary — the coordinate is the session's
own persisted selection, already located by the create or attach that stored it, and the boundary's
directory preparation has no business running on a read path a user triggers by opening a folder.
A session whose worktree is missing, unregistered, unhealthy, or branch-drifted therefore reports
the invalid path and the remedy instead of a bare filesystem error, and no shell or TUI process is
started in it.

These requests are interactive and overlap freely, so one positive proof stands for a couple of
seconds against the exact path and branch it proved. Any selection the runner makes changes what the
proof is keyed on and is therefore never answered from it; only a change made outside Wollipog waits
out that window, which is shorter than the gap between proving a root and using it. Failures are not
retained, so a repaired worktree is usable again on the next request.

Claude Code launches also receive an additive `wollipog` stdio MCP configuration. Both adapters
execute the existing manager tool table, including bounded output projection and `wait_session`, so
their schemas, self-targeting checks, and REST paths cannot drift.

Agent-created children do not receive invented cost or tool-call limits. Explicit creation values
take precedence over the parent Project's child defaults, and a finite parent's remaining ceiling
still bounds every child at creation. If none of those sources supplies a limit, the child remains
unlimited for that dimension; explicit zero also requests no limit when the parent is unbounded.
Creation results report the effective limits, including `null` for none. `maxChildSessions` defaults to four
concurrent live children and accepts zero through 64. New Orchestrator sessions expose and persist
that initial limit before their first turn. Session views report the effective limit, occupied live
slots, and remaining capacity. Completed, failed, stopped, and archived
children release live slots. A finite parent is charged each live child's full limits, and each
terminal child's actual cost and tool calls, including those of the child's own children; deleting
a child never reduces that charge, and
restarting a terminal child re-reserves its unspent limits. A refused creation reports the parent's
remaining allowance. Live cost/tool edits require delivery to an online current runner and fail closed rather
than leaving control-plane and runner thresholds out of sync.

`create_session` and `wollipog session create` accept an optional reasoning effort alongside the
model. The control plane validates the requested pair against the selected runner harness before
creating the session, and the same create request carries both values through governance approval,
persistence, and the initial provider launch. Explicit values take precedence over saved Agent
Harness defaults. Omitting effort preserves the existing default-resolution behavior, including
harnesses that expose no configurable effort. The creation result and `get_session` report the
effective model and effort so callers can verify what launched.

Explicit effort selection requires protocol v138 between the current CLI or MCP adapter and the
control plane. The adapter rejects an older control plane before creation and tells the caller to
update Wollipog or omit effort; it never retries without the value. Older clients do not expose
this option and must be upgraded before a caller can request it. Calls that omit effort remain
compatible with the protocol-v100 Agent Control creation contract.

Creating an Orchestrator as an authenticated human authorizes its ordinary child-session creation
within the audience, workspace access, runner capacity, concurrency, cost, tool-call, and
child-admission limits already attached to the session. Explicit applicable governance policies
retain precedence and may still ask or deny. The control plane derives eligibility from the
persisted Orchestrator configuration and its own creation-actor record; children, imported sessions,
and ambiguous legacy rows do not inherit or infer it from prompts, titles, or client claims. Existing
rows are upgraded only when their stored campaign-policy provenance establishes human creation.
This decision is control-plane-local, so mixed-version runners and clients continue through the same
spawn gate without a protocol fallback or broadened resource access.

## Orchestrator Role and Execution Policy

Protocol v144 separates the Orchestrator's coordination role from its execution boundary. New
sessions default to **Delegate Implementation** with `execution.strictProjectIsolation=false`.
The parent plans, assigns explicitly authorized child work, monitors progress, and reviews results;
an ordinary multi-issue request is not itself authorization to create a campaign or children. The
parent may maintain planning artifacts permitted by its provider policy and governance settings.

When a human explicitly asks the parent to implement, its launch instructions require it to inspect
child assignments and open pull requests for overlapping ownership, create and select its own
dedicated Wollipog worktree, and use the repository's normal testing, cross-model review, UI
evidence, merge, and cleanup workflow. The exact-session credential can request that self-worktree
only when the control plane's immutable campaign snapshot says strict isolation is disabled. No MCP
argument or session configuration mutation can change that snapshot.

**Strict Project Isolation** remains a human-controlled default for newly created sessions. It keeps
the previous session-private scratch directory, project-write refusal, restricted launch tools, and
host-boundary requirements. Legacy policy snapshots that lack the execution field normalize to
strict mode, so an upgrade never silently broadens an existing session. The Settings and creation
interfaces distinguish provider permission controls from OS-enforced read-only filesystem
isolation. Provider-mode native Claude Code requires interactive Default approval support. Strict
structured Claude also uses that runner control channel inside `bwrap` on Linux or Seatbelt on
macOS: routine coordination is auto-authorized by the shared semantic contract, and everything else
is denied. In provider mode, a routine-looking command that is not in canonical safe form is denied
back to the agent with retry guidance instead of producing a human approval card; genuine mutations
and unknown operations retain the normal provider approval path. Existing human-created root
campaigns recover missing issue scope from their immutable initial request on restart. Native TUI
and ACP launches without the channel retain `dontAsk`. Provider permission
checks, Parent Control, typed workflow decisions, authentication exclusions, child admission,
resource limits, and audit provenance are unchanged. The full operation and campaign issue-scope
contract is recorded in [ADR 0007](adr/0007-separate-orchestrator-role-from-project-isolation.md).

## Managed Worktree Administrative Paths

A runner-owned session worktree is protected against provider commands that remove or unregister it,
but that protection lives at the command-approval boundary and cannot see a write a script or tool
performs at runtime. The worktree's `.git` link file is the one path inside an otherwise writable
worktree where a single stray write is unrecoverable: Git reads it to locate the real administrative
directory, so a damaged link breaks every later Git operation and the session's pre-launch
verification while the worktree root and its repository registration both survive.

Sandbox modes that can express a per-path rule therefore present that link read-only to the provider
and leave the rest of the worktree writable. Git never rewrites the link, so ordinary edits, staging,
commits, branch switches, and test runs are unaffected. The repository's own `.git` directory is
deliberately **not** covered — every worktree's real administrative directory lives inside it, and
freezing it would break the commits this rule exists to keep working. Attached operator worktrees
contribute no rule at all: only runner-created identities are managed.

| Isolation mode | Enforces the read-only rule | Why |
| --- | --- | --- |
| `bwrap` (native Linux) | Yes | The link is bind-mounted read-only over itself after every writable bind, so writes fail with `EROFS` and delete or rename with `EBUSY`. |
| `seatbelt` (native macOS) | Yes | The profile denies `file-write*` on the link after the `allow` that grants the containing worktree; Seatbelt takes the last matching rule. |
| `bwrap` in Direct WSL | No | The target-local launcher attests only directories as bind sources, so a link **file** cannot be bound. Raising that needs a new attested launcher protocol version. |
| `windows-job` | No | Job Objects manage a process tree. They do not restrict filesystem access at all. |
| `container` execution targets | No | The workspace is one read-write bind into the image; the rule is not expressed per path today. |
| `cloud` execution targets | No | The filesystem boundary belongs to the remote adapter, not to this runner. |
| `provider` | No | There is no runner-owned boundary; the provider's own sandbox decides, and none of the supported providers expose a per-path exclusion inside a writable root. |

On a non-enforcing mode the behavior is exactly what it was before this rule existed. Nothing is
newly permitted anywhere: the rule only ever removes provider write access to one runner-owned path.

**The rule is bound at launch, like every other filesystem boundary here.** A `bwrap` or Seatbelt
sandbox is constructed when the provider starts, so the read-only entries are the ones that exist
then. A worktree the provider requests *during* a turn is created inside the session's
requested-worktree boundary, which is already writable, and a worktree switch schedules a relaunch
rather than rebinding a live sandbox — so that new worktree's link is writable until the relaunch,
exactly as the **Attach** notice already reports for the worktree root itself. This is the same
same-turn window the command-approval boundary has, tracked separately; closing it means retiring
the provider at creation time, not changing the sandbox rule.

## Runner Hook State at the Sandbox Boundary

> **Two separate rules, by execution isolation mode.** Where the runner sandboxes its providers
> (`executionIsolation.mode` of `bwrap` or `seatbelt`), the runner's own sandbox hides the directory
> from every provider. In the default `provider` mode the runner sandboxes nothing, and **no
> provider has an OS boundary there today**: the directory stays readable and writable to anything
> running as the runner's user. Codex's own permission profile can deny it — the machinery to do so
> ships and is proven per launch — but on codex-cli 0.155.1 a `deny` entry also disables every
> APPROVED network escalation, so no launch selects one (#1464). See "Codex in `provider` Mode". What changed there (#1336 slice 3, native Linux only) is that **nothing in
> the directory decides the guard's verdict any more** — see "The Guard's Verdict in `provider`
> Mode" — and, since #1472, that **it holds no manager policy hook credential and no circuit the
> runner honours** — see "The Manager Policy Hook in `provider` Mode". Reading it is still possible,
> so issue #1336 stays open for Claude in `provider` mode and for MCP servers under every provider.
> The veto and its history are in [ADR 0012](adr/0012-managed-worktree-guard-hook.md).

The managed-worktree guard keeps its protection list in the runner's hook state directory
(`<data dir>/hooks/<runner key>`), and the provider runs as the same OS user as the runner. A veto on
tool calls cannot see indirection: a script, an interpreter, a command held in a variable, a
recursive walk started from an ancestor directory, or an MCP filesystem tool. So a runner-owned
sandbox hides the directory from the provider **and from everything it spawns**, including its
tools, its MCP servers, and the guard sidecar itself:

- **`bwrap`** mounts an empty tmpfs over the directory, after every other bind, and remounts it
  read-only. It then binds back, read-only, only the session's own settings documents (Claude reads
  them at start) and the session's own verdict-socket directory. Reads get `ENOENT`, walks from an
  ancestor see an empty directory, and writes get `EROFS`. This includes `git clean -dfx` run from a
  repository that contains the data directory.
- **Seatbelt** denies `file-read*` and `file-write*` on the directory. The deny comes after the
  allow that makes the data directory writable, and Seatbelt takes the last matching rule. It then
  re-allows reading those same entries, plus an outbound connection to the session's socket when the
  network is denied. It also grants back the session's manager policy hook state (see the known
  limits below).

The guard sidecar can no longer read its list, so a guarded launch in these modes carries
`--guard-socket`. The sidecar sends the hook payload to a per-session Unix socket that the runner
serves from outside the sandbox. The runner judges it with the same function a file-mode sidecar
runs, against the list of the session that owns the socket:

- **One socket per session.** Each socket sits in an owner-only directory. A request carries no
  session identity, so a caller cannot name another session's list, and the sandbox binds only that
  session's socket directory back into view.
- **The sidecar never falls back to the file.** A missing socket, a refused or reset connection, a
  30-second timeout, or a malformed answer all exit 2, which blocks the tool call.
- **No socket means no guard.** If the socket cannot be established (for example, its path would not
  fit in `sun_path`), the launch gets no guard and the driver mediates the permission mode. A
  file-mode guard would refuse every matched tool call instead.
- **The launch proves the guard from inside its own sandbox.** Before the provider starts, the
  runner runs the real sidecar through the launch's exact sandbox wrapper. The probe payload names
  the session's own protections file, which the guard refuses only after loading the list. If the
  mask would hide the socket or stop the sidecar starting, the **launch fails** with the reason. It
  never starts a provider whose every matched tool call would be refused.

| Launch | Hook state directory hidden | How the guard gets its verdict | Verified by |
| --- | --- | --- | --- |
| Runner `bwrap`, native Linux | Yes: reads, enumeration, writes, `git clean` | Verdict socket | Real-kernel test in the Platform Isolation Ubuntu job (`managed-worktree-guard-sandbox.integration.test.ts`) |
| Runner `seatbelt`, native macOS | Yes: reads, enumeration, writes | Verdict socket | **macOS CI only** (`managed-worktree-guard-seatbelt.integration.test.ts`), not verified on a developer machine |
| Runner `provider` (the default), Codex structured launch | **No** at the OS level: the permission-profile deny works but costs every approved network escalation, so it is withheld (see below). The `PreToolUse` guard hook IS carried since #1499, which vetoes a command targeting a managed worktree whoever reviews the approval | The guard hook, trusted by hash and proven from the launch's own inventory; the driver's structured protection remains as a second layer | `codex-permission-profile*.test.ts` and `codex-guard-reviewer.test.ts`, over behaviour measured by `pnpm probe:codex-escalation` and `pnpm probe:codex-guard-hook` |
| Runner `provider` (the default), Claude, native Linux | **No.** Readable and writable by the runner's OS user | **Runner memory, over an abstract verdict socket; the settings document is passed inline.** No file in the directory is consulted | `hook-settings.test.ts`, `managed-worktree-guard-socket.test.ts`, and a real claude 2.1.278 run (see below) |
| Runner `provider`, Claude, macOS and Windows | **No** | Protections file plus file-form settings. Before every spawn the runner compares the live, heal-template, and guard-only documents with the exact set it provisioned; any changed copy drops the settings argument and restores driver mediation | `hook-settings.test.ts` and `claude-code-managed-worktree.test.ts`; measured with the same file form against real claude 2.1.278 on Linux. The identity check is platform-independent, so the ordinary macOS runner tests cover the same branch |
| Direct WSL `bwrap` | No | No guard (WSL hook paths are not translated) | Unchanged |
| `windows-job` | No: Job Objects do not restrict the filesystem | Protections file, unchanged | Unchanged |
| `container` and `cloud` targets | Not reachable: the hook state directory is not in the workspace bind or snapshot | No guard (not provisioned there) | Unchanged |
| Native TUI launches | Not by the runner, which does not sandbox a TUI. A native **Codex** TUI could deny it through Codex's own permission profile, but that is withheld on codex-cli 0.155.1 (see "Codex in `provider` Mode"); neither a Codex nor a Claude TUI denies it today. A Codex TUI does carry the `PreToolUse` guard hook (#1377), now trusted by hash and proven from the inventory rather than by passing a flag (#1499) | In `provider` mode on native Linux, Claude and Codex alike: runner memory over the abstract verdict socket. Elsewhere the protections file, or the session's path socket when a sandboxed launch already provisioned one. Claude ordinarily re-provisions its file-form set before a TUI spawn; any mismatch detected afterward refuses a TUI whose session owns a managed worktree instead of opening it unguarded | `agent-tui-memory-guard.test.ts` and `agent-tui-managed-worktree.test.ts` (real provisioning, real socket/sidecar entry points), and a real Claude TUI under a pty. Codex deny: `agent-tui-codex-permission-profile.test.ts` |

What the providers' own sandboxes can do in `provider` mode was measured (Linux, Claude Code 2.1.278,
codex-cli 0.155.1). Neither is used by this rule today:

- **Claude Code's sandbox** covers only Bash and the processes it starts. Hooks and MCP servers run
  outside it. It needs `bubblewrap` and `socat`; without them it warns and runs commands
  **unsandboxed** unless `sandbox.failIfUnavailable` is set. Enabling it also confines writes to the
  working directory and puts the network behind a domain allowlist for every session.
- **Codex's sandbox** enforces a `deny` entry in a named permission profile at the OS level, for
  reads, walks from an ancestor, writes, and renames. Hooks and MCP servers run outside it. #1464
  used this in `provider` mode; it is withheld again because the same `deny` entry disables every
  approved network escalation — see "Codex in `provider` Mode" below.

  An earlier version of this page said Codex *refuses* to combine the legacy
  `sandbox_mode`/`sandboxPolicy` with a permission profile. **That was wrong.** Re-measured on
  codex-cli 0.155.1: Codex accepts both and silently ignores the profile. `codex exec -s
  workspace-write` read a denied file at exit 0 while the profile was the configured default, and
  the app-server behaved the same way for every `sandboxPolicy` shape. A silent fail-open, not a
  loud refusal — which is why the runner never sends both, and proves the deny before each launch
  rather than trusting that the configuration was accepted.

Known limits of the runner-sandboxed form:

- **A stalled runner delays verdicts.** The verdict is served by the runner's main event loop, so a
  long synchronous operation there (the guard's own host-side self-test is one, typically about a
  second) delays every guarded tool call behind it. A stall longer than 30 seconds refuses the call;
  it never passes it.
- **Manager policy hooks keep their own state under Seatbelt only.** The manager policy hook is
  also a re-entry the provider spawns. It reads its credential and acknowledgement and rewrites its
  circuit file on every call, all inside the hidden directory. Seatbelt grants exactly those paths
  back (the circuit, its lock, and the circuit's atomic-write temporaries), so the hook keeps
  working, while the protection list and every other session's files stay hidden. That grants
  nothing new: before this rule the whole directory was readable and writable there. `bwrap` cannot
  grant a write inside its read-only data root. There, the manager hook already failed closed on
  every call before this change, because its circuit write failed, and it still does. That is a
  pre-existing limit, not something the mask introduces.
- **The mask is bound at launch.** Like every other filesystem boundary here, it covers the entries
  that exist when the provider starts. The hook state directory is created before the sandbox is
  built, so nothing written into it later becomes visible.

### The Guard's Verdict in `provider` Mode

In `provider` mode nothing stands between the hook state directory and a process running as the
runner's OS user: an MCP filesystem server, an interpreter under Claude, or a Codex launch that
keeps its legacy policy. Until #1336 slice 3 that directory was also the **authority** for the
guard. Two things in it decided whether a protected worktree could be removed:

- **The protections list.** Rewriting it removed a protection for every later tool call. The digest
  tripwire noticed only at the next spawn or refresh.
- **Claude's settings document.** Measured with the runner's own functions: with the hook `command`
  rewritten to `/bin/true` in the live file, the heal template, and the guard-only copy, and the
  arguments left alone, `prepareClaudeHookArgs` still reported `guardActive: true`. The
  self-description reads the arguments, never the command, and **no tripwire ever covered these
  documents**. The next Claude spawn ran with a no-op hook and with mediation switched off.

On a native Linux host launch in `provider` mode, neither is an authority now:

- **The list lives in runner memory.** Provisioning and the live refresh write a map in the runner
  process. No protections file is written for such a session, and one planted there is never read.
- **The verdict comes over an abstract-namespace Unix socket.** The hook command carries
  `--guard-socket @wollipog-guard-<name>`, and the sidecar sends the hook payload **and its own
  environment** to the runner, which judges with the same decision function the file form runs.
  Slice 1's path socket was not reused, because it does not hold here. Measured: a second process
  of the same OS user unlinked the `0600` socket inside its `0700` directory, bound its own listener
  at the same path, and the sidecar's next request got the forged answer. Under `bwrap` and
  Seatbelt the sandbox binds that directory read-only, so the path form is sound there and is
  unchanged. An abstract name has no filesystem entry to unlink, and a second bind while the runner
  listens failed with `EADDRINUSE`. The name carries 192 random bits, is generated once per session
  per runner process, and is never logged or written to disk.
- **Claude gets its settings document inline.** The persisted launch arguments still name the
  settings path, which keeps every path-keyed mechanism working. For the spawn itself,
  `prepareClaudeHookArgs` replaces that path with the document the runner holds in memory
  (`--settings <json>`, measured on claude 2.1.278: the hook ran and exit 2 blocked the call). Claude
  therefore opens no file in the hook state directory, and nothing written there changes the hook
  command it runs. The files still written there are the same documents **without** the socket:
  if one were ever launched, its guard would find no list and refuse every matched call. Codex's
  hook command was already argv-only (`-c hooks.PreToolUse=…`).
- **Every failure to reach a verdict exits 2.** A closed socket (`ECONNREFUSED`, measured against a
  real Claude run: `echo` was blocked), a timeout, an oversized or malformed answer, a request that
  is not the sidecar's envelope, or a session for which the runner holds no list. The sidecar never
  falls back to a file.
- **The socket is proven before it is relied on.** Once per address, the runner runs the real
  sidecar against the real socket with a payload the guard refuses only after loading the session's
  list. If that fails, or the socket cannot be created, the launch keeps the file form exactly as it
  was before this slice, and the runner log says so.

Measured against the real CLIs with the runner's own provisioning (claude 2.1.278, codex-cli
0.155.1, a throwaway repository and worktree). Before the Claude run, every document on disk had its
hook command rewritten to `/bin/true` and an allow-everything list was planted:

- Claude `-p` in `bypassPermissions`: `git worktree remove --force <worktree>` was refused with the
  managed-worktree refusal, at the top level **and from a subagent**; `git status` and the
  subagent's `echo` ran; the worktree was still there afterwards.
- A real interactive Claude TUI under a pty, with the argv `prepareAgentTuiLaunch` builds: it
  started with no settings error, ran the `PreToolUse` hook, showed the refusal, and left the
  worktree in place.
- `codex exec` with the arguments `provisionCodexGuard` builds: the removal was refused
  (`Command blocked by PreToolUse hook`), `git status` ran, and the hook state directory stayed
  **empty**.
- A user's own settings combine exactly as they did with a file. Run both ways, a project
  `.claude/settings.json` hook and the runner's hook both fired, and a hook from an earlier
  `--settings` argument did not: Claude applies only the last `--settings`, inline or not. The #1303
  rule that leaves a user-supplied `--settings` unshadowed while the session owns no worktree is
  unchanged.

What this does **not** deliver, stated plainly:

- **It is not an OS boundary.** The #1336 criteria about reads failing at the OS level, walks from
  an ancestor, `git clean -dfx`, and MCP filesystem tools are still **not met** for Claude in
  `provider` mode. The directory can be read, enumerated, and deleted. Deleting it no longer
  disarms or blocks a memory-held guard; it still disturbs the manager policy hook, below.
- **Any local user can ask for a verdict.** An abstract socket has no permission bits, and its name
  is listed in `/proc/net/unix`. A caller that connects learns deny or allow for a payload it
  supplies, which is to say which paths are that session's managed worktrees. The protocol has no
  request that changes anything, and a request names no session, so a socket answers only for the
  session it was created for. A process of the runner's own user can query every session's socket;
  that cannot be prevented against the same UID, and it is no more than reading the list file gave.
- **The name is visible in the provider's own argv and errors.** It is in the inline document, so in
  `/proc/<pid>/cmdline` of that session's provider. On an exit-2 refusal Claude itself prints the
  whole hook command, name included, into the error the model reads, and so into that session's own
  timeline. The sidecar's own message does not repeat it. Both disclose nothing beyond
  `/proc/net/unix`.
- **The manager policy hook kept its state there until #1472.** See "The Manager Policy Hook in
  `provider` Mode" below for what a native Linux launch does now. On macOS and Windows its
  credential, acknowledgement, and circuit files are still read and rewritten by a provider-spawned
  re-entry: a reader gets that credential, and a writer can open the circuit, which drops the
  manager hooks for the next spawn.
- **Not the runner itself.** A process of the same OS user can still kill the runner (every verdict
  then refuses), rewrite the runner's own code on disk, or remove the worktree directly. None of
  that is new, and no file-level design can close it; only an OS boundary or a separate user can.
- **macOS, Windows, WSL, container, and cloud launches are unchanged.** There is no abstract socket
  namespace outside Linux, and the file form with its list tripwire remains. The settings documents
  there are still untripwired.
- **An inline document must fit one argv string.** Linux caps a single argument at 128 KiB; the
  documents are about 1 to 4 KiB. One above 96 KiB is not launched, and the driver mediates.

### The Manager Policy Hook in `provider` Mode

The manager policy hook (`WOLLIPOG_CLAUDE_HOOKS=1`) is a sidecar the provider starts for every
`PreToolUse`, `PostToolUse`, and `UserPromptSubmit`. In its file form it reads a bearer **token**
and the **ready** file that says the control plane acknowledged it, and it reads and rewrites a
**circuit** under a **lock**: three consecutive transport failures open the circuit, after which
the sidecar stops denying and the next spawn drops the manager hooks, so an unreachable control
plane does not brick the session. All four files sit in the hook state directory. In `provider`
mode the provider can read and write them, so a reader had the credential and a writer could drop
the manager hooks for the next spawn, with nothing saying why (#1472).

A sidecar the provider starts cannot read a credential the provider cannot, so on a native Linux
host launch the runner does not sandbox, **the sidecar holds nothing and the runner relays**:

- **The credential, acknowledgement, and circuit are in runner memory.** No token, ready, circuit,
  or lock file is written; ones left by an earlier file-form launch are removed; ones planted later
  are never read, by the runner or by the sidecar.
- **The sidecar hands the event to the session's abstract verdict socket**, the same one the guard
  asks. The runner runs the same evaluation the file-form sidecar runs, makes the control-plane
  request with the credential it holds, and returns the hook response for the sidecar to print.
- **A relay request carries a key from the spawn environment.** A relayed event reaches the control
  plane, unlike a guard verdict, and an abstract socket has no permission bits. The key (256 random
  bits, per session per runner process) is in the provider's environment, which is owner-only in
  `/proc`, and never in its argv, which is world-readable. A request without it gets the
  fail-closed response and reaches neither the control plane nor the circuit.
- **A circuit file written by the provider is ignored.** Only the runner's own circuit chooses
  between the combined settings document and the guard-only one. When the runner opens it, the next
  spawn reports it through the existing policy-transport notice.
- **No answer is the existing fail-closed response.** `PreToolUse` denies; the other two events do
  not block. The sidecar never falls back to a file. An approval that parks for a human holds its
  connection open without a deadline; a sidecar that goes away ends the runner's polling for it.

| Launch | Manager hook credential and circuit | Verified by |
| --- | --- | --- |
| Runner `provider`, Claude, native Linux | **Runner memory, relayed over the abstract socket.** Nothing in the hook state directory is a credential, and a circuit written there is ignored | `policy-hook-relay.test.ts` (real provisioning, real socket, real sidecar entry point), and a real claude 2.1.278 run |
| Runner `seatbelt`, native macOS | Files, granted back through the mask's `managerTransport` rules (#1447), unchanged | **macOS CI only** (`managed-worktree-guard-seatbelt.integration.test.ts`) |
| Runner `bwrap`, native Linux | Files, unchanged. `bwrap` cannot grant the circuit write, so the hook fails closed on every call, as it did before (see the known limits above) | Unchanged |
| Runner `provider`, Claude, macOS and Windows | Files, unchanged: readable and writable by the provider | Existing `policy-hook.test.ts` and `hook-settings.test.ts` |
| A launch whose abstract socket could not be created or proven | Files, as before, and the runner log says the guard reads its file | `policy-hook-relay.test.ts` |
| WSL, container, and cloud launches | No manager hooks (not provisioned there) | Unchanged |

Measured with the runner's own provisioning, the real socket and sidecar, a stand-in control plane,
and claude 2.1.278 in `bypassPermissions`: all three events arrived with the runner-held bearer, a
policy deny blocked the tool call, and the hook state directory held only the three settings
documents before and after. With an open circuit and a token planted there first, the run was
identical.

What this does **not** deliver:

- **The provider can still use the hook it starts.** A process of the runner's OS user that reads
  the key from its environment can submit hook events for that session, and enough rejected ones
  open the circuit. That is what the token allowed, without the token, and an opened circuit is now
  always announced at the next spawn. The key is in the environment of every process the provider
  starts, MCP servers included.
- **It is not an OS boundary**, like everything else in `provider` mode.
- **A runner restart forgets the credential and the circuit.** A provider that outlived it is denied
  on every `PreToolUse` until its next spawn provisions afresh, as with the guard's verdicts.

### Codex in `provider` Mode

Where the runner sandboxes nothing, a Codex launch **can** deny the hook state directory through
Codex's own sandbox: a named permission profile carries one `deny` entry for the directory, and the
launch sends **no legacy sandbox policy at all**, because Codex silently ignores a profile whenever
a policy is also present.

> **Withheld on codex-cli 0.155.1.** A `deny` entry also disables approved sandbox
> escalation's network access. Measured with `pnpm probe:codex-escalation`: with the profile
> active, a `sandbox_permissions: "require_escalated"` command approved by the user ("Allow Once"
> and "Allow for Session" alike) or by Codex's own Guardian under `auto-review` still ran without
> the network, while the identical turn on the legacy `sandboxPolicy` reached it. Codex keeps the
> escalated command sandboxed so the deny stays enforced, and that retained sandbox has no network;
> the approval buys the filesystem escape and not the network, reporting nothing. `gh`, `git fetch`
> and every other approved network command then fails as though it had never been approved.
>
> Granting network in the profile is not a repair: `network = { enabled = true }` gives the network
> to ordinary sandboxed commands too, and sending the legacy policy alongside it takes the network
> back from the escalation as well. So the deny and an approved network escalation are mutually
> exclusive on this build, and the escalation wins. Every mode that could migrate can reach an
> approval, so **no launch migrates**; each keeps the legacy policy it had before #1336 slice 2,
> and spawns no proof. Everything below describes machinery that stays in place, tested, for a
> codex-cli whose escalation survives a deny — re-measure with the probe before re-enabling it.

- **The mode is unchanged, and each launch proves it.** With nothing in the user's Codex
  configuration adjusting the sandbox, the legacy policies the runner sends ARE the built-in
  profiles: `thread/start` projects `:read-only` to `{readOnly}` and `:workspace` to
  `{workspaceWrite}` with every field at its default, and a deny entry does not move that
  projection. But a user's `[sandbox_workspace_write]` settings (network access, extra writable
  roots, tmp exclusions) are honoured by the legacy launch — measured under `-s workspace-write`,
  under the app-server's explicit `sandboxPolicy`, and under Codex's implicit default — and NOT by a
  profile extending the built-in. So before each launch migrates, the runner asks a throwaway
  `codex app-server`, started with that launch's own arguments, environment, and working directory,
  which sandbox the launch resolves (an ephemeral thread, no turn, nothing reaches a model). It
  migrates only when that is exactly the plain built-in; otherwise it keeps its legacy policy.
- **Managed linked worktrees keep an explicit policy.** An App Server turn whose cwd is the
  session's runner-created linked worktree adds only the canonical linked-worktree admin directory
  and the common `objects`, `refs`, and `logs` descendants as writable roots. Codex automatically
  makes the `.git` pointer and its resolved target read-only; the exact admin-directory root
  reopens ordinary staging, commits, status, and branch operations beneath that carveout while the
  pointer stays protected. The common `.git` root, the primary checkout, and unrelated host paths
  are never granted. Runner-owned filesystem isolation re-applies read-only mounts to the static
  linked-worktree registration files `gitdir`, `commondir`, and an existing `config.worktree`
  beneath that writable admin directory. Without the outer filesystem boundary, the managed
  `PreToolUse` guard refuses direct command-text writes, removals, renames, and replacements under
  the repository's worktree registry. That has the guard's existing same-user, command-text
  strength: runtime indirection still requires the runner-owned filesystem layer. Because these are
  non-default roots, such a turn does not ride on a plain built-in permission profile.
- **A launch that never sent a legacy mode is compared with Codex's own default.** A native TUI and
  a resumed `codex exec` turn have always passed no `-s`, so they ran under whatever the user's Codex
  configuration selects — not the session's structured mode. They migrate only when that default is
  the plain `:workspace` built-in, and then as `:workspace`, so a `read-only` session's TUI keeps the
  write access it has always had.
- **The profile is argv-only.** Both keys travel as one `-c` each
  (`permissions.wollipog-runner-guard={extends=…,filesystem={"<dir>"="deny"}}` and
  `default_permissions="wollipog-runner-guard"`), placed last because the last override of a dotted
  path wins. Nothing is written into the user's `config.toml`.
- **Each launch proves the deny first.** Before the provider starts, the runner writes a marker file
  into the hook state directory and reads it back with `/bin/sh` and `cat` through `codex sandbox
  -P`, with the launch's exact profile arguments and the provider's own environment. Only a
  **positive denial report** from inside the sandbox counts. An exit code cannot tell a denial from
  a CLI that never ran the probe: a genuine deny exits 1, and a build predating permission profiles
  exits 1 or 2 with an argument error. Such a build silently ignores the unknown keys, so this probe
  — not a version string — is what catches a mixed-version host. A launch that cannot prove the
  deny keeps its legacy policy; it never runs claiming an enforcement it does not have.
- **Proofs are asynchronous, shared, and short-lived.** Neither probe blocks the runner's event
  loop, and concurrent launches share one proof while it runs. A proof is keyed on the executable's
  resolved file (so a replaced binary is proven again), the launch arguments, the working directory,
  `CODEX_HOME`, `HOME`, and `PATH`, and it expires after five minutes either way, because the user's
  Codex configuration can change under a running runner.
- **Only native Linux host launches.** Only Linux was measured. A WSL, container, cloud, or
  runner-sandboxed launch runs a different binary on a different filesystem, where a host-side proof
  would say nothing, so it keeps its legacy policy. macOS and Windows keep theirs too until measured.

The table below is the shape a build without the escalation cost would get. On codex-cli 0.155.1
every row reads **No**, because the escalation gate refuses them all.

| Codex launch in `provider` mode | Hook state directory denied |
| --- | --- |
| `auto-review` (the default), `on-request`, `untrusted`, `on-failure`, `workspace-write` | Withheld. Otherwise: through `:workspace`, when the launch's configured sandbox is the plain built-in |
| `read-only` | Withheld. Otherwise: through `:read-only`, on the same condition |
| A launch whose own Codex configuration adjusts its sandbox (`[sandbox_workspace_write]`, a selected `default_permissions` profile) | **No.** A profile would drop those settings, so the launch keeps its legacy policy |
| An App Server turn in a runner-managed linked worktree | **No.** Its operation-specific Git metadata roots require an explicit legacy policy |
| `danger-full-access` | **No.** It has no sandbox, and `:danger-full-access` cannot be extended. Narrowed to `on-request` while a managed worktree is live, and then it is denied |
| Orchestrator preset | **No.** Its policy has non-default writable roots that no projection reads back, so equivalence cannot be asserted |
| Native Codex TUI, and a resumed `codex exec` turn | Withheld: Codex's own default is approval-capable too. Otherwise: through `:workspace`, when that default is the plain `:workspace` built-in. Neither ever passed `-s` |
| Any launch that is not native Linux on the runner host | **No.** Nothing proves the deny there |
| Generic `acp` driver (an ACP-bridged Codex) | **No.** It spawns the catalog's command and arguments verbatim and injects no `-c` |
| A launch whose own arguments carry `-s`/`--sandbox` (in any spelling, including `-svalue`, `-s=value`, and `--sandbox=value`) or `--dangerously-bypass-approvals-and-sandbox` | **No.** Those defeat a profile, so the launch is left on its legacy policy rather than having the user's flag stripped |
| A launch whose own arguments carry `-C`/`--cd`, `--remote`, or `--worktree` | **No.** They move where configuration resolves, or run the session elsewhere, so the proof cannot read the right configuration |

### Who Reviews an Escalation in a Structured Codex Session

`auto-review` routes escalations to Codex's own Guardian. Until #1499 the runner overrode that to
`user` whenever the session owned a runner-created worktree — which is every issue-workflow session
— so the default mode silently became manual review in exactly the sessions doing the most work.

That override was load-bearing rather than cautious. Guardian cannot know which host paths belong
to the runner lifecycle, so the request was routed to the driver, where `commandTargetsManagedWorktree`
could veto a command targeting a managed worktree before any grant was returned. For a structured
Codex session that veto was the ONLY managed-worktree protection: a Claude session carries the
`PreToolUse` guard hook, a Codex TUI has carried it since #1377, and a structured Codex launch
carried none.

It now carries one. With the guard proven for the launch, the veto runs at the tool-call boundary
whoever reviews — measured, a protected command is denied before the approval is even raised, under
a client `accept` and under `approvalsReviewer: "auto_review"` alike — so Guardian owns the review
again and the driver-side veto becomes a second layer instead of the only one.

- **The relaxation is gated on proof, not on intent.** `codexGuardActiveInArgs` re-derives the
  answer from the argv each spawn uses, and requires both the hook override and the trust override.
  A launch that cannot prove the guard keeps routing escalations to the human, which is the
  pre-#1499 behaviour rather than a new failure mode.
- **Trust is by hash, because the flag does not work here.** `--dangerously-bypass-hook-trust`
  carries a TUI and `codex exec`; on `codex app-server` it does nothing at all, and the hook is
  skipped silently. The runner reads Codex's own `currentHash` from the launch's inventory, trusts
  by it, and reads the inventory back to confirm `trustStatus: trusted`.
- **A failed provisioning is not a refusal.** Unlike a TUI, a structured session still has the
  driver's approval-time veto, so it launches with escalations routed to the human and the runner
  logs why.

Known limits of the `provider`-mode form:

- **It is not in force at all on codex-cli 0.155.1.** See the callout above. `provider` mode is
  back to the command-text veto for Codex as well as Claude, and #1336 stays open for both.
- **MCP servers still reach it.** A configured stdio MCP server read the denied file at startup, so
  a user-configured filesystem server with a root above the hook directory is unaffected. This is
  the one #1336 acceptance criterion the mechanism does **not** meet, and #1336 stays open for it.
- **The guard hook is unaffected, by design.** Codex hooks run outside the sandbox: in a single run
  the model's own shell call reached the directory indirectly through a script and got
  `Permission denied`, while the `PreToolUse` hook process read its protection list normally. So the
  sidecar did not NEED a verdict socket here. A Codex TUI on native Linux now asks the abstract
  socket anyway (see "The Guard's Verdict in `provider` Mode"), because the deny does not cover the
  unenforced launches in the table above, MCP servers, or anything else outside Codex's sandbox.
- **Codex tells the model the path is denied.** Asked directly, it declines before issuing any tool
  call, naming the directory. Indirection through a script still runs and still hits the OS deny.
- **The app-server binds one base per process.** A profile is selected by configuration and
  `turn/start` carries no per-turn selection, so the base is fixed when the app-server starts. A
  turn whose mode that base does not express (a mid-session switch between `read-only` and the
  workspace modes, or to an unmigrated mode) sends its legacy policy instead, exactly as before this
  change. Because `sandboxPolicy` applies to a thread's remaining turns, a thread that has received
  one keeps receiving its legacy policy — even after switching back — until a new thread starts; it
  never drops back to profile-only while an old policy is still in force. A thread resumed in a
  fresh app-server is not affected: measured, `thread/resume` there reports the configured profile,
  not a policy an earlier process had sent.
- **A `-c sandbox_mode=…` override does not defeat the profile.** Measured in the separated and the
  attached spelling and in `config.toml`: the deny held, because `default_permissions` outranks the
  legacy key. Only the `-s`/`--sandbox` flag and `--dangerously-bypass-approvals-and-sandbox` do,
  and a launch carrying either keeps its legacy policy.
- **The projection is what equivalence rests on.** Everything Codex reports for a launch's sandbox
  is compared. A setting that changes enforcement without appearing in that report would not be
  caught; the legacy `sandbox_permissions` key is one that does not appear, and whether 0.155.1
  still honours it was not measured.
- **Claude in `provider` mode has no OS boundary.** Claude's own sandbox covers Bash only, needs
  `socat`, and would confine writes and network for every session, so it is not used. The
  command-text veto remains the only control over READING the directory; what the directory no
  longer does, on native Linux, is decide the guard's verdict.

## Typed Parent Control Decisions

An Orchestrator that cannot continue without a human response must create a structured blocking
request: `request_user_input` in Codex or `AskUserQuestion` in Claude. Writing the question only in
prose does not create attention and must not be treated as a fallback. A provider that cannot expose
its structured question action reports a visible compatibility failure and stops. The campaign
projection derives ownership from durable request and policy records; it never parses transcripts.

The root campaign surfaces human-owned descendant requests as **Needs Your Input** in its parent
status and request panel, even while its lifecycle remains **Awaiting Prompt**. Those requests use
the parent's ordinary Inbox, reminder, push, and browser-notification paths. Requests assigned to
the Orchestrator appear separately as **Orchestrator Action** and do not notify the human. Human
clients can inspect both groups. A session-scoped credential can list and resolve only its own
Orchestrator-assigned group; human-owned questions and approvals remain unavailable through agent
credentials.

Protocol v139 lets a human assign five workflow decisions independently to the human or the
controlling Orchestrator: implementation questions, pull-request merge approval, deletion of an
already-merged branch, publication of a sanitized follow-up issue, and UI-evidence approval. The
policy is revisioned. Every request records the exact controlling ancestor, child, category,
authority, policy revision, and a digest of its validated resource snapshot. A policy change,
ancestry change, audience loss, changed resource snapshot, duplicate response, or superseding
request fails closed. Approval is one-shot: the child must consume it against the same snapshot
immediately before starting the action. Protocol v142 gives PR merge consumption a narrower
two-step boundary. The child supplies the canonical command
`gh pr merge https://github.com/<owner>/<repository>/pull/<number> --squash --match-head-commit <approved-head-sha>`; the control plane
arms that exact command while the decision remains approved. The matching one-shot Bash or Codex
command permission is then admitted and the decision is marked consumed only after the allow
response is delivered to the runner. A changed command, failed delivery, stale policy, changed
ancestry, ambiguous match, persistent grant, or unsupported provider cannot consume the grant.
Other categories retain immediate consumption. Consumption records that the external action may
have started. A UI-evidence approval gates a later action rather than authorizing one, so campaign
child verification settles an approved evidence decision as consumed instead of requiring the child
to consume it first; a pending evidence decision, and every other approved category, still blocks
verification. A later policy change can revoke only approvals that have not been consumed; it does
not claim to roll back an action already in progress.

An injected child without the management MCP server uses the same shared handlers through
`wollipog decision request`, `wollipog decision get`, `wollipog decision consume`, and
`wollipog decision reconcile`. The exact
resource snapshot (and PR-merge action, when applicable) is passed as JSON. These commands are
self-scoped: they reject `--session`, send the injected session principal on every request, and do
not expose any resolution operation, so a child cannot target another session or approve itself.
The first three require protocol v139; reconciliation requires v153. Each fails before sending
its operation to an older control plane.

Protocol v150 adds a read-only reconciliation path for a PR merge that completed before its exact
armed occurrence was consumed. The child must be resumed on the same App Server thread and submit
the unchanged resource snapshot. Full provider history proves the exact successful command followed
its exact completed Wollipog admission call in the same turn, and the forge proves the approved
merged head. Only then does the control plane consume the original occurrence with
a content-safe audit receipt. Reconciliation never executes the command, and unavailable history,
duplicate commands, failed execution, forge mismatch, or mixed-version peers leave the occurrence
approved and retryable. Stale policy, ancestry, authority, or resource evidence revokes it.

Protocol v151 separates Wollipog's runner turn from the App Server's provider turn throughout
action admission. The control plane binds retries to the runner turn while the runner records the
provider turn returned by App Server; neither identifier may be substituted for the other. This
lets the ordinary `commandExecution` and Guardian auto-review paths consume the same exact typed
occurrence without a second decision. It also extends read-only reconciliation for CLI-arm paths
that do not appear as native provider MCP items: one exact durable arm marker must precede exactly
one allowed Guardian receipt for the canonical command in the same runner-history generation, and
provider history must contain exactly one successful command with those exact thread, turn, and
item coordinates. No later arm for the same command may intervene, and the provider item retains
one shared claim across live consumption and every reconciliation proof. The forge, snapshot,
policy, ancestry, and authority checks remain unchanged.
Missing, reordered, duplicated, cross-generation, replayed, or mismatched evidence fails closed.

Protocol v153 keeps that proof available across provider and session restarts. An ordered durable
runner sequence—arm, exact Guardian receipt, and one successful terminal update for the receipt's
item—can prove completion without asking the restarted App Server to reconstruct an old turn. A
legacy CLI admission that predates those runner fences may use only the exact Codex rollout for the
stored provider thread: one successful consume call for the occurrence and one later exact command
must appear uniquely in the same completed turn. The runner does not relay rollout contents, and
all existing snapshot, forge, policy, ancestry, authority, and receipt-replay checks still apply.
If `thread/read` retains the successful command but cannot represent that old CLI admission, the
rollout proof is accepted only when its thread, turn, and command item exactly match the live
successful item; a failed, duplicate, partial, fenced, or natively mismatched live item still blocks
the fallback.

Protocol v166 lets the resolver tell the child why. `resolve_descendant_workflow_decision` accepts
an optional `childMessage` of at most 2,000 characters, separate from the audit-only `rationale`.
The rationale is still never retained. The message is: its audience is the child, so it is stored
on the resolved occurrence, returned in the child's own `get_workflow_decision` view, and delivered
to the child as an ordinary prompt that wakes an idle child or queues behind a turn still in
progress. The governance audit records only the message's digest. The runner's tool refuses a
message when the connected control plane predates v166, because an older control plane would drop
the field and resolve the decision anyway. A child whose delivery was refused, for example while its
runner is offline, still finds the message on the decision record.

Every approval or denial resumes the child, whether or not it carries a message. A typed decision
does not suspend the provider turn, so a child that ended its turn behind the card has nothing else
to wake it. Resolution therefore delivers a short system-authored prompt naming the occurrence,
category, resource, outcome, and any selected option (followed by the message, when there is one)
through the same ordinary prompt path. A child still polling inside its turn receives that prompt
after the turn ends; the prompt tells it the decision record is authoritative and to continue if it
has already acted. Revocation and supersession do not send a prompt.

### Held Children

A child can be unable to start its next turn while nothing is asking a question. The case that
motivated this (#1650) is worktree recovery: the runner re-proves the selected worktree before
every turn, and a child that switched its worktree to another branch is parked `input_required`
with no pending request. Before, its decision resume was dropped and nothing told its parent.

- **The resume is kept.** On a runner at protocol v161 or later, the resolution prompt travels the
  durable prompt lane and its progress is recorded on the decision. If the control plane already
  knows the child is in recovery, the resume is held unsent. If the runner reports it not sent
  with `WORKTREE_RECOVERY_REQUIRED`, it is held the same way, and the not-sent row is retired so a
  manual Retry cannot deliver it a second time. The first boundary that sees the recovery cleared —
  a runtime update, a reconnect, or the prompt-maintenance sweep — delivers it once, as a fresh
  durable command with the same text. Staging that command and recording it on the decision happen
  in one transaction, conditional on the resume still being held. Holding a resume and retiring its
  not-sent row are also one transaction, and the sweep applies any receipt a restart left
  unapplied, so a restart can neither lose an owed resume nor send it twice. A resume held for a
  child that stops, or for a decision later revoked or superseded, is abandoned. Revocation or
  supersession also withdraws a resume still waiting in the outbox. One already handed to the
  runner cannot be recalled, but its text defers to the decision record, which now says revoked.
  Settling the card leaves a recovering child's status as the runner reported it, instead of
  marking it running or idle. Older runners keep the ordinary prompt path. A resume held before its
  runner downgraded is settled on that path rather than held on a recovery record the older runner
  never clears.
- **The parent sees the hold.** A session's `holds` list what keeps its next turn from starting,
  with a stable `holdId`, a reason, the `recoveryAction` that clears it, and any `heldResumes`.
  MCP `get_session` returns them together with `worktreeRecovery`. `list_descendant_requests` lists
  held descendants as `blockedChildren`, beside `requests` and never as a request, since there is
  nothing to answer. This is not gated on Parent Control. The campaign projection counts a held
  child as `blocked` rather than `active` and names it, with its holds, in `heldChildren`.
- **A human sees it too.** The campaign parent's session detail lists `heldChildren` under
  **Held Children** (#1760): each child's title and link, and for each hold its kind, reason,
  recovery action, and held decision resumes. The list reads the same projection as the `Blocked`
  count, so an entry leaves when its hold clears. It sits apart from the request inbox and offers no
  answer or approve control. Hold kinds render from their own fields, so a new kind needs no UI change.
- **The parent is woken.** Each new hold records one `child_blocked` campaign event, keyed by the
  hold's id, so an idle Orchestrator gets a continuation turn. The continuation tells it to clear
  each blocked child with the recovery action its hold names.
- **Refusals name the recovery step.** Prompting a held session, retrying its not-sent message, and
  attaching or selecting a worktree now on another branch all return a 409. The message says to
  restore the expected branch (`git -C <path> switch <branch>`) and select that worktree again with
  `select_worktree`, or to select or create another worktree.

The mechanism is not specific to worktrees. A hold is one `SessionHoldView` kind, derived in one
place (`sessionHolds` in the protocol package, fed by the control plane's session row). The
session view, the descendant view, the campaign projection, and the `child_blocked` wake event all
read that shape. A later runner-side hold, such as a prompt queued behind a handoff barrier, adds a
kind and its derivation, and every surface picks it up.

The control plane owns this lifecycle. A generic question answer or provider permission response
cannot satisfy a typed workflow decision. Authentication, identity, governance-policy changes,
secret access, and persistent permission grants are not typed categories and remain human-only.
The merge snapshot binds the repository, pull request, exact head SHA, cross-model review result,
and passing required checks from that same head. Branch deletion binds the merged branch and merge
commit and requires an explicit empty dependent-pull-request check. Follow-up publication binds the
sanitized repository, title, body, and labels. UI approval binds immutable evidence identifiers,
optional HTTPS URIs, artifact identities, and SHA-256 digests, and resolution records which evidence
was actually inspected.

### Orchestrator Review of UI Evidence

**UI Evidence Approval** is the one category whose saved owner is not automatically effective.
Assigning it to the Orchestrator is the human's opt-in to both decision ownership and the narrowly
scoped evidence access needed to exercise it; there is no separate access toggle. The Orchestrator
owns a decision only when all of the following hold, and otherwise the decision is created
human-owned with a `humanFallback` code and reason shown on the request card:

- the Orchestrator's runner speaks protocol v179 (`orchestratorImageToolResults`), which includes
  the v167 evidence reader;
- its harness is one whose MCP image path has been audited (Claude Code, Codex App Server), and its
  installation attests `imageToolResults`: the MCP client hands a tool's image content to the model.
  Unknown is treated as unsupported (`harness_unsupported`). Prompt-image support (`supportsImages`)
  is a different path and decides nothing here. The runner attests it only from live discovery — a
  Claude Code release at or after the one `pnpm probe:claude-mcp-image` verified, or a Codex App
  Server whose app-server contract is supported — never from agent configuration, and never for a
  configured wrapper or custom argv that matches a discovered installation only by name;
- its exact model is in the installation's catalog, and does not list input types that exclude
  `image` (`model_unsupported`). A model that lists none, as every Claude Code model does, is covered
  by the installation's attestation; a selected model missing from the catalog never inherits it;
- every evidence item names an `artifactId` of a `screenshot` Session artifact owned by the requesting
  child, declares an allowed image `mediaType`, and matches that artifact's type, size, and SHA-256.

Video (`media_video_unsupported`), unknown or non-raster media (`media_unsupported`), and evidence
that lives only behind a URI (`provider_untrusted`) always go to the human. The control plane never
fetches a child-supplied URL; the URI is display material for the human reviewer only. A screenshot
Session artifact can be submitted without a URI when it names its `artifactId`, raster `mediaType`,
and SHA-256. A first-class MP4 or WebM Session artifact can also be submitted without a URI, but
video remains human-owned: no installed Orchestrator client is audited to deliver its motion to the
model, so an artifact and a matching digest alone cannot create a review receipt. URI-only evidence
still requires a safe HTTPS link. Campaign-level
unavailability is reported as `uiEvidenceReview.reasonCode` and `reason` on the campaign projection.
A human fallback is scoped to that one decision: other children and other assigned categories are
unaffected.

#### What the Human Reviewer Sees

The human review card shows an artifact-backed raster image in place rather than linking out, so the
human and an assigned Orchestrator review the same bytes. The card fetches the artifact through the
authenticated export route with the reviewer's own session access, recomputes its SHA-256 in the
browser, and compares it with the digest in the decision snapshot before displaying anything. A
mismatch, a missing artifact, and an artifact the reviewer may not access each show their own state,
display no image, and cannot be marked reviewed, so approval stays blocked while rejection stays
possible; a reviewed mark saved on an earlier visit does not survive the artifact turning out wrong.
Images load as they approach the viewport, a few at a time, and are held only as short-lived object
URLs that are released when the card closes.

When supplied, the `uri` remains the reviewer's route for an item with no artifact, for video or
any non-raster media type, and in a browser context without SubtleCrypto (plain HTTP on a
non-localhost origin), where unverifiable bytes are not shown as the evidence the request names.
Those links are labelled as external. An artifact-only item with no SubtleCrypto cannot be marked
reviewed or approved from that browser; the reviewer must use HTTPS or localhost.
An artifact-only human approval also carries the exact decision digest from the updated review
card. A tab kept open from an older web build lacks that field and is refused with a reload prompt
instead of approving evidence it may not have shown.

#### Attaching Evidence From a File

A child makes an item reviewable by attaching the capture to its own session with
`attach_session_artifact` (`path`, optional `name`), or from a shell with
`wollipog artifact attach --file <path>`. Protocol v169. The file is read on the runner host and
uploaded directly, so its bytes never enter the model's context; passing an image as base64 through
`create_workflow_artifact` costs tens of thousands of tokens per capture and is not a usable path.

Use the returned `artifactId`, `mediaType`, and `sha256` in a `ui_evidence_approval` item's
snapshot. For a raster screenshot artifact, the item does not need a `uri` or an evidence-bucket
upload. Older runners whose tool schema still requires `uri` continue to use the existing linked
form, and an older control plane rejects the new shape rather than accepting an unverifiable item.

The tool takes an absolute path because the management server's working directory is the provider's
launch directory, not the agent's; the CLI resolves a relative `--file` against its own. It accepts a
regular file of at most 8 MiB whose **content** is PNG, JPEG, GIF, or WebP — the media type is sniffed
from the bytes, never taken from the name — and refuses a missing, unreadable, empty, oversized, or
non-regular file without creating anything. It answers with `artifactId`, `mediaType`, `sizeBytes`,
and `sha256` only, after checking that the control plane's digest of the stored bytes equals the
file's. Those are exactly the values to cite in the evidence item.

The upload goes to `POST /api/sessions/:id/artifacts/screenshots`, where the session is the route
parameter and the kind and encoding are fixed, so a body cannot redirect or retype it, and the
response never echoes the bytes. A session credential may attach only to its own session: not to a
descendant, an ancestor, or any other session it can see, because an artifact's session is what
proves who produced it. The route is outside the Orchestrator allowlist, since an Orchestrator
reviews evidence rather than producing it. Because attaching is cheap, what agents attach to one
session is bounded at 256 screenshots and 512 MiB, refused with `409` before anything is stored;
prompt images and a human's own uploads are neither counted nor limited.

Attaching is idempotent. The same bytes, name, and type attached again to the same session by the
same author return the existing artifact with `200` instead of creating another, and are answered
even when the session is at its bound. An upload of several megabytes can time out after the control
plane has committed it; the tool then reports that the outcome is unknown and that attaching the same
file again is safe. Uploads get a three-minute deadline rather than the ordinary RPC one. The reader
takes one byte more than the size it checked, so a file that grows after the check cannot make it
allocate without bound, and a file whose size changes either way during the read is refused. Against a pre-v169 control plane the tool refuses with the
version to upgrade to instead of falling back to a base64 argument.

The Orchestrator inspects evidence with `review_descendant_ui_evidence` (`sessionId`,
`occurrenceId`, `evidenceId`). Delivery re-runs every gate that guards resolution — root campaign
controller, ancestry, audience, pending status, policy revision, and current authority — then reads
the artifact bytes, recomputes their SHA-256 against the digest in the decision snapshot, and revokes
the decision on mismatch instead of showing anything. The runner recomputes the digest again, then
acknowledges the exact receipt id and digest; only then does it return the image as MCP image
content. An unacknowledged receipt supports no approval, and a failed acknowledgement withholds the
image, so a dropped response or refused bytes can never stand in for a review. The text block carries only the receipt, so the CLI path,
transcripts of tool text, campaign projections, and audit never hold evidence bytes or signed query
parameters.

Each delivery records a server-side review receipt bound to the reviewer, child, occurrence, policy
revision, evidence identifier, artifact, and digest. `resolve_descendant_workflow_decision` approves a
UI-evidence decision only when an acknowledged, unexpired (one hour), unconsumed, unrevoked receipt exists for every
item; repeating `evidenceReviewed` identifiers is not sufficient. Denial needs no receipts and must omit
`evidenceReviewed`, which accompanies only an approval. Receipts
are spent by resolution and revoked with the decision, so a policy-revision or ownership change,
supersession, or revocation invalidates them. The resolution audit lists evidence identifier and
digest pairs and the receipt ids spent; each delivery is a `review`-stage audit entry.

This boundary governs actions performed through Wollipog's workflow-decision tools. It cannot
intercept a separate shell, forge client, browser, or other credential that can independently
perform the action. Orchestrator instructions must therefore require `request_workflow_decision`,
the assigned authority's exact resolution, and `consume_workflow_decision` immediately before
using a supported mutation path. For PR merge, the command returned in the durable action admission
must be executed byte-for-byte. The GitHub CLI rejects enqueue if the PR head changed after review;
a generic or altered forge command deliberately falls back to its
ordinary human-only permission boundary. Audit entries correlate the typed decision occurrence and
matching permission through content-safe digests and outcomes without retaining raw rationale or
credentials or recording a second user decision.
For the exceptional case where that exact command already succeeded but the armed occurrence was
not consumed, `reconcile_workflow_decision` performs the v150/v151 proof above against the original
occurrence and snapshot. It is not a retry mechanism and must never be followed by replaying the
merge command.
A Claude Code child has no correlated command receipt: in auto or Full Access mode the enqueue runs
without a permission prompt, so nothing consumes the armed occurrence live. For such a child the
proof is the forge alone: the runner reads the pull request and reconciliation succeeds only when
it reports the approved head merged. One merged head settles one occurrence. When the child stops,
restarts, or its provider session ends with an armed merge still approved, the occurrence is revoked
at once as before, so a relaunched provider cannot reuse it; the control plane then reads the forge
and moves it to consumed if the approved head merged.

Before creating a child, an Orchestrator can call `get_agent_capabilities` with an exact `runnerId`
and `agentId`. The matching CLI command is:

```sh
wollipog session capabilities --runner <runner-id> --agent <agent-id> --limit 50 --json
```

The response returns a bounded page of exact model identifiers and advertised display names,
defaults, descriptions, context windows, input modalities, and effective reasoning efforts.
`effortSource` says whether each model uses its own efforts, the harness-level fallback, or has no
configurable effort. Discovery is separately labeled available or unavailable, and known model
sources are labeled `live` or `cached`. An unavailable result identifies whether discovery was not
advertised or is negotiated only after starting an ACP session. Hidden models are excluded by default; use
`--include-hidden` to page through them or `--model <exact-model-id>` to inspect one persisted
hidden selection. Continue a truncated page with its `page.nextOffset`. The lookup is advisory:
`session create` revalidates the requested model and effort against the installation's current
capabilities immediately before launch, so capability drift fails closed.

Protocol v124 completes that contract for structured Direct WSL sessions. Discovery must resolve an
absolute, root-owned Linux Node 22+ runtime plus distro-owned compiler and bubblewrap runtimes with
the fd-bind contract. Before each provider launch, the Windows
runner rotates and registers the exact-session credential, waits for the control plane's positive
hash acknowledgement, and atomically installs a root-owned, mode-0555 helper and compiled native
launcher at fixed paths in that distro. The launcher uses `openat2` without following symlinks,
reopens and fingerprints the authoritative cwd, HOME, and every writable bind, and retains their
directory descriptors through bubblewrap exec. Session provider state and relay files live below a
root-owned runner/session hash anchor; only their exact leaves are writable. A target-local shared
HOME lease remains held until the sandbox is gone. The provider receives only a mode-0600 token and
MCP configuration in its private bwrap `/tmp`.

The helper connects to a per-launch mode-0600 Unix socket. A sibling relay outside bwrap is entered
through the same native launcher's held directory descriptor; its Node and helper files are opened
without following links and pinned through exec. It carries versioned bounded frames over that process's
standard input/output to the Windows runner, which checks the
session, token, readiness marker, and CLI command family before reusing the existing Orchestrator
tool table. The bwrap process sees only the one socket directory; it never sees `wsl.exe`, `/init`,
a TCP listener, or a general process-execution RPC. Relay exit removes the socket, provider stop
reaps both processes, restart rotates the token, and terminal/delete/startup cleanup removes
credential files. Direct WSL conversation fork/state adoption, provider-mode sessions, non-Orchestrator
sessions, WSL Native TUI, generic ACP, container, and cloud targets remain fail-closed.

## Authorization and compatibility

The general surface has a closed method-and-canonical-route allowlist. The control plane converts a valid exact-session claim into an `AgentPrincipal`, applies
the session's delegated resource scope, and records authorized mutations in the content-free
mutation audit under that session id. New API routes remain denied until explicitly added.

The CLI reads the authenticated `/api/compatibility` endpoint before a command and rejects a
control plane older than the protocol required by that command. The public `/healthz` probe keeps
only service-readiness metadata and does not expose the protocol version. During the unreleased
protocol-v100–v102 compatibility window, a 404 from the authenticated endpoint falls back to the
legacy health version; authentication failures remain fail-closed, including API-only peers that
answer 401 before routing the missing endpoint.
Runners connected to older control planes do not inject the general surface. WSL runners also
withhold the Orchestrator capability unless both peers negotiate v124 and fresh discovery proves the
complete target-local launcher contract.

See [Using Wollipog](../skills/using-wollipog/SKILL.md) for the compact agent-facing skill.
