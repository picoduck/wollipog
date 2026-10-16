import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FullControlLaunchRequest, PreparedCampaignLaunch, CampaignLaunchInspectionResult } from "@wollipog/protocol";
import { randomUUID } from "node:crypto";
import type { AuthPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { SessionsService } from "./sessions.js";
import type { OrchestratorSettings } from "./orchestrator-settings.js";
import { resolveSessionCreationOwnership } from "./session-creation-route.js";
import { campaignLaunchPreflight, parseCampaignLaunchProposal } from "./campaign-launch-admission.js";

/** No agent allowlist entry or ordinary-creation fallback. This is source integration only:
 * production admission stays refused until complete enforcement contracts are actually present. */
export function registerFullControlLaunchRoutes(app: FastifyInstance, dependencies: {
  db: ControlPlaneDb; hub: Hub; sessions: SessionsService; settings: OrchestratorSettings;
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null;
}): void {
  const { db, hub, sessions, settings, requestPrincipal } = dependencies;
  for (const admit of [false, true]) app.post(admit ? "/api/full-control-campaigns" : "/api/full-control-campaigns/preflight", async (request, reply) => {
    const startedAt = performance.now();
    const principal = requestPrincipal(request);
    if (principal?.kind !== "human") return reply.code(403).send({ error: "authenticated Human launch authorization is required" });
    const raw = request.body;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).some((key) => !["session", "proposal", "requestId", "preflightDigest"].includes(key))) {
      return reply.code(400).send({ error: "an exact session and campaign proposal are required" });
    }
    const body = raw as FullControlLaunchRequest;
    const proposal = parseCampaignLaunchProposal(body.proposal);
    if (!proposal || !body.session || typeof body.session !== "object" || Array.isArray(body.session) ||
        body.session.campaignWorkItemId !== undefined || body.session.workspacePath !== undefined ||
        body.session.images?.length || body.session.launchSurface === "native_tui") {
      return reply.code(400).send({ error: "a valid finite Human campaign proposal and registered managed root are required" });
    }
    if (admit && (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId) ||
        typeof body.preflightDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.preflightDigest))) {
      return reply.code(400).send({ error: "request identity and exact preflight digest are required" });
    }
    const runner = db.listRunnersForPrincipal(principal).find((candidate) => candidate.runnerId === body.session.runnerId);
    if (!runner || !runner.workspaces.some((workspace) => workspace.id === body.session.workspaceId)) {
      return reply.code(404).send({ error: "runner workspace not found" });
    }
    const ownership = resolveSessionCreationOwnership(db, principal, body.session);
    if (!ownership.ok) return reply.code(ownership.status).send({ error: ownership.error });
    let plan: PreparedCampaignLaunch | undefined;
    const prepared = sessions.createSession(ownership.body, undefined, ownership.scope, false, false, false, {
      defaultOwnerUserId: principal.userId,
      orchestratorDefaults: settings.view(principal),
      validateOrchestratorDefaults: (defaults) => settings.compatibilityError(principal, defaults),
      inspectLaunchPlan: (value) => { plan = value; },
    });
    if (!plan) return reply.code(prepared.status).send({ error: prepared.error ?? "launch preparation failed" });
    let inspection: CampaignLaunchInspectionResult | undefined;
    if (runner.runtime?.campaignLaunchInspection?.version === 1) {
      try {
        const requestId = `campaign_launch_${randomUUID()}`;
        const result = await hub.requestFromRunner(runner.runnerId, requestId, {
          type: "campaign_launch_inspect", requestId, workspaceId: plan.workspaceId, issueNumbers: proposal.issueNumbers,
        }, 60_000);
        if (result.type === "campaign_launch_inspection_result" && result.requestId === requestId) inspection = result;
      } catch { /* No credential-bearing runner error escapes the preflight. */ }
    }
    const preflight = campaignLaunchPreflight(plan, proposal, runner, inspection);
    request.log.info({ event: "full_control_launch_preflight", requestId: request.id,
      entryPoint: admit ? "human_launch_admission" : "human_launch_preflight", supported: preflight.supported,
      missingCapabilities: preflight.capabilities.filter((item) => item.state === "unsupported").map((item) => item.capability),
      preflightDigest: preflight.digest, durationMs: Math.round(performance.now() - startedAt) }, "Full Control launch preflight evaluated");
    reply.header("cache-control", "private, no-store");
    if (!admit) return { preflight };
    if (body.preflightDigest !== preflight.digest) return reply.code(409).send({ error: "launch preflight changed; refresh and review the exact proposal again", preflight });
    // There is deliberately no supported-subcontract bypass, caller readiness switch, or
    // ordinary Create Session fallback. Source fixtures exercise atomic persistence separately.
    return reply.code(409).send({ error: "Full Control launch is blocked until every mandatory execution, review, media, evidence and usage capability has trusted current proof", preflight });
  });
}
