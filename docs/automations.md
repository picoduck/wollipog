# Durable automations

Automations are control-plane-owned schedules and signed triggers for unattended session and workflow actions. They
persist in the same SQLite database as sessions, expose their execution history in the Automations
view, and use the existing paired-device authentication boundary for every API mutation.

## Schedule contract

- Cron expressions have exactly five fields: minute, hour, day of month, month, and day of week.
  Names and seconds fields are rejected. Lists, ascending ranges, and steps are supported; `0` and
  `7` both mean Sunday.
- The timezone must be an IANA name such as `America/Chicago`. Nonexistent spring-forward wall times
  are skipped. A repeated fall-back wall time fires once.
- `skip` records one skipped receipt and advances beyond the missed backlog. `fire_once` executes one
  action for the oldest missed occurrence and advances beyond the backlog. `catch_up` runs bounded
  batches and leaves unprocessed occurrences durable for later ticks. Extremely large backlogs are
  limited to a 10,000-occurrence enumeration window per tick. Skip/fire-once advance beyond older
  overflow; catch-up retains the next unprocessed occurrence and continues in later bounded batches.
- Each claimed occurrence has a unique `<automationId>:<scheduledFor>` key. The schedule advance,
  immutable schedule revision/spec snapshot, execution receipt, and audit event commit in one SQLite
  transaction, so duplicate scheduler ticks cannot claim the same occurrence.

Editing creates a new monotonic revision. Existing execution receipts retain the exact prior spec.
Pause clears the next fire time; re-enable calculates a fresh future fire. Delete is soft: the
schedule disappears from CRUD results while its execution and actor-attributed audit history remain.
The same enabled switch is the master pause for signed webhook and chat-ops triggers. See the
[signed trigger contract](./automation-triggers.md).

## Actions, availability, and limits

An automation can create a session, prompt an existing session, or start a workflow run. Stored
actions are secret-free and image-free and must define finite positive cost and tool-call ceilings.
For a workflow, both ceilings apply separately to every member session. A prompt action never raises
an existing session ceiling; the strictest existing, per-action, or automation ceiling wins, and an
already-exhausted session fails without a prompt.

Runner policy is explicit:

- `wait` leaves the occurrence unclaimed until the configured runner is online and compatible;
- `expire` does the same until its bounded age, then records an expired receipt;
- `alternate` considers the primary target followed by the configured runner/workspace/agent
  mappings and expires after its bound. Prompt actions cannot move provider state to another runner.

Concurrency can wait, record a skip, or run parallel actions. Parallel prompt-existing-session is
rejected because two turns cannot safely share one provider session, and a prompt occurrence remains
unclaimed until its target session is idle. Accepted actions reconcile to
success or failure from their durable session or workflow status.

### Delivery guarantee

The control plane persists the exact session command, digest, selected runner, downstream resource
IDs, and stable command ID before materializing or sending work. It retries that command across
socket and control-plane restarts until a protocol-v53 runner durably acknowledges ownership. The
runner journals the command identity and a keyed payload digest before acknowledging it, so the same
ID and payload reports the existing state rather than executing twice; the control-plane outbox
retains the exact payload needed to recover an accepted-but-not-started command after runner restart.
Every transport attempt has a separately persisted request ID. Direct receipts must match a recorded
attempt plus the assigned runner, command, and session; malformed or crossed receipts are ignored.
Staged recovery materializes from that persisted payload snapshot, so a runner discovery update
cannot silently change the launch contract after the command was committed.

This is **exactly-once runner acceptance**, not an overclaim of exactly-once provider execution.
Acceptance, actual start, and exact-command completion are separate monotonic receipts. If a runner
dies after provider submission begins and provider evidence cannot prove the outcome, the receipt
becomes `uncertain` and is never automatically replayed. Prompt automations settle only from their
matching command receipt, not from an unrelated session becoming idle. Workflow runs use a stable
command per member and retain the workflow instance as their overall completion boundary.

The box-wide journal serializes ownership with a per-command lock and a live process lease. It
fsyncs new records and parent-directory entries before acceptance, and fsyncs the command-tagged
session event before advancing to `started`. A live process therefore does not lose a long-queued
command merely because a time window elapsed, while a stale owner can be reclaimed safely. If the
event-to-receipt boundary cannot be proven after an I/O failure, retry settles as `uncertain` rather
than submitting the provider turn again.

Pre-v53 runners fail closed before an occurrence is claimed; an explicit alternate may be selected
only if it is compatible. If an assigned runner reconnects without v53 after staging or acceptance,
staged/pending commands are rejected, while sent or accepted commands become uncertain instead of being sent as
legacy fire-and-forget work. Legacy executions created before this contract retain their original
at-most-once recovery behavior and are labeled separately in execution history. Runner receipt
journals do not retain prompt, environment, path, or launch content. The exact nonterminal payload
remains in the control-plane database under the existing sensitive runner-config storage boundary
and is redacted from the outbox row when the command becomes terminal; its digest and audit metadata
remain for deduplication evidence.

## Notifications and API

Each schedule selects any of `started`, `succeeded`, `failed`, and `expired`. Selected events use the
existing encrypted Web Push channel with a per-automation coalescing key and open the Automations
view. Push endpoints and credentials stay in the device subscription tables, never in a schedule.

Authenticated routes are:

- `GET /api/automations`
- `POST /api/automations`
- `GET /api/automations/:id`
- `PUT /api/automations/:id`
- `DELETE /api/automations/:id`

Trigger management adds authenticated routes under `/api/automations/:id/triggers`. Signed delivery
uses the separate `/hooks/v1/automation-triggers/:triggerId` HMAC boundary; it does not use the
paired-device bearer token. The exact signature, idempotency, request bodies, bounds, one-time secret
handling, and response contract are documented in [signed automation triggers](./automation-triggers.md).

Every dashboard, including loopback, presents either the local startup credential or an ordinary
paired-device bearer token; see [device auth](./device-auth.md).

## Always-on deployment and laptop-off limits

The scheduler runs inside the control-plane process. It is useful for unattended work only when all
of these remain online:

1. exactly one control-plane process owns a given `CONTROL_PLANE_DB` file;
2. that credential-bearing database is on persistent local storage and is encrypted, access-controlled,
   and backed up with SQLite-aware tooling;
3. the selected runner is reachable and its agent authentication remains valid;
4. HTTPS or a private authenticated network keeps remote UI and Web Push enrollment available.

Build the repository, set a non-default `CONTROL_PLANE_TOKEN`, an absolute persistent
`CONTROL_PLANE_DB`, and the intended host/port, then supervise
`pnpm --filter @wollipog/control-plane start` with the operating system's service manager. Run it as a
dedicated unprivileged account, restart on failure with backoff, preserve graceful termination, and
monitor process health, free disk, database backups, runner connectivity, and failed/expired
execution history. Rotate logs and keep the host clock and IANA timezone data current. Use SQLite's
online backup API or `VACUUM INTO`/a coordinated WAL checkpoint rather than blindly copying a live
database. Do not place SQLite on a network filesystem and do not start active replicas against one
file; leader election is not part of this scheduler. Expose only the HTTPS dashboard/control-plane
surface through Tailscale or a correctly configured reverse proxy—never expose runner or ACP ports.

Turning off or suspending the laptop that hosts the control plane stops schedule evaluation and push
delivery. On restart, explicit misfire policy decides what happens. An always-on control plane can
keep a dashboard-supervised SSH tunnel alive, but that runner still exits whenever the owning
control plane or tunnel exits; it is not independently durable. Use an independently supervised
native runner against the reachable control plane, or accept the documented tunnel lifetime in
[SSH runner lifecycle](./ssh-runner-lifecycle.md). Web Push also requires the control plane to be
online; there is no hosted relay in this slice. Signed trigger ingress likewise stops when the
control plane is offline, though accepted deliveries remain durable while only their runner is offline.
