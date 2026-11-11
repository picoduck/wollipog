import { randomUUID } from "node:crypto";
import { runnerCapabilityRequirementError, runnerSupportsProtocol, workspaceRemovalBlockedMessage, type ResourceScope } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { isRunnerRequestNotSentError, type Hub } from "./hub.js";
import type { SessionsService } from "./sessions.js";
import { OwnerManagement } from "./owner-management.js";
import { projectName, requestedAccessScope, accessScopeOwnerFromQuery, accessScopeTransitionError, accessScopePreviewForPrincipal } from "./project-management-validation.js";

/** Machine/Workspace application services shared by owner HTTP and Assistant transports. */
export function createOwnerMachineManagement(db: ControlPlaneDb, hub: Hub, svc: SessionsService) {
  const management = new OwnerManagement();
  management.define("PATCH", "/api/runners/:id", (req, reply) => {
    const {id} = req.params as {id: string};
    if (!db.canManageRunner(req.principal, id)) return reply.code(403).send({error: "Machine owner or organization admin permission is required"});
    const body = (req.body ?? {}) as {displayName?: unknown};
    if (typeof body.displayName !== "string") return reply.code(400).send({error: "displayName must be a string"});
    const displayName = body.displayName.trim();
    if (displayName && !projectName(displayName)) return reply.code(400).send({error: "displayName must be 120 characters or fewer and contain no control characters"});
    const boxId = db.boxIdForRunner(id);
    if (!db.getRunner(id) && !boxId) return reply.code(404).send({error: "runner not found"});
    db.setMachineDisplayName(id, displayName);
    hub.runnerChanged(id);
    if (boxId) hub.boxChanged(boxId);
    return {ok: true};
  });
  management.define("POST", "/api/runners/:id/rediscover", (req, reply) => {
    const {id} = req.params as {id: string};
    if (!db.canManageRunner(req.principal, id)) return reply.code(403).send({error: "Machine owner or organization admin permission is required"});
    if (!hub.isRunnerOnline(id)) return reply.code(409).send({error: "runner is offline"});
    if (!hub.sendToRunner(id, {type: "rediscover", runnerId: id})) return reply.code(503).send({error: "runner not reachable"});
    return {ok: true};
  });
  management.define("DELETE", "/api/runners/:id", (req, reply) => {
    const {id} = req.params as {id: string};
    if (!db.canManageRunner(req.principal, id)) return reply.code(403).send({error: "Machine owner or organization admin permission is required"});
    if (hub.isRunnerOnline(id)) return reply.code(409).send({error: "runner is online — stop it before removing"});
    if (db.boxIdForRunner(id)) return reply.code(409).send({error: "this runner belongs to a box — remove the box instead (DELETE /api/boxes/:id)"});
    const projectIds = db.projectIdsForRunner(id), removed = db.deleteRunner(id);
    if (!removed) return reply.code(404).send({error: "runner not found"});
    for (const sessionId of removed.sessionIds) hub.sessionRemoved(sessionId, false);
    for (const runId of removed.runIds) hub.runRemoved(runId);
    for (const podId of removed.podIds) {
      const pod = db.reconcilePodAfterMembershipLoss(podId, Date.now());
      if (pod) hub.podChanged(pod);
    }
    hub.runnerRemoved(id);
    for (const projectId of projectIds) hub.projectChangedById(projectId);
    return reply.code(204).send(undefined);
  });
  management.define("GET", "/api/runners/:id/external-sessions", async (req, reply) => {
    const {id} = req.params as {id: string}, query = (req.query ?? {}) as {agentId?: unknown};
    if (!db.canAccessRunner(req.principal, id)) return reply.code(404).send({error: "runner not found"});
    if (query.agentId !== undefined && typeof query.agentId !== "string") return reply.code(400).send({error: "agentId must be a string"});
    const result = await svc.listExternalSessions(id, query.agentId || undefined);
    return result.ok ? {sessions: result.data} : reply.code(result.status).send({error: result.error, capabilityRequirement: result.capabilityRequirement});
  });
  management.define("GET", "/api/runners/:id/list-directory", async (req, reply) => {
    const {id} = req.params as {id: string}, query = (req.query ?? {}) as {path?: unknown; distro?: unknown};
    if (!db.canAccessRunner(req.principal, id)) return reply.code(404).send({error: "runner not found"});
    if ((query.path !== undefined && typeof query.path !== "string") || (query.distro !== undefined && typeof query.distro !== "string")) return reply.code(400).send({error: "path and distro must be strings"});
    const result = await svc.listDirectory(id, query.path ?? "", query.distro || undefined);
    return result.ok ? result.data : reply.code(result.status).send({error: result.error, capabilityRequirement: result.capabilityRequirement});
  });
  for (const register of [false, true]) management.define("POST", `/api/runners/:runnerId/workspaces${register ? "/register" : ""}`, (req, reply) => {
    const {runnerId} = req.params as {runnerId: string};
    if (!db.canManageRunner(req.principal, runnerId)) return reply.code(403).send({error: "Machine owner or organization admin permission is required"});
    const body = (req.body ?? {}) as {name?: unknown; path?: unknown};
    const name = typeof body.name === "string" ? body.name.trim() : "", path = typeof body.path === "string" ? body.path.trim() : "";
    if (!name || !path) return reply.code(400).send({error: "name and path are required"});
    if (!db.getRunner(runnerId)) return reply.code(404).send({error: "runner not found"});
    if (!hub.isRunnerOnline(runnerId)) return reply.code(409).send({error: "runner is offline"});
    const scope: ResourceScope = {organizationId: req.principal.organizationId, owner: {kind: "user", userId: req.principal.userId}};
    try {
      const workspace = register ? db.registerMachineWorkspace(runnerId, {name, path}, scope) : db.createWorkspace(runnerId, {name, path}, scope);
      hub.runnerChanged(runnerId);
      if (!register) for (const projectId of db.projectIdsForWorkspace(runnerId, workspace.id)) hub.projectChangedById(projectId);
      return {workspace};
    } catch (error) {
      if (!register) throw error;
      const message = (error as Error).message;
      return reply.code(message.includes("already registered") ? 409 : 400).send({error: message});
    }
  });
  management.define("POST", "/api/runners/:runnerId/workspaces/:workspaceId/rename", (req, reply) => {
    const {runnerId, workspaceId} = req.params as {runnerId: string; workspaceId: string};
    const body = (req.body ?? {}) as {name?: unknown};
    if (typeof body.name !== "string") return reply.code(400).send({error: "name must be a string"});
    if (!db.getRunner(runnerId)) return reply.code(404).send({error: "runner not found"});
    if (!db.canManageWorkspace(req.principal, runnerId, workspaceId)) return reply.code(404).send({error: "workspace not found"});
    const projects = db.projectIdsForWorkspace(runnerId, workspaceId);
    db.renameWorkspace(runnerId, workspaceId, body.name);
    hub.runnerChanged(runnerId);
    for (const id of projects) hub.projectChangedById(id);
    for (const id of db.sessionIdsForWorkspace(runnerId, workspaceId)) hub.sessionChangedById(id);
    return {ok: true};
  });
  management.define("DELETE", "/api/runners/:runnerId/workspaces/:workspaceId", async (req, reply) => {
    const {runnerId, workspaceId} = req.params as {runnerId: string; workspaceId: string};
    const runner = db.getRunner(runnerId);
    if (!runner) return reply.code(404).send({error: "runner not found"});
    if (!db.canManageWorkspace(req.principal, runnerId, workspaceId)) return reply.code(404).send({error: "workspace not found"});
    const source = db.workspaceSource(runnerId, workspaceId);
    if (!source) return reply.code(404).send({error: "workspace not found"});
    if (!hub.isRunnerOnline(runnerId)) return reply.code(409).send({error: "runner is offline"});
    if (source === "configured" && !runnerSupportsProtocol(runner.protocolVersion, "workspaceRemoval")) return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "workspaceRemoval", "removing configured workspaces"));
    const started = db.beginWorkspaceRemoval(runnerId, workspaceId);
    if (!started) return reply.code(404).send({error: "workspace not found"});
    if (!started.ok) return reply.code(409).send({error: workspaceRemovalBlockedMessage(started.blockers), blockers: started.blockers});
    hub.runnerChanged(runnerId);
    if (started.source === "managed") return {removed: true};
    const requestId = `workspace_remove_${randomUUID()}`;
    try {
      const result = await hub.requestFromRunner(runnerId, requestId, {type: "remove_workspace", requestId, runnerId, workspaceId, path: started.path});
      if (result.type !== "remove_workspace_result" || !result.ok) {
        db.cancelWorkspaceRemoval(runnerId, workspaceId);
        hub.runnerChanged(runnerId);
        return result.type === "remove_workspace_result" ? reply.code(409).send({error: result.error ?? "The machine could not remove the workspace."}) : reply.code(502).send({error: "unexpected runner reply"});
      }
    } catch (error) {
      if (isRunnerRequestNotSentError(error)) {
        db.cancelWorkspaceRemoval(runnerId, workspaceId);
        hub.runnerChanged(runnerId);
        return reply.code(409).send({error: "runner is offline"});
      }
      return reply.code(504).send({error: "The machine didn't confirm the removal. The workspace stays hidden, and comes back when the machine reconnects if it wasn't removed."});
    }
    db.finishWorkspaceRemoval(runnerId, workspaceId);
    return {removed: true};
  });
  management.define("GET", "/api/runners/:runnerId/workspaces/:workspaceId/access-scope", (req, reply) => {
    const {runnerId, workspaceId} = req.params as {runnerId: string; workspaceId: string}, principal = req.principal;
    if (!db.canManageWorkspace(principal, runnerId, workspaceId)) return reply.code(404).send({error: "workspace not found"});
    const requested = requestedAccessScope(db, principal, accessScopeOwnerFromQuery(req.query));
    if (!requested.ok) return reply.code(requested.status).send({error: requested.error});
    const current = db.workspaceScope(runnerId, workspaceId);
    if (!current) return reply.code(404).send({error: "workspace not found"});
    const error = accessScopeTransitionError(db, principal, current, requested.scope);
    if (error) return reply.code(403).send({error});
    const preview = db.previewWorkspaceAccessScope(runnerId, workspaceId, requested.scope);
    return preview ? {preview: accessScopePreviewForPrincipal(db, principal, preview)} : reply.code(404).send({error: "workspace not found"});
  });
  management.define("GET", "/api/projects/:id/access-scope", (req, reply) => {
    const {id} = req.params as {id: string}, principal = req.principal;
    if (!db.canManageProject(principal, id) || !db.getProjectForPrincipal(principal, id)) return reply.code(404).send({error: "project not found"});
    const requested = requestedAccessScope(db, principal, accessScopeOwnerFromQuery(req.query));
    if (!requested.ok) return reply.code(requested.status).send({error: requested.error});
    const current = db.projectScope(id);
    if (!current) return reply.code(404).send({error: "project not found"});
    const error = accessScopeTransitionError(db, principal, current, requested.scope);
    if (error) return reply.code(403).send({error});
    const preview = db.previewProjectAccessScope(id, requested.scope);
    return preview ? {preview} : reply.code(404).send({error: "project not found"});
  });
  return management;
}
