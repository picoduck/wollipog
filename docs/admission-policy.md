# Runner Admission Policy

The runner treats `maxConcurrentSessions` as Machine capacity. The default is 16 units. Existing
configurations are unchanged: every session consumes one unit and no provider has its own quota.

Machine owners and organization administrators can change this value from **Machine Settings →
Runner Capacity**. The control plane stores that override with a monotonic revision and sends it to
the connected runner immediately. It remains authoritative across control-plane and runner restarts;
the local `runner.config.json` value is the fallback until the Machine has a saved override. A stale
browser or runner cannot replace a newer revision.

Operators can add exact agent-id policy in `runner.config.json`:

```json
{
  "maxConcurrentSessions": 8,
  "admission": {
    "agentLimits": { "claude": 2, "codex": 4 },
    "agentWeights": { "claude": 3, "codex": 2 },
    "activeTurnLimit": 4,
    "idleProcessPolicy": "park_when_needed"
  }
}
```

In this example, one Claude process consumes three of eight units and at most two Claude processes
may run. Unlisted agents retain weight 1 and no provider-specific limit. Keys must be exact agent ids;
values are positive integers, weights cannot exceed box capacity, and each map is capped at 64 entries.

`activeTurnLimit` is optional and bounds simultaneous provider turns across runner processes sharing
the data directory. Runner-authoritative detached work retains the same permit from its parent turn
through any required continuation, so the count cannot drop merely because the provider returned
while its work remained active. The limit must be between 1 and Machine capacity. When omitted, it
follows Machine capacity and adds no narrower boundary. `idleProcessPolicy` defaults to `retain`, preserving the
historical warm-process behavior. Opting into `park_when_needed` lets the runner retire the oldest
eligible idle provider when resident capacity blocks new work. Only a provider with a verified
resume coordinate is eligible; active turns, background work, approvals, queued commands, and
unresumable providers are never pressure-parked. Parking is disabled while connected to a pre-v135
control plane, because that peer cannot confirm the expanded capacity state.

The Machine view defines the three dimensions independently:

- **Active Turns** counts provider turns plus runner-authoritative detached work and has the
  `activeTurnLimit` ceiling.
- **Resident Process Units** counts weighted live provider processes and has the existing Runner
  Capacity ceiling.
- **Retained Resumable Sessions** counts durable, safely resumable conversations whether their
  provider process is resident or parked. Its limit is explicitly unlimited: Wollipog never deletes
  durable sessions to satisfy capacity. **Parked Sessions** is the retained subset without a
  resident provider process.

A parked session remains idle and retains its provider resume identity, transcript, configuration,
worktree and checkpoints. Its next prompt enters the same resident-process admission queue as a new
session, then resumes the established provider conversation. Claude, Codex exec, and Codex app-server
sessions are eligible after establishing a provider identity. ACP is eligible only when its live
capabilities prove `sessionResume` or `loadSession`; other providers remain resident. Input-required
and approval states, queued provider commands, provider-owned steering, authentication recovery,
and background/detached work all block parking. Shells and Native TUI processes are independent of
the provider-process lease: parking does not stop them or change their preserved session worktree.

## Enforcement and Fairness

Each admitted session atomically claims its weight in global slot directories plus one hashed
provider slot under the external runner data directory. The owner file contains only process,
runner-instance, session, and agent identifiers. A partial multi-slot claim is rolled back, release
verifies the runner-instance token, and dead-process leases use the existing crash reclamation path.
All protocol-v42 processes claim provider slots even when no limit is configured, so a later policy
tightening is observable across sibling processes.

Waiters stay in arrival order. The runner selects the oldest entry that fits the currently available
global and provider capacity, preventing a blocked heavyweight or provider-capped entry from leaving
the box idle. An older entry may be bypassed at most eight times; after that, capacity is reserved
until it can start or is cancelled. The runner reports configured, used, available, and queued units,
plus the actual boundary blocking each waiter: Machine capacity, agent quota, execution-target quota,
exclusive provider state, a request whose weight exceeds the configured capacity, or bounded-fairness
queue order. Protocol-v135 peers also report active turns, resident process units, retained resumable
sessions, parked sessions, and the idle-process policy. Queued session cards and search results
preserve the exact reason, including Active Turn Capacity. Stop cancels a waiter before any agent
process launches.

Capacity reporting takes one bounded diagnostic observation per filesystem lease root and reuses it
across the queue. Reports contain at most 256 blocker objects. If exact groups exceed
that bound, one actionable example of every represented boundary is retained, remaining slots follow
queue order, and the final `diagnostic_overflow` entry accounts for every omitted waiter. Run
`pnpm benchmark:admission` for the repeatable 50,000-waiter, 256-unit regression benchmark.

Increases take effect live and reconsider all capacity and worktree-preparation waiters immediately.
Decreases never stop running sessions or revoke their leases. When current use is above the new
ceiling, new work waits until enough existing work exits naturally.

## Choosing a Capacity

Capacity measures concurrent provider-process units, not CPU cores or memory. Idle resident sessions
can still hold memory and provider state, and weighted agents may consume more than one unit. Wollipog
therefore does not infer a supposedly safe value from hardware alone.

Start with 16 for a typical development Machine, then watch memory pressure, provider limits, and the
reported queue reasons. Reduce the value if the Machine swaps, becomes interactive-task starved, or
provider processes become unstable. Increase it gradually when work is routinely blocked only by
Runner Capacity and the host retains comfortable headroom. Raising Machine capacity cannot bypass a
smaller per-agent or execution-target quota; the reported blocker identifies which setting matters.

All runner processes sharing one data directory should use the same policy. Protocol-v41 and older
processes enforce only global one-unit slots, so update the whole shared-data-root cohort before
depending on provider quotas or weights during a rolling deployment.
