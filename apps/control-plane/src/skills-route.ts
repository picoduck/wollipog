/**
 * REST surface for the managed skill library plus the per-machine sync trigger, and the shared
 * push-on-change helper. Registered from index.ts next to the other /api routes; extracted as a
 * module (mirroring runner-credential-route.ts) so the routes are unit-testable with a real
 * in-memory db and a mock hub.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type ResourceScope,
  type SkillInvocationPolicy,
} from "@wollipog/protocol";
import type {
  ControlPlaneDb,
  SkillAssignmentScopeKind,
  SkillAssignmentView,
} from "./db.js";
import type { Hub } from "./hub.js";
import type { HumanPrincipal, AuthPrincipal } from "./identity.js";
import { parseSkillAgentSelector, resolveDesiredSkills, validateSkillPayload } from "./skills.js";

/** The narrow hub surface the skill routes need (mockable in tests). */
export type SkillsHub = Pick<Hub, "isRunnerOnline" | "sendToRunner" | "requestFromRunner">;

export interface SkillsLog {
  debug(message: string): void;
  warn(message: string): void;
}

const NOOP_LOG: SkillsLog = { debug: () => {}, warn: () => {} };

/**
 * Fire-and-forget the authoritative desired skill set to one machine. Used after every skill /
 * version / assignment mutation and after runner registration completes. No-ops (with a debug log)
 * for offline runners and for runners that have not negotiated the agentSkills capability.
 */
export function makeSkillsSyncPusher(deps: {
  db: ControlPlaneDb;
  hub: SkillsHub;
  log?: SkillsLog;
}): (runnerId: string) => void {
  const log = deps.log ?? NOOP_LOG;
  return (runnerId: string) => {
    if (!deps.hub.isRunnerOnline(runnerId)) {
      log.debug(`skills sync skipped for ${runnerId}: runner is offline`);
      return;
    }
    if (!runnerSupportsProtocol(deps.db.getRunner(runnerId)?.protocolVersion, "agentSkills")) {
      log.debug(`skills sync skipped for ${runnerId}: runner lacks the agentSkills capability`);
      return;
    }
    try {
      deps.hub.sendToRunner(runnerId, {
        type: "skills_sync",
        runnerId,
        skills: resolveDesiredSkills(deps.db, runnerId),
      });
    } catch (error) {
      log.warn(`skills sync push to ${runnerId} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };
}

export interface SkillsRouteDeps {
  db: ControlPlaneDb;
  hub: SkillsHub;
  requestHuman(req: FastifyRequest): HumanPrincipal | null;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
  pushSkillsSync(runnerId: string): void;
}

/** Skill creation ownership defaults exactly like project creation: organization scope for
 * owners/admins, private scope otherwise. */
function defaultSkillScope(principal: HumanPrincipal): ResourceScope {
  return {
    organizationId: principal.organizationId,
    owner: principal.role === "owner" || principal.role === "admin"
      ? { kind: "organization", organizationId: principal.organizationId }
      : { kind: "user", userId: principal.userId },
  };
}

function parseInvocation(value: unknown): SkillInvocationPolicy | null | undefined {
  if (value === undefined) return undefined;
  return value === "agent" || value === "manual" ? value : null;
}

function parseNote(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 2000) return null;
  return value;
}

export function registerSkillRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  const { db, hub, pushSkillsSync } = deps;

  /** Re-sync every machine whose desired set may have changed. Runner-scoped assignment
   * mutations touch exactly one machine; everything else fans out (the pusher itself
   * no-ops for offline or incapable runners). */
  const pushAffected = (assignment?: Pick<SkillAssignmentView, "scopeKind" | "runnerId">): void => {
    if (assignment?.scopeKind === "runner" && assignment.runnerId) {
      pushSkillsSync(assignment.runnerId);
      return;
    }
    for (const runner of db.listRunners()) pushSkillsSync(runner.runnerId);
  };

  /* ------------------------------ Skill library ------------------------------ */

  app.get("/api/skills", async (req) => {
    const principal = deps.requestPrincipal(req);
    return { skills: principal ? db.listSkills() : [] };
  });

  app.post("/api/skills", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const body = (req.body ?? {}) as {
      name?: unknown; description?: unknown; groupId?: unknown; files?: unknown; note?: unknown;
    };
    const validated = validateSkillPayload({ name: body.name, description: body.description, files: body.files });
    if (!validated.ok) return reply.code(400).send({ error: validated.error });
    if (body.groupId !== undefined && body.groupId !== null && typeof body.groupId !== "string") {
      return reply.code(400).send({ error: "groupId must be a string" });
    }
    const note = parseNote(body.note);
    if (note === null) return reply.code(400).send({ error: "note must be 2000 characters or fewer" });
    if (db.getSkillByName(validated.name)) {
      return reply.code(409).send({ error: "a skill with this name already exists" });
    }
    let skill;
    try {
      skill = db.createSkill({
        name: validated.name,
        description: validated.description,
        groupId: (body.groupId as string | null | undefined) ?? null,
        files: validated.files,
        manifest: validated.manifest,
        digest: validated.digest,
        note,
        scope: defaultSkillScope(principal),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "skill creation failed";
      return reply.code(/already exists/.test(message) ? 409 : 400).send({ error: message });
    }
    pushAffected();
    return reply.code(201).send({ skill });
  });

  app.get("/api/skills/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const skill = db.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const latestVersion = skill.latestVersion ? db.getSkillVersion(skill.latestVersion.id) : null;
    return { skill, latestVersion, assignments: db.listSkillAssignments(id) };
  });

  app.put("/api/skills/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { description?: unknown; groupId?: unknown };
    if (body.description !== undefined && body.description !== null &&
        (typeof body.description !== "string" || body.description.length > 1024)) {
      return reply.code(400).send({ error: "description must be a string of 1024 characters or fewer" });
    }
    if (body.groupId !== undefined && body.groupId !== null && typeof body.groupId !== "string") {
      return reply.code(400).send({ error: "groupId must be a string" });
    }
    try {
      const skill = db.updateSkill(id, {
        ...(body.description === undefined ? {} : { description: body.description as string | null }),
        ...(body.groupId === undefined ? {} : { groupId: body.groupId as string | null }),
      });
      if (!skill) return reply.code(404).send({ error: "skill not found" });
      pushAffected();
      return { skill };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "skill update failed" });
    }
  });

  app.post("/api/skills/:id/versions", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    const skill = db.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const body = (req.body ?? {}) as { files?: unknown; note?: unknown };
    const validated = validateSkillPayload({ name: skill.name, files: body.files });
    if (!validated.ok) return reply.code(400).send({ error: validated.error });
    const note = parseNote(body.note);
    if (note === null) return reply.code(400).send({ error: "note must be 2000 characters or fewer" });
    const version = db.addSkillVersion(id, {
      files: validated.files,
      manifest: validated.manifest,
      digest: validated.digest,
      note,
    });
    if (!version) return reply.code(404).send({ error: "skill not found" });
    pushAffected();
    return reply.code(201).send({ version });
  });

  app.delete("/api/skills/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    const assignments = db.listSkillAssignments(id);
    if (!db.deleteSkill(id)) return reply.code(404).send({ error: "skill not found" });
    if (assignments.some((assignment) => assignment.scopeKind === "instance")) {
      pushAffected();
    } else {
      for (const runnerId of new Set(assignments.map((a) => a.runnerId).filter((r): r is string => Boolean(r)))) {
        pushSkillsSync(runnerId);
      }
    }
    return reply.code(204).send();
  });

  /* ------------------------------ Skill groups ------------------------------ */

  app.get("/api/skill-groups", async () => ({ groups: db.listSkillGroups() }));

  app.post("/api/skill-groups", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const name = (req.body as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return reply.code(400).send({ error: "name must be 1-120 characters" });
    }
    return reply.code(201).send({ group: db.createSkillGroup(name) });
  });

  app.delete("/api/skill-groups/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    if (!db.deleteSkillGroup((req.params as { id: string }).id)) {
      return reply.code(404).send({ error: "skill group not found" });
    }
    return reply.code(204).send();
  });

  /* ---------------------------- Skill assignments ---------------------------- */

  app.get("/api/skill-assignments", async (req) => {
    const skillId = (req.query as { skillId?: unknown }).skillId;
    return { assignments: db.listSkillAssignments(typeof skillId === "string" && skillId ? skillId : undefined) };
  });

  app.post("/api/skill-assignments", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const body = (req.body ?? {}) as {
      skillId?: unknown; scopeKind?: unknown; runnerId?: unknown; agentSelector?: unknown; invocation?: unknown;
    };
    if (typeof body.skillId !== "string" || !db.getSkill(body.skillId)) {
      return reply.code(404).send({ error: "skill not found" });
    }
    if (body.scopeKind !== "instance" && body.scopeKind !== "runner") {
      return reply.code(400).send({ error: "scopeKind must be instance or runner" });
    }
    if (body.scopeKind === "runner" && (typeof body.runnerId !== "string" || !db.getRunner(body.runnerId))) {
      return reply.code(404).send({ error: "runner not found" });
    }
    const agentSelector = parseSkillAgentSelector(body.agentSelector);
    if (!agentSelector) {
      return reply.code(400).send({ error: "agentSelector must be {kind:'all'}, {kind:'driver',driver}, or {kind:'agent',agentId}" });
    }
    const invocation = parseInvocation(body.invocation);
    if (invocation === null) return reply.code(400).send({ error: "invocation must be agent or manual" });
    const assignment = db.createSkillAssignment({
      skillId: body.skillId,
      scopeKind: body.scopeKind as SkillAssignmentScopeKind,
      runnerId: body.scopeKind === "runner" ? (body.runnerId as string) : null,
      agentSelector,
      invocation,
    });
    pushAffected(assignment);
    return reply.code(201).send({ assignment });
  });

  app.patch("/api/skill-assignments/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { enabled?: unknown; invocation?: unknown };
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }
    const invocation = parseInvocation(body.invocation);
    if (invocation === null) return reply.code(400).send({ error: "invocation must be agent or manual" });
    const assignment = db.updateSkillAssignment(id, {
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(invocation === undefined ? {} : { invocation }),
    });
    if (!assignment) return reply.code(404).send({ error: "skill assignment not found" });
    pushAffected(assignment);
    return { assignment };
  });

  app.delete("/api/skill-assignments/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const removed = db.deleteSkillAssignment((req.params as { id: string }).id);
    if (!removed) return reply.code(404).send({ error: "skill assignment not found" });
    pushAffected(removed);
    return reply.code(204).send();
  });

  /* ------------------------------ Per-machine view ------------------------------ */

  app.get("/api/runners/:id/skills", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!db.getRunner(id)) return reply.code(404).send({ error: "runner not found" });
    return {
      // File contents stay out of the listing; the digest + targets are what the UI compares.
      desired: resolveDesiredSkills(db, id).map((entry) => ({
        name: entry.name,
        versionDigest: entry.versionDigest,
        targets: entry.targets,
      })),
      reported: db.getRunnerSkillState(id),
    };
  });

  app.post("/api/runners/:id/skills/sync", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const runner = db.getRunner(id);
    if (!runner) return reply.code(404).send({ error: "runner not found" });
    if (!hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is offline" });
    if (!runnerSupportsProtocol(runner.protocolVersion, "agentSkills")) {
      return reply.code(409).send({
        error: runnerCapabilityRequirement(runner.protocolVersion, "agentSkills", "Managed agent skills"),
      });
    }
    const requestId = `skills_${randomUUID().slice(0, 8)}`;
    try {
      const result = await hub.requestFromRunner(id, requestId, {
        type: "skills_sync",
        runnerId: id,
        requestId,
        skills: resolveDesiredSkills(db, id),
      });
      if (result.type !== "skills_state") {
        return reply.code(502).send({ error: "unexpected runner reply" });
      }
      db.setRunnerSkillState(id, result, Date.now());
      return { state: db.getRunnerSkillState(id) };
    } catch (error) {
      return reply.code(504).send({ error: (error as Error).message });
    }
  });
}
