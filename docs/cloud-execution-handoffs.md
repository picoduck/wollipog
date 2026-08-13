# Cloud execution handoffs

Cloud targets are opt-in, runner-owned proxy placements for reproducible remote agent environments.
They are independent of agent drivers: one configured target can launch any compatible native-context
agent id. Wollipog does not bundle a paid cloud provider or silently create billable
resources. An operator installs a stdio proxy adapter and declares its environment, cost, and
concurrency policy. Protocol v62 carries the exact target and a content-safe acceptance receipt.

## Runner configuration

The runner accepts up to 16 `cloudTargets`. Every target has stable kebab-case identity, an immutable
environment reference, explicit compatible commands, and a bounded target policy.

```json
{
  "cloudTargets": [
    {
      "id": "metered-tools",
      "name": "Metered tools",
      "revision": 1,
      "adapterCommand": "wollipog-cloud-proxy",
      "adapterArgs": ["--profile", "engineering"],
      "adapterEnv": {
        "CLOUD_PROXY_TOKEN": { "fromEnv": "WOLLIPOG_CLOUD_PROXY_TOKEN" }
      },
      "image": "registry.example/wollipog/cloud-agent@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "setupCheckDigest": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "agentCommands": {
        "codex": { "command": "codex", "args": ["app-server"] },
        "claude-native": { "command": "claude", "args": [] }
      },
      "policy": {
        "maxConcurrentSessions": 2,
        "estimatedHourlyRateUsd": 1.25,
        "minimumBudgetUsd": 0.5,
        "maximumBudgetUsd": 20
      }
    }
  ]
}
```

`revision`, the digest-pinned `image`, and `setupCheckDigest` are operator attestations checked by the
adapter. Increment the revision whenever the remote template, setup procedure, or compatible command
changes. `agentCommands` replaces the runner host command only for the actual provider launch;
driver-added dynamic arguments are appended. Helper processes keep their own basename and arguments.

Adapter credentials must be supplied through `adapterEnv` references. The runner resolves each
`fromEnv` value only in its native process immediately before adapter use. Never place credentials in
`adapterArgs`, `agentCommands`, image names, or policy fields. The control plane receives neither
environment variable names nor values.

## Adapter protocol

The executable is invoked directly, never through a shell. `adapterArgs` precede one of four protocol
v1 operations:

```text
inspect --protocol 1 --target ID --revision N --image DIGEST --setup-check-digest SHA256
prepare --protocol 1 --target ID --source ABSOLUTE_PATH --idempotency-key SHA256 --manifest BASE64URL_JSON
connect --protocol 1 --target ID --handoff PRIVATE_ID --session SESSION_ID -- COMMAND [ARGS...]
cancel  --protocol 1 --target ID --handoff PRIVATE_ID
```

`inspect` must exit zero and return one bounded JSON object containing the exact protocol version,
target id, revision, image, setup-check digest, and `available: true`. Any mismatch leaves the target
visible but disabled. `prepare` receives the source checkout path and exact manifest. It returns the
same protocol and target, a 1-to-128-character reconnect id, the manifest SHA-256, and a finite
`quotedCostUsd`. The idempotency key is the manifest SHA-256; `prepare` must return the same live
allocation for repeated calls with that key, closing the crash window between provider allocation and
runner-local receipt persistence. A mismatched or over-budget result fails closed; if it included a
syntactically valid handoff id, the runner calls `cancel` before rejecting it.

After acceptance, `connect` is the long-lived stdio proxy for the configured remote command. The raw
handoff id stays only in runner-local session state and adapter argv. The control-plane receipt stores
only its SHA-256. An operator adapter must make `connect` idempotent for the accepted handoff and make
`cancel` safe to repeat.

## Handoff manifest and provenance

The runner computes provenance immediately before `prepare`:

- exact `HEAD` commit and tree object ids;
- SHA-256 of the origin URL, if configured, never the URL itself;
- SHA-256 over porcelain status, the binary `HEAD` patch, and sorted untracked-file path/blob hashes;
- dirty state and a bounded untracked-file count;
- up to 32 authorized workflow-artifact references with kind, size, and SHA-256;
- exact target environment, boundaries, policy, destination/source session ids, and USD budget.

The tracked binary patch is bounded at 8 MiB and untracked files at 256. Unsafe paths, invalid git
objects, oversized input, missing native Git, or an unsettled source session reject the launch. Paths,
branch names, patch bytes, artifact bodies, remote URLs, adapter output, and the private handoff id are
not persisted in the control plane.

Artifact references come from the authoritative workflow-artifact store; browser-supplied ids are
resolved and ownership-checked before runner dispatch. Bodies remain behind the existing authorized
artifact export boundary. A provider adapter that needs those bytes must use its operator-owned,
authenticated artifact integration; Wollipog does not place artifact bodies or credentials
in the runner/control-plane command stream.

The validated source/artifact request is stored before runner dispatch. A control-plane restart in
the pre-acceptance window therefore reuses the exact metadata instead of silently launching from a
different source. A later runner receipt must match that durable source, ordered artifact list, and
session budget before it can replace the pending state.

The accepted receipt contains only the manifest digest, hashed adapter id, git object/digest proof,
artifact metadata, requested budget, adapter quote, and acceptance time. The runner emits that receipt
in its runtime snapshot, and the control plane validates it against the immutable cloud target before
durable storage or UI projection.

## Cost and admission

New Session shows the operator estimate, required budget range, and target concurrency. A cloud launch
must carry a finite USD budget within the advertised minimum and maximum. The adapter quote must not
exceed either that budget or the target maximum. The quote is an admission estimate, not an invoice;
the existing session cost guardrail remains authoritative for usage reported by the agent.

`maxConcurrentSessions` is enforced with atomic target-specific leases under the runner data root.
Those leases are shared by sibling runner processes, coexist with the box capacity and per-agent
quotas, roll back if any later claim fails, and reclaim owners whose process died. Waiting sessions use
the existing bounded FIFO admission queue.

## Boundary and lifecycle

Cloud targets advertise `filesystem: snapshot`, `network: policy`, `secrets: references`, and
`billing: target_metered`. These are deliberately different from host inheritance and the
secret-free container boundary:

- The adapter owns remote filesystem materialization and network enforcement for the attested image.
- The local proxy retains ordinary non-sensitive process environment needed by a native executable.
  Provider and terminal values, inherited credential-shaped names, Wollipog variables, host provider
  state, ACP additional directories, and MCP servers do not cross the boundary. Any sensitive value
  must be introduced through an explicit adapter reference.
- Target registration waits for `inspect`; there is no host/container fallback.
- The destination uses an isolated local worktree as its deterministic staging boundary. A referenced
  source session must belong to the same runner, workspace, repository, and authorization scope, and
  must have a settled non-running worktree.
- A runner restart reconnects with its local private handoff id. If that local state is absent, a later
  control-plane restart request prepares a new handoff from the durable source/artifact references.

## Scope and limitations

- No cloud adapter, provider SDK, remote listener, account, or paid resource ships with the project.
  The deterministic test fixture exercises the same argv/JSON contract without external spend.
- Cloud agents must use the runner's native context. WSL-context targets are rejected.
- Network `policy` is an adapter attestation, not a Wollipog-defined egress allowlist. Audit the adapter
  and provider policy before trusting it with source code or referenced credentials.
- Source-session transfer is intentionally same-runner and same-workspace. A cloud target configured on
  a local runner or SSH-box runner can hand off that runner's in-place/worktree state, but Wollipog
  does not relay arbitrary checkout bytes directly between unrelated runners.
- The runner supplies the local source path to its trusted adapter. That path is not sent to the
  control plane or stored in the receipt.
- Setup checks are attested by the adapter's exact digest; unlike container targets, Wollipog cannot
  independently inspect a remote image. Changing remote state without changing the revision/digest is
  an operator contract violation.
- A failed launch cancels an allocation prepared by that launch, and deleting a session calls `cancel`
  for its runner-local handoff id. Adapters must also bind remote lifecycle to the `connect` process and
  an expiry policy so process loss and an unreachable adapter cannot create unbounded cost. Rejected
  preparations are explicitly cancelled.
