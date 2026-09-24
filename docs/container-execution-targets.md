# Container execution targets

Container targets are opt-in runner placements for reproducible, secret-free agent environments.
They are distinct from agent drivers: a configured target may launch any compatible native-context
agent id whose command is present in the image. Protocol v61 carries the exact checked template into
the session as immutable provenance.

## Configuration

The runner accepts up to 16 `containerTargets`. Images must already exist locally and use an immutable
`name@sha256:<digest>` reference. The runner never pulls or builds an image.

```json
{
  "containerTargets": [
    {
      "id": "offline-tools",
      "name": "Offline tools",
      "revision": 1,
      "runtime": "docker",
      "image": "registry.example/wollipog/offline-agent@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "network": "deny",
      "agentCommands": {
        "local-acp": {
          "command": "/usr/local/bin/local-agent",
          "args": ["--acp"]
        }
      },
      "setupChecks": [
        { "name": "agent", "command": "/usr/local/bin/local-agent", "args": ["--version"] },
        { "name": "git", "command": "git", "args": ["--version"] }
      ]
    }
  ]
}
```

`id` is stable kebab-case identity. Increment `revision` whenever the intended environment changes.
`agentCommands` maps existing runner agent ids to their in-image command and configured base args;
driver-added dynamic args are appended at launch. Host executable paths and host-only configured args
do not cross the container boundary. Setup checks are ordered argv arrays, not shell fragments.

For protocol v176 and newer, `alternateCommands` may map an existing agent id to up to eight
additional absolute executable paths with optional base args. The primary `agentCommands` entry is
also a candidate. On startup and explicit Rediscover, the runner resolves each entry inside the
digest-pinned image using a bounded, network-free, read-only container, then invokes the resolved
executable with `--version` through the same boundary. Entries with the same resolved executable
and base args are deduplicated within that target. The target id is part of each opaque installation
id, so matching paths in two images cannot substitute for each other. A candidate that cannot be
resolved or version-probed is not selectable; ordinary legacy target launches keep their configured
primary command. For known Claude Code and Codex agents, the runner also executes read-only,
non-interactive status and help commands through that same absolute executable in the pinned image.
The probes have no workspace mount, network, injected host environment, or interactive stdin; each
has a five-second deadline and 64 KiB output limit. Provider-native results can establish local
authentication readiness or a specific help contract, and Machine settings show the probe method.
An unsupported, ambiguous, timed-out, or generic agent probe stays `unknown`. Configured arguments
that can change provider settings also suppress the status claim. A local status check does not
guarantee that credentials will remain valid when a later session contacts the provider. Machine
settings retain an explicit selection if rediscovery loses it; new launches fail until another
candidate is selected. Probe containers carry runner labels
and deterministic names so a timed-out probe can be forcibly removed and startup reconciliation can
find any survivor.

`network: "deny"` becomes runtime network `none`. `network: "bridge"` uses the runtime's ordinary
bridge and is advertised as a policy boundary, not as filtered egress. Setup checks always use no
network, including for a bridge-enabled target.

## Readiness and provenance

Before its first control-plane registration, the runner:

1. resolves the selected Docker or Podman client natively and verifies its actual engine identity;
2. removes bounded, validated container ids carrying that runner's ownership label from a previous
   crashed process;
3. runs `image inspect` on the exact digest without pulling;
4. runs every setup check in the pinned image with no network, no implicit image pull, a read-only
   root, all capabilities dropped, `no-new-privileges`, a PID limit, and private `/tmp` tmpfs.

Setup checks launch the runtime client with an explicit minimal environment and a temporary client
config directory. Local Docker contexts are reduced to Unix socket or Windows named-pipe endpoints.
The runner probes the resolved command rather than trusting its filename. A `docker` wrapper that
executes Podman, or a Docker CLI connected to a Podman API engine, is unavailable as a Docker target;
configure a Podman target so its defaults and proxy guards apply. Unrecognized engine identities
remain unavailable before any container launch.
Immediately before each session container client spawn, including later setup commands and terminals,
the runner checks that the effective command still identifies the configured runtime. For Docker it
also checks the engine behind the pinned local endpoint, using the same private client config and
environment as the pending launch. A command reporting the wrong runtime, a Podman or unrecognized
Docker server, or a failed identity probe blocks the launch without exposing probe output. Restart
the runner after changing the runtime command or endpoint to repeat the full readiness checks.
Rootless Podman keeps its home, local image/runtime directories, and storage configuration file so
its existing image store remains usable. The runner verifies that the configured Podman client is local
before isolating general Podman container config. Docker client config is isolated. Other
host variables and credentials are not inherited by the setup-check client or container.
Podman ordinarily copies its client's proxy variables into every container. Wollipog passes
`--http-proxy=false` on Podman setup checks, installation probes, and session launches so
those host values do not enter a target advertising `secrets: "none"`. A trust-gated repository
setup variable explicitly forwarded with `--env NAME` remains an intentional exception.
Docker CLI `config.json` can also inject proxy variables, including credentials in proxy URLs,
into new containers. Docker setup checks, installation probes, providers, and terminals use an
empty runner-owned CLI config and a verified local engine endpoint. No empty proxy override is
passed to `docker run`, so proxy values deliberately built into the digest-pinned image remain
available. In particular, an uppercase-only image value is not shadowed by an empty lowercase
value. The image operator must keep proxy values free of credentials to maintain the target's
secret-free claim. Repository setup reserves HTTP, HTTPS, ALL, and NO proxy variable names, so
configure an intentional container proxy in the reviewed image rather than in the operator's Docker
CLI config. FTP proxy names remain trust-gated setup variables.
Podman's independent `mounts.conf` files and `containers.conf` mount or volume defaults can add
host binds without a Wollipog mount argument. A Podman target stays unavailable if local system or
user defaults contain such entries or cannot be safely read. Podman configuration that selects a
remote engine also blocks the target; backslash escapes in config are rejected conservatively because
they can hide those settings in quoted TOML keys. The runner checks again before each
container client launch, including later terminals, and on Rediscover while the target is available.
The same check rejects `env_host = true`, `env` entries that copy a named host variable, a custom
`base_hosts_file`, `pidns = "host"`, nonempty `devices`, and `ipcns = "host"`. These can expose the
Podman client's environment, a host file, host processes, host devices, or host IPC objects to a
target advertising `secrets: "none"`. Wollipog does not select devices or IPC mode in its run
arguments; Podman's built-in defaults add no host devices and create a separate IPC namespace, but
operator configuration can override them. Explicit `env_host = false`, literal `env` assignments,
the default `/etc/hosts` or `image`/`none` hosts sources, `pidns = "private"`, empty `devices`, and
`ipcns = "private"`, `"shareable"`, or `"none"` remain usable. Environment arrays the runner cannot
verify as literal-only are rejected; use a single-line array of literal assignments for this target.
If the target becomes unavailable,
remove the unsafe default and restart the runner to repeat readiness checks. Socket-backed Podman
engines and Podman on non-Linux hosts remain unavailable because their engine's default mounts cannot
be checked locally. An inherited rootless UID that differs from the runner UID also makes Podman
unavailable because the engine would read a different per-UID configuration directory.
Repository worktree setup cannot override Podman client config, connection, helper-binary, or storage
environment variables; those values could otherwise change the engine, its default mounts, or host
executables selected by the Podman client after the runner's check. Internal `_CONTAINERS_`
variables are reserved because they can change which per-UID Podman configuration is loaded.
Docker target launches also reject forwarded `DOCKER_` variables. Those names control the client
itself, so allowing a setup value through could bypass the checked local endpoint or private config.
Check output is never included in an unavailable reason. A runtime that needs a credential or a
remote client configuration for these checks fails closed.

The environment reference contains the template id/revision, image digest, and a SHA-256 digest over
the revision, image, sorted agent-command map, and ordered checks. Check output is not provenance and
is not sent to the control plane. A missing runtime/image, failed check, failed orphan cleanup, or
malformed inventory leaves the target visible but unavailable with a bounded diagnostic. Readiness is
refreshed on runner restart, not by agent Rediscover.

## Container Identity Compatibility

Orphan cleanup queries the current `com.wollipog.runner` ownership label and the legacy
`com.misko-agent-manager.runner` label with separate concurrent list calls, validates both
inventories, and removes their deduplicated union. Separate queries are required because Docker and
Podman combine repeated label filters with AND rather than OR; starting them together keeps startup
within one bounded list timeout envelope. A failure or malformed result from either query prevents
all removal and leaves the target unavailable.

When a trusted inventory contains a container found only through the legacy label, the runner emits
one value-free compatibility-window notice per process. The notice describes persisted container
state, not the installed runner version, and does not tell an already-updated operator to update
again. Canonical-only and dual-labelled containers do not warn. Container ids, runner ids, template
ids, and label values are never included in the notice. The producer cutover retains both runner and
template label generations on new containers so a rollback runner that understands only the legacy
ownership label can still reconcile them.

Legacy label emission may be removed only after every supported rollback runner includes dual-label
discovery and operators have had at least one complete stable release with dual-labelled production.
Legacy discovery has a stronger gate: every configured Docker and Podman endpoint must have completed
a successful dual-discovery cleanup since its last legacy-only runner was active. Dormant endpoints
and skipped upgrades make that condition difficult to prove, so legacy discovery should remain
indefinitely unless an explicit migration supplies equivalent cleanup evidence. A time window alone
is not sufficient grounds to remove it.

## Launch boundary

The control plane validates and persists the runner advertisement, filters it by compatible agent,
and sends the exact environment reference. The runner revalidates target ownership, adapter, native
context, isolated-worktree strategy, compatible agent, all four boundary claims, and the environment
reference before creating session state or a process.

An accepted launch uses runtime argv directly with no shell and applies:

- `--read-only`, `--cap-drop ALL`, `no-new-privileges`, `--pids-limit 512`, and `--init`;
- a private `/tmp` tmpfs;
- exactly one read/write bind: the resolved session worktree at `/workspace`;
- no host workspace root, provider home/state directory, container socket, additional directory, or
  other host mount;
- `--rm`, signal proxying, a unique session-attributable name, and runner/template ownership labels.

Agent and ACP-terminal environment values are not forwarded to the runtime client or container.
Sensitive daemon environment names are also removed from the runtime client process. No `--env`,
secret file, credential helper, provider auth directory, or billing identity is injected. The target
therefore advertises `secrets: "none"` and `billing: "none"`; operators must not bake credentials into
the image. On normal exit the runtime removes the container. A later runner start reconciles labeled
containers left by a crash.

## Scope and limitations

- Only native runner agent contexts are eligible. WSL-context agents cannot select a container target;
  install Docker/Podman in the runner's native context instead.
- Every launch requires an isolated git worktree. In-place workspaces are rejected.
- There is no implicit image pull, build, mutable tag resolution, target fallback, cloud handoff,
  metered billing, secret broker, privileged mode, host networking, or arbitrary mount escape.
- ACP additional directories and MCP servers are rejected for explicit requests and omitted from
  runner/workspace defaults; otherwise they could expose host paths or materialize secret references.
- No provider auth or persistent home/state volume is mounted. Select only agents that can operate
  without those facilities; session resume behavior remains the configured agent's responsibility.
- Only files inside the worktree are visible. Provider features that depend on host temporary-file
  paths or host-side state require an adapter-specific container implementation and may be unavailable.
- `bridge` is ordinary runtime networking, not an allowlist. Use `deny` for genuinely offline work.
- Runtime availability and setup checks are startup snapshots. Restart the runner after installing an
  image/runtime or changing external runtime state.
