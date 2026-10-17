import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  supportsPacedVideoReviewPeer,
  type CampaignLaunchInspectionResult, type CampaignIssueScope, type PreparedCampaignLaunch, type RunnerView,
} from "@wollipog/protocol";
import { randomUUID } from "node:crypto";
import type { AuthPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import { RunnerRequestTimeoutError, type Hub } from "./hub.js";
import type { SessionsService } from "./sessions.js";
import type { OrchestratorSettings } from "./orchestrator-settings.js";
import type { EvidenceAuthorityDisclosures } from "./evidence-authority.js";
import { resolveSessionCreationOwnership } from "./session-creation-route.js";
import { authorizeFullControl } from "./campaign-authority.js";
import { evaluateUiEvidenceReviewClient } from "./ui-evidence-review.js";
import { campaignLaunchPreflight, launchSessionRequest, parseFullControlLaunchRequest } from "./campaign-launch-admission.js";

export const CAMPAIGN_LAUNCH_INSPECTION_TIMEOUT_MS = 60_000;

/** Ask the runner to inspect the workspace origin and issues. Expiry or cancellation of the caller
 * drops the pending request (so a late result is discarded, never admitted) and, on a version-2
 * runner, stops that one inspection. Older runners stay bounded by their per-command timeouts. */
export async function inspectCampaignWorkspace(hub: Hub, runner: RunnerView, workspaceId: string, issueNumbers: number[],
  signal: AbortSignal, timeoutMs = CAMPAIGN_LAUNCH_INSPECTION_TIMEOUT_MS): Promise<CampaignLaunchInspectionResult | undefined> {
  const version = runner.runtime?.campaignLaunchInspection?.version ?? 0;
  if (!version || (version < 2 && !issueNumbers.length) || signal.aborted) return undefined;
  const requestId = `campaign_launch_${randomUUID()}`;
  const stopRunner = () => {
    if (version >= 2) hub.sendToRunner(runner.runnerId, { type: "campaign_launch_inspect_cancel", requestId });
  };
  const onAbort = () => {
    if (hub.cancelRunnerRequest(runner.runnerId, requestId, new Error("campaign launch inspection was cancelled"))) stopRunner();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await hub.requestFromRunner(runner.runnerId, requestId, {
      type: "campaign_launch_inspect", requestId, workspaceId, issueNumbers,
    }, timeoutMs);
    if (signal.aborted || result.type !== "campaign_launch_inspection_result" || result.requestId !== requestId) return undefined;
    return result;
  } catch (error) {
    if (error instanceof RunnerRequestTimeoutError) stopRunner();
    // No credential-bearing runner error escapes the preflight.
    return undefined;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Human-only Full Control launch. Preflight is read-only; admission needs the exact reviewed
 * digest and creates the root, its scope, authority and allowance in one atomic step. There is no
 * agent allowlist entry, caller readiness switch or ordinary Create Session fallback. */
export function registerFullControlLaunchRoutes(app: FastifyInstance, dependencies: {
  db: ControlPlaneDb; hub: Hub; sessions: SessionsService; settings: OrchestratorSettings;
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null;
  evidenceDisclosures?: EvidenceAuthorityDisclosures;
  inspectionTimeoutMs?: number;
}): void {
  const { db, hub, sessions, settings, requestPrincipal } = dependencies;
  for (const admit of [false, true]) app.post(admit ? "/api/full-control-campaigns" : "/api/full-control-campaigns/preflight", async (request, reply) => {
    const startedAt = performance.now();
    const principal = requestPrincipal(request);
    if (principal?.kind !== "human") return reply.code(403).send({ error: "authenticated Human launch authorization is required" });
    const body = parseFullControlLaunchRequest(request.body, admit);
    if (!body) {
      return reply.code(400).send({ error: admit
        ? "a workspace, a task or issue numbers, a request identity and the exact preflight digest are required"
        : "a workspace and a task or issue numbers are required" });
    }
    reply.header("cache-control", "private, no-store");
    if (admit) {
      // A committed identity answers before readiness is re-evaluated: HEAD, runner generation or
      // inspection availability may legitimately change after commit, and a lost response must
      // still recover the retained root without another inspection or provider start.
      const committed = db.humanCampaignLaunchIdentity(principal.userId, body.requestId!);
      if (committed) {
        const retained = committed.digest === body.preflightDigest && db.canAccessSession(principal, committed.sessionId)
          ? db.getSession(committed.sessionId) : null;
        return retained ? reply.code(200).send(retained)
          : reply.code(409).send({ error: "this request identity already admitted a different reviewed launch; use a new request identity" });
      }
    }
    const currentRunner = () => db.listRunnersForPrincipal(principal).find((candidate) =>
      candidate.runnerId === body.runnerId && candidate.workspaces.some((workspace) => workspace.id === body.workspaceId));
    const runner = currentRunner();
    if (!runner) return reply.code(404).send({ error: "runner workspace not found" });
    // The simple request names a workspace; resolve its exact Project Location so saved Project
    // defaults apply. Without one accessible Location the root is an explicit no-Project session.
    if (body.projectLocationId === undefined && body.projectId !== null) {
      const location = body.projectId === undefined ? db.findProjectLocation(body.runnerId, body.workspaceId)
        : db.findProjectLocationForProject(body.projectId, body.runnerId, body.workspaceId);
      const visible = location && db.canAccessProject(principal, location.projectId) ? location : null;
      if (body.projectId !== undefined && !visible) return reply.code(404).send({ error: "project location not found" });
      body.projectId = visible?.projectId ?? null;
      body.projectLocationId = visible?.id ?? null;
    }
    const sessionRequest = launchSessionRequest(body, runner);
    if (!sessionRequest) return reply.code(409).send({ error: "this runner has no available native Claude Code or Codex App Server installation for an Orchestrator" });
    const ownership = resolveSessionCreationOwnership(db, principal, sessionRequest);
    if (!ownership.ok) return reply.code(ownership.status).send({ error: ownership.error });
    // Campaign allowance and controlled review are charged to the authorizing Human, so the root is
    // user-owned even inside an organization Project; creation verifies the Project contains it.
    const scope = { organizationId: principal.organizationId, owner: { kind: "user" as const, userId: principal.userId } };
    const creationContext = {
      defaultOwnerUserId: principal.userId,
      orchestratorDefaults: settings.view(principal),
      validateOrchestratorDefaults: (defaults: Parameters<OrchestratorSettings["compatibilityError"]>[1]) => settings.compatibilityError(principal, defaults),
    };
    const prepare = (): { plan?: PreparedCampaignLaunch; status: number; error?: string } => {
      let plan: PreparedCampaignLaunch | undefined;
      const prepared = sessions.createSession(ownership.body, undefined, scope, false, false, false, {
        ...creationContext, inspectLaunchPlan: (value) => { plan = value; },
      });
      return { plan, status: prepared.status, error: prepared.error };
    };
    const initial = prepare();
    if (!initial.plan) return reply.code(initial.status).send({ error: initial.error ?? "launch preparation failed" });

    // The inspection lives only as long as this request: a closed connection cancels it.
    const lifetime = new AbortController();
    const onClose = () => { if (!reply.raw.writableFinished) lifetime.abort(); };
    reply.raw.once("close", onClose);
    let inspection: CampaignLaunchInspectionResult | undefined;
    try {
      inspection = await inspectCampaignWorkspace(hub, runner, initial.plan.workspaceId, [...(body.issueNumbers ?? [])].sort((a, b) => a - b),
        lifetime.signal, dependencies.inspectionTimeoutMs);
    } finally { reply.raw.off("close", onClose); }
    if (lifetime.signal.aborted) {
      request.log.info({ event: "full_control_launch_preflight_cancelled", requestId: request.id,
        durationMs: Math.round(performance.now() - startedAt) }, "Full Control launch preflight cancelled by its caller");
      return reply;
    }

    // Saved defaults, runner discovery and policy may change while the inspection is pending. The
    // preflight (and so the digest the Human reviewed) is computed from facts re-read after it,
    // and admission below creates the root synchronously from these same facts.
    const runnerNow = currentRunner();
    if (!runnerNow) return reply.code(404).send({ error: "runner workspace not found" });
    const current = prepare();
    if (!current.plan) return reply.code(current.status).send({ error: current.error ?? "launch preparation failed" });
    const plan = current.plan;
    const agent = runnerNow.agents.find((candidate) => candidate.id === plan.agentId);
    const policyIds = body.overrides?.delegatablePolicyIds ?? [];
    const { preflight, proposal } = campaignLaunchPreflight({
      request: body, plan, runner: runnerNow, inspection, organizationId: principal.organizationId,
      projectDefaults: plan.projectId ? db.projectChildSessionDefaults(plan.projectId) : null,
      accountingError: db.campaignBudgetAccountingError(plan.driver, plan.config.model, true),
      dailyLimit: db.getUsageDailyBudget(plan.scope.organizationId).perUserUsd !== null,
      invalidPolicyIds: policyIds.filter((id) => !sessions.governancePolicies().some((rule) =>
        rule.policyId === id && rule.enabled && rule.effect === "ask" && !rule.builtin && !rule.conditions?.humanRequired)),
      imageReview: evaluateUiEvidenceReviewClient(db.uiEvidenceReviewClient({ runnerId: plan.runnerId, agentId: plan.agentId,
        driver: plan.driver, model: plan.config.model ?? null }, "orchestrator")),
      pacedVideoPeer: supportsPacedVideoReviewPeer(runnerNow.protocolVersion, agent?.capabilities?.pacedVideoReviewContract),
      disclosuresAvailable: dependencies.evidenceDisclosures !== undefined,
    });
    request.log.info({ event: "full_control_launch_preflight", requestId: request.id,
      entryPoint: admit ? "human_launch_admission" : "human_launch_preflight", ready: preflight.ready,
      missingCapabilities: preflight.capabilities.filter((item) => item.state === "unsupported").map((item) => item.id),
      humanRequired: preflight.capabilities.filter((item) => item.state === "human_required").map((item) => item.id),
      inspectionCancellation: preflight.inspectionCancellation,
      preflightDigest: preflight.digest, durationMs: Math.round(performance.now() - startedAt) }, "Full Control launch preflight evaluated");
    if (!admit) return { preflight };
    if (body.preflightDigest !== preflight.digest) return reply.code(409).send({ error: "launch preflight changed; refresh and review the exact proposal again", preflight });
    if (!preflight.ready || !proposal) {
      return reply.code(409).send({ error: `Full Control launch is blocked: ${preflight.summary.blockers.map((item) => item.reason).join(" ")}`, preflight });
    }
    // The one explicit Human authorization mints scope and authority from the reviewed inspection.
    const now = Date.now();
    const issueScope: CampaignIssueScope = { repository: proposal.repository, issueNumbers: [...proposal.issueNumbers],
      revision: 1, authorizedByUserId: principal.userId, authorizedAt: now };
    const control = authorizeFullControl(principal, issueScope, proposal, 1, now);
    if (control?.mode !== "full_control") return reply.code(409).send({ error: "the reviewed proposal is outside the Full Control schema", preflight });
    const evidence = preflight.summary.evidence;
    const created = sessions.createSession(ownership.body, undefined, scope, false, false, false, {
      ...creationContext,
      humanCampaignLaunch: { principal, requestId: body.requestId!, digest: preflight.digest, control, issueScope,
        ...(evidence.envelope && evidence.provider?.reviewer.model ? { evidenceAuthority: {
          destinationConfigurationId: evidence.destination.configurationId,
          destinationDisclosureRevision: evidence.destination.disclosureRevision,
          providers: [{ providerId: evidence.provider.providerId, disclosureRevision: evidence.provider.disclosureRevision,
            reviewers: [{ driver: evidence.provider.reviewer.driver as "claude-code" | "codex-app-server", modelId: evidence.provider.reviewer.model }] }],
        } } : {}) },
    });
    request.log.info({ event: "full_control_launch_admission", requestId: request.id, ok: created.ok,
      sessionId: created.data?.id ?? created.errorDetails?.sessionId, preflightDigest: preflight.digest,
      durationMs: Math.round(performance.now() - startedAt) }, "Full Control launch admission evaluated");
    if (!created.ok || !created.data) {
      return reply.code(created.status).send({ error: created.error ?? "the campaign was not created", ...(created.errorDetails ? { details: created.errorDetails } : {}) });
    }
    return reply.code(created.status ?? 201).send(created.data);
  });
}
