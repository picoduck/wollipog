# Runner admission policy

The runner treats `maxConcurrentSessions` as box capacity. Existing configurations are unchanged:
every session consumes one unit and no provider has its own quota.

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

## Enforcement and fairness

Each admitted session atomically claims its weight in global slot directories plus one hashed
provider slot under the external runner data directory. The owner file contains only process,
runner-instance, session, and agent identifiers. A partial multi-slot claim is rolled back, release
verifies the runner-instance token, and dead-process leases use the existing crash reclamation path.
All protocol-v42 processes claim provider slots even when no limit is configured, so a later policy
tightening is observable across sibling processes.

Waiters stay in arrival order. The runner selects the oldest entry that fits the currently available
global and provider capacity, preventing a blocked heavyweight or provider-capped entry from leaving
the box idle. An older entry may be bypassed at most eight times; after that, capacity is reserved
until it can start or is cancelled. The existing `queued` session state exposes the requested weight,
active units, and provider quota, and Stop cancels a waiter before any agent process launches.

All runner processes sharing one data directory should use the same policy. Protocol-v41 and older
processes enforce only global one-unit slots, so update the whole shared-data-root cohort before
depending on provider quotas or weights during a rolling deployment.
