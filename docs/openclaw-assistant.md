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
Use #4467's [Assistant work and conversation connector](assistant-work-events.md) for
Discord-originated commands and signed event/reply delivery. That component owns the OpenClaw-side
correlation and event receiver; this guide configures the generic MCP connection only.

Discord-originated commands correlate with work only through #4467's trusted ingress. At
composition, that ingress supplies `hooks.authenticatedOrigin(receipt)` after authenticating the
requester and binding the connection, operation, argument digest and resolved target. Model-supplied
tool arguments, conversation IDs, requester IDs or JSON origin fields cannot establish this binding.
Do not ask the model to copy an origin into a tool call as a substitute for authenticated ingress.
Plain MCP commands remain valid without Discord correlation; the smoke test below deliberately
uses this uncorrelated path and does not claim originating-conversation delivery evidence.

The trusted connector calls `/assistant/discord/commands` with both an Assistant bearer and a
separate binding-scoped `X-Wollipog-Connector-Token`. It must authenticate the actual Discord
account, requester and conversation before selecting that credential. Connector credentials stay
in protected native runtime configuration, outside model prompts, arguments and MCP tool
configuration. Do not add the connector credential to the generic MCP entries generated here.
Keep the broad generic MCP connection restricted to owner-trusted contexts; shared Discord contexts
must use the requester-aware connector rather than receiving that connection's authority directly.

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

## Reproducible Verification

From this worktree, with dependencies already installed:

```sh
node --test scripts/openclaw-assistant.test.mjs
node --import tsx apps/control-plane/scripts/openclaw-assistant-smoke.ts /absolute/path/to/openclaw
```

The smoke script starts two **test control planes** using the production Assistant Fastify routes,
operation registry and independent in-memory SQLite databases. It binds only ephemeral loopback
ports, issues synthetic test credentials in memory, creates isolated temporary OpenClaw state,
and invokes the installed OpenClaw `mcp probe`. It exercises real MCP initialization/discovery,
distinct prefixed catalogs, direct HTTP discovery calls/identity routing, credential rotation,
revocation, unavailable endpoints and incompatible-protocol refusal. It closes both listeners
and removes its temporary profile. It neither starts nor modifies the hosting stack.

Evidence boundaries: prefixed discovery is real OpenClaw integration; explicit discovery tool
calls use HTTP directly, not model tool selection. This test does not execute a provider/model,
Discord, remote TLS, remote host or SSH runner. It is a test assembly of production routes,
not a deployed full-stack installation. It prints categorical outcomes and withholds raw runtime
output because diagnostics may contain secrets.

Session launch, follow-up, status/result retrieval, configuration mutation and durable receipt
reconciliation are **pending #4464/#4465 integration**. Those steps must be added to this smoke
test as their production registrations land; the current script explicitly reports them pending.
Do not treat discovery success as completion of those acceptance criteria.

## OpenClaw References

Version-matched documentation inspected from the installed 2026.11.3 package:

- `docs/tools/mcp.md` and `docs/cli/mcp/registry.md`: client discovery, caching, policy and refresh.
- `docs/cli/mcp/transports.md`: Streamable HTTP, bearer headers, environment references and TLS.
- `docs/help/environment.md`: profile/state/workspace environment contracts.
- `docs/gateway/config-hooks.md`: hook auth, routing and limited replay cache.
- `docs/channels/discord/messaging.md` and `access-control.md`: conversation identity and admission.

Published equivalents: [MCP](https://docs.openclaw.ai/tools/mcp),
[transports](https://docs.openclaw.ai/cli/mcp/transports),
[environment](https://docs.openclaw.ai/help/environment),
[hooks](https://docs.openclaw.ai/gateway/config-hooks).
