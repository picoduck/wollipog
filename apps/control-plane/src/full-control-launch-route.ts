import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  PROJECT_LOCATION_INSPECTION_FAILURES, supportsPacedVideoReviewPeer, humanRequiredRulesExist, runnerSupportsProtocol,
  type CampaignLaunchInspectionResult, type CampaignIssueScope, type PreparedCampaignLaunch, type ProjectLocationInspection,
} from "@wollipog/protocol";
import type { AuthPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { inspectCampaignWorkspace, inspectProjectLocation } from "./project-location-inspection.js";
import type { SessionsService } from "./sessions.js";
import type { OrchestratorSettings } from "./orchestrator-settings.js";
import type { EvidenceAuthorityDisclosures } from "./evidence-authority.js";
import { resolveSessionCreationOwnership } from "./session-creation-route.js";
import { authorizeFullControl } from "./campaign-authority.js";
import { evaluateUiEvidenceReviewClient } from "./ui-evidence-review.js";
import { campaignLaunchDigest, campaignLaunchPreflight, derivedLaunchLimits, firstMessageLaunch, launchSessionRequest, parseFullControlEnableRequest,
  parseFullControlLaunchRequest, type VideoLaunchCertification } from "./campaign-launch-admission.js";

/** Human-only Full Control launch. Preflight is read-only; admission needs the exact reviewed
 * digest and creates the root, its scope, authority and allowance in one atomic step. There is no
 * agent allowlist entry, caller readiness switch or ordinary Create Session fallback. */
export function registerFullControlLaunchRoutes(app: FastifyInstance, dependencies: {
  db: ControlPlaneDb; hub: Hub; sessions: SessionsService; settings: OrchestratorSettings;
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null;
  evidenceDisclosures?: EvidenceAuthorityDisclosures;
  /** The certified video reviewer on a runner, if a current Human-recorded proof exists (#1321). */
  videoCertification?: (runnerId: string) => VideoLaunchCertification | null;
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
        ? "a workspace, a request identity and the exact preflight digest are required"
        : "a workspace is required" });
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

    // Same source as ordinary session creation, after its authorization and assignment checks.
    const workspacePath = db.getWorkspacePath(initial.plan.runnerId, initial.plan.workspaceId);
    if (!workspacePath) return reply.code(404).send({ error: "project location path is unavailable" });

    // The inspection lives only as long as this request: a closed connection cancels it.
    const lifetime = new AbortController();
    const onClose = () => { if (!reply.raw.writableFinished) lifetime.abort(); };
    reply.raw.once("close", onClose);
    // #4117: a v288 root's campaign covers every active Location of its Project. Each other Location
    // is inspected in its own path, in parallel with the launch Location and within its lifetime.
    const projectId = initial.plan.projectId ?? null;
    const launchLocationId = initial.plan.projectLocationId ?? null;
    // Only Locations the launching person can reach themselves are inspected or named; the rest
    // are left out entirely, never listed as excluded.
    const reachableLocations = () => projectId && db.canAccessProject(principal, projectId) &&
      runnerSupportsProtocol(runner.protocolVersion, "campaignRepositoryBoundary")
      ? (db.getProject(projectId)?.locations ?? []).filter((location) => location.availability !== "runner_removed" &&
        (location.id === launchLocationId || db.canAccessWorkspace(principal, location.runnerId, location.workspaceId))) : null;
    const projectLocations = reachableLocations();
    // What each secondary Location was when its inspection started, so a Location that changes
    // while any inspection is still pending is caught after all of them settle.
    const inspected = new Map((projectLocations ?? []).filter((location) => location.id !== launchLocationId).map((location) =>
      [location.id, { runnerId: location.runnerId, workspaceId: location.workspaceId,
        path: db.getWorkspacePath(location.runnerId, location.workspaceId) }]));
    let inspection: CampaignLaunchInspectionResult | undefined;
    const inspections = new Map<string, ProjectLocationInspection>();
    try {
      const others = (projectLocations ?? []).filter((location) => location.id !== launchLocationId);
      const [launched, ...results] = await Promise.all([
        inspectCampaignWorkspace(hub, runner, initial.plan.workspaceId, [...(body.issueNumbers ?? [])].sort((a, b) => a - b),
          lifetime.signal, dependencies.inspectionTimeoutMs, workspacePath),
        ...others.map((location) => inspectProjectLocation({ db, hub }, location.id, { projectId: projectId!, signal: lifetime.signal,
          timeoutMs: dependencies.inspectionTimeoutMs, requireProtocol: "campaignRepositoryBoundary" })),
      ]);
      inspection = launched;
      others.forEach((location, index) => inspections.set(location.id, results[index]!));
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
    // Re-read the Human's defaults too: the saved campaign budget never enters campaign policy,
    // so a change to it is visible to the digest only through this fresh snapshot.
    creationContext.orchestratorDefaults = settings.view(principal);
    const current = prepare();
    if (!current.plan) return reply.code(current.status).send({ error: current.error ?? "launch preparation failed" });
    const plan = current.plan;
    if (db.getWorkspacePath(plan.runnerId, plan.workspaceId) !== workspacePath || (plan.projectId ?? null) !== projectId ||
        (plan.projectLocationId ?? null) !== launchLocationId) {
      return reply.code(409).send({ error: "project location changed during inspection; refresh the preflight" });
    }
    // Every secondary Location is read again now that all inspections have settled. One that left
    // the Project or the launching person's reach meanwhile is left out entirely; one now pointing
    // at another runner, workspace or path is not the Location that was inspected, so it reads as
    // unread. A Location added meanwhile was never inspected and is left for a later inspection.
    const settledLocations = projectLocations ? (reachableLocations() ?? []).filter((location) =>
      location.id === launchLocationId || inspected.has(location.id)) : null;
    for (const location of settledLocations ?? []) {
      const before = inspected.get(location.id);
      if (before && (before.runnerId !== location.runnerId || before.workspaceId !== location.workspaceId ||
          before.path !== db.getWorkspacePath(location.runnerId, location.workspaceId))) {
        inspections.set(location.id, { ok: false, locationId: location.id, failure: "read_failed", reason: PROJECT_LOCATION_INSPECTION_FAILURES.read_failed });
      }
    }
    const agent = runnerNow.agents.find((candidate) => candidate.id === plan.agentId);
    const policyIds = body.overrides?.delegatablePolicyIds ?? [];
    const { preflight, proposal } = campaignLaunchPreflight({
      request: body, plan, runner: runnerNow, inspection, organizationId: principal.organizationId,
      projectLocations: settledLocations ? { launchLocationId: plan.projectLocationId ?? null,
        locations: settledLocations.map((location) => ({ id: location.id, name: location.name })), inspections } : null,
      projectDefaults: plan.projectId ? db.projectChildSessionDefaults(plan.projectId) : null,
      accountingError: (costProtected) => db.campaignBudgetAccountingError(plan.driver, plan.config.model, costProtected),
      dailyLimit: db.getUsageDailyBudget(plan.scope.organizationId).perUserUsd !== null,
      invalidPolicyIds: policyIds.filter((id) => !sessions.governancePolicies().some((rule) =>
        rule.policyId === id && rule.enabled && rule.effect === "ask" && !rule.builtin && !rule.conditions?.humanRequired)),
      imageReview: evaluateUiEvidenceReviewClient(db.uiEvidenceReviewClient({ runnerId: plan.runnerId, agentId: plan.agentId,
        driver: plan.driver, model: plan.config.model ?? null }, "orchestrator")),
      humanRequiredRules: humanRequiredRulesExist(sessions.governancePolicies()),
      pacedVideoPeer: supportsPacedVideoReviewPeer(runnerNow.protocolVersion, agent?.capabilities?.pacedVideoReviewContract),
      disclosuresAvailable: dependencies.evidenceDisclosures !== undefined,
      videoCertification: dependencies.videoCertification?.(runnerNow.runnerId) ?? null,
      savedBudget: creationContext.orchestratorDefaults.defaults.campaignBudget ?? null,
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
        ...(preflight.summary.excludedLocations?.length ? { excludedLocations: preflight.summary.excludedLocations } : {}),
        ...(firstMessageLaunch(body) ? { firstMessage: { derivedLimits: derivedLaunchLimits(body.overrides) } } : {}),
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

  registerFullControlEnableRoutes(app, dependencies);
}

/** Human-only enable on an existing live root campaign. The preflight reuses the launch
 * evaluation with the campaign's own Human-established scope in place of the inspection; enabling
 * recomputes it and requires the exact reviewed digest and policy revision before the existing
 * `setCampaignControl` operation runs. Revoke keeps using the ordinary control endpoint. */
function registerFullControlEnableRoutes(app: FastifyInstance, dependencies: Parameters<typeof registerFullControlLaunchRoutes>[1]): void {
  const { db, sessions, settings, requestPrincipal } = dependencies;
  for (const enable of [false, true]) app.post(enable ? "/api/sessions/:id/orchestrator-campaign/full-control"
    : "/api/sessions/:id/orchestrator-campaign/full-control/preflight", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (principal?.kind !== "human") return reply.code(403).send({ error: "authenticated Human authorization is required" });
    const id = (request.params as { id: string }).id;
    const body = parseFullControlEnableRequest(request.body ?? {}, enable);
    if (!body) return reply.code(400).send({ error: enable ? "the exact preflight digest and policy revision are required" : "invalid Full Control overrides" });
    const session = db.getSession(id);
    if (!session || !db.isSessionOwner(principal, id)) return reply.code(404).send({ error: "campaign not found" });
    const policy = session.orchestratorPolicy;
    if (!policy || session.parentSessionId || !session.workspaceId || !session.agentId) return reply.code(409).send({ error: "only a live root campaign can enable Full Control" });
    // A stopped campaign, including one revoked to Custom, restarts under Custom first (#2940).
    if (["completed", "failed", "stopped"].includes(session.status)) {
      return reply.code(409).send({ error: session.archived ? "only a live root campaign can enable Full Control"
        : "This campaign isn't running. Restart it, then enable Full Control." });
    }
    const runner = db.listRunnersForPrincipal(principal).find((candidate) => candidate.runnerId === session.runnerId);
    const scope = db.sessionScope(id);
    if (!runner || !scope) return reply.code(409).send({ error: "the campaign's runner or ownership is unavailable" });
    const limits = (sessionId: string) => {
      const view = db.getSession(sessionId);
      // A revoked allowance's personal ceilings include limits the person lowered since (#2940).
      const member = db.campaignBudgets.governingRoot(sessionId) ? db.campaignBudgets.userLimits(sessionId)
        : db.campaignBudgets.personalLimits(sessionId, { costBudgetUsd: view?.costBudgetUsd ?? null, maxToolCalls: view?.maxToolCalls ?? null });
      return member ?? { costBudgetUsd: view?.costBudgetUsd ?? null, maxToolCalls: view?.maxToolCalls ?? null };
    };
    const ceiling = (value: { costBudgetUsd: number | null; maxToolCalls: number | null }) => (value.costBudgetUsd ?? 0) > 0 || (value.maxToolCalls ?? 0) > 0;
    const rootLimits = limits(id);
    const plan: PreparedCampaignLaunch = { runnerId: session.runnerId, workspaceId: session.workspaceId,
      ...(session.projectId !== undefined ? { projectId: session.projectId } : {}),
      ...(session.projectLocationId !== undefined ? { projectLocationId: session.projectLocationId } : {}),
      agentId: session.agentId, driver: session.driver, ...(session.providerAccountId ? { providerAccountId: session.providerAccountId } : {}),
      config: { ...(session.resolvedModel ?? session.model ? { model: (session.resolvedModel ?? session.model)! } : {}),
        ...(session.effort ? { effort: session.effort } : {}), ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
        ...(rootLimits.costBudgetUsd != null ? { costBudgetUsd: rootLimits.costBudgetUsd } : {}),
        ...(rootLimits.maxToolCalls != null ? { maxToolCalls: rootLimits.maxToolCalls } : {}) },
      useWorktree: session.useWorktree, executionTarget: (session.executionTarget ?? { adapter: "host" }) as PreparedCampaignLaunch["executionTarget"], policy, scope };
    const issueScope = policy.issueScope;
    // The issues a Custom campaign's first message names come only from the Decision Model's reading
    // of it (#4259): while that reading runs, nothing is derived, and enabling waits for it.
    if (!issueScope && sessions.campaignFirstMessageReadingPending(id)) {
      return reply.code(409).send({ error: "The Decision Model is still reading this campaign's first message for its issues. Try again in a moment." });
    }
    // A campaign with no issue scope yet gets the one a launch would derive: its repository and the
    // issues its first message names. With no message yet, the next one is the task.
    const derived = issueScope ? null : await sessions.campaignScopeFromFirstMessage(id);
    const agent = runner.agents.find((candidate) => candidate.id === session.agentId);
    const revision = session.parentControlPolicy?.revision ?? 0;
    const { preflight: evaluated, proposal } = campaignLaunchPreflight({
      request: { runnerId: session.runnerId, workspaceId: session.workspaceId, ...(derived?.firstMessage ? {} : { task: session.title }),
        overrides: body.overrides },
      plan, runner, organizationId: principal.organizationId,
      campaignScope: issueScope ? { repository: issueScope.repository, issueNumbers: issueScope.issueNumbers,
        authorizedByCaller: issueScope.authorizedByUserId === principal.userId }
        : { repository: derived?.repository ?? "", issueNumbers: derived?.issueNumbers ?? [], authorizedByCaller: true },
      participantCeiling: db.campaignDescendantIds(id).some((childId) => {
        const child = db.getSession(childId);
        return Boolean(child && !["completed", "failed", "stopped"].includes(child.status) && ceiling(limits(childId)));
      }),
      projectDefaults: session.projectId ? db.projectChildSessionDefaults(session.projectId) : null,
      accountingError: (costProtected) => db.campaignBudgetAccountingError(session.driver, plan.config.model, costProtected),
      dailyLimit: db.getUsageDailyBudget(scope.organizationId).perUserUsd !== null,
      invalidPolicyIds: (body.overrides?.delegatablePolicyIds ?? []).filter((policyId) => !sessions.governancePolicies().some((rule) =>
        rule.policyId === policyId && rule.enabled && rule.effect === "ask" && !rule.builtin && !rule.conditions?.humanRequired)),
      imageReview: evaluateUiEvidenceReviewClient(db.uiEvidenceReviewClient({ runnerId: session.runnerId, agentId: session.agentId,
        driver: session.driver, model: plan.config.model ?? null }, "orchestrator")),
      humanRequiredRules: humanRequiredRulesExist(sessions.governancePolicies()),
      pacedVideoPeer: supportsPacedVideoReviewPeer(runner.protocolVersion, agent?.capabilities?.pacedVideoReviewContract),
      disclosuresAvailable: dependencies.evidenceDisclosures !== undefined,
      videoCertification: dependencies.videoCertification?.(runner.runnerId) ?? null,
      savedBudget: settings.view(principal).defaults.campaignBudget ?? null,
    });
    // The reviewed digest also binds this campaign and its current policy revision.
    const preflight = { ...evaluated, digest: campaignLaunchDigest({ launch: evaluated.digest, sessionId: id, revision }) };
    reply.header("cache-control", "private, no-store");
    request.log.info({ event: "full_control_enable_preflight", requestId: request.id, sessionId: id,
      entryPoint: enable ? "human_enable" : "human_enable_preflight", ready: preflight.ready,
      missingCapabilities: preflight.capabilities.filter((item) => item.state === "unsupported").map((item) => item.id),
      preflightDigest: preflight.digest }, "Full Control enable preflight evaluated");
    if (!enable) return { preflight, expectedRevision: revision };
    if (body.expectedRevision !== revision || body.preflightDigest !== preflight.digest) {
      return reply.code(409).send({ error: "the campaign or its preflight changed; refresh and review the exact proposal again", preflight, expectedRevision: revision });
    }
    if (!preflight.ready || !proposal) {
      return reply.code(409).send({ error: `Full Control cannot be enabled: ${preflight.summary.blockers.map((item) => item.reason).join(" ")}`, preflight, expectedRevision: revision });
    }
    const evidence = preflight.summary.evidence;
    const result = sessions.setCampaignControl(id, { mode: "full_control", objective: proposal.objective, operations: proposal.operations,
      delegatablePolicyIds: proposal.delegatablePolicyIds, issueAuthority: proposal.issueAuthority, budgetAuthority: proposal.budgetAuthority,
      ...(evidence.envelope && evidence.provider?.reviewer.model ? { evidenceAuthority: {
        destinationConfigurationId: evidence.destination.configurationId,
        destinationDisclosureRevision: evidence.destination.disclosureRevision,
        providers: [{ providerId: evidence.provider.providerId, disclosureRevision: evidence.provider.disclosureRevision,
          reviewers: [{ driver: evidence.provider.reviewer.driver as "claude-code" | "codex-app-server", modelId: evidence.provider.reviewer.model }] }],
      } } : {}) }, revision, principal, derived ?? undefined, derivedLaunchLimits(body.overrides));
    if (!result.ok || !result.data) return reply.code(result.status).send({ error: result.error ?? "Full Control was not enabled" });
    return result.data;
  });
}
