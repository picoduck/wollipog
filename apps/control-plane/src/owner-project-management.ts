import { randomUUID } from "node:crypto";
import type { AddProjectLocationRequest, CreateProjectLocationRequest, CreateProjectRequest, UpdateProjectRequest, MoveProjectLocationRequest, RenameProjectLocationRequest, ProjectLocationView, ResourceScope, SessionView } from "@wollipog/protocol";
import { OccupiedUnreadLocationError, type ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { SessionsService } from "./sessions.js";
import { childSessionDefaultsError } from "./child-session-guardrails.js";
import { type HumanPrincipal } from "./identity.js";
import { projectName, requestedAccessScope } from "./project-management-validation.js";
import { OwnerManagement, type OwnerManagementInput, type OwnerManagementReply } from "./owner-management.js";
import { failureBody, type CapabilityRefusal } from "./capability-refusal.js";

export function createOwnerProjectManagement(deps: {
  db: ControlPlaneDb; hub: Hub; svc: SessionsService;
  locationAdded: (locationId: string, owner: HumanPrincipal) => Promise<unknown>;
  runnerCapabilityError: (runnerId: string, capability: "directoryListing" | "worktreeSetupConfig", operation: string) => CapabilityRefusal | null;
}) {
  const {db, hub, svc, runnerCapabilityError} = deps;
  const campaignLocations = {locationAdded: deps.locationAdded};
  const management = new OwnerManagement();
  const respond = (reply: OwnerManagementReply, result: {ok: boolean; status: number; data?: unknown; error?: string}) => reply.code(result.status).send(result.ok ? result.data : failureBody(result));
  const accessibleProject = (req: OwnerManagementInput, projectId: string) => {
    const principal = req.principal;
    return principal ? db.getProjectForPrincipal(principal, projectId) : null;
  };

  const manageableProject = (req: OwnerManagementInput, projectId: string) => {
    const principal = req.principal;
    return principal && db.canManageProject(principal, projectId)
      ? db.getProjectForPrincipal(principal, projectId)
      : null;
  };

  const canManageAffectedSessions = (
    principal: HumanPrincipal,
    predicate: (session: SessionView) => boolean,
  ) => db.listSessions({ includeArchived: true })
    .filter(predicate)
    .every((session) => db.canAccessSession(principal, session.id));


  management.define("POST", "/api/projects", async (req, reply) => {
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const body = (req.body ?? {}) as CreateProjectRequest;
    const name = projectName(body.name);
    if (!name) return reply.code(400).send({ error: "name must be 1-120 characters" });
    const defaultScope: ResourceScope = {
      organizationId: principal.organizationId,
      owner: principal.role === "owner" || principal.role === "admin"
        ? { kind: "organization", organizationId: principal.organizationId }
        : { kind: "user", userId: principal.userId },
    };
    const requestId = body.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(requestId))) {
      return reply.code(400).send({ error: "requestId must be 1-128 letters, digits, dashes or underscores" });
    }
    const requested = requestedAccessScope(db, principal, body.owner, defaultScope);
    if (!requested.ok) return reply.code(requested.status).send({ error: requested.error });
    if (requestId === undefined) {
      const project = db.createProject({
        name,
        scope: requested.scope,
      });
      hub.projectChanged(project);
      return reply.code(201).send({ project: db.getProjectForPrincipal(principal, project.id)! });
    }
    // A retry after a lost reply (#3468) returns the project the first request created. It is keyed
    // by this human, and the replayed project must still be one they can see.
    const result = db.createProjectForRequest({
      userId: principal.userId,
      requestId,
      name,
      scope: requested.scope,
    });
    if ("refused" in result) {
      return reply.code(409).send(result.refused === "reused"
        ? { error: "This request id was already used for a project with a different name or access.", code: "PROJECT_REQUEST_ID_REUSED" }
        : { error: "The project this request created is no longer available.", code: "PROJECT_REQUEST_UNAVAILABLE" });
    }
    const visible = db.getProjectForPrincipal(principal, result.project.id);
    if (!visible) {
      return reply.code(409).send({ error: "The project this request created is no longer available.", code: "PROJECT_REQUEST_UNAVAILABLE" });
    }
    if (result.created) hub.projectChanged(result.project);
    return reply.code(result.created ? 201 : 200).send({ project: visible });
  });

  management.define("PATCH", "/api/projects/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    const body = (req.body ?? {}) as UpdateProjectRequest;
    if (body.name === undefined && body.hidden === undefined && body.childSessionDefaults === undefined && body.memorySharing === undefined) {
      return reply.code(400).send({ error: "name, hidden, childSessionDefaults, or memorySharing is required" });
    }
    const name = body.name === undefined ? undefined : projectName(body.name);
    if (body.name !== undefined && !name) return reply.code(400).send({ error: "name must be 1-120 characters" });
    if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
      return reply.code(400).send({ error: "hidden must be a boolean" });
    }
    if (body.memorySharing !== undefined && body.memorySharing !== "separate" && body.memorySharing !== "shared") {
      return reply.code(400).send({ error: "memorySharing must be separate or shared" });
    }
    if (body.childSessionDefaults !== undefined) {
      const error = childSessionDefaultsError(body.childSessionDefaults);
      if (error) return reply.code(400).send({ error });
    }
    db.updateProject(id, {
      ...(name ? { name } : {}),
      ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
      ...(body.childSessionDefaults !== undefined ? { childSessionDefaults: body.childSessionDefaults } : {}),
      ...(body.memorySharing !== undefined ? { memorySharing: body.memorySharing } : {}),
    });
    const project = db.getProject(id)!;
    if (body.memorySharing !== undefined) hub.syncProjectMemory(id);
    hub.projectChanged(project);
    return { project: db.getProjectForPrincipal(principal, id)! };
  });

  management.define("DELETE", "/api/projects/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    if (!canManageAffectedSessions(principal, (session) => session.projectId === id)) {
      return reply.code(409).send({ error: "project contains sessions you cannot manage" });
    }
    // What deleting it ends of an unread Location's refusal leaves its pauses like any revocation, and
    // names who deleted it, whose action led to it (#4319, #3916).
    let deleted: ReturnType<typeof db.deleteProject>;
    try {
      deleted = db.deleteProject(id, Date.now(), (root, revoked) => svc.settleCampaignBoundaryChange(root, revoked, principal.userId));
    } catch (error) {
      // Only the sessions this person can see are named (#4319).
      return reply.code(409).send({ error: error instanceof OccupiedUnreadLocationError ? error.describe((sessionId) => db.canAccessSession(principal, sessionId)) : (error as Error).message });
    }
    if (!deleted) return reply.code(404).send({ error: "project not found" });
    hub.projectRemoved(id);
    for (const sessionId of deleted.sessionIds) hub.sessionChangedById(sessionId);
    return { deleted: true };
  });

  management.define("POST", "/api/projects/:id/locations", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    const body = (req.body ?? {}) as AddProjectLocationRequest;
    if (typeof body.runnerId !== "string" || !body.runnerId || typeof body.workspaceId !== "string" || !body.workspaceId) {
      return reply.code(400).send({ error: "runnerId and workspaceId are required" });
    }
    if (!db.canAccessWorkspace(principal, body.runnerId, body.workspaceId)) {
      return reply.code(404).send({ error: "workspace not found" });
    }
    let added: ProjectLocationView;
    try {
      added = db.addProjectLocation(id, { runnerId: body.runnerId, workspaceId: body.workspaceId, addedByUserId: principal.userId });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    const project = db.getProject(id)!;
    hub.projectChanged(project);
    // Campaigns in this Project inspect it in the background (#4117); the response never waits.
    void campaignLocations.locationAdded(added.id, principal);
    return { project: db.getProjectForPrincipal(principal, id)! };
  });

  management.define("POST", "/api/projects/:id/locations/new", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    const body = (req.body ?? {}) as Partial<CreateProjectLocationRequest>;
    const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
    const name = projectName(body.name);
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!runnerId || !name || !path || path.length > 4096 || /[\0-\x1f\x7f]/.test(path)) {
      return reply.code(400).send({ error: "runnerId, a 1-120 character name, and a valid path are required" });
    }
    if (!db.canAccessRunner(principal, runnerId)) return reply.code(404).send({ error: "runner not found" });
    const projectScope = db.projectScope(id);
    if (!projectScope) return reply.code(404).send({ error: "project not found" });
    const requested = requestedAccessScope(db, principal, body.owner, projectScope);
    if (!requested.ok) return reply.code(requested.status).send({ error: requested.error });
    if (!hub.isRunnerOnline(runnerId)) return reply.code(409).send({ error: "runner is offline" });
    const unsupported = runnerCapabilityError(runnerId, "directoryListing", "directory browsing");
    if (unsupported) return reply.code(409).send(failureBody(unsupported));
    const browsed = await svc.listDirectory(runnerId, path);
    if (!browsed.ok) {
      const message = browsed.status === 404
        ? "The selected folder was not found on this Machine. It may have moved or been deleted; browse for the folder again."
        : `The selected folder could not be verified on this Machine: ${browsed.error}`;
      return reply.code(browsed.status).send({ error: message });
    }
    if (!browsed.data?.path) return reply.code(502).send({ error: "the runner did not return the selected directory" });
    await req.recheck?.();
    if (!db.canManageProject(principal, id) || !db.canAccessRunner(principal, runnerId)) {
      return reply.code(403).send({error: "Project or Machine access changed during directory inspection."});
    }
    let created: { id: string };
    try {
      created = db.createProjectWorkspace(id, runnerId, { name, path: browsed.data.path }, Date.now(), requested.scope, principal.userId);
    } catch (error) {
      const message = (error as Error).message;
      // The code tells Add Location this refusal apart: after a lost reply, the retry is refused this
      // way when the first request registered the folder (#3468).
      return message.includes("already registered")
        ? reply.code(409).send({ error: message, code: "LOCATION_ALREADY_REGISTERED" })
        : reply.code(400).send({ error: message });
    }
    const project = db.getProject(id)!;
    hub.runnerChanged(runnerId);
    hub.projectChanged(project);
    const createdLocation = db.findProjectLocationForProject(id, runnerId, created.id);
    if (createdLocation) void campaignLocations.locationAdded(createdLocation.id, principal);
    return reply.code(201).send({ project: db.getProjectForPrincipal(principal, id)! });
  });

  management.define("POST", "/api/projects/:id/locations/move", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    const locationId = (req.body as MoveProjectLocationRequest | undefined)?.locationId;
    const location = typeof locationId === "string" ? db.projectLocation(locationId) : null;
    if (!location || !db.canManageProject(principal, location.projectId)) {
      return reply.code(404).send({ error: "project location not found" });
    }
    if (!canManageAffectedSessions(principal, (session) => session.projectLocationId === location.id)) {
      return reply.code(409).send({ error: "project location contains sessions you cannot manage" });
    }
    const sourceProjectId = location.projectId;
    const affectedSessionIds = db.listSessions({ includeArchived: true })
      .filter((session) => session.projectLocationId === location.id)
      .map((session) => session.id);
    let moved: ProjectLocationView | null;
    try {
      // What a move ends of an unread Location's refusal leaves its pauses like any revocation, and
      // names who moved it, whose action led to it (#4319, #3916).
      moved = db.moveProjectLocation(location.id, id, Date.now(), principal.userId,
        (root, revoked) => svc.settleCampaignBoundaryChange(root, revoked, principal.userId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    hub.projectChangedById(sourceProjectId);
    hub.projectChangedById(id);
    for (const sessionId of affectedSessionIds) hub.sessionChangedById(sessionId);
    if (moved && sourceProjectId !== id) void campaignLocations.locationAdded(moved.id, principal);
    return { project: db.getProjectForPrincipal(principal, id)! };
  });

  management.define("DELETE", "/api/projects/:id/locations/:locationId", async (req, reply) => {
    const { id, locationId } = req.params as { id: string; locationId: string };
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    const location = db.projectLocation(locationId);
    if (!location || location.projectId !== id) {
      return reply.code(404).send({ error: "project location not found" });
    }
    if (!canManageAffectedSessions(principal, (session) => session.projectLocationId === locationId)) {
      return reply.code(409).send({ error: "project location contains sessions you cannot manage" });
    }
    // What removing it ends of an unread Location's refusal leaves its pauses like any revocation, and
    // names who removed it, whose action led to it (#4319, #3916).
    // A campaign session running on an unread Location keeps it in place, so a read can still end its
    // refusal; the refusal says so (#4319).
    try {
      db.removeProjectLocation(locationId, Date.now(), (root, revoked) => svc.settleCampaignBoundaryChange(root, revoked, principal.userId));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof OccupiedUnreadLocationError ? error.describe((sessionId) => db.canAccessSession(principal, sessionId)) : (error as Error).message });
    }
    const project = db.getProject(id)!;
    hub.projectChanged(project);
    for (const session of db.listSessions({ includeArchived: true })) {
      if (session.projectId === id) hub.sessionChanged(session, false);
    }
    return { project: db.getProjectForPrincipal(principal, id)! };
  });

  // Rename a Location within this Project (#4151): its label here only. The workspace, its folder, and
  // the same workspace's Locations in other Projects keep their names, so the machine need not be online.
  management.define("PATCH", "/api/projects/:id/locations/:locationId", async (req, reply) => {
    const { id, locationId } = req.params as { id: string; locationId: string };
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    const location = db.projectLocation(locationId);
    if (!location || location.projectId !== id) {
      return reply.code(404).send({ error: "project location not found" });
    }
    const name = projectName((req.body as Partial<RenameProjectLocationRequest> | undefined)?.name);
    if (!name) {
      return reply.code(400).send({ error: "Enter a location name of 1–120 characters, without control characters." });
    }
    if (!db.renameProjectLocation(id, locationId, name)) {
      return reply.code(404).send({ error: "project location not found" });
    }
    hub.projectChangedById(id);
    return { project: db.getProjectForPrincipal(principal, id)! };
  });

  management.define("POST", "/api/projects/:id/locations/:locationId/default", async (req, reply) => {
    const { id, locationId } = req.params as { id: string; locationId: string };
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    const location = db.projectLocation(locationId);
    if (!location || location.projectId !== id) {
      return reply.code(404).send({ error: "project location not found" });
    }
    try {
      const project = db.setProjectDefaultLocation(id, locationId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      hub.projectChanged(project);
      return { project: db.getProjectForPrincipal(principal, id)! };
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  async function projectLocationWorktreeSetup(
    req: OwnerManagementInput,
    reply: OwnerManagementReply,
    operation: "inspect" | "generate",
  ) {
    const { id, locationId } = req.params as { id: string; locationId: string };
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const project = accessibleProject(req, id);
    const location = db.projectLocation(locationId);
    if (!project || !location || location.projectId !== id) {
      return reply.code(404).send({ error: "project location not found" });
    }
    if (operation === "generate" && !db.canManageProject(principal, id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    if (location.availability !== "available" || !hub.isRunnerOnline(location.runnerId)) {
      return reply.code(409).send({ error: "project location is unavailable" });
    }
    const unsupported = runnerCapabilityError(location.runnerId, "worktreeSetupConfig", "worktree setup configuration");
    if (unsupported) return reply.code(409).send(failureBody(unsupported));
    const requestId = `workspace_setup_${randomUUID().slice(0, 8)}`;
    try {
      const result = await hub.requestFromRunner(location.runnerId, requestId, {
        type: "workspace_worktree_setup",
        requestId,
        workspaceId: location.workspaceId,
        workspacePath: location.path,
        operation,
      }, 150_000);
      if (result.type !== "workspace_worktree_setup_result") {
        return reply.code(502).send({ error: "unexpected runner reply" });
      }
      if (!result.ok || !result.status) {
        return reply.code(409).send({ error: result.error ?? "worktree setup operation failed" });
      }
      return {
        locationId,
        status: result.status,
        ...(result.path ? { path: result.path } : {}),
        ...(result.detected ? { detected: result.detected } : {}),
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  management.define("GET", "/api/projects/:id/locations/:locationId/worktree-setup", async (req, reply) =>
    projectLocationWorktreeSetup(req, reply, "inspect"));

  management.define("POST", "/api/projects/:id/locations/:locationId/worktree-setup", async (req, reply) =>
    projectLocationWorktreeSetup(req, reply, "generate"));

  management.define("PUT", "/api/projects/:id/worktree-setup-notice/dismiss", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!accessibleProject(req, id)) return reply.code(404).send({ error: "project not found" });
    db.dismissWorktreeSetupNotice(principal.userId, id);
    hub.worktreeSetupNoticeDismissed(principal.userId, id);
    return { dismissed: true };
  });

  management.define("POST", "/api/projects/:id/archive-sessions", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const principal = req.principal;
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
    if (!canManageAffectedSessions(principal, (session) => session.projectId === id)) {
      return reply.code(409).send({ error: "project contains sessions you cannot manage" });
    }
    const outcome = svc.archiveProjectSessions(id);
    if (!outcome.ok || !outcome.data) return respond(reply, outcome);
    const project = db.getProject(id)!;
    hub.projectChanged(project);
    return {
      project: db.getProjectForPrincipal(principal, id)!,
      ...outcome.data,
    };
  });

  return management;
}
