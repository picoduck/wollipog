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

`network: "deny"` becomes runtime network `none`. `network: "bridge"` uses the runtime's ordinary
bridge and is advertised as a policy boundary, not as filtered egress. Setup checks always use no
network, including for a bridge-enabled target.

## Readiness and provenance

Before its first control-plane registration, the runner:

1. resolves the selected Docker or Podman client natively;
2. removes bounded, validated container ids carrying that runner's ownership label from a previous
   crashed process;
3. runs `image inspect` on the exact digest without pulling;
4. runs every setup check in the pinned image with no network, a read-only root, all capabilities
   dropped, `no-new-privileges`, a PID limit, and private `/tmp` tmpfs.

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
