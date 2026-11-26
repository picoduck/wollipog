import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { campaignAuthorityPreflight, campaignIssueForgeUrl, type CampaignRecoveryRecord } from "@wollipog/protocol";
import { campaignBoundaryCurrent, campaignIssueInScope } from "./campaign-authority.js";
import { hasCampaignCheckFailure } from "./campaign-forge-observations.js";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import type { RecoveryExtensionSnapshot } from "./campaign-recovery-store.js";

/** Only observed PR repairs with one proven original review requester are eligible. No new
 * requester, review epoch, worktree, provider permission or spending authority is created. */
export function recoveryExtensionContext(db: ControlPlaneDb, campaignId: string, record: CampaignRecoveryRecord, now: number) {
  const root = db.getSession(campaignId, { includeCampaignProjection: false });
  const control = root?.orchestratorPolicy?.control;
  const scope = db.sessionScope(campaignId);
  if (!root || control?.mode !== "full_control" || !campaignBoundaryCurrent(root) ||
      scope?.owner.kind !== "user" || scope.owner.userId !== control.boundary?.authorizedByUserId ||
      root.archived || root.stopOperation || !["idle", "running", "input_required"].includes(root.status) ||
      !campaignAuthorityPreflight(control, root.driver, db.getRunner(root.runnerId)?.protocolVersion).supported ||
      record.resource.kind !== "pull_request" || record.resource.sessionId !== root.id ||
      !["repair_checks", "rereview"].includes(record.action) || !record.resource.repository || !record.resource.pullRequest)
    return null;
  const ref = { repository: record.resource.repository, number: record.resource.pullRequest };
  const work = db.campaignWorkLedger.pullRequestWorkItems(root.id).get(`${ref.repository.toLowerCase()}#${ref.number}`);
  const item = work && db.campaignWorkLedger.detail(root.id, work.workItemId, now, () => true);
  if (!item?.issue || work?.handoff || !campaignIssueInScope(root.orchestratorPolicy, item.issue)) return null;
  const fact = db.campaignForgeObservations.facts(root.id, [ref], now)[0]?.fact;
  if (fact?.availability !== "fresh" || fact.value.state !== "open" || fact.value.headSha !== record.resource.occurrenceId) return null;
  if (record.action === "repair_checks" ? !hasCampaignCheckFailure(fact.value)
    : fact.value.forge === "gitlab" || fact.value.reviewDecision !== "changes_requested") return null;
  const requesters = db.campaignRecoveryRequesters(root.id, ref.repository, ref.number);
  if (requesters.length !== 1) return null;
  const requester = db.getSession(requesters[0]!, { includeCampaignProjection: false });
  const requesterScope = requester && db.sessionScope(requester.id);
  if (!requester || requesterScope?.owner.kind !== "user" || requesterScope.owner.userId !== scope.owner.userId ||
      requesterScope.organizationId !== scope.organizationId ||
      !campaignAuthorityPreflight(control, root.driver, db.getRunner(requester.runnerId)?.protocolVersion).supported) return null;
  const worktrees = requester.worktrees ?? [];
  const worktree = worktrees.find(tree => tree.pullRequest?.state === "open" &&
    campaignIssueForgeUrl(tree.pullRequest.url, ref.repository, "change", ref.number));
  if (!worktree || !requester.worktreePath) return null;
  const restorationRequired = requester.archived || !!requester.stopOperation || ["stopped", "failed", "completed"].includes(requester.status);
  const binding = createHash("sha256").update(JSON.stringify({ campaignId, control, scope,
    policy: root.parentControlPolicy, repository: ref.repository, number: ref.number, head: fact.value.headSha,
    action: record.action, requester: requester.id, requesterScope: db.sessionScope(requester.id),
    runner: requester.runnerId, worktree: { id: worktree.id, path: worktree.path, branch: worktree.branch,
      source: worktree.source, pullRequestUrl: worktree.pullRequest!.url } })).digest("hex");
  return { binding, requesterSessionId: requester.id, ownerUserId: scope.owner.userId, restorationRequired,
    guidance: "Restore the original requester through human Unarchive and Restart if needed. Preserve its linked unmerged worktree and review history. Admission does not restore a session or authorize CI reruns, review extensions, merges, credentials or spending." };
}

/** Human HTTP entry points only: deliberately absent from agent tools and automatic recovery. */
export function registerCampaignRecoveryExtensionRoutes(app: FastifyInstance, deps: {
  db: ControlPlaneDb; requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
}) {
  const { db } = deps;
  const owner = (req: FastifyRequest) => {
    const principal = deps.requestPrincipal(req);
    const { id } = req.params as { id: string };
    const scope = db.sessionScope(id);
    return principal?.kind === "human" && principal.role !== "viewer" && db.canAccessSession(principal, id) &&
      scope?.organizationId === principal.organizationId && scope.owner.kind === "user" && scope.owner.userId === principal.userId
      ? { id, principal } : null;
  };
  app.get("/api/sessions/:id/campaign/recovery-extensions", async (req, reply) => {
    const target = owner(req);
    if (!target) return reply.code(403).send({ error: "Only the campaign owner may inspect recovery extensions." });
    return { receipts: db.campaignRecovery.extensions(target.id), records: db.campaignRecovery.activeRecords(target.id) };
  });
  app.post("/api/sessions/:id/campaign/recovery-extensions/preview", async (req, reply) => {
    const target = owner(req);
    if (!target) return reply.code(403).send({ error: "Only the campaign owner may extend recovery." });
    const body = req.body as { recoveryId?: string; extraInstructions?: number } | null;
    const record = db.campaignRecovery.activeRecords(target.id).find(item => item.id === body?.recoveryId);
    const extraInstructions = body?.extraInstructions;
    if (!record || record.reason !== "attempts_exhausted" || record.state !== "blocked" || record.dispatchFenced ||
        record.attempts !== record.maxAttempts || !Number.isSafeInteger(extraInstructions) || extraInstructions! < 1 || extraInstructions! > 4)
      return reply.code(409).send({ error: "Recovery is ineligible or changed. Unrelated fences cannot be overridden." });
    const context = recoveryExtensionContext(db, target.id, record, Date.now());
    if (!context) return reply.code(409).send({ error: "Refresh forge facts and check campaign authority, supported runners and original requester ownership." });
    const { binding, requesterSessionId, ownerUserId } = context;
    const snapshot: RecoveryExtensionSnapshot = { record, extraInstructions: extraInstructions!, binding, requesterSessionId, ownerUserId };
    return { campaignId: target.id, snapshot, ...context };
  });
  app.post("/api/sessions/:id/campaign/recovery-extensions/apply", async (req, reply) => {
    const target = owner(req);
    if (!target) return reply.code(403).send({ error: "Only the campaign owner may extend recovery." });
    const body = req.body as { requestId?: string; snapshot?: RecoveryExtensionSnapshot } | null;
    if (!body?.requestId || !/^[a-zA-Z0-9_-]{1,128}$/u.test(body.requestId) || !body.snapshot?.record)
      return reply.code(400).send({ error: "An exact preview and a bounded request ID are required." });
    const snapshot = body.snapshot;
    // Reconciliation precedes current-resource checks: a spent/revoked receipt is history only.
    const previous = db.campaignRecovery.extensions(target.id).find(item => item.requestId === body.requestId);
    if (!previous) {
      const current = db.campaignRecovery.activeRecords(target.id).find(item => item.id === snapshot.record.id);
      const context = current && recoveryExtensionContext(db, target.id, current, Date.now());
      if (!context || context.restorationRequired || context.binding !== snapshot.binding ||
          context.requesterSessionId !== snapshot.requesterSessionId || context.ownerUserId !== snapshot.ownerUserId)
        return reply.code(409).send({ error: "Recovery changed or the original requester needs human restoration. Obtain a fresh preview." });
    }
    try { return { receipt: db.campaignRecovery.extend(target.id, body.requestId, snapshot, Date.now()) }; }
    catch { return reply.code(409).send({ error: "Recovery changed or the request ID was already used. Read the existing receipt." }); }
  });
  app.post("/api/sessions/:id/campaign/recovery-extensions/:requestId/revoke", async (req, reply) => {
    const target = owner(req);
    if (!target) return reply.code(403).send({ error: "Only the campaign owner may revoke recovery." });
    db.campaignRecovery.revokeExtension(target.id, (req.params as { requestId: string }).requestId, Date.now());
    return { receipts: db.campaignRecovery.extensions(target.id) };
  });
}
