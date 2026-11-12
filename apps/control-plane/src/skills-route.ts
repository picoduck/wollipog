import { createExtendedSkillsManagement } from "./skill-extended-management.js";
import type { SkillApplicationService } from "./skills-management.js";
import { createSkillsManagement } from "./skills-management.js";
/**
 * REST surface for the managed skill library plus the per-machine sync trigger, and the shared
 * push-on-change helper. Registered from index.ts next to the other /api routes; extracted as a
 * module (mirroring runner-credential-route.ts) so the routes are unit-testable with a real
 * in-memory db and a mock hub.
 */

import { randomUUID } from "node:crypto";
import { registerSkillVersionPolicyRoutes } from "./skill-version-policy-route.js";
import type { BuiltInSkill } from "./built-in-skills.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  SKILL_MAX_TOTAL_BYTES,
  runnerCapabilityRequirementError,
  runnerSupportsProtocol,
  type SkillsSyncContentMessage,
  type SkillsSyncManifestMessage,
  type SkillsSyncNeedMessage,
  type SkillsSyncMessage,
} from "@wollipog/protocol";
import type {
  ControlPlaneDb,
} from "./db.js";
import type { Hub } from "./hub.js";
import type { RunnerRequestResult } from "./hub.js";
import type { HumanPrincipal, AuthPrincipal } from "./identity.js";
import {
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
  extendedManagement?: SkillApplicationService;
  db: ControlPlaneDb;
  hub: SkillsHub;
  requestHuman(req: FastifyRequest): HumanPrincipal | null;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
  pushSkillsSync: SkillsSyncPusher;
  /** The running release's built-in skills; their content backs the built-in review routes. */
  builtInSkills?: readonly BuiltInSkill[];
}

export function registerSkillRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  registerSkillVersionPolicyRoutes(app, deps);
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

  (deps.extendedManagement ?? createExtendedSkillsManagement(deps)).registerHttp(app, deps);
}
