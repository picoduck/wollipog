# Execution targets

Execution targets answer **where and inside which workspace boundary a session runs**. Agent drivers
answer **which provider protocol controls the agent**. These contracts are intentionally independent:
the same local, SSH, container, or cloud target may run Claude, Codex, or ACP agents.

Protocol v60 describes a target with a stable id, runner id, placement kind, workspace strategy,
adapter, availability, and four explicit boundaries. Boundary descriptors contain no secret values.
`runner_local` means credentials remain on the runner; `agent_account` means provider billing follows
the selected runner-local agent login. A worktree filesystem descriptor identifies the workspace
strategy, not a security sandbox by itself; the runner's separate execution-isolation policy remains
the authoritative enforcement boundary.

Current host projection supplies two targets per runner: in-place and isolated worktree. The control
plane classifies runners backed by its SSH-box records as `ssh`; other host runners are `local`.
Existing clients remain compatible through `runnerId` and `useWorktree`. New clients send the
advertised target id as well, and the control plane plus runner both reject identity, mode, or policy
drift before launch.

Protocol v61 adds opt-in runner-owned container targets. Each target binds a digest-pinned image,
template revision, deterministic setup-check digest, and exact compatible agent ids into the durable
session reference. The runner checks the native Docker or Podman runtime, reconciles its own orphaned
containers, inspects the already-local image, and runs the configured checks before registration. A
missing runtime/image or failed check remains visible as unavailable; the runner never pulls an image
or silently falls back to a host target.

At launch the runner revalidates the entire reference, mounts only the isolated worktree read/write at
`/workspace`, keeps the image root read-only, supplies a private tmpfs, drops capabilities, enables
`no-new-privileges`, and applies the declared network mode. Container targets inject no manager-held
agent or terminal environment values and expose no provider-state/auth volume, so their secret and
billing boundaries are both `none`. See [Container execution targets](./container-execution-targets.md)
for configuration, lifecycle, and limitations.

Cloud definitions remain reserved contract values, not silently emulated by host or container targets.
Protocol v62 activates runner-owned cloud proxy targets. Each target binds an operator-attested image,
revision, setup-check digest, compatible remote commands, USD budget range, estimate, and cross-process
concurrency limit. A launch snapshots git and workflow-artifact provenance before the adapter accepts
it, stores only a content-safe receipt in the control plane, and keeps the raw reconnect id and
credential references runner-local. There is no bundled provider or implicit paid resource. See
[Cloud execution handoffs](./cloud-execution-handoffs.md) for the adapter protocol, configuration,
cost/admission behavior, lifecycle, and limitations.
