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
the supplied environment. The full delayed event/result sender and real Discord access/receipt
integration remain separate acceptance work; this package does not claim that they passed.
