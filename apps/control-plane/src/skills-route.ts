import { createSkillsManagement } from "./skills-management.js";
/**
 * REST surface for the managed skill library plus the per-machine sync trigger, and the shared
 * push-on-change helper. Registered from index.ts next to the other /api routes; extracted as a
 * module (mirroring runner-credential-route.ts) so the routes are unit-testable with a real
 * in-memory db and a mock hub.
 */

import { randomUUID } from "node:crypto";
import { registerSkillVersionPolicyRoutes } from "./skill-version-policy-route.js";
import { registerSkillGitRoutes } from "./skill-git-route.js";
import { registerMachineSkillRoutes } from "./skill-machine-route.js";
import { registerSkillDriftRoutes } from "./skill-drift-route.js";
import { registerSkillBuiltInRoutes } from "./skill-built-in-route.js";
import type { BuiltInSkill } from "./built-in-skills.js";
import { listOrphanedSkillCopies } from "./skill-orphan-route.js";
import { skillStateResponse } from "./skill-edited-copy.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  SKILL_MAX_TOTAL_BYTES,
  runnerCapabilityRequirementError,
  runnerSupportsProtocol,
  type ResourceScope,
  type SkillInvocationPolicy,
  type SkillsSyncContentMessage,
  type SkillsSyncManifestMessage,
  type SkillsSyncNeedMessage,
  type SkillsSyncMessage,
} from "@wollipog/protocol";
import type {
  ControlPlaneDb,
  SkillAssignmentView,
} from "./db.js";
import type { Hub } from "./hub.js";
import type { RunnerRequestResult } from "./hub.js";
import type { HumanPrincipal, AuthPrincipal } from "./identity.js";
import {
  parseSkillAgentSelector,
  resolveDesiredSkillSnapshot,
  resolveDesiredSkills,
  SKILLS_SYNC_MAX_TOTAL_BYTES,
  skillsSyncMessageBytes,
} from "./skills.js";

/** The narrow hub surface the skill routes need (mockable in tests). */
export type SkillsHub = Pick<Hub, "isRunnerOnline" | "sendToRunner" | "requestFromRunner"> &
  Partial<Pick<Hub, "sendToRunnerAndWait" | "refreshRunnerRequestTimeout">>;

export interface SkillsLog {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const NOOP_LOG: SkillsLog = { debug: () => {}, warn: () => {}, error: () => {} };

/**
 * Fire-and-forget the authoritative desired skill set to one machine. Used after every skill /
 * version / assignment mutation and after runner registration completes. No-ops (with a debug log)
 * for offline runners and for runners that have not negotiated the agentSkills capability.
 */
export interface SkillsSyncPusher {
  (runnerId: string): void;
  handleNeed(message: SkillsSyncNeedMessage): Promise<void>;
  request(runnerId: string, requestId: string): Promise<RunnerRequestResult>;
}

export class SkillsSyncBudgetError extends Error {
  override readonly name = "SkillsSyncBudgetError";
}

export class SkillsSyncInProgressError extends Error {
  override readonly name = "SkillsSyncInProgressError";
}

interface PendingSkillsDelivery {
  runnerId: string;
  syncId: string;
  requestId?: string;
  skills: ReturnType<typeof resolveDesiredSkillSnapshot>;
  sending: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** One independently bounded skill frame plus ordinary runner traffic may be queued at once.
 * JSON escaping can expand the 2 MiB decoded skill payload, so reserve its strict worst-case
 * expansion without allowing aggregate catalog size to affect the transport bound. */
export const SKILLS_SYNC_MAX_BUFFERED_BYTES = SKILL_MAX_TOTAL_BYTES * 6 + 1024 * 1024;

export function makeSkillsSyncPusher(deps: {
  db: ControlPlaneDb;
  hub: SkillsHub;
  log?: SkillsLog;
  /** Test seam; bounds orphaned manifests and each stalled transport flush in production. */
  deliveryTtlMs?: number;
}): SkillsSyncPusher {
  const log = deps.log ?? NOOP_LOG;
  const deliveryTtlMs = deps.deliveryTtlMs ?? 30_000;
  const pending = new Map<string, PendingSkillsDelivery>();
  const pendingByRunner = new Map<string, string>();
  const sendBounded = (runnerId: string, message: Parameters<Hub["sendToRunner"]>[1]): Promise<boolean> =>
    deps.hub.sendToRunnerAndWait
      ? deps.hub.sendToRunnerAndWait(runnerId, message, SKILLS_SYNC_MAX_BUFFERED_BYTES, deliveryTtlMs)
      : Promise.resolve(deps.hub.sendToRunner(runnerId, message));
  const refreshCorrelation = (delivery: PendingSkillsDelivery): void => {
    if (!delivery.requestId) return;
    deps.hub.refreshRunnerRequestTimeout?.(delivery.runnerId, delivery.requestId, deliveryTtlMs);
  };

  const forget = (delivery: PendingSkillsDelivery): void => {
    clearTimeout(delivery.timer);
    pending.delete(delivery.syncId);
    if (pendingByRunner.get(delivery.runnerId) === delivery.syncId) pendingByRunner.delete(delivery.runnerId);
  };
  const begin = (runnerId: string, requestId?: string): SkillsSyncMessage | SkillsSyncManifestMessage => {
    if (!runnerSupportsProtocol(deps.db.getRunner(runnerId)?.protocolVersion, "chunkedAgentSkills")) {
      const skills = resolveDesiredSkills(deps.db, runnerId);
      return { type: "skills_sync", runnerId, ...(requestId ? { requestId } : {}), skills };
    }
    const skills = resolveDesiredSkillSnapshot(deps.db, runnerId);
    let effectiveRequestId = requestId;
    const priorId = pendingByRunner.get(runnerId);
    if (priorId) {
      const prior = pending.get(priorId);
      if (prior) {
        if (requestId && prior.requestId && requestId !== prior.requestId) {
          throw new SkillsSyncInProgressError("a skills sync is already in progress for this machine");
        }
        effectiveRequestId ??= prior.requestId;
        forget(prior);
      }
    }
    const syncId = `skills_${randomUUID()}`;
    const delivery = {
      runnerId,
      syncId,
      ...(effectiveRequestId ? { requestId: effectiveRequestId } : {}),
      skills,
      sending: false,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    delivery.timer = setTimeout(() => {
      forget(delivery);
      log.warn(`expired incomplete skills delivery to ${runnerId}`);
    }, deliveryTtlMs);
    delivery.timer.unref?.();
    pending.set(syncId, delivery);
    pendingByRunner.set(runnerId, syncId);
    return {
      type: "skills_sync_manifest",
      runnerId,
      syncId,
      ...(effectiveRequestId ? { requestId: effectiveRequestId } : {}),
      skills: skills.map(({ versionId: _versionId, ...entry }) => entry),
    };
  };

  const push = ((runnerId: string) => {
    if (!deps.hub.isRunnerOnline(runnerId)) {
      log.debug(`skills sync skipped for ${runnerId}: runner is offline`);
      return;
    }
    if (!runnerSupportsProtocol(deps.db.getRunner(runnerId)?.protocolVersion, "agentSkills")) {
      log.debug(`skills sync skipped for ${runnerId}: runner lacks the agentSkills capability`);
      return;
    }
    try {
      const message = begin(runnerId);
      if (message.type === "skills_sync" && skillsSyncMessageBytes(message) > SKILLS_SYNC_MAX_TOTAL_BYTES) {
        const bytes = skillsSyncMessageBytes(message);
        // Fail closed, never partial: a truncated authoritative list would make the runner
        // delete deployed skills, and an oversized frame would close the runner connection.
        log.error(
          `skills sync push to ${runnerId} skipped: the aggregate desired skill payload is ${bytes} bytes, ` +
            `over the ${SKILLS_SYNC_MAX_TOTAL_BYTES}-byte sync budget; unassign or shrink skills for this machine`,
        );
        return;
      }
      if (!deps.hub.sendToRunner(runnerId, message) && message.type === "skills_sync_manifest") {
        const delivery = pending.get(message.syncId);
        if (delivery) forget(delivery);
      }
    } catch (error) {
      log.warn(`skills sync push to ${runnerId} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }) as SkillsSyncPusher;

  push.handleNeed = async (message: SkillsSyncNeedMessage): Promise<void> => {
    const delivery = pending.get(message.syncId);
    if (!delivery || delivery.runnerId !== message.runnerId || !Array.isArray(message.missing)) {
      log.warn(`ignored stale or invalid skills content request from ${message.runnerId}`);
      return;
    }
    if (delivery.sending) {
      log.warn(`ignored duplicate skills content request from ${message.runnerId}`);
      return;
    }
    const desired = new Map<string, PendingSkillsDelivery["skills"][number]>(
      delivery.skills.map((entry) => [`${entry.name}\0${entry.versionDigest}`, entry] as const),
    );
    const requested = new Set<string>();
    const requestedEntries: PendingSkillsDelivery["skills"] = [];
    for (const missing of message.missing) {
      const key = `${missing?.name}\0${missing?.versionDigest}`;
      const entry = desired.get(key);
      if (!entry || requested.has(key)) {
        log.warn(`rejected invalid skills content request from ${message.runnerId}`);
        forget(delivery);
        return;
      }
      requested.add(key);
      requestedEntries.push(entry);
    }
    delivery.sending = true;
    refreshCorrelation(delivery);
    // The orphan timer protects only a manifest that never receives a valid need. Once transfer
    // starts, every individual socket flush has the same timeout, while a healthy large catalog
    // may legitimately take longer than one timeout window in aggregate.
    clearTimeout(delivery.timer);
    try {
      for (const entry of requestedEntries) {
        if (pending.get(delivery.syncId) !== delivery) return;
        const version = deps.db.getSkillVersion(entry.versionId);
        if (!version || version.digest !== entry.versionDigest) {
          log.warn(`skills content delivery to ${message.runnerId} lost its immutable version snapshot`);
          forget(delivery);
          return;
        }
        const content: SkillsSyncContentMessage = {
          type: "skills_sync_content",
          runnerId: message.runnerId,
          syncId: message.syncId,
          name: entry.name,
          versionDigest: entry.versionDigest,
          files: version.files,
        };
        const sent = await sendBounded(message.runnerId, content);
        if (pending.get(delivery.syncId) !== delivery) return;
        if (!sent) {
          log.warn(`skills content delivery to ${message.runnerId} was interrupted or exceeded its buffer bound`);
          forget(delivery);
          return;
        }
        refreshCorrelation(delivery);
      }
      const completed = await sendBounded(message.runnerId, {
        type: "skills_sync_complete",
        runnerId: message.runnerId,
        syncId: message.syncId,
      });
      if (pending.get(delivery.syncId) !== delivery) return;
      if (!completed) {
        log.warn(`skills completion delivery to ${message.runnerId} was interrupted`);
      } else {
        refreshCorrelation(delivery);
      }
      forget(delivery);
    } catch (error) {
      if (pending.get(delivery.syncId) === delivery) forget(delivery);
      log.warn(
        `skills content delivery to ${message.runnerId} failed: ` +
          `${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  };

  push.request = async (runnerId: string, requestId: string): Promise<RunnerRequestResult> => {
    const message = begin(runnerId, requestId);
    if (message.type === "skills_sync" && skillsSyncMessageBytes(message) > SKILLS_SYNC_MAX_TOTAL_BYTES) {
      throw new SkillsSyncBudgetError(
        `this machine's aggregate desired skill payload is ${skillsSyncMessageBytes(message)} bytes, over the ` +
          `${SKILLS_SYNC_MAX_TOTAL_BYTES}-byte skills sync budget; unassign or shrink skills before syncing`,
      );
    }
    try {
      return await deps.hub.requestFromRunner(runnerId, requestId, message, deliveryTtlMs);
    } catch (error) {
      if (message.type === "skills_sync_manifest") {
        const original = pending.get(message.syncId);
        const currentId = pendingByRunner.get(runnerId);
        const current = currentId ? pending.get(currentId) : undefined;
        // A superseding push inherits the manual request id. Once its content transfer is in
        // flight, the late HTTP timeout no longer owns that healthy delivery; let it finish and
        // update authoritative state even though the original waiter has gone away.
        const delivery = original ??
          (current?.requestId === requestId && !current.sending ? current : undefined);
        if (delivery) forget(delivery);
      }
      throw error;
    }
  };
  return push;
}

export interface SkillsRouteDeps {
  db: ControlPlaneDb;
  hub: SkillsHub;
  requestHuman(req: FastifyRequest): HumanPrincipal | null;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
  pushSkillsSync: SkillsSyncPusher;
  /** The running release's built-in skills; their content backs the built-in review routes. */
  builtInSkills?: readonly BuiltInSkill[];
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

export function registerSkillRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  registerSkillGitRoutes(app, deps);
  registerMachineSkillRoutes(app, deps);
  registerSkillDriftRoutes(app, deps);
  registerSkillVersionPolicyRoutes(app, deps);
  registerSkillBuiltInRoutes(app, deps, deps.builtInSkills ?? []);
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

  // Per-resource authorization mirrors /api/projects exactly: listings filter to the caller's
  // accessible scopes (db.canAccessSkill ≙ db.canAccessProject) and an inaccessible id answers
  // 404 "not found" — never 403 — so foreign-organization callers cannot probe for existence.

  const management = createSkillsManagement(deps);
  for (const key of management.handlers.keys()) {
    const [method, url] = key.split(" ");
    app.route({ method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: url!, handler: async (req, reply) => {
      const principal = method === "GET" ? deps.requestPrincipal(req) : deps.requestHuman(req);
      const result = await management.execute(key, {principal, params: req.params, body: req.body, query: req.query});
      return reply.code(result.status).send(result.body);
    }});
  }

  /* ------------------------------ Skill groups ------------------------------ */

  // Legacy groups remain visible metadata until explicitly converted. Owned groups and every
  // deployment rule are resource-scoped; no implicit ownership backfill grants deployment rights.
  app.get("/api/skill-groups", async (req) => {
    const principal = deps.requestPrincipal(req);
    const human = deps.requestHuman(req);
    return { groups: principal ? db.listSkillGroups().filter(g => !g.scope || db.canAccessSkillGroup(principal, g.id)) : [],
      creationScope: human ? defaultSkillScope(human) : null };
  });

  app.post("/api/skill-groups", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const name = (req.body as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return reply.code(400).send({ error: "name must be 1-120 characters" });
    }
    return reply.code(201).send({ group: db.createSkillGroup(name, Date.now(), defaultSkillScope(principal)) });
  });

  app.post("/api/skill-groups/:id/convert", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (!db.listSkillGroups().some(g => g.id === id) ||
        (db.skillGroupScope(id) && !db.canAccessSkillGroup(principal, id))) {
      return reply.code(404).send({ error: "skill group not found" });
    }
    if ((req.body as { accepted?: unknown } | null)?.accepted !== true) {
      return reply.code(400).send({ error: "explicit acceptance of group ownership is required" });
    }
    try { db.convertSkillGroup(id, defaultSkillScope(principal)); }
    catch { return reply.code(409).send({ error: "group is already owned or its members do not share your default ownership scope" }); }
    return { group: db.listSkillGroups().find(g => g.id === id) };
  });

  app.delete("/api/skill-groups/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (db.skillGroupScope(id) && !db.canAccessSkillGroup(principal, id)) {
      return reply.code(404).send({ error: "skill group not found" });
    }
    if (!db.deleteSkillGroup(id)) {
      return reply.code(404).send({ error: "skill group not found" });
    }
    pushAffected();
    return reply.code(204).send();
  });

  const accessibleGroupRule = (principal: AuthPrincipal, rule: { scopeKind: string; runnerId: string | null }) =>
    rule.scopeKind !== "runner" || (!!rule.runnerId && db.canAccessRunner(principal, rule.runnerId));

  app.get("/api/skill-groups/:id/assignments", async (req, reply) => {
    const principal = deps.requestPrincipal(req);
    const id = (req.params as { id: string }).id;
    if (!principal || !db.canAccessSkillGroup(principal, id)) return reply.code(404).send({ error: "skill group not found" });
    return { assignments: db.listSkillGroupAssignments(id).filter(a => accessibleGroupRule(principal, a)) };
  });

  app.post("/api/skill-groups/:id/assignments", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (!db.canAccessSkillGroup(principal, id)) return reply.code(404).send({ error: "owned skill group not found" });
    const body = (req.body ?? {}) as { scopeKind?: unknown; runnerId?: unknown; agentSelector?: unknown; invocation?: unknown; enabled?: unknown };
    if (body.scopeKind !== "runner" && body.scopeKind !== "instance") return reply.code(400).send({ error: "scopeKind must be instance or runner" });
    if (body.scopeKind === "runner" && (typeof body.runnerId !== "string" || !db.getRunner(body.runnerId) || !db.canAccessRunner(principal, body.runnerId))) {
      return reply.code(404).send({ error: "runner not found" });
    }
    const agentSelector = parseSkillAgentSelector(body.agentSelector);
    const invocation = parseInvocation(body.invocation);
    if (!agentSelector || invocation === null || (body.enabled !== undefined && typeof body.enabled !== "boolean")) {
      return reply.code(400).send({ error: "invalid agentSelector, invocation, or enabled value" });
    }
    try {
      const assignment = db.createSkillGroupAssignment({ groupId: id, scopeKind: body.scopeKind,
        runnerId: body.scopeKind === "runner" ? body.runnerId as string : null,
        agentSelector, invocation: invocation ?? "agent", enabled: body.enabled !== false });
      pushAffected(assignment);
      return reply.code(201).send({ assignment });
    } catch { return reply.code(409).send({ error: "the group's access scope does not include this machine" }); }
  });

  for (const method of ["PATCH", "DELETE"] as const) app.route({
    method, url: "/api/skill-groups/:id/assignments/:assignmentId",
    handler: async (req, reply) => {
      const principal = deps.requestHuman(req);
      if (!principal) return reply.code(403).send({ error: "human identity is required" });
      const { id, assignmentId } = req.params as { id: string; assignmentId: string };
      if (!db.canAccessSkillGroup(principal, id)) return reply.code(404).send({ error: "skill group not found" });
      const existing = db.listSkillGroupAssignments(id).find(a => a.id === assignmentId);
      if (!existing || !accessibleGroupRule(principal, existing)) return reply.code(404).send({ error: "group assignment not found" });
      if (method === "DELETE") {
        db.deleteSkillGroupAssignment(id, assignmentId);
        pushAffected(existing);
        return reply.code(204).send();
      }
      const body = (req.body ?? {}) as { enabled?: unknown; invocation?: unknown };
      const invocation = parseInvocation(body.invocation);
      if (invocation === null || (body.enabled !== undefined && typeof body.enabled !== "boolean")) return reply.code(400).send({ error: "invalid enabled or invocation value" });
      const assignment = db.updateSkillGroupAssignment(id, assignmentId, {
        ...(body.enabled === undefined ? {} : { enabled: body.enabled as boolean }), ...(invocation === undefined ? {} : { invocation }),
      });
      pushAffected(existing);
      return { assignment };
    },
  });

  /* ---------------------------- Skill assignments ---------------------------- */

  // Assignment authorization derives from the referenced skill: listings show only assignments of
  // accessible skills, and creating/mutating/deleting one requires access to that skill (plus, for
  // runner-scoped rows, the same canAccessRunner gate the other /api/runners/:id routes use).

  /* ------------------------------ Per-machine view ------------------------------ */

  app.get("/api/runners/:id/skills", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const runner = db.getRunner(id);
    if (!runner) return reply.code(404).send({ error: "runner not found" });
    const principal = deps.requestPrincipal(req);
    return {
      // File contents stay out of the listing; the digest + targets are what the UI compares.
      desired: resolveDesiredSkills(db, id).map((entry) => ({
        name: entry.name,
        versionDigest: entry.versionDigest,
        targets: entry.targets,
      })),
      reported: skillStateResponse(db.getRunnerSkillState(id)),
      removalReporting: runnerSupportsProtocol(
        runner.protocolVersion,
        "skillLinkRemovalReporting",
      ) ? "supported" : "unsupported",
      // An older runner never reports drift, so an empty list from it proves nothing.
      driftReporting: runnerSupportsProtocol(runner.protocolVersion, "skillDrift") ? "supported" : "unsupported",
      // Likewise for copies a restore kept aside, which only a v185 runner reports.
      keptAsideReporting: runnerSupportsProtocol(runner.protocolVersion, "skillKeptAsideCopies") ? "supported" : "unsupported",
      orphaned: principal ? listOrphanedSkillCopies(db, principal, id) : [],
    };
  });

  app.post("/api/runners/:id/skills/sync", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const runner = db.getRunner(id);
    if (!runner) return reply.code(404).send({ error: "runner not found" });
    if (!hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is offline" });
    if (!runnerSupportsProtocol(runner.protocolVersion, "agentSkills")) {
      return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "agentSkills", "managed agent skills"));
    }
    const requestId = `skills_${randomUUID().slice(0, 8)}`;
    try {
      const result = await pushSkillsSync.request(id, requestId);
      if (result.type !== "skills_state") {
        return reply.code(502).send({ error: "unexpected runner reply" });
      }
      db.setRunnerSkillState(id, result, Date.now());
      return { state: skillStateResponse(db.getRunnerSkillState(id)) };
    } catch (error) {
      if (error instanceof SkillsSyncInProgressError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof SkillsSyncBudgetError) {
        return reply.code(409).send({ error: error.message });
      }
      return reply.code(504).send({ error: (error as Error).message });
    }
  });
}
