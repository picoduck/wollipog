# Assistant Machine and Workspace Management

Refs #4468. Group 4 extends the same registry, receipt store and owner application services
described in [Assistant Owner-Capability Parity](assistant-owner-parity.md).

| Owner Capability | Assistant Tool | Input |
| --- | --- | --- |
| Select Discovered Harness | `harness_select` | `runnerId`, `commandId`, `payload.agentId`, `payload.installationId` |
| Select Target Harness | `target_harness_select` | `runnerId`, `commandId`, `payload.targetId`, `payload.agentId`, `payload.installationId` |
| Read Safe Account Selection | `account_selection_get` | `runnerId`, owner-preview query fields in `payload` |
| Rename Installation | `installation_rename` | `commandId`, `payload.name` |
| Rename Machine | `runner_rename` | `runnerId`, `commandId`, `payload.displayName` |
| Remove Offline Machine | `runner_remove` | `runnerId`, `commandId`, optional `confirmationId` |
| Rediscover Agents | `runner_rediscover` | `runnerId`, `commandId` |
| Discover External Sessions | `runner_external_sessions` | `runnerId`, optional `payload.agentId` |
| Browse Registration Directories | `runner_directory` | `runnerId`, optional `payload.path` and `payload.distro` |
| Create Managed Workspace | `workspace_create` | `runnerId`, `commandId`, `payload.name`, `payload.path` |
| Register Workspace Folder | `workspace_register` | `runnerId`, `commandId`, `payload.name`, `payload.path` |
| Rename Workspace | `workspace_rename` | `runnerId`, `workspaceId`, `commandId`, `payload.name` |
| Remove Workspace | `workspace_remove` | `runnerId`, `workspaceId`, `commandId`, optional `confirmationId` |
| Read Workspace Access | `workspace_scope_get` | `runnerId`, `workspaceId` |
| Read Project Access | `project_scope_get` | `projectId` |

The owner HTTP routes and these tools invoke `createOwnerMachineManagement` together with the
existing session/runner services. No HTTP credential impersonation or descendant/campaign
membership is involved. The same tools and standing grants apply to local and SSH Machines;
existing runner compatibility, availability and OS/provider restrictions still apply.

## Authority and Scope

Full Access includes these registrations. Narrow operation grants name exact tool names.
Runner-wide operations, external-session discovery and arbitrary folder browsing/registration
require all projects: they cannot be confined to an existing project's resources. Selected-project
grants cannot register an arbitrary folder and then attach it to manufacture new access.

Workspace operations check every currently linked project, plus the granting owner's Machine
and Workspace authority. All linked projects must remain granted and accessible. An unprojected
workspace requires all projects. Project access reads use the exact project grant and owner
management authority. Access-scope tools return effective scope and authorized impact only;
they do not return an audience-change confirmation token. Persistent audience changes remain
on the authenticated owner access-scope path.

Every call checks current authority. Asynchronous results are checked again before release.
The shared owner HTTP global-resource ceiling also applies: Machine-global operations require
the installation's personal organization. Other organizations retain the owner API's member-scoped
Workspace rename and scope reads; owning a runner alone does not bypass a global route restriction.
If grants narrow while a directory or external-session read is in flight, its result is withheld.
If access changes after a write commits, the command stays uncertain and private results are
withheld; an uncertain receipt never authorizes replay. Activity records failed/uncertain service
outcomes as failures, rather than treating successful RPC delivery as successful management.

## Removal and Recovery

Under `destructiveConfirmation: "confirm"`, removal first returns a short-lived preview with
the exact target and affected scope. Repeat unchanged arguments and command ID with its
`confirmationId`. A changed grant, workspace name/source, dependent resources or Machine state
invalidates the preview. Confirmation consumption and command reservation share one transaction.
Under `"none"`, the owner's standing authority applies without this additional confirmation.

Workspace removal unregisters its record; it does not delete files. Existing Project Locations,
active sessions and automation dependencies still block removal. Configured workspaces require
a compatible online runner. A known-not-sent command restores the hidden record; a lost reply
keeps the existing pending-removal recovery behavior and an uncertain receipt. Reconnection
reconciles the runner's actual state. Never repeat a command merely because its response was lost.

Machine removal requires an offline runner. Box-backed Machines still require the owner's Box
removal path, because it also tears down the runtime state. The preview exposes no inaccessible
session identifiers. Removal uses the existing database cascade, Project detachment, Pod
reconciliation and dashboard notifications. This feature never stops or restarts the hosting stack.

Mutation tools use the shared `commandId` namespace. `command_get` retains only a content-free
verdict after a source Machine or Workspace disappears, under current operation/project authority.
No private response body, supplied path, transcript or raw runner exception is cached in receipts.
Read tool results include an HTTP-style `status` and `body`; mutations also include `receipt`.
Check these fields. `succeeded` means the owner service accepted the action, not that asynchronous
rediscovery or other runner work finished. Read current `runner_list` state for completion.

## Audit Boundaries and Evidence

Only group-4 audit classifications change here. Sign-in transactions, provider credential HOME
recovery and persistent provider-account access policies remain explicit human-authority paths,
with exact reasons and supported owner remedies in the audit. Host graphical editor/file-manager
actions are interactive workspace I/O; directory selection for registration is implemented above.
The campaign selected option 1: selecting already-trusted, already-discovered harness installations
and reading the existing opaque account-selection preview are ordinary app management. Both harness
choices reuse the exact owner service, retaining discovered-candidate and protocol checks. They do
not install, trust or authenticate new harnesses. The preview uses the existing agent projection;
account IDs, account labels and credential HOME paths are withheld. Account creation and recovery,
sign-in, credentials and lasting account policies remain human-only with explicit audit reasons.
Installation renaming shares `AssistantConnectionManagement.rename` with the owner API and the
`install_name` tool; both `installation_rename` and `install_name` remain registered aliases.
It retains the personal-organization owner check;
it changes only the display name, without changing installation ID or Assistant authority.

Tests use actual SQLite, Fastify HTTP/MCP registration, production inventory composition and
shared application services, with synthetic owner identity and fixture runner transport. Database
reopen verifies durable uncertainty. This is automated/mocked execution evidence, not real SSH,
OpenClaw model use, Discord delivery, remote TLS or hosting deployment. The complete campaign
acceptance matrix and the global strict parity gate remain required.
