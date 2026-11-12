import { providerAccountSelectionPreviewForAgent, type ProviderAccountSelectionPreview, type ResourceScope } from "@wollipog/protocol";
import { PERSONAL_ORGANIZATION_ID, humanGlobalResourceAuthorizationError } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import { AssistantRefusal, type AssistantOperations, type AssistantOperation, type AssistantTarget } from "./assistant-connections.js";
import { AssistantCommandReceipts, assistantRequestDigest } from "./assistant-command-receipts.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import type { OwnerManagement, OwnerManagementResult } from "./owner-management.js";

const string = {type: "string"};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Supply an object of tool arguments.");
  return value as Record<string, unknown>;
}
function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new AssistantRefusal(`${key} must be a nonempty string of at most 4096 characters.`);
  return value;
}
export function machineWorkspaceCoordinates(target: AssistantTarget): [string, string] {
  const parsed: unknown = JSON.parse(target.id);
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(value => typeof value !== "string")) throw new AssistantRefusal("Workspace receipt target is invalid. Inspect the command with the owner.");
  return parsed as [string, string];
}
export const ASSISTANT_MACHINE_MANAGEMENT = [
  ["harness_select", "PUT /api/runners/:id/harness-installation", "runner", true, false],
  ["target_harness_select", "PUT /api/runners/:id/target-harness-installation", "runner", true, false],
  ["account_selection_get", "GET /api/runners/:id/provider-account-selection", "runner", false, false],
  ["installation_rename", "POST /api/assistant-connections/installation", "control_plane", true, false],
  ["runner_rename", "PATCH /api/runners/:id", "runner", true, false],
  ["runner_remove", "DELETE /api/runners/:id", "runner", true, true],
  ["runner_rediscover", "POST /api/runners/:id/rediscover", "runner", true, false],
  ["runner_external_sessions", "GET /api/runners/:id/external-sessions", "runner", false, false],
  ["runner_directory", "GET /api/runners/:id/list-directory", "runner", false, false],
  ["workspace_create", "POST /api/runners/:runnerId/workspaces", "runner", true, false],
  ["workspace_register", "POST /api/runners/:runnerId/workspaces/register", "runner", true, false],
  ["workspace_rename", "POST /api/runners/:runnerId/workspaces/:workspaceId/rename", "workspace", true, false],
  ["workspace_remove", "DELETE /api/runners/:runnerId/workspaces/:workspaceId", "workspace", true, true],
  ["workspace_scope_get", "GET /api/runners/:runnerId/workspaces/:workspaceId/access-scope", "workspace", false, false],
  ["project_scope_get", "GET /api/projects/:id/access-scope", "project", false, false],
] as const;
const descriptions: Record<typeof ASSISTANT_MACHINE_MANAGEMENT[number][0], string> = {
  harness_select: "Select an already discovered harness installation, preserving owner trust and protocol checks. Requires all projects; never installs or authenticates a harness.",
  target_harness_select: "Select an already discovered harness for an execution target through the same owner service. Requires all projects; never changes target trust.",
  account_selection_get: "Read the existing account-selection preview through its opaque agent-safe projection. Requires all projects; never returns account names, credential paths or account IDs.",
  installation_rename: "Rename this control plane display label as its personal-organization owner. Requires all projects; does not change standing authority or installation identity.",
  runner_rename: "Rename an authorized Machine. Requires all projects because its name is shared across projects.",
  runner_remove: "Remove an offline non-box runner through owner cleanup. Honors destructive confirmation; never stops a hosting stack. Reconcile commandId before retrying.",
  runner_rediscover: "Request fresh agent discovery on a Machine. Read runner_list for asynchronously reported capabilities.",
  runner_external_sessions: "Discover external sessions using the owner's runner service, including compatible SSH Machines. Requires all projects.",
  runner_directory: "Browse directories for workspace registration through the owner's service. Requires all projects; this does not grant file contents or credentials.",
  workspace_create: "Create a managed workspace through the owner's service. Requires all projects; does not create an Assistant authority grant.",
  workspace_register: "Register a Machine folder through the owner's service. Requires all projects; cannot import a folder to manufacture scoped access.",
  workspace_rename: "Rename a workspace only when every linked Project is granted. Display overrides survive runner re-registration.",
  workspace_remove: "Unregister a workspace, preserving files and dependency/protocol checks. Honors destructive confirmation and durable command receipts.",
  workspace_scope_get: "Read effective workspace access scope and authorized relationship impact; never returns an access-change confirmation token.",
  project_scope_get: "Read effective Project access scope and authorized relationship impact; persistent audience changes remain on the owner's access-scope path.",
};

/** Group 4 adapters use exactly the same services and command namespace as the owner APIs. */
export function registerAssistantMachineManagement(operations: AssistantOperations, db: ControlPlaneDb,
  service: OwnerManagement, receipts: AssistantCommandReceipts) {
  AssistantCommandConfirmations.install(db.raw());
  const confirmations = new AssistantCommandConfirmations(db.raw());
  type Context = Parameters<AssistantOperation["execute"]>[1];
  const publicResult = (result: OwnerManagementResult): OwnerManagementResult => {
    if (result.status < 400) return result;
    const body = (result.body ?? {}) as {error?: unknown; capabilityRequirement?: unknown; blockers?: unknown;
      requiredRunnerProtocolVersion?: number; runnerProtocolVersion?: number | null};
    const capabilityRequirement = body.capabilityRequirement ?? (Number.isInteger(body.requiredRunnerProtocolVersion)
      ? {requiredRunnerProtocolVersion: body.requiredRunnerProtocolVersion, runnerProtocolVersion: body.runnerProtocolVersion ?? null} : undefined);
    const known = typeof body.error === "string" && ["runner is offline", "runner not reachable", "runner not found", "workspace not found",
      "project not found", "name and path are required", "name must be a string", "displayName must be a string",
      "displayName must be 120 characters or fewer and contain no control characters", "path and distro must be strings",
      "agentId must be a string", "runner is online — stop it before removing",
      "this runner belongs to a box — remove the box instead (DELETE /api/boxes/:id)"].includes(body.error);
    return {status: result.status, body: {
      error: known ? `${body.error}. Inspect the Machine/Workspace in owner settings, correct the condition and use a new commandId for a new mutation.`
        : "The Machine or Workspace could not confirm this request. Inspect owner settings for dependencies or protocol recovery; reconcile command_get before retrying a mutation.",
      ...(capabilityRequirement ? {capabilityRequirement} : {}),
      ...(body.blockers ? {blockers: body.blockers} : {}),
    }};
  };
  type Kind = typeof ASSISTANT_MACHINE_MANAGEMENT[number][2];
  const target = (kind: Kind, value: unknown): AssistantTarget => {
    const args = object(value);
    if (kind === "control_plane") return {kind, id: db.instanceId()};
    if (kind === "project") {
      const id = text(args, "projectId");
      return {kind: "project", id, projectId: id};
    }
    const runnerId = text(args, "runnerId");
    if (kind === "runner") return {kind, id: runnerId};
    const workspaceId = text(args, "workspaceId"), projects = db.projectIdsForWorkspace(runnerId, workspaceId).sort();
    return {kind, id: JSON.stringify([runnerId, workspaceId]), ...(projects[0] ? {projectId: projects[0]} : {})};
  };
  const access: AssistantOperation["ownerCanAccess"] = (owner, resolved) => {
    if (resolved.kind === "receipt") return true; // Only server-owned command_get reconciliation uses this target.
    if (resolved.kind === "control_plane") return resolved.id === db.instanceId() && owner.role === "owner" && owner.organizationId === PERSONAL_ORGANIZATION_ID;
    if (resolved.kind === "project") return db.canManageProject(owner, resolved.id);
    if (resolved.kind === "runner") return db.canManageRunner(owner, resolved.id);
    if (resolved.kind !== "workspace") return false;
    const [runnerId, workspaceId] = machineWorkspaceCoordinates(resolved);
    return db.workspaceSource(runnerId, workspaceId) ? db.canManageWorkspace(owner, runnerId, workspaceId)
      : db.canManageRunner(owner, runnerId); // Absent sources expose only a prior receipt or content-free 404.
  };
  const checkScope = (kind: Kind, args: Record<string, unknown>, ctx: Context) => {
    const connection = db.assistantConnections.get(ctx.connection.id)!;
    if (kind !== "workspace") return;
    const projects = db.projectIdsForWorkspace(text(args, "runnerId"), text(args, "workspaceId"));
    for (const id of projects) {
      if (!db.canAccessProject(ctx.owner, id) || (connection.grant.projects !== "all" && !connection.grant.projects.includes(id))) {
        throw new AssistantRefusal("This workspace affects a Project outside the connection's current access. The owner can select every linked Project or grant all projects in Assistant Connections.");
      }
    }
  };
  const impact = (kind: Kind, args: Record<string, unknown>, ctx: Context) => {
    const runnerId = text(args, "runnerId"), runner = db.getRunner(runnerId);
    if (!runner) throw new AssistantRefusal("Runner not found. Refresh runner_list and select a current Machine.");
    if (kind === "workspace") {
      const id = text(args, "workspaceId"), workspace = runner.workspaces.find(item => item.id === id);
      if (!workspace) throw new AssistantRefusal("Workspace not found. Refresh runner_list before removing it.");
      checkScope(kind, args, ctx);
      return {runnerId, workspace: {id, name: workspace.name, path: workspace.path}, source: db.workspaceSource(runnerId, id),
        projects: db.projectIdsForWorkspace(runnerId, id).sort(), blockers: db.workspaceRemovalBlockers(runnerId, id)};
    }
    const sessions = db.listSessions({includeArchived: true}).filter(session => session.runnerId === runnerId);
    if (sessions.some(session => !db.canAccessSession(ctx.owner, session.id))) throw new AssistantRefusal("The removal affects inaccessible sessions. Ask the owner to inspect and resolve their Machine cleanup before retrying.");
    return {runnerId, displayName: runner.displayName, hostname: runner.hostname, status: runner.status,
      workspaces: runner.workspaces.map(workspace => ({id: workspace.id, path: workspace.path})).sort((a, b) => a.id.localeCompare(b.id)),
      sessions: sessions.map(session => session.id).sort(), projects: db.projectIdsForRunner(runnerId).sort()};
  };
  for (const [name, route, kind, mutate, destructive] of ASSISTANT_MACHINE_MANAGEMENT) {
    const properties = kind === "control_plane" ? {} : kind === "project" ? {projectId: string} : {runnerId: string, ...(kind === "workspace" ? {workspaceId: string} : {})};
    const space = route.indexOf(" "), method = route.slice(0, space), path = route.slice(space + 1);
    operations.register({name, description: descriptions[name], ownerCanAccess: (owner, resolved) =>
      humanGlobalResourceAuthorizationError(method, path, owner) === null && access(owner, resolved),
      inputSchema: {type: "object", additionalProperties: false, properties: {...properties, payload: {type: "object"},
        ...(mutate ? {commandId: string, confirmationId: string} : {})},
        required: [...Object.keys(properties), ...(mutate ? ["commandId"] : [])]},
      resolveTarget: value => target(kind, value), execute: async (value, ctx) => {
        const args = object(value), payload = args.payload === undefined ? {} : object(args.payload);
        let owner = await ctx.recheck();
        checkScope(kind, args, {...ctx, owner});
        const params = kind === "control_plane" ? {} : kind === "project" ? {id: text(args, "projectId")} : {id: text(args, "runnerId"), runnerId: text(args, "runnerId"),
          ...(kind === "workspace" ? {workspaceId: text(args, "workspaceId")} : {})};
        const execute = () => service.execute(route, {principal: owner, params, body: payload, query: payload});
        if (!mutate) {
          let result: OwnerManagementResult;
          if (name === "workspace_scope_get" || name === "project_scope_get") {
            // Read the owner's existing scope service, but never issue standing-authority tokens.
            result = await service.execute(route, {principal: owner, params, body: {},
              query: {ownerKind: "organization", ownerId: owner.organizationId}});
            if (result.status < 400) {
              const preview = (result.body as {preview: {currentScope: ResourceScope; affectedProjects: unknown[]; activeSessionCount: number; totalSessionCount: number}}).preview;
              result = {status: result.status, body: {scope: preview.currentScope, affectedProjects: preview.affectedProjects,
                activeSessionCount: preview.activeSessionCount, totalSessionCount: preview.totalSessionCount}};
            }
          } else result = await execute();
          if (name === "account_selection_get" && result.status < 400) result = {...result,
            body: providerAccountSelectionPreviewForAgent(result.body as ProviderAccountSelectionPreview)};
          owner = await ctx.recheck();
          checkScope(kind, args, {...ctx, owner});
          return publicResult(result);
        }
        const commandId = text(args, "commandId"), {confirmationId, ...request} = args;
        const current = db.assistantConnections.get(ctx.connection.id)!, resolved = target(kind, args);
        const identity = {controlPlaneId: db.instanceId(), connectionId: current.id, operationId: commandId,
          operation: name, argumentsDigest: assistantRequestDigest(request), grantRevision: current.revision, target: resolved};
        if (receipts.get(current.id, commandId)) return {receipt: receipts.reserve(identity).receipt,
          recovery: "Already reserved. Reconcile command_get and current state; never redispatch accepted or uncertain commands."};
        const affected = destructive ? impact(kind, args, {...ctx, owner}) : undefined;
        const binding = {connectionId: current.id, grantRevision: current.revision, operation: name,
          argumentsDigest: identity.argumentsDigest, targetDigest: assistantRequestDigest({target: resolved, impact: affected ?? null})};
        const confirm = destructive && db.assistantConnections.destructiveConfirmation(current.id) === "confirm";
        if (confirm && confirmationId === undefined) return {confirmationRequired: true, ...confirmations.issue(binding),
          operation: name, target: resolved, impact: affected,
          recovery: "Review this exact scope, then repeat unchanged arguments and commandId with confirmationId before expiry. Nothing was dispatched."};
        const reservation = receipts.reserve(identity, () => {if (confirm) confirmations.consume(text(args, "confirmationId"), binding);});
        if (!reservation.created) return {receipt: reservation.receipt};
        try {
          const result = publicResult(await execute());
          const workspaceId = (result.body as {workspace?: {id?: string}} | undefined)?.workspace?.id;
          if (destructive && result.status < 400) return {receipt: receipts.settle(current.id, commandId, "succeeded", workspaceId),
            meaning: "Owner service accepted removal. Reconcile current Machine/Workspace state before any new action."};
          owner = await ctx.recheck();
          checkScope(kind, args, {...ctx, owner});
          const receipt = receipts.settle(current.id, commandId, result.status < 400 ? "succeeded" : result.status >= 500 ? "uncertain" : "failed", workspaceId);
          return {receipt, ...result};
        } catch {
          return {receipt: receipts.settle(current.id, commandId, "uncertain"),
            recovery: "Outcome or current access is uncertain. Inspect command_get and the owner's current resource state; never replay this command."};
        }
      }});
  }
}
