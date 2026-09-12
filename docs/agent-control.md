# Agent Control CLI and MCP

Wollipog protocol v100 gives each native host session a purpose-specific control credential. The
runner stores the plaintext in a mode-0600 session file, sends only its SHA-256 digest to the
control plane, and waits for an exact positive acknowledgement marker before the CLI or MCP server
makes its first request. Stopping the session makes the credential unusable; deleting it cascades
the hash row and removes runner-local credential/config files.

The runner injects these non-transcript environment values at launch:

- `WOLLIPOG_CONTROL_PLANE_URL`: HTTP origin for the session's control plane.
- `WOLLIPOG_SESSION_ID`: the principal and ownership scope of every request.
- `WOLLIPOG_SESSION_TOKEN_FILE`: protected bearer source; never pass its contents in argv.
- `WOLLIPOG_SESSION_CREDENTIAL_READY_FILE`: runner/control-plane registration fence.
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
wollipog session create --runner ID --agent ID (--workspace ID | --path PATH) [--prompt TEXT] [--cost-budget USD] [--max-tool-calls N] [--max-child-sessions N] --json
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
wollipog admin <pairing-url|status|user list|device list|device create|device revoke|runner-credential ...> [--json]
wollipog service <install|status|restart|logs|uninstall> [options]
```

`wollipog admin` is host administration for an SSH operator on the control-plane machine. It
authenticates with the control plane's protected local credential over loopback instead of a
session or device token and is documented in [host administration](./host-administration.md).
`wollipog service` manages the Linux systemd deployment; see [headless deployment](./headless-deployment.md).

An injected session defaults worktree commands to its own id and cannot override that target.
Paired-device and conductor callers may supply `--session`. A create without `--base` fetches and
resolves the remote default branch. Create, attach, and select return the selected absolute path;
the already-running provider process keeps its original operating-system cwd, so it must use the
returned path explicitly during that turn. A later resume or restart launches in the selection.
Discard is intentionally fail-closed: it removes only an inactive runner-owned tree with a clean
status and no commits ahead of its configured upstream. If a merged pull or merge request's remote
branch has already been deleted, its forge-verified head OID can replace the missing upstream proof
only when it exactly matches the local branch head. Attached, active, dirty, other upstream-less,
unpushed, branch-drifted, and Git-unavailable worktrees are retained. The runner applies the same
checks during startup and periodic reconciliation after a linked change request is definitively
merged or closed; an unavailable forge keeps the durable open linkage unchanged.

Discard is the only supported way to retire a runner-owned worktree. `git worktree remove` bypasses
every check above and leaves the session selecting a path that no longer exists, so agent cleanup
workflows must not use it for a session-linked path. A retained worktree is reported with the reason
it was kept, including the tree the requesting session is itself running in; that is a deferral to
reconciliation, not a failed cleanup.

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
concurrent live children and accepts zero through 64. Completed, failed, stopped, and archived
children release live slots, while their lifetime usage reservations remain charged to a finite
parent. Live cost/tool edits require delivery to an online current runner and fail closed rather
than leaving control-plane and runner thresholds out of sync.

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

The general surface has the same closed method-and-canonical-route allowlist as the conductor
manager. The control plane converts a valid exact-session claim into an `AgentPrincipal`, applies
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
complete target-local launcher contract. Conductor discovery,
launch gating, default permission-mode clamp, and legacy manager credential remain unchanged.

See [Using Wollipog](../.agents/skills/using-wollipog/SKILL.md) for the compact agent-facing skill.
