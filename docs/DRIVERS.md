# DRIVERS — concrete native-CLI driver specs

Companion to [`docs/SCOPE.md`](./SCOPE.md). This file pins the exact spawn commands/flags, the
stream/JSON event schemas, and the event→`SessionEventPayload` mapping tables for the
`ClaudeCodeDriver` and `CodexDriver`, plus the shared `Driver` interface every driver implements.

The normalized taxonomy (`SessionEventPayload`) lives in `packages/protocol/src/index.ts`. Drivers
emit it via a callback; everything upstream (hub, DB, web) is unchanged.

---

## 1. The `Driver` interface

`SessionManager` (`apps/runner/src/session-manager.ts`) depends on this and nothing else. `AcpClient`
already satisfies a near-identical shape; `AcpDriver` is a thin adapter.

```ts
// apps/runner/src/drivers/driver.ts
import type { PromptImage, SessionEventPayload } from "@wollipog/protocol";

export type StopReason =
  | "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** Resolved per-session knobs the driver applies at spawn / turn time. */
export interface DriverConfig {
  model?: string;          // alias or full id (claude --model / codex model)
  effort?: string;         // reasoning effort (claude --effort / codex model_reasoning_effort)
  permissionMode?: string; // claude --permission-mode / codex approvalPolicy
}

export interface DriverSpawnOptions {
  command: string;                 // resolved binary (or "wsl.exe")
  args: string[];                  // base args (may include "-d <distro> -- <bin>")
  cwd: string;                     // absolute; worktree path when isolated
  env: Record<string, string>;
  config: DriverConfig;
  /** For native CLIs: dirs to scan for slash commands/skills, auth hints, etc. */
  workspacePath: string;
}

/** The runner-side callbacks. Identical to today's AcpEvents plus nothing new required. */
export interface DriverCallbacks {
  onEvent: (payload: SessionEventPayload) => void;
  onStderr: (text: string) => void;
  onExit: (code: number | null) => void;
  /** ACP-only live session presentation; omitted by native drivers. */
  onAcpSessionState?: (state: { capabilities: AgentCapabilities; config: SessionConfig }) => void;
}

export interface Driver {
  /** PID of the underlying process (for process_status), if spawned. */
  readonly pid: number | undefined;

  /** Protocol handshake / auth check. Resolves when ready to accept newSession. */
  initialize(): Promise<void>;

  /** Begin a logical session at cwd; returns the agent-native session/thread id. */
  newSession(cwd: string): Promise<string>;

  /** Run one user turn to completion; resolves with the stop reason. */
  prompt(text: string, images?: PromptImage[], slashCommand?: string): Promise<StopReason>;

  /** Interrupt the in-flight turn (best-effort). */
  cancel(): void;

  /** Apply turn-scoped controls before prompt dispatch; may fail closed asynchronously. */
  setConfig(config: SessionConfig): void | Promise<void>;

  /** Answer a pending permission/approval request surfaced via onEvent. */
  resolvePermission(requestId: string, optionId: string | null): void;

  /** Kill the process tree and reject in-flight work. */
  dispose(): void;
}
```

Runner-owned isolation is resolved once per session before driver construction. Provider mode keeps
the driver mappings below unchanged. Bubblewrap, macOS Seatbelt, and Windows Job Object modes pass the same resolved boundary to Claude,
Codex exec/app-server, ACP, provider fork helpers, and ACP-created command terminals. Bubblewrap makes `/`
read-only, overlays only the session/terminal root writable, supplies an ephemeral `/tmp`, and may
unshare networking. ACP filesystem calls remain independently constrained to the canonical session
root and explicitly activated additional-directory grants. A strict resolution failure is terminal;
drivers are never constructed outside the requested boundary. Seatbelt restricts writes and optionally
network on native macOS, but cannot provide bwrap's per-session transcript mount; its real provider
transcript leaf is shared, so admission enforces one live session per provider family across runner
processes sharing the data root; unknown ACP state is not serialized by guessing, and same-session
restart cannot overlap a fork helper. The Windows Job
launcher provides kill-on-close descendant containment only; it never claims filesystem or network
restriction, and `network: "deny"` is rejected for that mode.

The bwrap profile maps Claude's `projects` and Codex's `sessions` stores to hashed per-manager-session
roots under runner data. In WSL, those roots live below
`~/.agent-manager/runner-instances/<attested-owner>/`, so runners with the same distro user cannot
reconcile or remove each other's state. Provider forks copy the completed source store into the child partition before
publishing the child, after polling for a non-empty size-stable provider-specific fork artifact; a
missing or continuously growing artifact fails the fork. Failed forks and session deletion remove only
their exact partition. Functional
resume/fork still depends on the installed CLI tolerating its other read-only indexes/history and is not
claimed without real-host conformance. Native pre-partition sessions copy the legacy provider-wide store once.
WSL v1/v2 state is not automatically adopted because runner-id-only or absent markers cannot prove a
control-plane owner; resume fails with instructions to stop pre-attestation runners and explicitly archive
the reported retained source paths, then manually migrate the intended session into the reported owner-scoped
target path. New sessions are marked at creation and never import it. Credentials/config remain read-only, ACP state is not guessed,
and existing provider-mode transcripts are not imported automatically. Failed exact cleanup is journaled;
startup GC expires runner-owned orphans and enforces the configured per-provider/context byte ceiling while
protecting every stored session. Pending cleanup/fork records claim short-lived failed partitions for exact
retry; a surviving session row or in-flight fork target keeps cleanup intent dormant, and a fresh record
has a one-hour cross-process grace. WSL GC additionally requires the current runner's ownership marker and
skips an offline distro without aborting other contexts. New WSL worktree directories and branches carry
the same attested owner namespace. A stored pre-attestation WSL session continues using its exact
registered legacy worktree so upgrade cannot strand uncommitted changes; an absent, unhealthy, or
unexpected legacy path fails closed for manual recovery instead of creating a replacement worktree.
The unowned legacy shared leaf is retained until provider-specific inventory can prove exclusive migration.
That same ownership boundary applies to pre-attestation cleanup journals: a current runner does not
delete a shared WSL leaf merely because an old journal names the session, because another runner may
own identically named shared state. A rollback to the preceding runner generation also cannot resume
the owner-scoped transcript of a WSL session created after this upgrade: it sees only the retained
shared leaf. No bytes are removed; roll forward to the current runner to resume that session.
Fork verification requires non-empty history
because a provider-native fork always starts from a completed source turn. Network denial is offline/local-model-only because it also
removes access to cloud model APIs. New checkpoint refs use
`refs/{wollipog,mam}/owners/<full-attested-owner>/<session>/<kind>-<turn>`; persisted legacy rows and
cleanup journals retain their exact unscoped layout until explicit offline adoption. Native provider
mode remains the broadest compatibility default but takes an exclusive whole-HOME lease shared by
Claude, Codex, ACP, Seatbelt, Windows Job, and Agent TUI launches. Direct WSL provider mode fails
closed; choose bwrap or a dedicated distro/account.
Standalone Agent TUI processes are not bwrapped, so Agent TUI attachment from a WSL session requires
a dedicated distro/account even when the session's structured provider launch uses bwrap.

On upgrade, a persisted Conductor `--mcp-config` argument is rewritten to the attested runner's
owned data directory before launch. The former `~/.agent-manager/conductor/*.mcp.json` file is never
updated or deleted automatically: it has no trustworthy owner metadata and may still be used by an
older runner. To retire those files, stop every pre-attestation runner for the OS account, run the
redacted `--state-doctor inventory`, then use the explicit quarantine action. Adoption conditionally
copies legacy checkpoint or WSL provider state and preserves all source bytes; divergent targets fail
closed. Provider-home bytes remain operator-owned even though native mutable launches are cross-process
leased. Use bwrap or separate WSL distros/accounts for concurrent owners.

`makeDriver(spec, cb): Driver` (`drivers/factory.ts`) switches on `spec.driver`
(`"acp" | "claude-code" | "codex"`). `AcpDriver` (`drivers/acp-driver.ts`) constructs the existing
`AcpClient` and forwards 1:1. Stable ACP `available_commands_update` entries populate the
session-scoped slash palette; selecting one travels as typed `slashCommand` metadata and is rendered
into ACP's stable prompt-text command form only after the live session advertised that exact name.

`SessionManager` changes: replace `new AcpClient(...)` with `makeDriver(spec, {onEvent, onStderr,
onExit})`; all subsequent calls (`initialize`, `newSession`, `prompt`, `cancel`,
`resolvePermission`, `dispose`, `.pid`) already match the interface.

---

## 2. ClaudeCodeDriver — native `claude` (subscription)

Drives the `claude` binary in streaming print mode. This is the priority driver: it makes
subscription Pro/Max Claude work without a Console API key.

### 2.1 Auth (per-spawn env)

Prefer subscription OAuth. Provision once on the machine with `claude setup-token` (mints a ~1-year
token); the driver spawns with `env.CLAUDE_CODE_OAUTH_TOKEN` set and **`ANTHROPIC_API_KEY` deleted
from the child env** (in `-p`, an API key, if present, always wins). Do **not** pass `--bare` (it
ignores `CLAUDE_CODE_OAUTH_TOKEN`). Discovery uses `claude auth status`, whose current output is
JSON, and retains only bounded auth-method/provider/subscription labels. Email, organization fields,
command output, and credential values are discarded.

### 2.1.1 Installed capability and readiness discovery

Protocol v30 probes the exact resolved launch in each native/WSL context with `--version`, `--help`,
and `auth status`. Effort levels and permission modes are advertised only when that installation's
help enumerates them. The stream-json input requirement is verified independently; the undocumented
stdio-control and image-block contract is enabled only at the regression-tested 2.1.205-or-newer
compatibility floor. Readiness also requires the driver's implicit `acceptEdits` fallback to be
enumerated. A stale value explicitly submitted by a client is rejected, while an older persisted
session is healed if a CLI update narrows its modes or effort levels. The runner checks the same
advertised capability immediately before constructing argv.

`AgentDefinition.claudeCode` reports ready/unauthenticated/unsupported/unavailable state, how the
binary was resolved (ordinary PATH, common directory, version manager, or login shell), and a safe
billing classification: subscription, API, Bedrock, Vertex, gateway, or unknown. Explicit per-agent
auth environment changes the classification from safe presence/enablement checks; values never enter the
diagnostic. Rediscover refreshes the result, and the runner repeats discovery every five minutes so
a CLI self-update changes capabilities without a runner restart.

Cloud-provider flags follow Claude's documented credential precedence ahead of direct API/OAuth
configuration: [Claude Code authentication](https://code.claude.com/docs/en/team#authentication-precedence).

### 2.2 Spawn command and persistent process

The default is one persistent process per session. The `WOLLIPOG_CLAUDE_PERSISTENT=0` circuit breaker
uses one process per turn with this base argv:

```
claude -p \
  --output-format stream-json --verbose --include-partial-messages \
  --session-id <uuid> \                         # turn 1; --resume <uuid> on later turns
  --model <alias|id> \                          # from DriverConfig.model (omit if unset)
  --effort <discovered-level> \                 # from DriverConfig.effort (omit if unset)
```

plus per-mode flags (`claudePermissionArgs`; runtime default is `acceptEdits` when
`permissionMode` is unset):

| `permissionMode` | extra argv | prompt delivery |
|---|---|---|
| `default` (ask everything) | `--input-format stream-json --permission-prompt-tool stdio` (**no** `--permission-mode`) | stream-json user message on stdin; stdin stays open for approvals |
| `auto` | `--input-format stream-json --permission-prompt-tool stdio --permission-mode auto` | same — mode rules classify first; the stdio channel catches escalations so a blocked headless turn settles gracefully |
| `acceptEdits` / `plan` / `bypassPermissions` | `--permission-mode <mode>` | plain-text stdin; with images: + `--input-format stream-json` (prompt as a stream-json message, stdin closed immediately — no approvals) |

All argv tokens are quote-safe simple strings (no user prompt or JSON on argv). This keeps multiline
text and `cmd.exe` metacharacters out of the Windows command line.

- Spawned via `spawn.ts` (`shell:isWindows` handles the `claude.cmd` shim; `killTree` reaps the tree —
  for WSL-bridged agents it launches under `setsid` as a process-group leader and `kill -- -<pgid>`s the
  whole group inside the distro, since `taskkill` only sees the `wsl.exe` relay, not the Linux agent).
- `cwd` = worktree path when isolated, else workspace path. Session-id resume is scoped to cwd + its
  git worktrees, so always spawn from the same `cwd`.
- **stdio control protocol** (interactive modes): when claude needs permission for a tool it writes a
  `control_request` JSONL frame on stdout —
  `{"type":"control_request","request_id":"<id>","request":{"subtype":"can_use_tool","tool_name":"Bash","description":"…","input":{…}}}`.
  The driver stashes `request.input`, emits a `permission_request` event, and on `resolvePermission`
  answers with a `control_response` frame on stdin. Allow:
  `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow","updatedInput":<the stashed input, echoed verbatim>}}}`;
  deny: same envelope with `{"behavior":"deny","message":"The user declined this tool call."}`. An
  unrecognized `control_request` (unknown subtype) is never silently ignored — the driver emits a
  stderr canary and auto-declines with
  `{"subtype":"error","request_id":"<id>","error":"unsupported control request"}` so the turn cannot
  park (the stdio channel is the undocumented Agent SDK protocol; a CLI release could reframe it).
- **Interactive stdin lifecycle**: the prompt is written as a stream-json user message, then stdin
  stays open for control_responses; the `result` handler closes it. A deny does **not** end the
  turn — claude is told the user declined and adapts.

The Claude driver starts one
`claude -p --input-format stream-json --output-format stream-json` process per active session by
default and treats every terminal `result` as a turn boundary without closing stdin. The existing
SessionManager queue remains the single prompt serializer. All approval and AskUserQuestion
`control_response` frames share that stdin channel, and text, slash-command, multiline, and image
messages use the same user-message envelope. `WOLLIPOG_CLAUDE_PERSISTENT=0` opts out to the
one-process-per-turn `--resume` path.

The lifetime policy is quiescence-aware and fail-safe:

- Model, effort, permission-mode, cwd, or launch-arg changes reap the idle process and resume the
  same Claude session with new argv on the next turn.
- `WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS` controls quiescent idle eviction (default 60 minutes). `0` means
  never evict; any safe integer of at least 30 seconds is honored without an upper clamp. Invalid
  or sub-minimum values are rejected with a runner diagnostic.
- `Agent`/`Task`, `Monitor`, `Workflow`, and background shell launches enter a per-session pending
  set provisionally. A provider task lifecycle event or structured async-launch result promotes
  the entry; otherwise the launch tool's plain result releases it so tools without a lifecycle
  coordinate cannot pin the session forever. Provider task lifecycle messages clear promoted
  entries. Before eviction, the driver also reconciles
  Claude's `<temp>/claude/<project>/<session>/tasks/*.output` artifacts against the provider
  transcript. Startup fallback reads native and WSL stores in their own execution context;
  ambiguous, unreadable, or oversized ledger evidence keeps work pending.
- `WOLLIPOG_CLAUDE_PENDING_MAX_MS` is a leak backstop for pending work (default seven days; `0` means
  unlimited). Hitting it writes a durable orphan marker before eviction.
- Eviction and runner-shutdown stops send EOF first and allow five seconds for a clean exit before
  `killTree` reaps the remaining native or WSL process group; explicit Stop and cancellation kill
  immediately. A stop with pending work writes the
  same orphan marker. Runner startup, session adoption, and client reconnect discover markers or
  incomplete task artifacts. Manager-owned sessions dispatch a synthetic continuation without a
  user prompt; a newly external-adopted session only shows the orphan state until its first
  explicit user prompt transfers recovery authority to the manager.
- Detached or external work is observable only when the agent leaves a harness-visible `Monitor`
  or background shell waiter. As an escape hatch, `<manager-session-dir>/hold.json` may contain
  `{"expiresAt":<future Unix epoch milliseconds>}`; valid holds suppress eviction until their TTL,
  bounded by `WOLLIPOG_CLAUDE_PENDING_MAX_MS` unless that ceiling is disabled, while expired, invalid,
  or unreadable holds are logged and ignored.
- A prompt write may restart/resume once only before Node acknowledges the stdin write. After that
  acknowledgement boundary, a terminated or malformed stream fails the active turn and the prompt
  is never submitted automatically again. The next distinct prompt gets one persistent `--resume`
  recovery attempt; another transport failure opens a per-session circuit breaker and later prompts
  use the proven one-process-per-turn `--resume` fallback.
- Events received without an active turn, including stray terminal results, are ignored with a
  diagnostic. Only the single active turn can consume its next terminal result, so output from turn
  N cannot settle turn N+1.
- Claude reports token usage per turn but `total_cost_usd` cumulatively within one persistent
  process. The driver emits a cost delta at each result and resets that baseline when a new process
  starts, preserving the SessionManager's existing additive accounting contract.
- All three lifetime controls are runner-only and are scrubbed from native, WSL, and standalone
  TUI child environments.

### 2.2.1 Per-session policy hook transport

`WOLLIPOG_CLAUDE_HOOKS=1` enables the default-off Phase 3 transport for native Claude Code agents in
fixed-rule permission modes (`acceptEdits`, `plan`, and `bypassPermissions`) after the connected
control plane acknowledges the required protocol version. Phase 3b does not advertise `hook` as an
elicitation transport because a matched `ask` cannot reach a user until Phase 4. Interactive
`default`/`auto` modes retain their stdio-control approval channel. WSL, container, cloud,
old/unknown control planes, and Conductor sessions do not receive this transport.

Before session persistence, the runner writes
`<dataDir>/hooks/<runnerHash>/<sessionId>.settings.json` with mode `0600` and appends
`--settings <file>`. The file adds `PreToolUse`, `PostToolUse`, and `UserPromptSubmit` command
hooks that re-enter the same runner executable as `--policy-hook`. SEA and Node/tsx launches share
the same runner-reentry resolver used by `--conductor-mcp`; secrets never appear on argv. The
runner-wide credential is never exposed to Claude. Instead, the runner creates an independent
per-session hook token file, sends only its SHA-256 binding over the authenticated runner socket,
and the settings environment carries that file reference plus bounded control-plane/session paths.
The control plane accepts it only for the exact live Claude session and exact policy-hook route;
session deletion cascades the hash binding. It returns a positive or negative registration
acknowledgement. The first sidecar waits for a positive acknowledgement before sending HTTP.
A delayed acknowledgement from a negotiated control plane remains fail-closed; a negative
acknowledgement opens the local circuit and emits no permission decision. Old control planes never
receive hook settings because they do not advertise the required registered-frame capability.

The sidecar sends a content-minimized authenticated request to the exact active session. It drops
transcript paths, cwd, prompt content, arbitrary tool input, and credential values; only provider
session id, mode, tool-use id, tool name, and normalized path/network/branch selectors can cross.
No matching manager policy defers to provider behavior. A matched `allow` or `deny` round-trips to
Claude in every permission mode. A matched `ask` preserves the existing Claude stdio approval flow
in `default` and `auto`. In `acceptEdits`, `plan`, and `bypassPermissions`, the same `PreToolUse`
hook process polls a durable control-plane decision until a dashboard user allows or denies it.
The provider turn is not cancelled and no runner `resolve_permission` message is used.

Only one approval card is visible per session. Concurrent fixed-rule asks enter a durable FIFO queue;
other concurrent hooks wait behind the turn-wide barrier and re-evaluate when it clears. Identical
hook retries use a deterministic request id and cannot duplicate the card or audit. `askTimeout`
starts when a policy matches, is optional, and is reconciled by the control plane after restart as
well as during live polling. Expiry denies with a distinct `timed_out` audit outcome. Terminal
session/runner state aborts every open hook decision fail-closed. Terminal decision-cache rows are
pruned after seven days; the content-minimized governance audit remains append-only.

Acknowledged `PreToolUse` transport/malformed failures return a structured deny. `PostToolUse` and
`UserPromptSubmit` failures return an empty non-blocking response. Three consecutive transport
failures open a per-session circuit: the triggering pre-tool call still fails closed, then later
processes omit the managed `--settings` pair and continue with provider-native behavior. After a
30-second cooldown, the sidecar or next process performs one half-open re-probe; success closes the
circuit and failure reopens it. Open and recovery transitions produce content-free governance
audit entries. Once a durable ask is accepted, transient poll failures retry with bounded backoff
and do not open the circuit or release the suspended tool. Successful terminal round-trips reset
the consecutive-failure count. Circuit and settings files are removed with the session and swept
on runner restart. The runner-hash namespace prevents one same-account runner's startup sweep from
deleting another runner's live hook files, and self-describing managed settings let forks strip a
hook inherited from a different runner identity without classifying arbitrary user settings as
manager-owned.

Native hooks are a cooperative same-user governance mechanism, not an OS isolation boundary.
Claude and its shell tools run as the runner account and can read and write hook environment/state;
a deliberately adversarial process can write the circuit file to disable enforcement or enumerate
sibling files owned by that account.
Per-session binding limits accidental credential reuse and no hook credential authorizes any other
API route, but adversarial same-user integrity requires a future sandbox/broker boundary.

Every Claude process boundary checks the exact persisted settings path. A protected template heals
manual deletion before one-shot first/resume turns, persistent restarts, and fork bootstrap. This
closes the resume gap that existed in the older Conductor-only provision path.

This rollout follows Anthropic's documented Agent SDK streaming-input contract while keeping the
CLI transport and subscription authentication unchanged. It does not migrate to the TypeScript SDK;
that decision remains Phase 2.5.

### 2.3 Turn I/O (stdin/stdout JSONL)

- In default mode, one process runs per turn (`--session-id` on turn 1, `--resume` after). In
  persistent mode the same input/output process spans result boundaries until eviction, config
  change, cancellation, or failure. In either stream-input form,
  `prompt()` writes one JSONL line to stdin and awaits the terminal `result` event:
  ```json
  {"type":"user","message":{"role":"user","content":"<text or /slash-command expanded>"},"parent_tool_use_id":null}
  ```
  Images become a content-block array with `{"type":"image","source":{"type":"base64","media_type":…,"data":…}}`.
- **Slash commands**: include `/name [args]` directly in `content` — `-p` expands it before running.
- Parse stdout line-by-line as JSONL (reuse the line-buffering approach from `jsonrpc.ts`'s `onData`).

### 2.4 stream-json output → SessionEventPayload mapping

| claude stream-json event | fields read | → `SessionEventPayload` |
|---|---|---|
| `system`/`init` | `session_id`, `model`, `tools`, `permissionMode` | record session id/model (no event, or `status`); seed capabilities |
| `stream_event` `content_block_delta` `text_delta` | `event.delta.text`, open `message_start.message.id`, block `index` | `{kind:"agent_message", text, messageId?}` (live token stream) |
| `stream_event` `content_block_start` `thinking`/thinking deltas | delta text, open message id, block `index` | `{kind:"agent_thought", text, messageId?}` |
| `stream_event` `content_block_start` `tool_use` | `content_block.name`, `id`, `parent_tool_use_id` | `{kind:"tool_call", toolCallId:id, title:name, toolKind, status:"pending", parentToolUseId?}` |
| `stream_event` `content_block_delta` `input_json_delta` | `partial_json` | `{kind:"tool_call_update", toolCallId, status:"in_progress", text:partial}` |
| `assistant` (complete) | `message.content[]` text blocks | authoritative `{kind:"agent_message", text}` (dedupe vs deltas) |
| `assistant` (complete) | `message.content[]` `tool_use`, `parent_tool_use_id`, parented `message.usage` | `{kind:"tool_call", toolCallId:id, title:name, status:"in_progress", text:JSON(input), parentToolUseId?}` plus attributed subagent `token_usage` when supplied |
| `user` | `message.content[]` `tool_result`, `parent_tool_use_id` | `{kind:"tool_call_update", toolCallId:tool_use_id, status: is_error?"failed":"completed", text:content, parentToolUseId?}` |
| `system`/`api_retry` | `error`, `attempt` | non-auth failures → `{kind:"stderr", text:"retry …"}`; provider-auth failures → secret-free driver signal that cancels the retry loop and parks the session on **Authentication Required** |
| `system`/`compact_boundary` | — | `{kind:"status", status:"running"}` (informational; or ignore) |
| `result` | `subtype`, `result`, `modelUsage`, `total_cost_usd` | end turn → `StopReason` (`success`→`end_turn`, `error_max_turns`→`max_turn_requests`, else `refusal`); emit `{kind:"token_usage", …}` |
| `control_request` (`subtype:"can_use_tool"`) | `request_id`, `request.tool_name`, `request.description`, `request.input` | `{kind:"permission_request", requestId, title:"<tool_name>: <description ≤80>", options:[allow_once,reject_once]}` (input stashed for the reply) |
| `control_request` (unrecognized subtype) | `request_id` | no event — stderr canary + auto-decline `subtype:"error"` control_response |

### 2.4.1 Provider Authentication Recovery

Native Claude and Codex sessions run provider-native status checks in the runner's exact launch
context. The runner strips daemon-only environment variables with the same policy as the provider
driver, parses status locally, and sends the control plane only a bounded Authentication Required
card. Provider output, auth URLs, account labels, credential paths, environment values, and
repository paths never enter session events, telemetry, or snapshots.

The durable runner block records an HMAC-scoped installation/credential context and whether the
failed prompt was definitely not delivered or has uncertain delivery. Revalidation unblocks only
sessions whose freshly resolved scope and expected account digest match. A retained ordinary prompt
may retry once only when failure occurred before provider creation; the retry tombstone is flushed
before enqueue. Uncertain turns and terminalized durable commands are never retried automatically.

Use **Recheck Authentication** after completing `claude auth login` or `codex login` in the Location
shown on the card. **Start Sign-In** remains fail-closed until issue #17/PR42's cross-process
provider-home ownership lease is available on this branch. Configured environment credentials and
WSL remain revalidation/manual-login only. Container/cloud adapters do not yet expose an exact-context
status probe, so they keep the process-local fail-closed behavior and do not claim durable recovery.

**Plan / TodoWrite**: claude surfaces plans via the `TodoWrite` tool call, not a dedicated event — map
a `TodoWrite` tool_use input to `{kind:"plan", entries}` when its name is `TodoWrite`.

**File edits**: `Edit`/`Write`/`MultiEdit` tool calls carry the path/diff in their input/result — emit
`{kind:"file_edit", path, diff}` in addition to the generic `tool_call`. (The worktree diff capture in
`session-manager.ts` still provides the authoritative post-turn diff.)

**Recursive agents**: normalize Claude `Task`/`Agent` tools to `toolKind:"agent"`. Every parented
message, thought, tool/update, plan, file edit, and historical transcript record carries the direct
spawning `parentToolUseId`; the web resolves the full chain with orphan/cycle protection. Parented
usage and provider duration are optional v31 fields. Tool timestamps provide a duration fallback.

### 2.5 Approvals mapping

| our `optionId` | `control_response` written to stdin |
|---|---|
| `"allow"` | `{"behavior":"allow","updatedInput":<stashed request.input, echoed verbatim>}` |
| `"deny"` / `null` (cancel) | `{"behavior":"deny","message":"The user declined this tool call."}` |

`PermissionOption`s synthesized by the driver: `{optionId:"allow",name:"Allow",kind:"allow_once"}`,
`{optionId:"deny",name:"Reject",kind:"reject_once"}`. (Future allow-always: accumulate
`--allowedTools` in driver/session state across the per-turn respawns — not claude settings files and
not per-CLI-session state, since the driver is one-process-per-turn.)

Lifecycle rules:

- **Deny does not end the turn** — claude receives the decline message and adapts.
- **Cancel or process exit mid-ask** clears the driver's pending-ask map: a dead process can no
  longer answer, so stale asks must never be "found" by a later click.
- **Runner restart mid-ask** deny-by-discards: reconcile demotes the session to idle and nulls the
  pending approval — the owning process is gone and an in-flight ask cannot be resumed.
- **No timeout anywhere in the chain, by design** (matches the ACP driver's forever-pending
  promise): an unanswered ask parks the session in `input_required` until answered, cancelled, or
  the runner restarts.
- **Dead-target clicks** (the ask is gone by the time the user answers): `resolvePermission` returns
  false and no `permission_resolved` is emitted; the runner surfaces a stderr note ("approval …
  could not be delivered") plus a corrective `session_status` so the UI settles instead of showing a
  phantom "running".

**MCP fallback (shelved).** If a claude CLI update breaks the stdio channel, the contingency is ONE
runner-hosted streamable-HTTP MCP server on `127.0.0.1` with per-session unguessable path tokens —
hand-rolled `initialize`/`tools/list`/`tools/call` parking on the same pendingApprovals machinery.
Localhost works native and WSL-mirrored; on WSL-NAT the approver is disabled and modes fall back to
fixed-rule `--permission-mode` (surfaced as a capabilities downgrade). Never a per-distro stdio MCP
child — that needs a Linux-side node plus an env side channel `spawn.ts` cannot deliver.

### 2.6 Model / effort / continuation

- **Model**: `--model` per spawn. Resolved model reported back in `result.modelUsage`.
- **Effort**: `--effort` per spawn; availability is model-dependent (UI gates). Unsupported level
  falls back to the highest supported ≤ requested.
- **Change model/effort mid-session**: not live. Re-spawn with the new flag + `--resume <session-id>
  --fork-session` (or `--resume` to mutate) from the same cwd; applies to the next turn.
- **Continuation across runner restarts**: persist the pinned `session_id`; resume with
  `--resume <id>` from the same cwd.

### 2.7 Conversation fork and file rewind

Discovery exposes conversation fork only when the resolved Claude installation advertises
`--fork-session`. The provider-neutral fork operation creates the target worktree from the exact
anchored post-turn tree, then runs a separate zero-cost bootstrap in that target cwd:

```
claude -p --resume <source-id> --fork-session --session-id <new-uuid> \
  --input-format stream-json --output-format stream-json --permission-mode plan --tools ""
```

The bootstrap message is the local `/context` command. It performs no model inference or tools but
forces Claude to persist the fork immediately, returning the caller-supplied UUID in both `init` and
`result`. The source driver's id is never mutated. A mismatched id, error result, process failure,
or 30-second timeout fails the fork and removes the target worktree.

Claude's CLI forks only the current transcript; it has no provider turn-id argument. Therefore the
dashboard offers Claude conversation fork only at the latest completed turn. Older checkpoints
remain available for **files-only rewind**, with a disabled explanation instead of a misleading
history-fork button. Codex app-server retains arbitrary completed-turn fork through `thread/fork`.
Both paths create the same target provenance: source app session, selected manager turn, provider
conversation coordinate, anchored checkpoint tree, independent provider id, and isolated worktree.

---

## 3. CodexDriver — native `codex app-server` (with `codex exec` fallback)

`codex app-server` is the JSON-RPC manager protocol (NDJSON over stdio, `"jsonrpc"` omitted on the
wire). It is the only surface with **interactive approvals**, so it is the default. `codex exec
--json` is a no-approval batch fallback.

### 3.0 Compatibility discovery

Discovery runs `app-server --help` through the already-resolved native or WSL launch target and
records an additive `AgentDefinition.codexAppServer` result. Supported means the CLI version is at
least the repository's verified floor (`0.144.1`) and the bounded probe exposes app-server, stdio,
and JSON-schema generation. Older, timed-out, missing, or contract-incompatible installations keep
the exec driver and surface a structured fallback reason. Pre-v27 runners omit the result.

The floor is deliberately a **verified floor**, not a claim that older Codex versions cannot run
app-server: official docs publish the current protocol and per-version schema generator but no
minimum CLI release. `pnpm check:codex-schema` generates the installed CLI's schema into a temporary
directory and compares required stable request/notification properties against the pinned fixture.
Additive fields are tolerated; removal or shape loss produces a focused drift report.

### 3.1 Auth

`codex` reuses ChatGPT-plan login from `~/.codex/auth.json` by default (every plan includes Codex), or
`OPENAI_API_KEY`. Discovery verifies with `codex login status` (exit 0). For determinism pin
`forced_login_method` in `~/.codex/config.toml`.

### 3.2 Spawn + lifecycle (app-server)

```
codex app-server          # stdio NDJSON; reuse JsonRpcPeer-style framing
```

1. `initialize` (request) `{clientInfo, capabilities:{experimentalApi:true}}` → result; then send
   `initialized` (notification). Any call before this errors "Not initialized".
2. For a new session, `thread/start {cwd}` → the durable `thread.id`. For a stored session,
   `thread/read {threadId,includeTurns:false}` first validates the id and idle state, then
   `thread/resume {threadId}` must return that exact id. A busy/conflicting thread is a retryable
   error; resume never falls back to `thread/start`. Provider turns returned by validation/resume
   are deliberately ignored because the runner event log already owns displayed history. Note
   app-server enums are **camelCase**: `readOnly` / `workspaceWrite` / `dangerFullAccess`.
3. `turn/start` `{threadId, input:[{type:"text",text:"…"},{type:"localImage",path:"…"}]}`
   (+ `{type:"skill",name,path}` items for slash-command/skill invocation) → streams notifications
   until `turn/completed`. PNG/JPEG/WebP attachments are validated at the browser, control plane,
   and runner; capped at 6 images and 8 MiB each. The browser uploads exact bytes to session-scoped,
   SHA-256-addressed artifacts, while prompt JSON, SQLite events, runner command journals, and
   WebSocket frames carry only bounded artifact references. The runner reads its active credential
   file for each fetch, denies redirects, and verifies MIME, length, and digest before staging files
   in a private per-turn native temp directory. WSL files are created inside the selected distro
   with mode 0600 and Linux paths—never through a Windows/UNC translation. Files survive until the
   turn request settles and are removed on completion, failure, cancellation, process exit, and
   dispose.
4. `turn/interrupt` for `cancel`. Shutdown interrupts an active turn, declines parked approvals,
   then closes transport without archiving/deleting the thread. Runner/app-server restarts resume
   through the stored id. An ambiguously delivered in-flight prompt is never replayed; only prompts
   that were still queued before `turn/start` are safe to continue automatically.

Reasoning effort: `-c model_reasoning_effort="<level>"` at spawn, or per-turn config override. Models +
their `supportedReasoningEfforts` come from the `model/list` request (also used by discovery).

### 3.3 app-server notification → SessionEventPayload mapping

| codex app-server notification (camelCase) | → `SessionEventPayload` |
|---|---|
| `thread/started` `{thread.id}` | record id (no event) |
| `turn/started` | `{kind:"status", status:"running"}` |
| `item/started` `agentMessage` / `item/agentMessage/delta {delta,itemId}` | `{kind:"agent_message", text:delta, messageId:itemId}` |
| `item/started`/`delta` `reasoning` / `item/reasoning/summaryTextDelta` | `{kind:"agent_thought", text:delta}` (or new `reasoning`) |
| `item/started` `commandExecution {command,cwd,status}` | `{kind:"tool_call", toolCallId:id, title:command, toolKind:"execute", status}` |
| `item/commandExecution/outputDelta` | `{kind:"tool_call_update", toolCallId:itemId, status:"in_progress", text:delta}` → also `{kind:"command_output", text}` |
| `item/completed` `commandExecution {exitCode,status}` | `{kind:"tool_call_update", toolCallId, status}` |
| `item/started`/`completed` `fileChange {changes:[{path,kind,diff}],status}` | per change: `{kind:"file_edit", path, diff}` + `{kind:"tool_call_update", toolCallId, status}` |
| `item/*` `mcpToolCall {server,tool,arguments,result?,error?,status}` | `{kind:"tool_call"/"tool_call_update", toolCallId:id, title:`${server}/${tool}`, status, text}` |
| `item/*` `webSearch {query}` | `{kind:"tool_call", toolCallId:id, title:`web_search: ${query}`, status:"completed"}` |
| `turn/plan/updated {plan:[{step,status}]}` | `{kind:"plan", entries: plan.map(p=>({content:p.step,status:p.status}))}` |
| `turn/diff/updated {diff}` | `{kind:"file_edit", path:"worktree", diff}` |
| `thread/tokenUsage/updated {…}` | retain latest schema-pinned `last`, then emit one `{kind:"token_usage",…}` at turn settlement; never add restored cumulative `total` usage |
| `turn/completed {turn.status}` | end turn → `StopReason` (`completed`→`end_turn`, `interrupted`→`cancelled`, `failed`→`refusal`); `{kind:"status", status:"idle"}` |
| `error {error:{message,codexErrorInfo?}}` | `{kind:"error", message}` |

### 3.4 Approval server-requests → permission events

When `approvalPolicy` is `on-request`/`untrusted`, codex sends **server→client JSON-RPC requests** the
driver must answer (this is exactly what `JsonRpcPeer.onRequest` already supports):

| server request | our `permission_request` options | reply on `resolvePermission` |
|---|---|---|
| `item/commandExecution/requestApproval {command,cwd,itemId}` | `[{optionId:"accept"},{optionId:"acceptForSession"},{optionId:"decline"}]` (title = command) | `{result:{decision: optionId ?? "cancel"}}` |
| `item/fileChange/requestApproval {itemId,reason}` | accept / acceptForSession / decline | `{result:{decision}}` (optional `grantRoot`) |
| `item/permissions/requestApproval {…}` | derived from requested perms | `{result:{scope:"session", permissions:{…granted subset…}}}` |
| `mcpServer/elicitation/request {…}` | accept / decline | `{action: optionId, content?}` |

`optionId` from the UI maps to codex `decision`: `allow_once`→`accept`, `allow_always`→
`acceptForSession`, `reject_*`/`null`→`decline`/`cancel`. After replying, expect
`serverRequest/resolved` then `item/completed` (status `completed|failed|declined`).

### 3.5 `codex exec --json` fallback (no approvals)

```
codex exec --json -m <model> -c model_reasoning_effort="<effort>" \
  --sandbox <read-only|workspace-write> [--skip-git-repo-check] -C <cwd> "<prompt>"
```

NDJSON `ThreadEvent`s (**snake_case**): `thread.started{thread_id}`, `turn.started`,
`item.started|updated|completed{item}`, `turn.completed{usage}`, `error`. `ThreadItem` variants
(`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
`todo_list`) map to the same `SessionEventPayload`s as §3.3 (just snake_case field names). No approval
channel — only when the manager can pre-grant via sandbox. Final answer = last `agent_message.text`.

### 3.6 Model / effort enumeration (feeds discovery)

`codex app-server` `model/list {includeHidden:true}` → entries with `supportedReasoningEfforts`
(ordered), `serviceTiers`. Authoritative; cache per binary version. `codex exec` has no list command —
fall back to the curated catalog (`gpt-5.2-codex`, `gpt-5.1-codex-max`, …) + effort
`["minimal","low","medium","high","xhigh"]`.

### 3.7 Thread-operation ownership decision

The manager exposes only provider operations whose ownership and filesystem provenance are clear:

- `thread/read` validates an exact persisted thread before resume. It never imports provider turns
  into the manager timeline; the runner event log remains the display source of truth.
- `thread/fork` is available only from a manager-recorded completed-turn checkpoint. The new thread
  receives a separate isolated worktree materialized from the checkpoint's anchored tree.
- External Codex discovery/adoption continues to use the CLI transcript index. `thread/list` would
  enumerate threads owned by CLI and other clients without a manager ownership
  marker, so it is not used as a bulk import or mutation surface.
- Dashboard Archive remains a reversible control-plane view operation. It does not call provider
  `thread/archive`, which could hide or disrupt a thread still used by another Codex client.
- Deprecated `thread/rollback` is not exposed: it rewrites conversation history but not files and
  cannot satisfy the conversation-plus-worktree provenance contract. Fork is the safe history
  operation; file-only rewind remains explicitly labeled as file-only.

Provider `thread/archive` is used only as best-effort cleanup for a newly minted manager fork that
fails before the target session becomes durable. That thread is manager-owned and has no external
consumer yet.

### 3.8 Privacy-safe operational telemetry

Protocol v29 reports content-free observations for `launch`, `resume`, `approval`, `crash`, and
legacy-exec `fallback` usage. Dimensions are limited to driver, discovered version, native/WSL
context, SSH-managed versus local, outcome, a closed reason enum, and a bounded duration. The
control plane stores hourly aggregates for 180 days; it never stores raw observations or session
identifiers. `GET /api/telemetry/drivers?days=30` returns a 1-90 day aggregate window for rollout
and retirement decisions.

`crash` means an unexpected exit of a session-persistent process (currently app-server and ACP).
Claude Code and Codex exec use a process per turn; their nonzero child exits are turn failures, not
session-process crashes, and therefore do not increment this metric. Any exit of a persistent
process while its session is active counts as a crash even when the OS exit code is zero: the
unexpected loss of the session process is the measured failure.

Fallback counts are launch usages, not distinct session counts; an explicit restart of an exec
session increments the corresponding explicit/compatibility bucket again.

Never add prompts, tool inputs, paths, environment values, auth/billing data, request ids, session
ids, hostnames, or free-form error strings to this message. Exec remains an Advanced
batch/compatibility fallback for at least one release cycle. Its interactive removal requires an
explicit later decision based on these aggregates plus the platform/resume/image/remote gates.

---

## 4. AcpDriver — capability-negotiated ACP v1

`AcpDriver` wraps `apps/runner/src/acp.ts` `AcpClient`. The runner pins
`@agentclientprotocol/sdk` 1.2.1 as its generated schema/type authority while keeping its proven
NDJSON process and compatibility layer. ACP wire version remains 1: additive stable features are
capability-negotiated, not inferred from the SDK package version. An unsupported response version
fails initialization; bounded `agentInfo` and normalized stable/preview capability diagnostics are
retained without `_meta` or other arbitrary agent data. Stable agent-managed authentication methods
are retained as bounded render-only choices; draft environment-variable and terminal methods are
ignored.

The current client advertises its canonical-root filesystem service and the complete stable
terminal lifecycle. Filesystem calls are active-session/root-bound with canonical and symlink
escape checks plus 8 MiB text limits. ACP terminals are separate from dashboard shells, retain a
bounded UTF-8 output tail with atomic slot reservation and incremental accounting, constrain
environment input, scrub inherited secrets, and are reaped on release/session/process shutdown.
Polling alone is not mirrored into the transcript; byte-cursored terminal tool references emit only
new retained output, release prunes their cursors, and co-located agent content suppresses duplicates.
Process exit uses a bounded stdio-drain window so inherited descendant pipes cannot hang ACP wait.
Experimental
elicitation, providers, NES, plan operations, session fork, MCP-over-ACP, and direct HTTP/WebSocket
transports are not advertised or called. Stable session config, commands, auth, and lifecycle
features are enabled only after their UI and lifecycle semantics exist.

Mapping remains in `acp.ts`
(`session/update` → `SessionEventPayload`): `agent_message_chunk`→`agent_message`,
`agent_thought_chunk`→`agent_thought`, `tool_call`/`tool_call_update` pass through, `plan`→`plan`,
`diff` content → `file_edit`; `session/request_permission` → `permission_request`. `resolvePermission`
selects the ACP option. Credential-free conformance fixtures replay the real Claude Agent 0.58.1 and
Gemini CLI 0.50.0 initialization shapes, and a spawned mock agent covers initialize/new/prompt,
permission resolution, streaming updates, diffs, and the complete terminal lifecycle end to end.

Protocol v39 adds opt-in ACP Registry v1 discovery. The runner accepts only operator-allowlisted
ids, validates and bounds the official index, selects the local OS/architecture distribution, and
probes existing OpenCode, Cursor, and Gemini binaries without treating a manifest as executable
authorization. Uninstalled entries stay disabled and expose an install preview only. Registry
version/transport/license metadata is safe to persist; auth and capability badges remain unknown
until a live ACP initialize handshake establishes them.

Protocol v40 makes an exact-version `npx`/`uvx` Registry row runnable only after an explicit
dashboard confirmation. Authorization is a runner-local fingerprint over schema version, adapter
version, distribution kind, command, and complete argv; refresh invalidates it when any component
changes, and revocation prevents new sessions. The `npx`/`uvx` runner must resolve locally before
approval and on refresh. Approval and discovery never spawn the package.
Binary archives and unpinned packages are manual-only because Registry v1 carries no integrity
digest. Registry downloads use an exact-origin, byte-limited stream and the approval store uses
serialized atomic replacement.

Protocol v41 exposes `acpTransport: "stdio"` for configured and Registry ACP agents. Remote-shaped
agent config is a startup error, and the reserved remote feature cannot be enabled. Local, WSL, and
SSH runners all keep the ACP process runner-local. Direct Streamable HTTP/WebSocket waits on the
stabilized upstream contract and every gate in [ADR 0002](./adr/0002-keep-acp-runner-local-until-remote-transport-stabilizes.md).

When `session/new` returns ACP `auth_required`, the runner renders the advertised methods through
the existing durable input-required card. UI option ids are synthetic: provider method ids remain
inside the runner process. Selecting a method calls `authenticate`; failures replace the card with
a bounded retry state, never the raw provider error. Browser and device-code interaction stays in
the agent process on the runner host, and Wollipog never transports or stores access tokens.

For a quiescent live ACP session, the dashboard offers **Sign out** through protocol-v34+ runners.
`AcpClient.logout()` calls the stable method only when `agentCapabilities.auth.logout` was
advertised. Success refreshes the runner agent row to `unauthenticated`; a later successful
`session/new` restores `authenticated`. Provider error bodies, identities, and credentials never
enter the normalized event or runner-metadata surfaces.

ACP session ids and the stable lifecycle capability set are persisted at setup time. Process-loss
recovery prefers `session/resume`, falls back to `session/load` without duplicating replay into the
manager transcript, and refuses to manufacture a replacement conversation when neither was
advertised. Explicit stop/delete uses negotiated `session/close` before the one-process-per-session
adapter is disposed.

The external-sessions panel also probes stable ACP `session/list` on demand. Results are bound to the
exact configured adapter that returned them, and adoption re-lists that same `(agentId, sessionId)`
before trusting cwd/title or persisting launch state. The control plane waits for that authoritative
runner result before creating its cache row. Resumability comes from that live adapter's negotiated
resume/load bits; provider `_meta` and raw list errors stay runner-local.

ACP session modes and stable select config options are also session-scoped. New/resume/load responses
plus `current_mode_update` and `config_option_update` map model, thought level, and mode into the
existing controls. Writes use `session/set_config_option` / `session/set_mode` and are awaited before
the queued turn can start; a failed write drops that turn rather than running under the wrong config.
Establishment reconciles persisted values only when the new/resumed session advertises them; omitted
or narrowed controls defer to the agent's live state instead of making the session unlaunchable.
Live capabilities/config persist in the box snapshot and a protocol-v36 runtime update, so two
sessions using one configured adapter cannot overwrite each other's controls. Boolean config options
remain unadvertised until Wollipog has a provider-neutral boolean UI.

Protocol v37 also maps stable `usage_update` as the semantics ACP actually defines: `used` and
`size` are the current context-window gauge, while optional USD `cost.amount` is cumulative for the
session. The runner persists the latest gauge and a monotonic cumulative cost; it does not mislabel
these values as additive input/output tokens. Stable `session_info_update` keeps only a bounded title
and canonical activity timestamp. A provider title can replace only a generated title; explicit
user titles and conservatively migrated legacy titles win over later provider updates. Resume/load
seed persisted commands, and runtime state received during load replay is applied only after
transcript events have been suppressed.

---

## 5. Quick reference — config flag mapping across drivers

| concept | ACP | ClaudeCode | Codex (app-server) |
|---|---|---|---|
| model | select `model` config option | `--model <alias\|id>` | `thread/start.model` / `-m` |
| effort | select `thought_level` config option | `--effort low..max` | `-c model_reasoning_effort=` / `model/list` |
| approval preset | session mode or select `mode` option | `--permission-mode` | `approvalPolicy` + `sandbox` |
| slash command | advertised command rendered as `/name` prompt text | `/name` inline in prompt | `$name` / `{type:"skill"}` input item |
| approve/deny | select ACP optionId | stdio `control_response` allow/deny | reply `{decision}` to server-request |
| session resume | ACP session id | `--session-id` / `--resume` | `thread/resume {threadId}` |
| auth | per adapter | `CLAUDE_CODE_OAUTH_TOKEN` (subscription) | `~/.codex/auth.json` (ChatGPT plan) |
