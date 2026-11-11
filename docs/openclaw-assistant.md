# Connect OpenClaw to Wollipog Assistant

Refs #4466 and #4462. Tested runtime: **OpenClaw 2026.11.3 (847611d)**.
This integration uses OpenClaw's native MCP client and Wollipog's
[Assistant connection contract](assistant-connections.md). It does not install or update
OpenClaw, supply model authentication, or configure Discord.

## Prerequisites and Authority

Install OpenClaw separately and check `openclaw --version`. Its runtime requirements and
provider authentication belong to OpenClaw. A model is necessary for conversational tool use;
`mcp probe` checks connectivity without a model or Discord account. Configure provider access
only in the dedicated profile using OpenClaw's supported authentication flow. Do not copy
Wollipog session credentials or the owner's OpenClaw credentials into it.

After selecting the dedicated paths below, the owner can inspect `openclaw models list` and
`openclaw models status --check`. For the selected provider, use its supported interactive
`openclaw models auth login --provider <provider>` flow or supply its API key through a protected
runtime secret source, then select `openclaw models set <provider/model>`. Do this on the machine
running the OpenClaw runtime, with the intended agent selected when multiple agents exist.
`models status` is configuration/auth-state evidence; `models status --probe` makes a live provider
request and can incur charges. The no-model smoke below does not perform either login or probing.
Keep OpenClaw provider credentials, Wollipog Assistant credentials, connector credentials and
webhook signing keys separate; none substitutes for another.

An authenticated Wollipog organization owner issues a connection using
`POST /api/assistant-connections` with a display name and grant. The connection API returns
the credential once; use the owner's authenticated client, not an Assistant credential, for
issuance, rotation and revocation. Full Access is `{ "operations": "all", "projects": "all" }`.
The owner must explicitly authorize that standing grant. Installing a runtime does not grant
Wollipog permissions. A test-only synthetic grant is not production pairing evidence.

Full Access includes registered management operations under the owner's current authority,
including unrelated sessions and other projects. SSH, provider, operating-system and peer
compatibility requirements still apply. OpenClaw tool policy is an additional boundary:
its minimal profile hides MCP tools, and `tools.deny: ["bundle-mcp"]` disables them.

## Dedicated Local Setup

Keep state outside the source/deployment tree. Create a descriptor containing **no credentials**:

```json
[
  {
    "name": "wollipog-alpha",
    "url": "http://127.0.0.1:YOUR_TEST_PORT/assistant/mcp",
    "tokenEnv": "WOLLIPOG_ALPHA_TOKEN"
  },
  {
    "name": "wollipog-beta",
    "url": "https://second-installation.example/assistant/mcp",
    "tokenEnv": "WOLLIPOG_BETA_TOKEN"
  }
]
```

Replace the local port before using the descriptor. For normal deployments use the installation's
HTTPS URL, including when OpenClaw happens to run on the same host.
Run the profile generator with a **new absolute directory** and the descriptor file:

```sh
node scripts/openclaw-assistant-profile.mjs /absolute/private/openclaw-assistant connections.json
```

It creates owner-only directories and a mode-0600 `state/openclaw.json`; it refuses an existing
root. The MCP entries use `transport: "streamable-http"` and
`headers.Authorization: "Bearer ${WOLLIPOG_ALPHA_TOKEN}"` (or the second connection's reference).
Tokens are not written by the generator. Supply the referenced secrets through a trusted
operator-controlled process environment or private service environment file. Never put tokens
on command lines, in descriptors, source control, prompts, screenshots or diagnostic reports.

Use these paths for **every** OpenClaw command and foreground Gateway launched for this profile:

```sh
export OPENCLAW_HOME=/absolute/private/openclaw-assistant/home
export OPENCLAW_STATE_DIR=/absolute/private/openclaw-assistant/state
export OPENCLAW_CONFIG_PATH=/absolute/private/openclaw-assistant/state/openclaw.json
export OPENCLAW_WORKSPACE_DIR=/absolute/private/openclaw-assistant/workspace
export OPENCLAW_PROFILE=wollipog-assistant
cd "$OPENCLAW_WORKSPACE_DIR"
openclaw config file
openclaw mcp probe wollipog-alpha --json
openclaw mcp probe wollipog-beta --json
```

Run from the isolated workspace to avoid loading another project's dotenv or skills. The automated
smoke test additionally clears inherited environment variables. Inspect `config file` before doing
any model or channel configuration. Do not run the commands against baseline owner state.
No Gateway is needed for the probe. If a dedicated Gateway is later required, select a free port
and loopback bind; do not install a service or bind publicly as part of a smoke test. CLI MCP
probes/mutations require the Gateway owning **that dedicated state** to be stopped; never stop
the hosting Wollipog stack or another owner's Gateway to satisfy this requirement.

## Two Connections and Explicit Routing

Use short distinct lowercase server names, with independent environment references and credentials.
OpenClaw exposes tools such as `wollipog-alpha__assistant_discover` and
`wollipog-beta__assistant_discover`. Call discovery on the **explicitly requested** connection;
retain the returned immutable `controlPlane.id` and `connection.id`. Display names and tool
prefixes are selectors, not identities. If identity differs from the saved binding, stop and
have the owner verify the endpoint. Never fail over a mutation to the other installation.
Disambiguate an unspecified installation before mutating anything.

Use the selected prefix for each subsequent operation. Session/resource IDs and operation receipts
must stay associated with the discovered installation and connection. A conversation needs an
explicit authorized connection binding; shared Discord membership does not grant Full Access.
Keep the generic MCP connection restricted to owner-trusted contexts. Discord correlation and
requester-aware command ingress remain separate work in #4467. This first slice does not expose
the connection to shared Discord contexts or claim originating-conversation delivery evidence.

## Discord Setup Boundary

Follow #4467's [Assistant work and conversation setup](assistant-work-events.md) and its native
`integrations/openclaw-discord` component for Discord commands, sender policy and signed event
delivery. That component is being delivered separately; do not substitute this generic MCP setup
for it. This guide neither installs nor duplicates the connector. Once that component lands,
follow its version-specific installation/configuration instructions in the dedicated profile.

Before enabling it, the owner configures the Discord channel plugin and bot credentials, DM
pairing/allowlists, guild/channel restrictions and explicit requester/destination bindings. Use
the exact bot account and thread/channel/DM destination; DMs require
`session.dmScope: per-account-channel-peer`. Test with authorized dedicated destinations. Membership
in a shared Discord channel does not inherit the connection owner's Full Access grant.

The following is the planned contract for #4467's next slice, **not an available setup path**:
once it lands, the native connector will authenticate the actual Discord account, author and
conversation before selecting a binding-scoped connector credential. Correlated launch/follow-up
requests are planned to use `/assistant/discord/commands` with both the Assistant bearer and
`X-Wollipog-Connector-Token`. Neither that route nor header is implemented in this slice. Verify
the merged connector's instructions before configuring either. Its credential must stay in
protected native runtime configuration, outside model prompts, arguments and generic MCP tool
configuration. Trusted ingress must bind the command, digest and resolved target outside model
arguments. Model-authored requester IDs or origin fields cannot establish that binding.
Plain MCP remains valid **uncorrelated**, as tested below.
Required owner approvals retain their authenticated Wollipog resolution path.

## Equivalent Remote Setup

Use the same descriptor/profile and bearer header on the other machine, changing the endpoint to
the intended installation's reachable HTTPS `/assistant/mcp`. There is no localhost-only grant
and no requirement for campaign membership or session ancestry. Keep TLS verification enabled;
provision DNS, trust and reverse-proxy routing separately. Allow authenticated POSTs and preserve
Authorization and MCP protocol headers. Stateless JSON responses are sufficient; GET/DELETE 405
is expected. Prove discovery from the remote runtime rather than assuming local success proves it.

OpenClaw supports eligible environment proxies and mTLS. The current profile generator uses the
normal verified HTTPS path. An operator requiring mTLS can add `clientCert` and `clientKey` paths
to the isolated MCP entry after reviewing OpenClaw's transport documentation. Never disable TLS
verification to manufacture a passing remote test.

OpenClaw's `gateway.remote.*` settings connect clients to an OpenClaw Gateway; they do not select
the Wollipog MCP endpoint. If the Gateway is on another machine, put the MCP configuration and
environment secrets on the machine actually owning its runtime.

For remote event replies, follow the connector's separate signed-receiver setup. Public callbacks
require HTTPS. Private/tailnet delivery requires an owner-issued, target-specific subscription
exception as documented in [Assistant work events](assistant-work-events.md); it does not change
MCP authority or provision networking. Proxy only the intended callback path, preserve signed raw
bytes, and keep administrative OpenClaw Gateway interfaces private. The generic OpenClaw hooks
endpoint does not verify Wollipog signatures; the dedicated receiver must verify them first.

## Recovery Without Credential Disclosure

| Symptom | Recovery |
| --- | --- |
| Authentication Refused / HTTP 401 | Confirm the selected name and environment reference. The owner rotates via `/api/assistant-connections/:id/rotate` and securely replaces that connection's environment secret. Refresh its runtime and probe again. Never print the secret. |
| Revoked Connection | Stop using it. Only the owner can issue a replacement connection. Accepted work may still exist; reconcile its receipt under authorized access before retrying. |
| Operation or Project Excluded | Inspect discovery and the current grant. The owner decides whether to change authority; the Assistant cannot expand its grant. |
| Control Plane Unavailable | Restore the selected endpoint/network. Retained schemas do not prove availability. Probe after recovery; never route to another installation automatically. |
| Unsupported Runtime or MCP Version | Record the runtime version, endpoint and supported protocol without credentials. This contract negotiates MCP 2025-06-18, also accepting 2025-03-26 request headers. The smoke script refuses runtimes other than the recorded tested version until compatibility is revalidated. Runtime installation/upgrades remain operator work. |
| Stale Tools After Grant Change | Refresh tools/list or the process owning the connection. A CLI reload does not reload a separate Gateway. Execution still rechecks authorization on every call. |
| Timeout or Lost Mutation Response | Preserve the client operation ID and argument digest. Read the receipt on the same installation/connection; retrieve the resulting resource or reconcile uncertainty before resubmitting. Do not invent a fresh operation ID to bypass deduplication. |

OpenClaw deliberately reports failed calls without automatic replay when an HTTP MCP session
expires. An accepted operation can survive connection loss. The durable receipt implementation
from #4464 is required for mutation recovery; this integration does not substitute local retries
for authoritative receipts. Generic OpenClaw hook replay keys reset on restart and are insufficient
for durable work tracking. Signed Wollipog event ingress and destination authorization belong to
#4467, not to an unauthenticated generic-hook mapping.

### Reconnect and Command Receipts

Before each session mutation, durably retain its selected installation/connection, operation,
arguments and caller-generated `commandId` outside the model's transient conversation state.
Use [`command_get`](assistant-session-management.md) with that ID after timeout, restart or lost
response. A missing local response is not evidence that the command failed. Do not route receipt
lookup to another installation or generate a new ID as a transport retry.

| Receipt State | Next Action |
| --- | --- |
| `succeeded` | The service accepted the command. Read `session_get` and `session_messages` for current execution status and results. This is not proof of model completion. |
| `failed` | Inspect the recorded refusal and owner-controlled remedy. A new intentional command after correction needs its own ID. |
| `accepted`, `running` or `uncertain` | Inspect the target and supported lifecycle/command recovery. Reusing the same ID reconciles without dispatch; a new ID would create new work. |
| Missing Receipt | Recheck the exact connection/ID and the source control plane. Only after authoritative lookup succeeds and confirms no reservation may the original command be submitted with the same ID. |

Read result pages with their returned cursor even if a filtered page is empty. Retain the session's
event epoch with progress; if it changes, discard the old event cursor and reconcile the current
session before reading again. Result sharing still requires current source and destination access.
For Discord work, use the connector's own durable reconciliation and reply receipts; do not infer
Discord delivery from a hook admission, model assertion or a session's completed state.

## Reproducible Verification

From this worktree, with dependencies already installed:

```sh
node --test scripts/openclaw-assistant.test.mjs
node --import tsx apps/control-plane/scripts/openclaw-assistant-smoke.ts /absolute/path/to/openclaw
```

The smoke script starts two **test control planes** using the production Assistant Fastify routes,
operation registry and independent temporary on-disk SQLite databases. It binds only ephemeral loopback
ports, issues synthetic test credentials in memory, creates isolated temporary OpenClaw state,
and invokes the installed OpenClaw `mcp probe`. It also invokes that installed version's native
MCP runtime for launch, follow-up, status/result reads and command receipt lookup. It closes and
reopens the test control plane/SQLite, rediscovers tools and reconciles an uncertain command without
redispatch. It also covers distinct prefixed catalogs, explicit identity routing, credential rotation,
revocation, unavailable endpoints and incompatible-protocol refusal. It closes both listeners
and removes its temporary profile and databases. It neither starts nor modifies the hosting stack.

The smoke runner requires a POSIX host for process-group cleanup. It overrides the child's home,
XDG and temporary directories as well as OpenClaw's paths, without changing the invoking shell's
environment. Timeouts and output-limit failures are distinct from normal CLI exits and never count
as unavailable-peer evidence; that check requires a named `ECONNREFUSED` diagnostic. Process-group
cleanup covers ordinary wrapper descendants, not deliberate session/group escapes; the test runner
is not an OS sandbox for untrusted executables.
Interrupting an active probe with Ctrl-C or SIGTERM stops its process group, lets the smoke test
close its test listeners and remove its temporary profile, and exits with status 130 or 143.

Evidence boundaries: CLI discovery and native runtime tool calls are real installed OpenClaw
integration. Explicit discovery also uses HTTP directly to cross-check identity. The test uses
real session services and receipt storage, but its runner transport, result text and response-loss
fault are **MOCKED**. No agent executable or model is started. A `succeeded` command receipt proves
service acceptance only. This is a test assembly of production routes, not a deployed full stack.
Discord, remote TLS/host and SSH execution remain for #4468 after owner setup. Raw runtime output
is withheld because diagnostics may contain secrets.

`scripts/openclaw-assistant-call.mjs` is a no-model smoke adapter to the installed version's
`dist/agents/agent-bundle-mcp-runtime.js` (`createSessionMcpRuntime`, catalog and `callTool`).
This is an **internal, version-pinned OpenClaw interface**, not a production connector contract.
It supplies only the generated native server config to avoid unrelated plugin discovery; the
client, listing and transport code remain OpenClaw's installed implementation. It refuses another
package/version or missing export without substituting a mock/SDK fallback. Supply the real
OpenClaw executable, resolving to its package's `openclaw.mjs`, rather than an unrelated wrapper.
This adapter does not establish model tool selection, Gateway policy enforcement or native Discord
admission; its direct runtime API exercise is separate from the real CLI probe.

Configuration mutation uses #4465's [skill tools](assistant-management.md): create an unassigned
synthetic skill, add a second immutable version with `expectedRevision` and a stable `operationId`,
then verify content, revision and receipt readback after control-plane/SQLite reopen. A duplicate
operation returns the same receipt without creating a third version. The stored library mutation
and installed OpenClaw MCP calls are real; there is no assignment or runner deployment. Configuration
tools use `operationId` for mutations; reconcile it through `command_get` as `commandId` on the
same connection. This smoke verifies a skill configuration change, not automation scheduling or
skill synchronization to a real runner. Those execution/deployment outcomes remain for #4468.

## OpenClaw References

Version-matched documentation inspected from the installed 2026.11.3 package:

- `docs/tools/mcp.md` and `docs/cli/mcp/registry.md`: client discovery, caching, policy and refresh.
- `docs/cli/mcp/transports.md`: Streamable HTTP, bearer headers, environment references and TLS.
- `docs/help/environment.md`: profile/state/workspace environment contracts.
- `docs/cli/models.md`: provider selection, authentication and probe evidence limits.
- `docs/gateway/config-hooks.md`: hook auth, routing and limited replay cache.
- `docs/channels/discord/messaging.md` and `access-control.md`: conversation identity and admission.

Published equivalents: [MCP](https://docs.openclaw.ai/tools/mcp),
[transports](https://docs.openclaw.ai/cli/mcp/transports),
[environment](https://docs.openclaw.ai/help/environment),
[hooks](https://docs.openclaw.ai/gateway/config-hooks).
