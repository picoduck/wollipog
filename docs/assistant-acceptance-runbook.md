# Assistant Acceptance Runbook

Refs #4468 and #4462. The owner chose to **skip real runs for now**. This document specifies
the later run; it does not record a successful live acceptance. Both issues remain open until
the real workflow is exercised and its evidence reviewed. Managed installation, automatic
OpenClaw upgrades and native Wollipog chat remain outside this acceptance scope.

Use [OpenClaw setup and recovery](openclaw-assistant.md) for isolated profiles, model
authentication, MCP discovery and named connections. Use the current
[native Discord integration instructions](../integrations/openclaw-discord/README.md) for
requester-aware ingress, the signed receiver, hook admission and durable replies. That README
describes the delivered connector; historical planned-connector sections in the OpenClaw guide
are not installation instructions. Do not expose a generic owner MCP connection to a shared
Discord model context to substitute for the trusted native command path.

## Owner Prerequisites

Keep the Phase 1 handoff's numbering. Each matrix row below cites the applicable items.
All setup involving credentials, standing grants or networking is owner-controlled; an agent
must not perform it merely to turn an unavailable test green.

| Item | Required Owner Preparation |
| --- | --- |
| 1 | An operator outside the hosting stack deploys accepted main and records the deployed commit plus control-plane, local/SSH runner and negotiated protocol versions. This campaign never updates or restarts its hosting stack. |
| 2 | Create a dedicated OpenClaw profile with model authentication, separate state/workspace and protected secret references. Through supported owner setup, issue Full Access and narrow test connections, exact requester/conversation bindings, and the connector/subscription/signing authority needed for the run. Preserve the baseline profile. |
| 3 | Configure a dedicated Discord application/account and test conversations, explicit sender/channel allowlists, required intents, read/send permissions and thread membership. Keep tokens and actual destination coordinates in private owner configuration. |
| 4 | Confirm the SSH Machine's current agent authentication, quota/capacity and compatible harness, plus a safe repository Project Location. Discovery's authenticated/online label alone does not prove execution. Repair authentication only through owner setup if needed. |
| 5 | Confirm a supported OpenClaw version on another machine and an isolated profile there. Record the actual version; do not infer installation from Wollipog registration. Runtime installation is separate operator work. |
| 6 | Provide verified HTTPS MCP connectivity and signed event-receiver/hook paths for the chosen topology. Preserve authentication headers and signed raw bytes. Configure only an exact owner-approved private callback exception where required; never disable TLS verification or global network policy. |

Before any row, the owner designates disposable resources: a pre-existing **unrelated** session,
two Projects, local and SSH repository Locations, an initially disabled finite automation, and a
narrowly assigned test skill. Use a separate disposable control plane, Assistant runtime and
runner for interruption tests; never interrupt the hosting stack or unrelated live work.
Authorize any provider charges and live execution before starting. Save initial revisions and
restore only these resources afterward, preserving dirty or unpushed work.

## Evidence Rules and Run Record

- **REAL** means the stated boundary was actually exercised with the intended runtime, current
  owner authority and observed effect. Label the boundary: real loopback HTTP or host plugin
  registration does not prove a real model, Discord delivery, remote HTTPS or SSH execution.
- **MOCKED** means deterministic coverage uses synthetic identities, Discord responses or
  runner/provider transport, even when SQLite, Fastify, HTTP/MCP and application services are real.
- **UNVERIFIED** means the required live observation is absent, skipped or blocked. Retain the
  reason; do not promote a row because CI, discovery or a command receipt succeeded.

Create a private run record with date, code/deployed commit, OpenClaw/Node/harness versions,
negotiated protocols, local/remote topology labels, prerequisite readiness and one result per
row below. Keep identifiers needed to correlate command/work/revision/message receipts private.
Public reports use opaque labels, sanitized observations and test/PR references: no credentials,
private destinations, machine addresses, prompts or raw database/log dumps. Attach relevant
redacted screenshots through authorized private Session artifacts and retain their artifact ID,
media type, byte count and SHA-256; obtain the required evidence inspection verdict.

Each row remains UNVERIFIED until **every** required subcase passes. A failed/blocked subcase
must remain visible beside any bounded REAL result. Service acceptance, hook run IDs and native
command acknowledgements are intermediate observations, not execution or final delivery proof.

## Real-Run Acceptance Matrix

### A. Discord Request, Execution and Same-Conversation Reply

**Prerequisites:** 1, 2, 3, 4 for SSH targets, and 6. Use the native README's isolated configuration.

1. From the bound requester in the designated test thread or DM, run
   `/wollipog launch <connection> <request-id> <target-alias> <harmless task>` using a fresh ID.
   Choose a task that reports a unique non-secret marker and waits for a follow-up.
2. Observe the corresponding Wollipog session start and a real provider result. Send
   `/wollipog prompt <connection> <new-request-id> <original-launch-request-id> <follow-up>`
   in the same conversation. Require the same work/session association and a provider response.
3. Complete the task; separately cause a supported attention state in disposable work. Observe
   the signed delivery, receiver/inbox, OpenClaw hook admission and final Discord notice.
4. In the dedicated owner-trusted OpenClaw MCP profile, ask the authenticated model to discover
   the intended installation and read that session's status through its tools. Record the real
   model tool call separately: the native Discord command intentionally bypasses the model.
5. Try an unbound requester and wrong test conversation. Require refusal with no new work or
   redirected notice; do not borrow authority from membership in a shared channel.

**Observe and capture:** a sanitized timeline linking native request, durable command/work,
execution and follow-up, hook admission, reply revision and actual Discord message readback.
The notice stays in the originating thread/DM, never its parent or another connection. Final
notices contain supported status/attention and links, not arbitrary provider output. Attention
requires the supported Wollipog answer/approval path; ordinary chat cannot approve it.
**Mark REAL** only after live ingress, provider execution, model tool use, follow-up, completion,
attention, exact-conversation message receipts and negative cases are observed. Synthetic native
context or an acknowledgement alone leaves the live criterion UNVERIFIED.

### B. Full Access over an Unrelated Session

**Prerequisites:** 1 and 2; owner-selected disposable session created before this Assistant run,
with no parent/child/campaign relationship to it.

1. Discover the Full Access connection and use `session_list`/`session_get` to locate the session.
2. Read status/history; change its title with `session_title`, prompt it using `session_prompt`,
   and observe the real provider's response. Read the changed state through the owner's UI/API.
3. Stop/restart that disposable session, then stop it again before archive/unarchive through
   supported tools. Wait for each lifecycle transition before requesting the next.
   Under `destructiveConfirmation: confirm`, inspect the preview and repeat unchanged arguments
   with its confirmation. Reconcile stable command IDs through `command_get` before any retry.

**Observe and capture:** before/after owner readback, actual lifecycle transitions and provider
response, durable command verdicts and absence of fabricated ancestry. **Mark REAL** when these
effects work under the owner's current Full Access grant; list visibility alone is insufficient.

### C. Cross-Project Management

**Prerequisites:** 1 and 2; two disposable Projects with owner-accessible repository Locations.

1. Under Full Access, discover both Projects/Locations and launch harmless work in each.
2. Read each result, change a disposable Project/Location label and read it back through the
   owner API. Use `session_project` to move designated test work between the two Projects;
   verify the resulting placement and unchanged execution directory.
3. Repeat reads and the move using a connection limited to one Project. Require refusal for
   the other Project and for either move with an inaccessible source or destination.

**Observe and capture:** both launches/results, owner state readback and scoped refusals without
private excluded-resource data. **Mark REAL** after both positive effects and current-grant
negative cases pass; a fixture's Project IDs or Full Access discovery is not sufficient.

### D. SSH Runner Execution

**Prerequisites:** 1, 2, 4 and 6; disposable repository Location on the actual SSH Machine.

1. Discover current runner capabilities and select its authorized Location and compatible agent.
2. Launch a harmless task that writes a unique marker in its disposable worktree and reports it.
   Prompt the resulting session and read its history/status through the Assistant.
3. Verify the marker and provider execution on the designated SSH runner through owner-visible
   session/runner evidence; confirm the work was not executed on a fallback local runner.

**Observe and capture:** selected versus actual runner/Location, session lifecycle, provider
result and marker readback, with remote coordinates redacted. **Mark REAL** after real remote
execution and follow-up; online/authenticated/capability discovery alone remains UNVERIFIED.

### E. Automation and Skill Changes

**Prerequisites:** 1, 2 and 4 for the chosen remote target; safe automation and assigned test skill.
Follow [automation/skill schemas and recovery](assistant-management.md).

1. Read the automation's revision with `auto_get`. Use `auto_update` with `expectedRevision`,
   a stable `operationId` and its complete spec to change cron/timezone. Read it back, enable
   one bounded harmless occurrence, observe real execution, then pause and verify no further
   occurrence is admitted in the recorded observation window. Resume once and observe recovery.
2. Read `skill_get`, add a harmless marker version with `skill_version_add` using the current
   revision, and inspect `skill_versions` and `skill_deployments` plus owner UI/API state.
3. Verify the selected runner's **reported applied version** and the deployed marker in its test
   skill. With a separate disposable target offline, update again, observe pending desired state,
   reconnect it and require a new applied-version report. Restore the saved test configuration.

**Observe and capture:** revisions, schedule/timezone/pause/readback, finite execution outcome,
immutable version identifiers and desired-versus-reported deployment transitions. **Mark REAL**
only after scheduling/pause/resume and actual skill deployment/reconnect pass; desired state or
a successful mutation receipt does not prove application to a Machine.

### F. Local/Remote Parity and Two Connections

**Prerequisites:** 1, 2, 4, 5 and 6; two explicitly named control-plane test connections, with
equivalent owner-authorized grants and matching disposable resources.

1. From each actual OpenClaw machine, discover immutable installation/connection identities and
   current tool schemas. Perform B–E through both runtimes, recording capability/effect outcomes.
2. Select connection A explicitly, mutate its disposable label, and verify A changed while B did
   not. Repeat for B. Run A's exact-conversation reply check from row A through the remote setup.
3. Make only A's dedicated test endpoint unavailable. Require a named availability refusal;
   restore it and reconcile the original command on A. Never fail over a mutation to B.

**Observe and capture:** version/grant comparison, verified remote HTTPS, model tool calls,
matching results/refusals across local and remote runs, explicit installation isolation and
remote callback/reply receipts. **Mark REAL** only for equivalent actual machine runs; two
loopback listeners or address injection are bounded transport evidence, not remote parity.

### G. Grants, Rotation and Revocation

**Prerequisites:** 1, 2, 3 and 6; owner participates in all standing-authority changes.

1. Compare Full Access with a narrow operation/Project grant; require excluded reads/writes and
   installation-wide management to refuse without leaking hidden resources.
2. Have the owner narrow the grant while a disposable read/update is pending. Require current
   access rechecks, withheld private results and preserved receipt identity for possible effects.
3. The owner rotates a test credential and securely refreshes its dedicated runtime. Old access
   must refuse, new discovery/calls must work. Revoke that connection; require subsequent calls
   and pending work-update delivery to refuse. Withdraw test Discord access before a delayed
   notice and require no send to an unauthorized or fallback destination.

**Observe and capture:** secret-free connection/grant revisions, denied/allowed outcomes,
activity reasons and absence of post-revocation dispatch/delivery. **Mark REAL** after deployed
owner-issued credentials and live Discord checks pass; isolated issuance/rotation probes do not
establish this integrated boundary. Revocation cannot recall a message already sent.

### H. Interruptions, Duplicates and Uncertain Outcomes

**Prerequisites:** 1–6 as used by the topology, plus separate disposable runtimes and explicit
owner-controlled fault injection. Never restart the hosting stack to execute this row.

1. Interrupt the disposable runner during a harmless task; restore it and inspect the same
   session, command receipt and actual state before recovery. Require no duplicate launch.
2. Separately interrupt the disposable control plane and Assistant/bridge with pending work;
   restore their durable state and reconcile current work, inbox, wake and reply journals.
3. Redeliver the exact signed test event after bridge recreation. Require one admitted wake and
   one confirmed notice for its revision, no second command effect or cross-conversation reply.
4. In owner-controlled test transport, lose a mutation response after dispatch. Preserve its
   ID/arguments and use `command_get` plus resource readback; do not issue a new identity.
5. Lose a Discord send response or reply-confirmation response. Require readback of the matching
   message and durable receipt confirmation without another send. If readback is unavailable,
   ambiguous or unauthorized, retain **uncertain** and require owner review rather than guessing.

**Observe and capture:** pre/post durable identities, fault boundaries/times, dispatch/send counts,
resource/message readbacks and unresolved uncertainty. **Mark REAL** only when the deployed
disposable components and live Discord are exercised. Safe suppression with an unresolved
outcome is a recorded recovery result, not proof of successful execution/delivery or exactly-once
cross-service behavior. Automated restart/fault tests remain MOCKED at external boundaries.

### I. Owner-Capability Inventory and Compatibility

**Prerequisites:** 1 for the deployed comparison; 2, 4 and 5 for runtime compatibility checks.
Read [the audit contract](assistant-owner-parity.md) and
[the exact inventory](assistant-owner-capabilities.json).

1. At the recorded code commit, run the isolated production-registration gate and audit test:

   ```sh
   node --import tsx apps/control-plane/test-support/owner-parity-snapshot.ts --require-complete --verify-runtime-identity --verify-campaign-protocol --verify-residual-management
   node --import tsx --test apps/control-plane/src/owner-management-inventory.test.ts
   ```

2. Compare the deployed discovery/schema set with that code and trace every route to a registered
   equivalent or its exact exclusion/remedy. Record any new route, missing registration or gap.
   Positively exercise representative session, Project/Location, Machine, automation/skill,
   connection and campaign/review management from both actual runtimes under current grants.
3. Check version/capability floors against the actual local/SSH harnesses. On a disposable
   incompatible peer, require an actionable refusal without dispatch or policy relaxation.
   Credentials, standing authority and session-only protocol retain their supported owner/runtime
   paths; do not forge a session identity to manufacture parity.

**Observe and capture:** gate result, deployed schema comparison, representative live effects
and peer compatibility/refusal with supported remedy. At main `247c9793`, the audit contains
**303 routes: 184 tool-mapped route entries + 119 exclusions, zero gaps**. Exclusions comprise
57 human-authority, 11 interactive-workspace-I/O and 51 exact session-protocol entries. The
production registry contains **202 unique tools**; 184 is a route count, not a tool count.
**Mark REAL (inventory boundary)** when the actual registration gate passes at the recorded
commit. Deployed/local/remote capability acceptance remains UNVERIFIED until steps 2–3 pass;
zero audit gaps never proves a live end-to-end workflow.

## Completion and Recovery Handoff

Use the linked setup guides for authentication, TLS, signed callback, permission, version and
lifecycle troubleshooting. Inspect each stage separately: command admission, runner execution,
signed outbox/receiver, hook admission, reply reservation, Discord send and receipt confirmation.
Preserve stable IDs (`commandId`, or automation/skill `operationId`; receipt lookup uses
`commandId`) and current revisions. Never replay accepted/uncertain work blindly, select another
installation to bypass it, widen grants, or disclose secret configuration in diagnostics.

Publish a criterion-by-criterion REAL / MOCKED / UNVERIFIED report with sanitized evidence and
test/PR links. Keep the delivered runbook and automated parity result separate from the still
outstanding live execution. Normal cross-model review, exact-head required CI, typed merge
approval, successful merge-group checks and verified merge apply to delivery changes. Only after
the owner-authorized real acceptance and required evidence review may #4468/#4462 be considered
for completion; their current deferred run leaves both open.
