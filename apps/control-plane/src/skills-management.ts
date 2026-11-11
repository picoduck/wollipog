/** Shared skill application operations. REST and Assistant adapters pass an explicit principal;
 * no credential forwarding, HTTP injection, or duplicate validation. */
import type { AuthPrincipal } from "./identity.js";
import type { FastifyInstance } from "fastify";
import type { SkillsRouteDeps } from "./skills-route.js";
import type { SkillAssignmentView } from "./db.js";
import { SkillImportConflictError } from "./db.js";
import { validateSkillPayload, parseSkillAgentSelector } from "./skills.js";
import { withSkillRecommendation } from "./skill-built-in-route.js";
import { deploymentImpactRefusal } from "./skill-deployment-impact.js";
import type { ResourceScope, SkillInvocationPolicy } from "@wollipog/protocol";
import type { HumanPrincipal } from "./identity.js";
import type { SkillAssignmentScopeKind } from "./db.js";

export interface SkillApplicationInput {
  principal: AuthPrincipal | null;
  params: unknown;
  body?: unknown;
  query: unknown;
  /** Assistant authority/revision fence after asynchronous inspection, before later effects. */
  recheck?: () => Promise<unknown>;
  /** Final synchronous fence immediately before a write or destructive runner dispatch. */
  beforeEffect?: () => void;
  /** A write committed or an external mutation is about to be dispatched. Later refusals
   * cannot be reported as proof that the operation had no effect. */
  effectStarted?: () => void;
}
export interface SkillApplicationResult { status: number; body: unknown }
type Handler = (input: SkillApplicationInput, reply: SkillApplicationReply) => Promise<unknown>;
export class SkillApplicationReply {
  status = 200;
  sent = false;
  body: unknown;
  code(status: number): this { this.status = status; return this; }
  send(body?: unknown): unknown { this.sent = true; this.body = body; return body; }
}
export class SkillApplicationService {
  readonly handlers = new Map<string, Handler>();
  readonly closeHandlers: Array<() => Promise<void>> = [];
  /** Opaque previews resolve to their server-held source, never a caller-selected Machine. */
  reference: (id: string) => {runnerId?: string; skillId?: string | null} | undefined = () => undefined;
  addHook(_hook: "onClose", close: () => Promise<void>): void { this.closeHandlers.push(close); }
  route(input: {method: string; url: string; handler: Handler}): void {
    this.handlers.set(`${input.method} ${input.url}`, input.handler);
  }
  include(service: SkillApplicationService): void {
    for (const [key, handler] of service.handlers) {
      if (this.handlers.has(key)) throw new Error("Duplicate skill application operation");
      this.handlers.set(key, handler);
    }
    this.closeHandlers.push(...service.closeHandlers);
    const prior = this.reference;
    this.reference = id => prior(id) ?? service.reference(id);
  }
  registerHttp(app: FastifyInstance, deps: SkillsRouteDeps): void {
    for (const key of this.handlers.keys()) {
      const [method, url] = key.split(" ");
      app.route({method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: url!, handler: async (req, reply) => {
        // Preserve owner routes' live identity callbacks across runner/network awaits.
        const result = await this.execute(key, {get principal() {
          return method === "GET" ? deps.requestPrincipal(req) : deps.requestHuman(req);
        }, params: req.params, body: req.body, query: req.query});
        return reply.code(result.status).send(result.body);
      }});
    }
    app.addHook("onClose", async () => { for (const close of this.closeHandlers) await close(); });
  }
  get(path: string, handler: Handler): void { this.handlers.set(`GET ${path}`, handler); }
  post(path: string, handler: Handler): void { this.handlers.set(`POST ${path}`, handler); }
  put(path: string, handler: Handler): void { this.handlers.set(`PUT ${path}`, handler); }
  patch(path: string, handler: Handler): void { this.handlers.set(`PATCH ${path}`, handler); }
  delete(path: string, handler: Handler): void { this.handlers.set(`DELETE ${path}`, handler); }
  async execute(operation: string, input: SkillApplicationInput): Promise<SkillApplicationResult> {
    const handler = this.handlers.get(operation);
    if (!handler) throw new Error("Unknown skill application operation");
    const reply = new SkillApplicationReply();
    const body = await handler(input, reply);
    return {status: reply.status, body: reply.sent ? reply.body : body};
  }
}

function defaultSkillScope(principal: HumanPrincipal): ResourceScope {
  return {
    organizationId: principal.organizationId,
    owner: principal.role === "owner" || principal.role === "admin"
      ? { kind: "organization", organizationId: principal.organizationId }
      : { kind: "user", userId: principal.userId },
  };
}

/** The one refusal for an invalid selector, on create and on update alike. */
const AGENT_SELECTOR_ERROR = "agentSelector must be {kind:'all'}, {kind:'driver',driver}, or {kind:'agent',agentId}";

function parseInvocation(value: unknown): SkillInvocationPolicy | null | undefined {
  if (value === undefined) return undefined;
  return value === "agent" || value === "manual" ? value : null;
}

function parseNote(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 2000) return null;
  return value;
}


export function createSkillsManagement(deps: SkillsRouteDeps): SkillApplicationService {
  const service = new SkillApplicationService();
  const { db, pushSkillsSync } = deps;

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

  /** An assignment is visible and mutable only to principals who can access the referenced skill
   * AND, for runner-scoped rows, that runner — otherwise a skill-visible assignment would leak
   * (and let a caller redeploy against) a machine the principal cannot access. */
  const canAccessAssignment = (principal: AuthPrincipal, assignment: SkillAssignmentView): boolean =>
    db.canAccessSkill(principal, assignment.skillId) &&
    (assignment.scopeKind !== "runner" || !assignment.runnerId ||
      db.canAccessRunner(principal, assignment.runnerId));

  service.get("/api/skills", async (req) => {
    const principal = req.principal;
    if (!principal) return { skills: [] };
    const dismissed = principal.kind === "human" ? db.skillRecommendationDismissals(principal.userId) : undefined;
    return {
      skills: db.listSkillsForPrincipal(principal)
        .map((skill) => withSkillRecommendation(db, principal, skill, dismissed)),
    };
  });

  service.post("/api/skills", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const body = (req.body ?? {}) as {
      name?: unknown; description?: unknown; groupId?: unknown; files?: unknown; note?: unknown;
    };
    const validated = validateSkillPayload({ name: body.name, description: body.description, files: body.files });
    if (!validated.ok) return reply.code(400).send({ error: validated.error });
    if (body.groupId !== undefined && body.groupId !== null && typeof body.groupId !== "string") {
      return reply.code(400).send({ error: "groupId must be a string" });
    }
    if (typeof body.groupId === "string" && db.skillGroupScope(body.groupId) && !db.canAccessSkillGroup(principal, body.groupId)) {
      return reply.code(404).send({ error: "skill group not found" });
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

  service.get("/api/skills/:id", async (req, reply) => {
    const principal = req.principal;
    const id = (req.params as { id: string }).id;
    if (!principal || !db.canAccessSkill(principal, id)) {
      return reply.code(404).send({ error: "skill not found" });
    }
    const skill = db.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const latestVersion = skill.latestVersion ? db.getSkillVersion(skill.latestVersion.id) : null;
    return {
      skill: withSkillRecommendation(db, principal, skill),
      latestVersion,
      assignments: db.listSkillAssignments(id)
        .filter((assignment) => canAccessAssignment(principal, assignment)),
    };
  });

  service.put("/api/skills/:id", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (!db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
    const body = (req.body ?? {}) as { description?: unknown; groupId?: unknown };
    if (body.description !== undefined && body.description !== null &&
        (typeof body.description !== "string" || body.description.length > 1024)) {
      return reply.code(400).send({ error: "description must be a string of 1024 characters or fewer" });
    }
    if (body.groupId !== undefined && body.groupId !== null && typeof body.groupId !== "string") {
      return reply.code(400).send({ error: "groupId must be a string" });
    }
    if (typeof body.groupId === "string" && db.skillGroupScope(body.groupId) && !db.canAccessSkillGroup(principal, body.groupId)) {
      return reply.code(404).send({ error: "skill group not found" });
    }
    try {
      const skill = db.updateSkill(id, {
        ...(body.description === undefined ? {} : { description: body.description as string | null }),
        ...(body.groupId === undefined ? {} : { groupId: body.groupId as string | null }),
      });
      if (!skill) return reply.code(404).send({ error: "skill not found" });
      pushAffected();
      return { skill: withSkillRecommendation(db, principal, skill) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "skill update failed" });
    }
  });

  service.post("/api/skills/:id/versions", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (!db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
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

  service.get("/api/skills/:id/versions", async (req, reply) => {
    const principal = req.principal;
    const { id } = req.params as { id: string };
    if (!principal || !db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
    const { before } = req.query as { before?: unknown };
    if (before !== undefined && (typeof before !== "string" || !before || before.length > 100)) return reply.code(400).send({ error: "invalid version cursor" });
    try { return db.listSkillVersions(id, before as string | undefined); }
    catch { return reply.code(400).send({ error: "invalid version cursor" }); }
  });

  service.get("/api/skills/:id/versions/:versionId", async (req, reply) => {
    const principal = req.principal;
    const { id, versionId } = req.params as { id: string; versionId: string };
    if (!principal || !db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
    const skill = db.getSkill(id)!;
    const version = db.getSkillVersion(versionId);
    if (!version || version.skillId !== id) return reply.code(404).send({ error: "version not found" });
    return { version, currentVersion: skill.latestVersion ? db.getSkillVersion(skill.latestVersion.id) : null,
      deploymentImpact: db.skillDeploymentImpact(id).deploymentImpact };
  });

  service.post("/api/skills/:id/restore", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const { id } = req.params as { id: string };
    if (!db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
    const body = (req.body ?? {}) as { versionId?: unknown; expectedLatestVersionId?: unknown; expectedDeploymentImpact?: unknown };
    if (typeof body.versionId !== "string" || !body.versionId || body.versionId.length > 100 ||
        typeof body.expectedLatestVersionId !== "string" || !body.expectedLatestVersionId || body.expectedLatestVersionId.length > 100) {
      return reply.code(400).send({ error: "versionId and expectedLatestVersionId are required" });
    }
    // Restoring content that differs from the latest version deploys it to every unpinned machine.
    const target = db.getSkillVersion(body.versionId);
    const latest = db.getSkill(id)?.latestVersion;
    const refusal = target?.skillId === id && latest?.id === body.expectedLatestVersionId && target.digest !== latest.digest
      ? deploymentImpactRefusal(db, id, body.expectedDeploymentImpact) : null;
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    try {
      const version = db.restoreSkillVersion(id, body.versionId, body.expectedLatestVersionId);
      if (!version) return reply.code(404).send({ error: "version not found" });
      pushAffected();
      return { version };
    } catch (error) {
      if (error instanceof SkillImportConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  service.delete("/api/skills/:id", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (!db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
    if (!db.deleteSkill(id)) return reply.code(404).send({ error: "skill not found" });
    pushAffected(); // Includes machines reached through dynamic group assignments.
    return reply.code(204).send();
  });

  service.get("/api/skill-assignments", async (req) => {
    const principal = req.principal;
    if (!principal) return { assignments: [] };
    const skillId = (req.query as { skillId?: unknown }).skillId;
    return {
      assignments: db.listSkillAssignments(typeof skillId === "string" && skillId ? skillId : undefined)
        .filter((assignment) => canAccessAssignment(principal, assignment)),
    };
  });

  service.post("/api/skill-assignments", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const body = (req.body ?? {}) as {
      skillId?: unknown; scopeKind?: unknown; runnerId?: unknown; agentSelector?: unknown; invocation?: unknown;
    };
    if (typeof body.skillId !== "string" || !db.canAccessSkill(principal, body.skillId)) {
      return reply.code(404).send({ error: "skill not found" });
    }
    if (body.scopeKind !== "instance" && body.scopeKind !== "runner") {
      return reply.code(400).send({ error: "scopeKind must be instance or runner" });
    }
    if (body.scopeKind === "runner" && (typeof body.runnerId !== "string" ||
        !db.getRunner(body.runnerId) || !db.canAccessRunner(principal, body.runnerId))) {
      return reply.code(404).send({ error: "runner not found" });
    }
    if (body.scopeKind === "runner") {
      // Same containment rule resolveDesiredSkills applies at delivery time — rejecting here
      // instead of returning a 201 for an assignment that could never deploy.
      const skillScope = db.skillScope(body.skillId);
      const runnerScope = db.runnerScope(body.runnerId as string);
      if (!skillScope || !runnerScope || !db.scopeAudienceContainedWithMembership(skillScope, runnerScope)) {
        return reply.code(409).send({ error: "the skill's access scope does not include this machine" });
      }
    }
    const agentSelector = parseSkillAgentSelector(body.agentSelector);
    if (!agentSelector) return reply.code(400).send({ error: AGENT_SELECTOR_ERROR });
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

  service.patch("/api/skill-assignments/:id", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    const existing = db.getSkillAssignment(id);
    if (!existing || !canAccessAssignment(principal, existing)) {
      return reply.code(404).send({ error: "skill assignment not found" });
    }
    const body = (req.body ?? {}) as { enabled?: unknown; invocation?: unknown; agentSelector?: unknown };
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }
    const invocation = parseInvocation(body.invocation);
    if (invocation === null) return reply.code(400).send({ error: "invocation must be agent or manual" });
    // Optional, validated exactly as on create, so a rule's agents change in the same atomic update
    // as anything else in the request (the skill notice's Limit to Claude Code, #1972).
    const agentSelector = body.agentSelector === undefined ? undefined : parseSkillAgentSelector(body.agentSelector);
    if (agentSelector === null) return reply.code(400).send({ error: AGENT_SELECTOR_ERROR });
    const assignment = db.updateSkillAssignment(id, {
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(invocation === undefined ? {} : { invocation }),
      ...(agentSelector === undefined ? {} : { agentSelector }),
    });
    if (!assignment) return reply.code(404).send({ error: "skill assignment not found" });
    pushAffected(assignment);
    return { assignment };
  });

  service.delete("/api/skill-assignments/:id", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    const existing = db.getSkillAssignment(id);
    if (!existing || !canAccessAssignment(principal, existing)) {
      return reply.code(404).send({ error: "skill assignment not found" });
    }
    const removed = db.deleteSkillAssignment(id);
    if (!removed) return reply.code(404).send({ error: "skill assignment not found" });
    pushAffected(removed);
    return reply.code(204).send();
  });

  return service;
}
