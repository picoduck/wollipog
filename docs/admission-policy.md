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
    "agentWeights": { "claude": 3, "codex": 2 }
  }
}
```

In this example, one Claude process consumes three of eight units and at most two Claude processes
may run. Unlisted agents retain weight 1 and no provider-specific limit. Keys must be exact agent ids;
values are positive integers, weights cannot exceed box capacity, and each map is capped at 64 entries.

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
queue order. Queued session cards and search results preserve that exact reason. Stop cancels a waiter
before any agent process launches.

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
