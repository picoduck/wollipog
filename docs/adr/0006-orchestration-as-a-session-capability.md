# ADR 0006: Orchestration Is a Session Capability

- Status: Accepted
- Date: 2026-09-06
- Supersedes: [ADR 0004](0004-conductor-disabled-pending-acp-v2.md)

## Context

The session-scoped Wollipog CLI and MCP interface provides session management to ordinary agents.
The synthesized Claude-only Conductor no longer owns a distinct capability. Its runner credential,
launch provisioning, and special permission clamps add an unnecessary second authentication path.
The original runner environment gate was already removed by ADR 0004's August amendment.

## Decision

Retire the Conductor agent and its dedicated MCP entry point. Reject its reserved identity during
creation and durable launch recovery, filter configured and discovered advertisements, and retain
historical definitions and transcripts. Keep only cleanup for old credential-reference files.
General session management authenticates with the exact live session's separately bound credential.

The authenticated creator supplies child attribution. Request bodies and runner snapshots cannot
choose or overwrite a parent. A nullable parent reference is persisted on the child and exposed in
session views; removing a parent preserves the child's history and clears the reference.

All session credentials may prompt, stop, or archive only their own visible descendants.
The control plane walks persisted ancestry rather than trusting request fields, excludes self,
and retains ordinary audience checks. Missing or deleted ancestry fails closed. Orchestrators
may manage descendant worktrees; ordinary credentials retain only their own worktree operations.
The CLI `session archive` and MCP `archive_session` reuse stop-before-archive and retain history.
Agent credentials cannot unarchive sessions. Human device authority is unchanged.

Agent-created children receive their effective guardrails before their initial prompt can execute.
An explicit creation value takes precedence over the parent Project's human-managed child allowance,
and a finite parent's remaining allowance is always the ceiling. When none of those sources supplies
a cost or tool-call limit, that dimension remains unlimited; an agent caller may also pass zero to
request no limit when the parent itself is unbounded. Project settings and the human-only
`PATCH /api/projects/:id` surface accept `childSessionDefaults` with a positive finite
`costBudgetUsd` and a positive integer `maxToolCalls`; null removes the Project defaults.
The parent's Project supplies these defaults even when the child is filed elsewhere.
A bounded parent divides its
remaining, unreserved allowance across its remaining spawn slots; explicit child limits can narrow
that allocation. The default concurrent live-child cap is four, configurable at creation or on a
live session with `config.maxChildSessions` from zero through 64. Completed, failed, stopped, and
archived children free live slots. Lifetime usage reservations survive terminal states and deletion,
so a finite parent's already-allocated spend cannot be reused.
These are admission allowances; existing runtime cost and tool-call enforcement remains responsible
for stopping a child when it reaches its limit.

Apply the built-in `builtin:session-spawn-human-gate` to the
`wollipog.create_session` operation. The fallback permits sessions individually owned by an active
organization owner and asks for shared audiences and other roles. An explicit stored governance
policy can override that fallback. Bind each approval to the parent, exact creation request, and
spawn ordinal. Use the existing durable governance approval queue, audit, expiry, rejection, and
human response checks. The creating tool polls the same request while awaiting the human's decision.

Agent-initiated ordinary runs and workflow runs use the same child-admission rules. The authenticated
session is the parent of every member, including an explicitly requested workflow coordinator.
Preflight the complete member set against the parent's remaining spawn slots and allowances before
persisting a run or launching any worker. A batch approval names the child count and binds the full
request and resolved member identities; changing the task or membership requires a new approval.
Each child persists its own allowance reservation. Human-created runs and system-owned automation
delivery retain their existing behavior; agent creation cannot use automation delivery snapshots.
The compact MCP and CLI session responses preserve archive progress when the control plane supplies
it, so a successful request with Stop Pending or Stop Failed is not confused with completed archival.

The orchestrator preset is a separate permission boundary for an ordinary session. It exposes the
planning and coordination operations needed to inspect projects and delegate work while enforcing
refusal of project writes and implementation commands. Advertise it only where the harness can
enforce that boundary; unsupported adapters must fail closed. ACP transport availability alone does
not establish tool restriction capability.

The initial implementation supports native host Codex and Claude Code where their boundaries can be
verified. Native Windows harnesses are withheld because Windows Job Objects do not attest filesystem
confinement and Claude Bash-prefix rules cannot prevent output redirection. Codex disables native
extensions, hooks, ambient MCP servers, multi-agent tools, and browser/computer/image tools. It
keeps shell and live web search available under a no-approval workspace-write sandbox whose sole
project-independent writable root is a session-private scratch directory. Claude Code receives
Read, Grep, Glob, WebFetch, WebSearch, and an explicit Bash allowlist for read-only Git and bounded
GitHub issue coordination; Write, Edit, Agent, and Task remain disabled, hooks and settings sources
remain empty, and permission mode is `dontAsk`, which must be advertised by the installed CLI.
Configured Project Locations in the agent's execution namespace are supplied as read-only context.
Both harnesses start in scratch, use it for temporary files, may read user skills and project files,
and may use the reduced runner-owned Wollipog MCP server; the control plane independently permits
mutations only on trusted descendants. Unsupported or unverifiable configurations fail closed.
Neither the user nor a child can switch this preset on an existing session.

The preset is a cooperative safety boundary for trusted planning agents, not a hostile-model
sandbox. In particular, networked shell access can clone a repository into scratch and credentials
available to the provider may permit remote writes. The runner therefore combines filesystem
isolation, narrow Claude command patterns, explicit role instructions, and control-plane checks,
but does not claim to prevent a deliberately adversarial same-user process from bypassing intent.

Protocol v112 extends this boundary to native host Claude Code and Codex TUIs. Every initial or
manual TUI launch re-provisions runner-local credentials and restrictions, prepares the same
session-private scratch directory, and Codex repeats its MCP isolation probe there. Cancellation,
deletion, replacement launches, and
workspace changes fence asynchronous preparation before process creation. An idle orchestrator
credential remains usable only while its online owning runner has a running Agent TUI; ordinary
idle credentials, exited/reconnecting TUIs, and terminal sessions do not gain authority. Stop also
closes an orchestrator's TUI. Existing descendant authorization and child admission remain shared
with structured sessions. The TUI transcript and usage are not imported into structured events.
Native TUI spending and tool calls therefore do not contribute to persisted session usage or the
parent's remaining-budget calculation. The creation dialog discloses this limitation and directs
users to Direct for tracked usage and guardrails; it does not promise aggregate TUI budget enforcement.
A Native TUI now fails closed when its session has a cost budget, cost checkpoints, or a tool-call
limit, including inherited child limits, and those limits cannot be armed while an Agent TUI is
running. User-owned Native TUIs also fail closed while their organization has a daily cost budget;
that daily budget cannot be enabled while any user-owned Agent TUI in the organization is active.
This preserves the meaning of every displayed guardrail without fabricating usage.

This boundary is imposed by the provider interfaces, not by missing terminal parsing. Claude Code's
structured output and `--max-budget-usd` are print-mode-only; its interactive process exposes no
supported event stream. Codex app-server publishes thread-bound token usage, but the standalone Codex
TUI launch used here does not give Wollipog an authoritative thread binding or subscriber channel.
Reading provider-local history files or parsing terminal escape output is not an accounting contract:
concurrent conversations, resume/fork behavior, truncation, and provider format changes would make
attribution unsafe. A future metered TUI must launch through a provider-supported, runner-owned event
transport and bind its provider conversation id before the first turn. Until both supported providers
offer that contract, unguarded Native TUI sessions are labeled **Usage Accounting: Unavailable**.

The creation dialog distinguishes a saved permission default from an explicit Orchestrator override.
It matches the exact harness identity and uses the server's whole-preference capability check, so a
stale model/effort combination does not misleadingly appear to apply its permission mode. Effective
saved Orchestrator defaults also participate in target and TUI compatibility checks. Default creation
waits for preference loading (with a retry on failure); control planes without the defaults endpoint
retain harness-default behavior. The server remains authoritative at creation time, including changes
to saved preferences made in another tab after the dialog loaded.

Native-host structured sessions also support the exact audited
`@agentclientprotocol/claude-agent-acp` 0.75.1 adapter. The runner advertises the preset only for
the official Registry identity/version or an exact pinned `npx` package launch, then verifies the
live ACP initialize name and version before `session/new`. It supplies runner-owned Claude SDK
options with the same read/search/web and restricted Bash planning tools, no settings sources,
hooks, ambient MCP servers, or provider commands, plus configured Project Locations as additional
read-only directories; the sole allowed server is the session-scoped Wollipog MCP.
The pinned adapter routes `session/resume` and its `session/load` fallback through the same query
creation function, forwarding the request `_meta` and reapplying these options before the resumed
provider conversation is exposed.
The ACP client independently refuses filesystem and terminal services and cancels permission asks.
The management credential and MCP definition are materialized runner-locally from protected file
references and never persisted as token bytes.

Other ACP adapters and releases remain unavailable until their exact tool-isolation contract is
audited; ACP transport support or a self-reported display name is not sufficient. Protocol v124
permits structured Direct WSL only when discovery proves an exact root-owned Linux Node 22+ runtime,
the required bubblewrap fd interface, and a fixed distro compiler. The runner installs the fixed,
root-owned target helper and native no-follow launcher. That launcher holds cwd, writable-root, relay,
and provider-HOME descriptors through exec and leases HOME for the sandbox lifetime. A per-launch Unix socket and a
separate fixed-command WSL relay's standard pipes carry only authenticated, bounded Agent Control
frames to the runner-side
closed CLI/MCP implementation. The provider never receives a Windows executable path or a general
execution route; its bwrap namespace still has no WSL PE/binfmt registration. Credential
acknowledgement precedes launch, restart rotates the token, and terminal lifecycle removes it.
Direct WSL provider mode, conversation fork/state adoption, Native TUI, and generic ACP remain unavailable. Container and cloud targets deliberately
advertise `secrets: none` and mount only
the worktree. Cloud targets accept adapter-owned secret references but define no portable remote
Wollipog MCP runtime. None can yet provision and clean up the same target-local management
credential while proving that internal tools stay disabled. These combinations continue to fail
before provider launch; standard non-Orchestrator sessions remain available.

The device-local Conductor experiment is a permanently disabled compatibility tombstone;
saved opt-ins are ignored and the switch is removed. Session creation offers the native preset
without an experiment gate; advertised permission modes also expose it in per-agent defaults.

## Consequences

Parent attribution provides the durable session relationship consumed by #563 and #562.
The child remains subject to its existing session authorization; a parent relationship is not a
grant to answer approvals. Legacy sessions remain readable without invented parentage.
General session management and workflow dispatch keep their ordinary agent identities.

Removing the old Conductor does not restart or deploy any running stack.
