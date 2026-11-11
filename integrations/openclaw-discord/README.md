# OpenClaw Native Discord Ingress

Refs #4467. This package implements the trusted OpenClaw-native half of
`POST /assistant/discord/commands`. It is not an agent tool and never takes a claimed Discord
sender from tool arguments. It registers the authorized native `/wollipog` command, bypassing the
model. The server-side authority/receipt contract is in
[Assistant Work and Conversation Events](../../docs/assistant-work-events.md).

## Supported Host and Surface Choice

The only tested and declared OpenClaw version is **2026.11.3**. The package peer/compatibility
metadata pins it, and the handler rejects another runtime version. OpenClaw explicitly calls all
plugin APIs experimental, including registrars. Test another version before widening this range.

The installed documentation and runtime were checked before choosing the surface:

- `docs/automation/hooks/event-types.md` and `writing-hooks.md`: internal `message:received`
  hooks asynchronously observe accepted dispatch. They cannot claim the message or use
  `event.messages` as a reply API. They are unsuitable for exclusive command execution.
- `docs/plugins/sdk-overview/infrastructure.md`: the requester-scoped MCP resolver carries
  trusted sender/account/channel-provider identity but no conversation. It cannot safely choose
  this conversation-bound capability, and its transport cache can last five minutes.
- `docs/plugins/sdk-overview/tools-and-commands.md` and `PluginCommandContext` in the installed
  declarations: `registerCommand`, `requireAuth:true` and `channels:["discord"]` provide an
  authorized, model-free command with native sender, account, agent, destination and thread facts.
- `docs/plugins/sdk-overview.md` and `compatibility.md`: all these APIs remain experimental;
  pin and test host versions. No custom Gateway HTTP route, message takeover, private SDK import,
  or agent-visible credential resolver is needed by this component.

Missing account, sender, agent or explicit destination fails closed. Threads select the actual
thread ID, never the parent channel. DMs require an explicit matching `user:` route; an ambiguous
DM channel ID is not guessed into a user destination. Exactly one configured binding must match.
Real Discord-native field population still needs live acceptance; synthetic contexts do not prove it.

## Isolated Owner Setup

Use a dedicated named OpenClaw profile, separate state/config paths, and a separate workspace.
Never install into or restart an existing baseline/hosting profile as part of this integration.
Configure the Discord account through OpenClaw's owner-controlled setup; no bot/model credentials
are supplied by this package. Native commands need no LLM call, but ordinary OpenClaw conversations
and the hook-driven Assistant workflow still need their own configured model authentication.

Set the documented `OPENCLAW_PROFILE`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` for this
dedicated runtime. All paths must be absolute. The handler rejects `default`/`dev`, the baseline
state directory, an active config outside that directory, or private settings outside its `private/`
subdirectory. Keep that directory owner-only. The settings file must be owner-owned, regular,
at most 64 KiB and mode 0600; reads are bounded even if the file grows.

Use the dedicated profile's configuration to load the package:

```json
{
  "tools": {"profile": "minimal"},
  "plugins": {
    "allow": ["discord", "wollipog-assistant-discord"],
    "load": {"paths": ["<absolute package directory>"]},
    "entries": {
      "wollipog-assistant-discord": {
        "enabled": true,
        "config": {
          "profile": "<dedicated profile name>",
          "configPath": "<absolute state directory>/private/wollipog-native.json"
        }
      }
    }
  }
}
```

Add the normal Discord configuration separately. Do not paste its credentials into source,
reports or this example. Configure OpenClaw's DM pairing, sender/guild/channel allowlists and
mention policy. Use `session.dmScope: per-account-channel-peer` when enabling DMs.

The handler requires the global `minimal` tool profile, no `alsoAllow`/additional `allow` entries,
no broad per-agent tool override, and no static MCP servers in this dedicated runtime. This
keeps a shared-channel model from reading the Gateway process environment with exec/filesystem
tools or bypassing requester checks through a broad owner MCP transport. A profile is not an OS
sandbox against other code running as the same user; keep its plugin/code trust boundary intact.

Issue an Assistant credential and a destination binding through the owner's Wollipog APIs.
Issue a connector credential for that binding through
`POST /api/assistant-connections/:id/discord-connectors`, explicitly selecting `session_launch`
and/or `session_prompt`. This is standing authority; only the owner can issue it. Keep credential
values in the dedicated runtime's secret environment, outside prompts, tool configuration and
the agent workspace. The private settings refer to environment names, never token values:

```json
{
  "version": 1,
  "connections": [{
    "name": "local",
    "origin": "<owner-configured HTTPS origin or literal-loopback HTTP origin>",
    "controlPlaneId": "<discovered installation ID>",
    "connectionId": "<owner-issued connection ID>",
    "assistantTokenEnv": "WOLLIPOG_NATIVE_ASSISTANT_TOKEN",
    "launchTargets": {
      "repo": {"locationId": "<authorized Location ID>", "agentId": "<runner Agent ID>"}
    },
    "bindings": [{
      "bindingId": "<owner-issued binding ID>",
      "requesterId": "<exact native Discord sender ID>",
      "accountId": "<exact receiving Discord account ID>",
      "destination": "<exact channel:thread-or-channel-ID or user:peer-ID>",
      "agentId": "<host-resolved OpenClaw agent ID>",
      "connectorTokenEnv": "WOLLIPOG_NATIVE_CONNECTOR_TOKEN"
    }]
  }]
}
```

Populate identifiers only in the private runtime file, never in committed examples. Connection
names and launch-target aliases are owner configuration. One runtime can list multiple named
control planes and bindings; identity verification uses installation/connection IDs, not names.
The `agentId` in a binding is the OpenClaw agent receiving the Discord command; a launch target's
`agentId` is the execution agent on the selected Wollipog Location. They are different namespaces.
The destination must agree with the owner-issued server binding. Shared-channel participants do
not inherit its owner's authority: another sender/account/conversation has no matching capability.

## Commands and Recovery

```text
/wollipog launch <connection> <request-id> <target-alias> <task text>
/wollipog prompt <connection> <new-request-id> <original-launch-request-id> <follow-up text>
/wollipog status <connection> <request-id>
```

Aliases and request IDs use 1–64 letters, numbers, dots, colons, underscores or hyphens. Keep the
same request ID when reconciling an interrupted request; use a new one only for new work. Work and
command IDs are deterministically derived from installation, connection, binding and the request
handle, so plugin/Gateway recreation does not make a new command identity. Prompts look up the
original confirmed launch receipt and retain its work/conversation. Unconfirmed originals are
not guessed, relaunched or silently redirected.

Before submitting a mutation, the component calls `assistant_discover` and verifies the exact
installation/connection. Every HTTP operation reloads the private binding policy and credentials,
rejects a changed configuration during the invocation, uses bounded requests, and refuses redirects.
The control plane independently rechecks current owner/grant/source/binding access and binds the
operation, argument digest and resolved target in the receipt transaction.

There is no automatic mutation retry. A timeout is uncertain; use `status` with the same request ID.
Command receipt success means the application accepted the command, not that the runner finished
the work. Native acknowledgements are generic command notices routed by OpenClaw, not final work
results or independently confirmed Discord-send receipts. A repeated invocation may repeat an
acknowledgement without repeating the mutation. The durable event/reply pipeline owns work results.

Host command authorization is admission evidence. It is not proof of future Discord membership:
delayed results must recheck current destination access and obtain actual Discord message receipts
through the separate trusted sender. This native ingress does not resolve owner approvals or turn
ordinary messages into owner approval. Rotation/revocation refuses subsequent calls; update the
dedicated runtime's secret environment through its owner-controlled configuration before resuming.

## Repeatable Evidence

```text
node --import tsx --test scripts/openclaw-discord-native.test.mjs
node scripts/verify-openclaw-discord-native.mjs <absolute installed OpenClaw package directory>
```

The second command checks the exact host version and uses `plugins inspect --runtime` in a new
temporary profile with a scrubbed child environment. It verifies `loaded`, the `wollipog` command,
and no model tools, then removes the profile. It starts no Gateway, installs no bot, copies no
baseline profile and issues no live credential. The host's `plugins validate` authoring command
supports tool/feature authoring metadata, not this generic command plugin; runtime inspection is
the supported loading/registration check here.

Recorded evidence for OpenClaw 2026.11.3: **REAL host loading/registration**, no diagnostics,
`commands:["wollipog"]`, `modelTools:[]`. Automated tests cover private profile/config checks,
forged or missing native context, threads, ambiguous bindings, policy changes during discovery,
wrong installation, uncertain delivery, and deterministic command identity. A real loopback HTTP
test uses the real Wollipog session/origin/outbox services with stubbed runner transport to prove
launch/follow-up association and duplicate suppression. Discord context in those tests is synthetic.

No real Discord user, live bot/account, remote host or SSH execution was exercised. Model auth,
Discord credentials/destinations and owner-issued integration credentials remain unconfigured in
the supplied environment. The production status sender below has automated coverage. Real
Discord access/receipt and the complete configured workflow remain unverified.

## Durable Work Updates

Build the sender bundle with `pnpm build:openclaw-discord` before loading this package. The build
reuses the runner's esbuild toolchain and bundles the existing raw-byte signature verifier,
receiver/inbox and OpenClaw hook client with Fastify; it adds no workspace runtime dependency to
the OpenClaw installation. Keep the generated `dist/bridge.mjs` beside the package when copying
it to an owner-managed isolated profile. This is an explicit build, not a managed installer or
automatic upgrade. The native command can load without the bundle when updates are disabled.

The optional `wollipog-assistant-updates` service uses OpenClaw's documented version-2 service
scheduler. It opens no socket until the protected settings contain `bridge`. It binds only
literal loopback, uses `private/wollipog-bridge.sqlite` beside those settings, and requires an
owner-only containing directory and file. SQLite uses WAL and FULL synchronization. Service stop
joins admitted work before closing the database. It never restarts the Gateway or the hosting stack.

Add these fields to the **private** settings, using the placeholders only in this example:

```json
{
  "bridge": {
    "port": 28791,
    "gatewayOrigin": "<this isolated Gateway's HTTPS or literal-loopback HTTP origin>",
    "hookTokenEnv": "OPENCLAW_ASSISTANT_HOOK_TOKEN"
  },
  "connections": [{
    "events": {
      "subscriptionId": "<owner-created Assistant subscription ID>",
      "path": "work-updates",
      "signingSecretEnv": "WOLLIPOG_ASSISTANT_EVENT_SECRET"
    },
    "bindings": [{
      "conversationId": "<exact server binding conversation ID>",
      "sessionKey": "<exact server binding OpenClaw conversation key>",
      "updates": {
        "enabled": true,
        "botTokenEnv": "OPENCLAW_DISCORD_BOT_TOKEN",
        "botUserId": "<the same OpenClaw Discord account's bot user ID>",
        "dmChannelId": "<only for a DM: its existing exact Discord channel ID>"
      }
    }]
  }]
}
```

This is a fragment: preserve the connection/binding fields in the full native-ingress example
above. No tokens or real identifiers belong in source, prompts, screenshots or reports. Issue a
binding-scoped connector credential with the explicit `work_updates` capability; launch/prompt
credentials alone cannot read private routing or confirm replies. It may include the two command
capabilities as well, or use a separate credential and dedicated binding/runtime as appropriate.
The Assistant grant must currently allow `assistant_work_read` for the source project/session.

Configure the signed subscription callback as
`http://127.0.0.1:<port>/events/<path>/wollipog/events` for a control plane on the same host. For a
remote control plane, use an owner-managed HTTPS reverse proxy/tunnel to that loopback route.
The existing per-subscription exact-private-address exception supports private-network HTTPS
targets; it creates neither reachability nor certificates. The signature covers the raw body,
and the receiver checks the installation/connection/subscription and current signing key before
durable acceptance. URL paths/installation routing are configuration, never event-provided targets.
Topology changes require an owner-managed reload of this isolated profile; a changed topology
fails closed in the old instance. Key revocation/rotation and binding policy are reloaded each call.

Configure the Gateway's dedicated bearer-authenticated `/hooks/agent` endpoint and restrict its
agent IDs/session-key prefixes to the bound agents/conversations. Admission carries only work
references, explicit agent/account/session routing and `deliver:false`. The durable wake fence is
per installation, connection, work and revision, so a signed callback and a reconciliation sweep
do not cause two admissions for the same revision. A returned run ID proves admission only.
Unknown admissions are retained and never replayed because OpenClaw's hook replay cache is volatile.

The scheduler reconciles bounded current-work pages every 30 seconds, rotates through enabled
bindings, advances persisted cursors even across filtered pages, and independently scans uncertain
receipts and pending inbox entries. Full sweeps restart at the beginning; older work changes are
observed too. Failed/revoked destinations do not monopolize the head of an inbox/reply queue.
This recovers current state after missed callbacks, restart or temporary network outage; transient
historical states are not an unlimited event history.

Before preparing a notice, before entering Discord and before confirming its receipt, the service
rechecks Wollipog source/grant/binding access, private routing configuration, current OpenClaw
account/allowlist policy, current agent/conversation resolution, and live Discord access. The bot
token must belong to the configured OpenClaw account. Guild membership/roles are fetched live;
Discord's computed member-permission endpoint supplies current channel permissions. Both requester
and bot must see/read the channel, and the bot must have the appropriate send permission. Private
threads require explicit membership for both, and archived/locked threads are refused. DM delivery
requires an existing exact DM channel with the sole bound recipient; no new DM is silently created.
There is no fallback to a parent channel, default destination, or another installation.

Delayed updates deliberately support an explicit-ID policy subset: a configured enabled account,
`groupPolicy:allowlist`, exact guild/channel entries with `enabled:true`, and the requester listed
in guild `users` (and channel `users` when present). Threads can inherit their configured parent's
allowlist while retaining the exact thread binding. DMs require `dmPolicy:allowlist` and an explicit
requester ID in effective `allowFrom`. Pairing-only, wildcard/name/role/dynamic-group policies do
not silently extend standing background authority; configure explicit IDs through owner-controlled
setup. Native inbound admission still uses OpenClaw's own `isAuthorizedSender`. Current route
resolution must reproduce the exact bound agent, account and session key or the send is blocked.

The sender emits fixed status/attention notices and supported Wollipog links, with mentions and
automatic embeds disabled. It does not export transcripts, task text, arbitrary model output or
result summaries. Attention notices explicitly require the supported Wollipog answer/approval
path. They cannot answer an owner approval from ordinary chat.

Reply reservation is centralized in Wollipog before any message send. A local durable journal
records the channel and deterministic nonce before Discord. Only an actual matching Discord
message ID can confirm a reply. A lost send response searches at most 100 recent messages for the
exact nonce, bot and channel; an unresolved match remains uncertain and is never blindly resent.
A known message ID survives a control-plane outage and is read back from Discord before retrying
confirmation. The short Discord nonce window is supplemental, not an exactly-once guarantee.
Readback that is unavailable, too old, ambiguous or no longer authorized requires explicit owner
review; do not allocate a new reply/work ID to bypass uncertainty. Permission revocation cannot
recall an already sent message, and cross-service checks cannot eliminate every last-moment race.
A lost reply-reservation response, or a crash between CP reservation and the local journal write,
also remains uncertain. The two databases and Discord do not share an atomic transaction; this
implementation favors suppressing a possible duplicate over silently retrying an unproven send.

Diagnostics contain bounded event/reason labels only. Inspect local wake/reply state and the
control plane's bounded delivery journal privately; never publish raw rows, configuration, keys,
message bodies or private destination coordinates. The binding-scoped APIs are:

- `GET /assistant/discord/work?after=<returned cursor>`
- `GET /assistant/discord/work/:workId`
- `POST /assistant/discord/work/:workId/replies` with `action:begin` or `action:confirm`, the exact
  revision, and a Discord message ID for confirmation.

They require both current Assistant bearer and out-of-model connector credential. They are not
model-callable receipt tools and grant no owner-approval authority.

Discord protocol references: [channel member permissions](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx#get-channel-member-permissions),
[thread access](https://github.com/discord/discord-api-docs/blob/main/developers/topics/threads.mdx),
and [message nonce/receipts](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx#create-message).
Automated tests use synthetic Discord responses against the actual CP/store/receiver/sender code,
including private threads, DMs, lost responses, confirmation outages, revocation and wrong routes.
They do not establish live bot permissions or successful real Discord delivery.
