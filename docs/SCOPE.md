# SCOPE — Native-CLI parity for Wollipog

Status: design / planning. Companion: [`docs/DRIVERS.md`](./DRIVERS.md) (concrete CLI driver specs + the `Driver` interface).

## 0. Goal

Reach parity with — and beat — the **native** Claude Code "Remote Control" and Codex "remote
connection" harnesses, by driving the native CLIs directly instead of only ACP:

- Model selection, reasoning-effort selection, slash commands, streaming, tool calls, approvals.
- **Subscription Claude must work by driving the `claude` binary itself** (the ACP adapter steers
  you toward a Console API key, which we want to avoid). `claude -p` honors the logged-in Pro/Max
  OAuth, so a native driver unlocks subscription users.
- The runner **discovers** which agents are installed on each machine instead of trusting a static
  `runner.config.json` list.

## 1. Where we are today (grounded in the source)

- **Transport is ACP-only.** `apps/runner/src/acp.ts` (`AcpClient`) wraps a JSON-RPC peer
  (`jsonrpc.ts`) over a spawned agent's stdio and translates ACP `session/update` notifications +
  agent→client requests (`session/request_permission`, `fs/*`) into the normalized
  `SessionEventPayload` union (`packages/protocol/src/index.ts`).
- **`SessionManager` (`session-manager.ts`) is coupled to `AcpClient` directly.** It `new
  AcpClient(...)`, then calls `initialize()`, `newSession()`, `prompt()`, `cancel()`,
  `resolvePermission()`, `dispose()`. This is the seam we generalize.
- **Agents are static.** `RunnerMetadata.agents: AgentDefinition[]` is built from
  `runner.config.json` in `apps/runner/src/index.ts` (`config.ts`). No probing, no
  capabilities. `runner.config.example.json` lists `claude-code`/`codex` via the ACP adapters
  (`npx -y @agentclientprotocol/claude-agent-acp`, `…/codex-acp`).
- **No capability concept anywhere.** `AgentDefinition` is `{id,name,command,args,env}`. The DB
  (`db.ts`) persists exactly that per `runner_agents` row. The UI (`NewSessionDialog.tsx`) lets the
  user pick runner → workspace → agent and nothing else. There is no model, effort, or slash-command
  surface in the protocol, DB, control plane, or UI.
- **`spawn.ts` already solves the hard cross-platform problems** we will reuse for both discovery and
  CLI drivers: `shell: isWindows` for `.cmd`/`.ps1` shims, `killTree` via `taskkill /T /F` on Windows
  vs `SIGTERM`→`SIGKILL` on POSIX.
- **Worktrees** (`worktree.ts`) and the reconnect/outbox machinery (`index.ts`, `sessions.ts`) are
  transport-agnostic and stay as-is.

## 2. Target architecture — the Driver abstraction

Introduce a **`Driver`** interface (full TypeScript in `docs/DRIVERS.md` §1) that captures exactly
what `SessionManager` needs from an agent connection: `initialize`, `newSession`, `prompt`,
`cancel`, `resolvePermission`, `dispose`, plus an event/exit callback surface. `SessionManager`
talks only to `Driver`; it never references `AcpClient` again.

```
SessionManager
   │  creates a Driver from the launch spec (driver kind chosen by the spec)
   ▼
Driver (interface)
   ├── AcpDriver         → wraps today's AcpClient verbatim (zero behavior change)
   ├── ClaudeCodeDriver  → drives `claude -p --output-format stream-json …` (subscription Claude!)
   └── CodexDriver       → drives `codex app-server` (JSON-RPC) [+ `codex exec --json` fallback]
```

Every driver emits the **same** normalized `SessionEventPayload` stream the control plane and UI
already consume, so the entire upstream (hub, DB, web) is untouched except for additive capability
fields. The driver mapping tables (agent event → `SessionEventPayload`) live in `docs/DRIVERS.md`.

### 2.1 Driver selection

`SessionLaunchSpec` gains a `driver: "acp" | "claude-code" | "codex"` field (default `"acp"` for
back-compat). `SessionManager.start()` switches on it:

```ts
const driver = makeDriver(spec, callbacks); // factory in apps/runner/src/drivers/index.ts
```

The factory (`apps/runner/src/drivers/factory.ts`) reads `spec.driver`, `spec.model`,
`spec.effort`, `spec.permissionMode`, and constructs the right driver. Discovery decides which
driver an installed agent uses (`AgentDriverKind`), so the user's agent choice already implies a
driver.

### 2.2 Files

```
apps/runner/src/drivers/
  driver.ts        # the Driver interface + shared types (StopReason, DriverCallbacks)
  factory.ts       # makeDriver(spec, cb): Driver
  acp-driver.ts    # AcpDriver implements Driver — thin wrapper over existing AcpClient
  claude-code.ts   # ClaudeCodeDriver — native `claude` stream-json
  codex.ts         # CodexDriver — native `codex app-server` JSON-RPC
apps/runner/src/discovery/
  discover.ts      # probe pass: resolve binaries, version, capabilities
  resolve.ts       # cross-platform PATH/npm/shim/WSL resolution (uses spawn.ts patterns)
  capabilities.ts  # per-agent model/effort/slash-command enumeration (CLI query / disk scan / curated)
  catalog.ts       # curated fallback tables (claude aliases+effort, codex models+effort, …)
```

`apps/runner/src/acp.ts` stays; `acp-driver.ts` adapts it. `session-manager.ts` loses its direct
`AcpClient` import and depends on `Driver`/`makeDriver` only.

## 3. Protocol additions (`packages/protocol/src/index.ts`)

Additive only; bump `PROTOCOL_VERSION` 2 → 3. (Full type bodies in the structured output and
`docs/DRIVERS.md`.)

- `type AgentDriverKind = "acp" | "claude-code" | "codex"`.
- **Capabilities** on a discovered agent:
  ```ts
  interface AgentModel { id: string; displayName?: string; default?: boolean }
  interface AgentSlashCommand { name: string; source: "builtin"|"user"|"project"|"plugin"; description?: string }
  interface AgentCapabilities {
    models: AgentModel[];
    effortLevels: string[];               // e.g. ["low","medium","high","xhigh","max"]; [] if none
    slashCommands: AgentSlashCommand[];
    supportsImages: boolean;
    supportsApprovals: boolean;
    permissionModes?: string[];           // claude: default|acceptEdits|plan|…; codex: untrusted|on-request|never
  }
  ```
- **`AgentDefinition` extended** (back-compat: all new fields optional):
  `driver?: AgentDriverKind`, `displayName?`, `version?`, `available?`, `authStatus?:
  "authenticated"|"unauthenticated"|"unknown"`, `context?: { kind:"native" } | { kind:"wsl"; distro:string }`,
  `capabilities?: AgentCapabilities`, `source?: "config"|"discovered"`, `probedAt?: number`,
  `error?: string`.
- **Session config** carried into a launch + remembered per session:
  ```ts
  interface SessionConfig {
    model?: string;            // resolved model id/alias
    effort?: string;           // reasoning effort level
    permissionMode?: string;   // approval preset (claude permission-mode / codex approvalPolicy)
  }
  ```
  Added to `SessionLaunchSpec` (with `driver: AgentDriverKind`), `StartSessionMessage`,
  `CreateSessionRequest`, `CreateRunRequest`, and surfaced on `SessionView`
  (`model`/`effort`/`permissionMode`/`driver`).
- **Slash-command invocation.** Slash commands are passed *inline in the prompt text* for both native
  CLIs (`claude -p` expands `/name`; codex skills via `$name` / skill input item). No new wire
  message is strictly required — but add an optional `slashCommand?: string` to `PromptSessionMessage`
  so the UI can record "this turn was a command" and the driver can format it correctly per agent.
- **Discovery / rediscover commands.** Add `RediscoverMessage` (`ControlPlaneToRunner`) so the UI can
  force a re-probe, and let `RegisterMessage.runner.agents` already carry the discovered shape
  (capabilities ride along on `AgentDefinition`). Optionally a dedicated `AgentsUpdatedMessage`
  (`RunnerToControlPlane`) so a runner can push a fresh discovery result without re-registering.
- **New session events** for richer native output (additive to `SessionEventPayload`):
  `{ kind: "reasoning"; text: string }` (codex reasoning summaries / claude thinking — today thoughts
  reuse `agent_thought`, keep that), `{ kind: "token_usage"; inputTokens; outputTokens;
  cachedInputTokens?; costUsd? }`, `{ kind: "available_commands"; commands: AgentSlashCommand[] }`
  (claude `available_commands_update` / codex skills list, currently ignored in `acp.ts`).

## 4. Discovery design

A probe pass on the runner replaces/augments the static `agents[]`. See `docs/DRIVERS.md` for the
exact version/auth/capability commands; the design:

1. **Candidate set.** Known agent ids: `claude-code` (bin `claude`), `codex`, plus the existing ACP
   ids (`gemini-cli`, `openclaw`, `hermes`, `mock`). Config entries are merged in with
   `source:"config"` and **win on conflict** for `command`/`args`/`env` (preserve user overrides like
   `OPENCLAW_GATEWAY_TOKEN`); discovery adds `source:"discovered"` entries for anything found that
   isn't configured.
2. **Resolve the binary** (`resolve.ts`), first hit wins: OS PATH resolver (`command -v` / `where.exe`
   — never `which` on Windows) → npm global bin (`npm prefix -g`) → common install dirs (`~/.local/bin`,
   `~/.bun/bin`, `/opt/homebrew/bin`, Volta/fnm/asdf/nvm shims, Windows `%LOCALAPPDATA%\npm`, native
   `~/.local/bin/claude`) → **login-shell fallback** `bash -lc 'command -v claude'` (sources
   `~/.bashrc`/nvm; the daemon runs non-login so version-manager PATHs are otherwise invisible). On
   macOS launchd, include brew dirs explicitly + prefer the `-lc` fallback.
3. **WSL contexts** (Windows host): enumerate distros via `wsl.exe --list --quiet` (decode **UTF-16LE,
   strip NULs**), probe inside each with `wsl.exe -d <distro> -- bash -lc 'command -v claude'`. One
   physical agent reachable both natively and via WSL produces **two** `AgentDefinition` entries
   differing only in `context`/`command`/`args` (launch becomes `wsl.exe -d <distro> -- claude …`;
   `killTree` for that session must `wsl.exe -d <distro> -- kill`, since `taskkill` only sees the
   `wsl.exe` host).
4. **Confirm + version** with a 2–5 s timeout (`claude --version`, `codex --version`). Non-zero/timeout
   ⇒ `available:false` + `error`, not "absent".
5. **Capabilities** (`capabilities.ts`), prefer structured query → disk scan → curated table:
   - Models: claude — curated aliases (`opus|sonnet|haiku|fable|best|default`) from `catalog.ts`;
     codex — `codex app-server` `model/list` (authoritative, carries per-model
     `supportedReasoningEfforts`), else curated.
   - Effort: claude `["low","medium","high","xhigh","max"]` (gate by model in the UI); codex
     `["minimal","low","medium","high","xhigh"]` (or per-model from `model/list`).
   - Slash commands: scan `~/.claude/{commands/*.md,skills/*/SKILL.md}` + project `.claude/…` +
     plugins for claude; `~/.codex/prompts/*.md` / `skills/list` for codex; built-ins curated.
   - Auth: `claude auth status --json` (exit 0 = authenticated); `codex login status` (exit 0).
6. **Cache** keyed by `(path, mtime)`; re-probe on a timer (few min) and on `rediscover`. Bounded
   concurrency + per-probe timeout so one hung agent can't stall the pass. Use `execFile` (no
   `shell:true`) for probes, mirroring `spawn.ts`'s `shell:isWindows` only when the resolved target is
   a `.cmd`/`.ps1` shim.

Result: each entry is the extended `AgentDefinition` (§3) with `driver`, `context`, `version`,
`available`, `authStatus`, `capabilities`, `source`, `probedAt`. The runner advertises these on
`register` and on `AgentsUpdatedMessage`; the control plane persists capabilities (new
`runner_agent_caps` column or table) and includes them in `RunnerView.agents`.

## 5. UI features (`apps/web/src`)

- **Model picker + effort picker** in `NewSessionDialog.tsx`: when the selected agent has
  `capabilities.models`/`effortLevels`, show dropdowns (effort options gated by selected model for
  claude). Persist into `CreateSessionRequest.config`. Same in `NewRunDialog.tsx` per-agent.
- **In-session model/effort switcher** on `SessionDetail.tsx` (mirrors Codex IDE picker): change for
  the next turn; sends `SessionConfig` with the prompt (drivers re-spawn/`--resume` with the new
  `--model`/`--effort` or set codex `turn/start.model`).
- **Approval-mode presets** (Codex-style Chat / Agent / Agent-Full-Access ↔ claude
  default/acceptEdits/bypass): a small segmented control on the dialog, stored as
  `permissionMode`.
- **Slash-command palette**: a `/`-triggered autocomplete in the prompt box driven by
  `capabilities.slashCommands` (+ live `available_commands` events), inserting `/name` (claude) or
  `$name` (codex skills) into the prompt; show `description` and `argument-hint`.
- **Discovery view**: extend `RunnersView.tsx` to list each runner's discovered agents with version,
  driver kind, `authStatus` (green/red dot), context (native vs `wsl:<distro>`), available/broken
  state, and a **Rediscover** button (fires `RediscoverMessage`). Surface "not authenticated — run
  `claude setup-token`" hints.
- **Card chrome**: show model + effort badges on board cards (`Board.tsx`) and in
  `SessionDetail.tsx` header.

## 6. Parity / polish backlog (from the desktop research, post-MVP)

Tracked but out of the core driver scope: cross-surface live sync, auto-reconnect (already partially
present via the outbox), per-session worktree toggle at runtime, push notifications with
presence-aware suppression, smart auto-titling, diff-with-inline-comments, QR pairing, biometric
trusted-device step-up, bidirectional handoff with worktree transfer, token-usage/cost display.

## 7. Phased execution plan (ordered by value)

**Phase 0 — Driver seam (no behavior change).** Extract the `Driver` interface; make `AcpDriver` wrap
`AcpClient`; route `SessionManager` through `makeDriver`. Add `driver?` to `SessionLaunchSpec`
(default `"acp"`). Files: `drivers/{driver,factory,acp-driver}.ts`, `session-manager.ts`,
`packages/protocol/src/index.ts`. Effort: **S–M**. Deliverable: identical behavior, all ACP agents
still work, seam in place.

**Phase 1 — ClaudeCodeDriver (unblocks subscription Claude — highest value). SHIPPED** (03ac6cc,
hardened by 1e3a6c1, `auto` mode in af49819). Drives `claude -p --output-format stream-json
--verbose --include-partial-messages`, one process per turn with a pinned
`--session-id`/`--resume`. Interactive approvals use `--permission-prompt-tool stdio` — the CLI's
own control protocol (`control_request` frames on stdout, `control_response` answers on stdin) — no
bundled MCP server; the asks ride the stdout/stdin the runner already owns, so native Windows and
WSL (NAT or mirrored) behave identically. Maps stream-json → `SessionEventPayload` (table in
`docs/DRIVERS.md`). Wires `--model`/`--effort`/`--permission-mode` from `SessionConfig`. Auth via
`CLAUDE_CODE_OAUTH_TOKEN` (subscription). Files: `drivers/claude-code.ts`, `factory.ts`, protocol
`SessionConfig`. Effort: **L**. Deliverable: subscription Claude sessions with streaming, tool
calls, approvals, model/effort.

**Phase 2 — Discovery + capability advertisement.** Probe pass, binary resolution (PATH/npm/shim +
login-shell fallback), version/auth, curated+scanned capabilities; advertise extended
`AgentDefinition`; persist in DB; `RediscoverMessage`. Files: `discovery/*`, `runner/src/index.ts`,
`config.ts`, protocol caps types, `control-plane/{db,sessions,index}.ts`. Effort: **L**. Deliverable:
agents auto-detected with versions + capabilities; static config becomes optional override.

**Phase 3 — CodexDriver (native).** Drive `codex app-server` JSON-RPC: `initialize`/`initialized` →
`thread/start` → `turn/start`; map item/turn notifications → events; answer
`item/*/requestApproval` server-requests. `model/list` feeds capabilities. `codex exec --json`
fallback for no-approval batch. Files: `drivers/codex.ts`, `factory.ts`, `discovery/capabilities.ts`.
Effort: **L**. Deliverable: native Codex (ChatGPT-plan auth) with approvals, models, effort.

**Phase 4 — UI capability surfaces.** Model/effort/approval-mode pickers (new-session + new-run +
in-session), slash-command palette, discovery view with rediscover + auth hints, card badges. Files:
`web/src/components/{NewSessionDialog,NewRunDialog,SessionDetail,RunnersView,Board}.tsx`, `api.ts`,
`store.tsx`. Effort: **M–L**. Deliverable: full native-parity controls in the web UI.

**Phase 5 — WSL contexts + token/cost + polish.** WSL distro enumeration + `wsl.exe` launch/kill
rewrite per-context; `token_usage` events + cost badges; `available_commands` live updates; auto-title
from first message. Files: `discovery/resolve.ts`, `drivers/*`, `spawn.ts` (context-aware kill),
protocol, UI. Effort: **M**. Deliverable: cross-context discovery + usage telemetry.

## 8. Risks

- **CLI wire-format drift.** stream-json assistant/user/result field names and codex app-server schema
  are version-locked. Mitigation: tolerate extra/optional fields; for codex regenerate types via
  `codex app-server generate-ts`; pin/test against installed binary versions; keep curated fallbacks.
- **Auth ambiguity.** `claude -p` always uses `ANTHROPIC_API_KEY` when present (must `unset` to fall
  back to subscription); `--bare` ignores `CLAUDE_CODE_OAUTH_TOKEN`. Codex env-vs-`auth.json`
  precedence is underspecified. Mitigation: control env per spawn; prefer `CLAUDE_CODE_OAUTH_TOKEN`,
  do not pass `--bare`; pin codex `forced_login_method`.
- **The claude stdio control protocol is the undocumented Agent SDK channel** — a CLI update could
  reframe `control_request`/`control_response` silently. Mitigation: the driver's unrecognized-ask
  canary (stderr note + auto-decline error reply, so a turn never parks silently), pinned
  frame-level unit tests, and the shelved MCP fallback design in `docs/DRIVERS.md` §2.5. An
  unanswered ask parks the session in `input_required` with no timeout — deliberately.
- **Windows shim/`wsl.exe` kill semantics.** `taskkill` won't reach Linux children under `wsl.exe`.
  Mitigation: context-aware `killTree`.
- **Discovery false negatives** from non-login-shell PATH. Mitigation: login-shell fallback + direct
  shim-dir stats.
- **DB/protocol migration** for capabilities. Mitigation: additive columns, `PROTOCOL_VERSION` bump,
  all new fields optional.
- **Per-session model/effort change** requires re-spawn/`--resume` (claude) or new `turn/start`
  (codex); mid-turn switches are not always possible. Mitigation: apply on next turn only.
