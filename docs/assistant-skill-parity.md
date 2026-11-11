# Assistant Automation and Skill Library Parity

Refs #4468. Group 6 completes the remaining automation and Skill Library management inventory.
The inventory contract checks actual production registration. Other groups' gaps continue to block
the full `--require-complete` acceptance gate; this slice does not claim end-to-end acceptance.

## Operations

| Owner Capability | Assistant Operations |
| --- | --- |
| Trigger Metadata and Removal | `auto_triggers`, `auto_trigger_remove` |
| Groups | `skill_groups`, `skill_group_create`, `skill_group_remove` |
| Group Assignments | `skill_group_assignments`, `skill_group_assign`, `skill_group_assignment_edit`, `skill_group_unassign` |
| Direct Assignment Listing | `skill_assignments` (existing create/edit/remove operations are unchanged) |
| Machine State and Sync | `skill_machine_state`, `skill_sync` |
| Release Review and Recommendations | `skill_builtin_get`, `skill_builtin_apply`, `skill_recommendation` |
| Git Import | `skill_git_preview`, `skill_git_import`, `skill_git_preview_discard` |
| Machine Discovery and Import | `skill_machine_discover`, `skill_machine_preview`, `skill_machine_import`, `skill_machine_discard` |
| Adoption and Recovery | `skill_adoption_preflight`, `skill_machine_adopt`, `skill_recovery_list`, `skill_recovery_restore` |
| Edited Deployed Copies | `skill_drift_preview`, `skill_drift_import`, `skill_drift_restore`, `skill_drift_discard` |
| Orphaned Copies | `skill_orphan_preview`, `skill_orphan_import`, `skill_orphan_discard`, `skill_orphan_preview_discard` |

Skill operations use `skillId`, `groupId`, `assignmentId` or `runnerId` as appropriate. The top-level
`previewId` selects the server-held discovery/review resource (the `:id` in its owner route).
The `payload` is the corresponding owner request body. A machine discovery ID and its selected
file preview ID are distinct: pass the discovery ID as top-level `previewId`, and the returned
file preview ID in `payload.previewId` for import/adoption. Recovery restore uses `recoveryId`
for the selected journal's operation ID. Clients cannot choose an arbitrary route or HTTP method.

For example, discover with `skill_machine_discover({runnerId, commandId})`, then preview with
`skill_machine_preview({previewId: discoveryId, commandId, payload: {candidateId}})`.
The preview's `result.data` contains the file review; its `result.revision` fences a later import.
Owner HTTP and Assistant calls share the same bounded preview stores, expiry and locks. Restarting
the control plane expires those previews; obtain a fresh one rather than redispatching a reserved
command. Content previews and results are never stored in command receipts or Assistant activity.

## Authority, Fences and Recovery

All operations recheck the current connection, operation grant and granting owner's resource
authority. Skill Library resources have installation ownership rather than Project placement;
these operations require an all-project grant. Naming a Machine cannot manufacture a Project
association. Existing version-policy operations `skill_pin_get`/`skill_pin_set` remain registered.
Runner protocol/OS support, offline refusals, provider-home leases, source observation checks,
deployment-impact acceptance and recovery journals remain in the shared application services.

Mutations and stateful preview creation take a durable `commandId`. Read/modify/write operations
also take `expectedRevision`, obtained from an authorized read or previous result. Group/import
flows use a persistent, monotonic library revision because they can affect multiple skills and
Machines. Even an unrelated library edit can require a reread; change-and-revert writes also
conflict. The fence is checked again after asynchronous inspection and synchronously before a
subsequent import/adoption effect. Trigger revisions include the schedule revision and secret-free
trigger metadata, including monotonic credential generations. Trigger reads never return signing
secrets. No new protocol capability/version is required for control-plane tool registration.

Destructive removal, import/replacement, restore and adoption honor the owner's current
`destructiveConfirmation`. Under `none`, standing authority executes directly. Under `confirm`,
the first call returns affected skills, deployment impact and online/offline target Machines plus
a short-lived `confirmationId`. Repeat unchanged arguments and `commandId` with that ID.
Grant/impact changes invalidate the confirmation. Confirmation consumption and receipt reservation
share one SQLite savepoint. This is Assistant-side confirmation; it never impersonates an owner
approval. Existing owner service source-review/observation acceptance fields remain required.

Use `command_get({commandId})` after a lost response. A duplicate never redispatches, even if a
preview expired or the outcome is uncertain. Receipts contain identifiers, digests, attribution
and status, without raw arguments, files, credentials, responses or transport diagnostics.
`succeeded` records service acceptance, not successful deployment to an offline Machine. Read
`skill_machine_state` and `skill_deployments` for reported outcomes; preserve uncertain recovery
journals and follow the owner's supported recovery flow before issuing a genuinely new command.

## Human Authority and Evidence Limits

Four exact routes retain authenticated owner authority, with reasons/remedies in the manifest:

- Creating or rotating an inbound automation trigger issues/discloses a standing signing credential.
- Automatic Git update opt-in establishes unattended use of the control plane's ambient credentials.
- Converting a legacy group accepts persistent resource ownership/deployment authority.

The Assistant can use already-configured Git access for an explicitly requested preview/import;
it cannot sign in, install credentials or change the unattended opt-in. Applying a built-in version
that would disable automatic Git credential use first requires the owner to disable that setting.
An owner can then use the normal Assistant built-in review/apply operations. These are human
authority classifications, not external technical limitations or silent app-management gaps.
Session automation-creation proposal/approval rules and scheduled campaign authorization remain
unchanged. This slice changes no rendered UI and needs no UI screenshot evidence.

Verification uses actual SQLite, Fastify MCP/owner adapters and shared services with fixture runner
and Git transports: **MOCKED/automated coverage**. It does not prove real Git credentials, provider
file adoption, OpenClaw model calls, Discord delivery, SSH hosts or deployed hosting behavior.
No hosting process is updated or restarted. Existing owner service tests cover platform-specific
refusals and recovery validation; real integration remains the campaign's separate acceptance work.

Run the group-6 registration/parity and behavior gates:

```sh
node --import tsx --test apps/control-plane/src/assistant-skill-parity-inventory.test.ts apps/control-plane/src/assistant-skill-parity.test.ts
```

The global strict parity command in `assistant-owner-parity.md` remains authoritative for final
#4468 acceptance and must pass after every group's entries are delivered.
