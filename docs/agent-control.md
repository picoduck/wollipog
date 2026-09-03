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
wollipog session create --runner ID --agent ID (--workspace ID | --path PATH) [--prompt TEXT] --json
wollipog session prompt ID TEXT --json
wollipog session wait ID [--for STATE,...] [--timeout MS] [--interval MS] --json
wollipog session stop ID --json
```

Claude Code launches also receive an additive `wollipog` stdio MCP configuration. Both adapters
execute the existing manager tool table, including bounded output projection and `wait_session`, so
their schemas, self-targeting checks, and REST paths cannot drift.

## Authorization and compatibility

The general surface has the same closed method-and-canonical-route allowlist as the conductor
manager. The control plane converts a valid exact-session claim into an `AgentPrincipal`, applies
the session's delegated resource scope, and records authorized mutations in the content-free
mutation audit under that session id. New API routes remain denied until explicitly added.

The CLI reads `/healthz` before a command and rejects a control plane older than protocol v100.
Runners connected to older control planes do not inject the general surface. Conductor discovery,
launch gating, default permission-mode clamp, and legacy manager credential remain unchanged.

See [Using Wollipog](../.agents/skills/using-wollipog/SKILL.md) for the compact agent-facing skill.
