# Multi-user identity and resource ownership

The control plane now has a local-first collaboration boundary. A fresh or upgraded personal
deployment bootstraps one `Personal organization` and one `Local owner`; existing paired-device
tokens, runners, workspaces, and sessions are migrated into that organization without replacing
credentials or changing resource ids. This is an additive foundation, not an external identity
provider. Expiring transcript capabilities, authenticated artifact exports, runner-specific
credential rotation, and runner-local secret references build on this identity boundary; account
federation remains outside the current local-first deployment model.

## Principals and roles

Every paired device belongs to an active user membership in exactly one organization. Authentication
resolves the device, user, organization, and current role on every request and WebSocket connect, so
suspension or a role change takes effect without reissuing the device token. Suspending a user also
deletes that user's push subscriptions and closes their live UI sockets.

| Role | Organization reads | Scoped resource reads | Scoped mutations | Identity, teams, devices, ownership |
| --- | --- | --- | --- | --- |
| Owner | yes | yes | yes | yes, including owner grants |
| Admin | yes | yes | yes | yes, except changing owner access |
| Operator | limited to the scoped surface | yes | yes | no |
| Viewer | limited to the scoped surface | yes | no | no |

Owner and admin are intentionally organization-wide operators. For operator and viewer principals,
runner, workspace, and session access requires a matching owner:

- organization ownership grants access to every active member in the organization;
- user ownership grants access only to that user;
- team ownership grants access only to active members of that team.

Runner, workspace, and session ownership are independent records. A runner re-register does not
overwrite an existing workspace owner. Human-created sessions receive a server-derived user owner;
delegated/internal creations inherit a selected workspace or runner scope, and conversation forks
preserve the source session owner. A stale or unknown snapshot workspace falls back to the runner's
scope and never widens access; a runner fork response must preserve the source driver and agent
identity. Non-admin members cannot submit an arbitrary host path. A conductor session receives only
its live persisted session scope, and its existing route allowlist remains an additional ceiling.
Workflow-engine orchestrators are explicitly organization-owned even when their worker sessions use
a user/team-owned project: workflow definitions, runs, artifacts, and policies are still
organization resources, while each worker keeps the selected project scope. An ordinary conductor
session does not receive that widening merely because its agent id is `conductor`.

## Fail-closed transport behavior

The same policy applies to REST and `/ui` WebSockets:

- inaccessible resource ids return `404`, avoiding cross-user existence disclosure;
- non-admin REST access is limited to identity context, scoped runner/session operations, the
  device's own push subscription, and scoped workspace rename;
- organization-global surfaces such as boxes, runs, pods, automations, review queues, and host
  administration belong to the personal control-plane organization and remain available only to
  that organization's owner/admin members until they gain an explicit ownership model;
- non-admin snapshots and deltas include only visible runners, workspaces, and sessions;
- runner agent environment values and runtime diagnostics are redacted from scoped views;
- global boxes, runs, and pods are omitted from non-admin WebSocket snapshots;
- membership, team, and ownership changes force scoped clients to reconnect and receive a fresh
  authorization-filtered snapshot.
- push delivery resolves its session audience again at send time; suspending a member or changing
  ownership cannot leave a stale subscription authorized. Global automation notifications go only
  to personal-organization admins.

The authenticated local startup credential remains the bootstrap owner for zero-configuration
personal deployments. It is accepted only over a direct loopback socket; requests carrying
proxy/client-IP headers must use an ordinary paired-device credential. Operators must protect the
local credential file because possession by another same-account process grants administrative
access.

## Mutation attribution

Every `/api` mutation writes a content-free audit intent before its authorized handler runs, then
records the final HTTP status. A status of `0` means the process ended while the handler was active.
Requests rejected before the handler are appended with their denial status. Records contain only the
principal kind/id, stable user id, paired device id, organization id, method, matched route pattern,
a bounded path target id, status, and time. Bodies, query strings, headers, bearer tokens, prompts,
environment values, and other content are never stored in this audit.

Unauthenticated requests, including browser requests rejected by the authentication gate, are not
attributed to the local owner and are not persisted as audit noise. Retention is bounded to 180 days
and approximately 100,000 recent rows, with periodic pruning so hostile traffic cannot create
unbounded storage growth.

This audit is operational attribution, not a transactional business-event ledger. Domain operations
that require exact, append-only state transitions continue to use their dedicated governance,
automation, workflow, and reconciliation audits.

## Administration

The Machines view includes **People & Devices**. Owners/admins can create members, assign roles,
suspend/reactivate access, create teams, update team membership, and pair a device directly to an
active member. The last active owner cannot be demoted or suspended. Owners alone can grant or alter
owner access. A team that still owns a runner, workspace, or session cannot be deleted until those
resources are reassigned.

The REST surface is:

- `GET /api/identity` — current context plus organization directory and teams;
- `POST/PATCH /api/identity/users...` — member lifecycle;
- `POST/PUT/DELETE /api/identity/teams...` — team lifecycle and membership;
- `GET /api/identity/mutation-audit` — bounded recent mutation attribution;
- `PUT /api/identity/ownership/:resource/:resourceId` — runner/workspace/session owner assignment.

The current UI intentionally does not expose the raw ownership endpoint yet. It exists for tested
administrative clients and for the next sharing/ownership UX slice.

## Backup and migration boundary

Identity, memberships, teams, ownership, mutation attribution, device-token hashes, push
subscription keys, and active operationally redacted share projections all live in the control-plane
SQLite database. Backups must therefore be protected as credential- and content-bearing data.
Opening an older database adds the identity/share tables, preserves the
original device row and token hash, and backfills legacy resources into the personal organization.
The migration is idempotent across restarts.

## Explicitly deferred

This foundation does not claim that operational redaction is safe publication. Authenticated
[transcript exports](./transcript-exports.md) and expiring/revocable
[transcript share links](./transcript-sharing.md) use a versioned least-data projection rather than
normal authenticated DTOs. Authenticated [workflow artifact exports](./artifact-exports.md) instead
return exact raw bytes after scope and integrity checks, with an explicit unredacted warning.
Runner-specific rotating credentials and runner-local secret references are documented in
[runner credentials and local secrets](./runner-credentials-and-secrets.md). External vault
integrations and optimistic concurrency/approval ownership for co-driving remain later work.
