import {randomUUID} from "node:crypto";
import {runnerSupportsProtocol, validProviderHomeLaunchRefusal, handoffDestinationError, providerSupportsConversationFork, type SessionConfig, type SetProjectRequest, type SetWorkspaceRequest, type RunnerProtocolCapability} from "@wollipog/protocol";
import type {ControlPlaneDb} from "./db.js";
import {isRunnerRequestTimeoutError, type Hub} from "./hub.js";
import {sessionBlocksConversationFork, type SessionsService} from "./sessions.js";
import {canAssignSessionProject} from "./session-creation-route.js";
import {forkProjectAssignment, forkSnapshotIdentityError, providerForkCleanupTarget, providerForkSnapshotIdError, type AuthPrincipal, type HumanPrincipal} from "./identity.js";
import {failureBody, type CapabilityRefusal} from "./capability-refusal.js";
import type {OwnerManagementReply} from "./owner-management.js";
import type {ShellRegistry} from "./shell-registry.js";

/** Owner HTTP and Assistant adapters share these operations. Authority is explicit, never
 * reconstructed from Assistant text or HTTP injection. Recheck before post-await writes. */
export function createSessionLifecycleManagement(deps: {
  db: ControlPlaneDb; hub: Hub; svc: SessionsService;
  shellRegistry: ShellRegistry;
  locationAdded(id: string, principal: HumanPrincipal): Promise<unknown>;
  runnerCapabilityError(runnerId: string, capability: RunnerProtocolCapability, label: string): CapabilityRefusal | null;
}) {
  const {db, hub, svc, runnerCapabilityError} = deps;
  const campaignLocations = {locationAdded: deps.locationAdded};
  const conversationBranchesInFlight = new Set<string>();
  const respond = (reply: OwnerManagementReply, r: {ok: boolean; status: number; data?: unknown; error?: string}) => reply.code(r.status).send(r.ok ? r.data : failureBody(r));

  async function project(id: string, input: unknown, requester: AuthPrincipal | null, reply: OwnerManagementReply, recheck?: () => Promise<unknown>) {
    const body = (input ?? {}) as Partial<SetProjectRequest>;
    if (!("projectId" in body)) return reply.code(400).send({ error: "projectId is required" });
    if (body.projectId !== null && (typeof body.projectId !== "string" || !body.projectId.trim())) {
      return reply.code(400).send({ error: "projectId must be a non-empty string or null" });
  }
  if (body.linkLocation !== undefined && typeof body.linkLocation !== "boolean") {
    return reply.code(400).send({ error: "linkLocation must be a boolean" });
  }
  if (body.linkLocation && body.projectId === null) {
    return reply.code(400).send({ error: "linkLocation requires a target Project" });
  }
  const principal = (requester?.kind === "human" ? requester : null);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (typeof body.projectId === "string" && !db.canAccessProject(principal, body.projectId)) {
    return reply.code(404).send({ error: "project not found" });
  }
  if (body.linkLocation && typeof body.projectId === "string" &&
      !db.canManageProject(principal, body.projectId)) {
    return reply.code(403).send({ error: "Project management permission is required to link a Location" });
  }
  if (body.linkLocation) {
    const session = db.getSession(id);
    const reusedWorkspaceId = session ? db.resolveAdoptedSessionLinkWorkspace(id)?.workspaceId : null;
    if (reusedWorkspaceId && session &&
        !db.canAccessWorkspace(principal, session.runnerId, reusedWorkspaceId)) {
      return reply.code(404).send({ error: "workspace not found" });
    }
  }
  if (!canAssignSessionProject(db, principal, id, body.projectId as string | null)) {
    return reply.code(403).send({
      error: "Project management permission or personal session ownership is required",
    });
  }
  // Active only: linking a detached Location revives it under the same id, and that is an addition.
  const existingLocations = new Set(body.linkLocation && typeof body.projectId === "string"
    ? (db.getProject(body.projectId)?.locations ?? []).filter((location) => location.availability !== "runner_removed").map((location) => location.id) : []);
  const moved = svc.setProject(
    id,
    body.projectId as string | null,
    principal.userId,
    { linkLocation: body.linkLocation },
  );
  // A Location this move added is a Location added to the Project, as Add Location's are (#4117).
  const linkedLocationId = body.linkLocation && moved.ok ? moved.data?.projectLocationId : null;
  if (linkedLocationId && !existingLocations.has(linkedLocationId)) void campaignLocations.locationAdded(linkedLocationId, principal);
  return respond(reply, moved);
  }

  async function workspace(id: string, input: unknown, requester: AuthPrincipal | null, reply: OwnerManagementReply, recheck?: () => Promise<unknown>) {
    const body = (input ?? {}) as Partial<SetWorkspaceRequest>;
    const session = db.getSession(id);
    const principal = requester;
    const location = session && body.workspaceId
      ? db.findProjectLocation(session.runnerId, body.workspaceId)
      : null;
    if (location && (!principal || !db.canAccessProject(principal, location.projectId))) {
      return reply.code(404).send({ error: "project not found" });
  }
  return respond(reply, svc.setWorkspace(id, body.workspaceId ?? null));
  }

  async function rewind(id: string, input: unknown, requester: AuthPrincipal | null, reply: OwnerManagementReply, recheck?: () => Promise<unknown>) {
    const turn = Number((input as { turn?: number })?.turn);
    if (!Number.isInteger(turn) || turn < 1) return reply.code(400).send({ error: "turn must be a positive integer" });
    const session = db.getSession(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const reconciliationBlock = svc.podReconciliationMutationError(id);
    if (reconciliationBlock) return reply.code(409).send({ error: reconciliationBlock });
    if (!session.worktreePath) return reply.code(409).send({ error: "rewind requires a worktree session" });
    if (session.status === "running" || session.status === "starting") {
      return reply.code(409).send({ error: "a turn is running — stop or wait before rewinding" });
  }
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
  // Persisted checkpoint events can outlive a runner downgrade — a pre-v25 runner ignores the
  // unknown command and the caller would eat a 30s timeout instead of a clear failure.
  const unsupported = runnerCapabilityError(session.runnerId, "checkpointRewind", "checkpoint rewind");
  if (unsupported) return reply.code(409).send(failureBody(unsupported));
  const requestId = `rew_${randomUUID().slice(0, 8)}`;
  try {
    const res = await hub.requestFromRunner(
      session.runnerId,
      requestId,
      { type: "rewind_session", requestId, sessionId: id, turn, timeoutMs: 30_000 },
      30_000,
    );
    if (res.type !== "rewind_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!res.ok) return reply.code(409).send({ error: res.error ?? "rewind failed" });
    return { ok: true };
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
  }

  async function fork(id: string, input: unknown, requester: AuthPrincipal | null, reply: OwnerManagementReply, recheck?: () => Promise<unknown>) {  const sourceId = id;

  const reviewRefusal = svc.reviewSessionRefusal(sourceId, "cannot be forked");
  if (reviewRefusal) return reply.code(409).send({ error: reviewRefusal });
  const reconciliationBlock = svc.podReconciliationMutationError(sourceId);
  if (reconciliationBlock) return reply.code(409).send({ error: reconciliationBlock });
  const turn = Number((input as { turn?: number })?.turn);
  if (!Number.isInteger(turn) || turn < 1) return reply.code(400).send({ error: "turn must be a positive integer" });
  const forkingHuman = (requester?.kind === "human" ? requester : null);
  const source = db.getSession(sourceId);
  if (!source) return reply.code(404).send({ error: "session not found" });
  const sourceScope = db.sessionScope(sourceId);
  if (!sourceScope) return reply.code(409).send({ error: "source session ownership is unavailable" });
  const sourceAgent = db.getRunner(source.runnerId)?.agents.find((agent) => agent.id === source.agentId);
  const handoff = (input as { handoff?: { agentId: string; config: SessionConfig } })?.handoff;
  const destination = handoff ? db.getRunner(source.runnerId)?.agents.find((agent) => agent.id === handoff.agentId) : undefined;
  // Recovering a quarantined conversation is the one fork whose destination may be the same
  // provider: the invalid item is excluded by a new thread, not by a different vendor. Validate the
  // request against the session's own durable quarantine so the allowance cannot be borrowed by an
  // ordinary fork; the runner revalidates it again against its authoritative copy.
  const recovery = (input as { recovery?: boolean })?.recovery === true;
  const quarantine = source.historyQuarantine;
  if (recovery) {
    if (!quarantine) return reply.code(409).send({ error: "this session's provider conversation is not quarantined" });
    if (quarantine.recoveryTurn === undefined) {
      return reply.code(409).send({ error: "this quarantined conversation has no safe checkpoint to recover from" });
    }
    if (turn !== quarantine.recoveryTurn) {
      return reply.code(409).send({ error: "recovery must start from the quarantined session's recorded safe checkpoint" });
    }
    if ((quarantine.recovery === "handoff") !== !!handoff) {
      return reply.code(409).send({ error: `this quarantined conversation recovers by ${quarantine.recovery ?? "fork"}` });
    }
    const unsupported = runnerCapabilityError(source.runnerId, "providerHistoryQuarantine", "quarantine recovery");
    if (unsupported) return reply.code(409).send(failureBody(unsupported));
  } else if (quarantine) {
    return reply.code(409).send({ error: "this session's provider conversation is quarantined — use its recovery action" });
  }
  if (handoff) {
    if (!handoff.config || typeof handoff.config !== "object" || Array.isArray(handoff.config)) return reply.code(400).send({ error: "handoff config is required" });
    const error = handoffDestinationError(destination, source.driver, handoff.config, { allowSameProvider: recovery });
    if (error) return reply.code(409).send({ error });
    if (!db.getAgentLaunch(source.runnerId, handoff.agentId)) {
      return reply.code(409).send({ error: "The destination harness installation is unavailable or not selected." });
    }
    const unsupported = runnerCapabilityError(source.runnerId, "conversationHandoff", "checkpoint handoffs");
    if (unsupported) return reply.code(409).send(failureBody(unsupported));
  }
  const supportsFork = providerSupportsConversationFork(source.driver, sourceAgent?.capabilities);
  if (!supportsFork && !handoff) return reply.code(409).send({ error: "this provider session does not support conversation fork" });
  if (!source.worktreePath && !handoff) return reply.code(409).send({ error: "conversation fork requires a worktree session" });
  if (sessionBlocksConversationFork(source.status)) {
    return reply.code(409).send({ error: "the source session is busy — wait before forking" });
  }
  if (!hub.isRunnerOnline(source.runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const unsupported = runnerCapabilityError(source.runnerId, "conversationFork", "conversation forks");
  if (unsupported) return reply.code(409).send(failureBody(unsupported));
  const deferHistory = runnerSupportsProtocol(db.getRunner(source.runnerId)?.protocolVersion, "indexedHistory");
  const sourceExecutionWorkspacePath = db.getAdHocWorkspacePath(sourceId);
  const targetSessionId = `s_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const requestId = `fork_${randomUUID().slice(0, 8)}`;
  if (conversationBranchesInFlight.has(sourceId)) return reply.code(409).send({ error: "a conversation fork or handoff is already in progress" });
  conversationBranchesInFlight.add(sourceId);
  let forkCreatedOnRunner = false;
  try {
    const res = await hub.requestFromRunner(
      source.runnerId,
      requestId,
      {
        type: "fork_session",
        requestId,
        sourceSessionId: sourceId,
        targetSessionId,
        turn,
        title: `${source.title} (${recovery ? "recovered" : handoff ? "handoff" : "fork"})`.slice(0, 120),
        ...(handoff ? { handoff: {
          agentId: handoff.agentId,
          config: handoff.config,
          ...(destination?.installation?.selection === "selected"
            ? { expectedInstallationId: destination.installation.id } : {}),
        } } : {}),
        ...(recovery ? { recovery: true as const } : {}),
        ...(deferHistory ? { deferHistory: true } : {}),
      },
      65 * 60_000,
    );
    if (res.type !== "fork_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!res.ok || !res.snapshot) {
      // #3240: the fork's provider launch was refused at the account's lease; the client shows the
      // same state a refused session launch does. A malformed refusal falls back to the text.
      const providerHomeRefusal = res.providerHomeRefusal === undefined ? null
        : validProviderHomeLaunchRefusal(res.providerHomeRefusal);
      return reply.code(409).send({
        error: handoff && !source.worktreePath && res.error === "conversation fork requires a worktree session"
          ? "Update the runner to support handoffs from in-place sessions."
          : res.error ?? "conversation fork failed",
        ...(providerHomeRefusal ? { providerHomeRefusal } : {}),
      });
    }
    const snapshotIdError = providerForkSnapshotIdError(targetSessionId, res.snapshot.id);
    if (snapshotIdError) {
      forkCreatedOnRunner = true;
      throw new Error(snapshotIdError);
    }
    forkCreatedOnRunner = true;
    if (handoff && (!res.handoffDraft || typeof res.handoffDraft.text !== "string" || !Array.isArray(res.handoffDraft.images))) throw new Error("runner returned no valid handoff draft");
    const forkIdentityError = forkSnapshotIdentityError(
      { ...source, ...(destination ? { agentId: destination.id, driver: destination.driver! } : {}), executionWorkspacePath: sourceExecutionWorkspacePath },
      res.snapshot,
    );
    if (forkIdentityError) throw new Error(forkIdentityError);
    await recheck?.();
    const now = Date.now();
    const activeSourceLocation = source.projectLocationId
      ? db.projectLocation(source.projectLocationId)
      : null;
    const inheritedProject = forkProjectAssignment(source, activeSourceLocation, res.snapshot.workspaceId);
    const session = db.createSessionFromSnapshot(
      res.snapshot,
      source.runnerId,
      now,
      sourceScope,
      inheritedProject,
      { sourceSessionId: sourceId, sourceTurn: turn, ...(forkingHuman ? { launcherUserId: forkingHuman.userId } : {}) },
    );
    let highWater = 0;
    for (const event of deferHistory ? [] : (res.events ?? [])) {
      db.appendEvent(targetSessionId, event.payload, event.ts);
      highWater = event.seq;
    }
    db.setHydratedSeq(targetSessionId, highWater);
    hub.sessionChangedById(session.id);
    if (deferHistory) void svc.hydrateHistory(targetSessionId);
    return reply.code(201).send({
      ...db.getSession(targetSessionId),
      ...(handoff ? { handoffDraft: res.handoffDraft } : {}),
      // The source's unsent prompt travels to the client as a composer draft only.
      ...(res.retainedPrompt ? { retainedPrompt: res.retainedPrompt } : {}),
    });
  } catch (err) {
    const timedOut = isRunnerRequestTimeoutError(err);
    const cleanupTargetSessionId = providerForkCleanupTarget(targetSessionId, forkCreatedOnRunner, timedOut);
    if (cleanupTargetSessionId) {
      // A timeout or malformed reply does not prove the runner failed before creating the fork.
      // Retain this tombstone across absent reconnect snapshots so a later-created target cannot
      // be adopted as an unassigned session.
      db.addTombstone(cleanupTargetSessionId, source.runnerId, Date.now(), "retain");
      hub.sendToRunner(source.runnerId, { type: "delete_session", sessionId: cleanupTargetSessionId });
      if (db.getSession(cleanupTargetSessionId)) {
        db.deleteSession(cleanupTargetSessionId);
        hub.sessionRemoved(cleanupTargetSessionId);
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    if (timedOut) {
      return reply.code(409).send({
        error: "the fork timed out and was discarded — retry when the runner is responsive",
      });
    }
    return reply.code(502).send({ error: message });
  } finally {
    conversationBranchesInFlight.delete(sourceId);
  }
  }

  function remove(id: string, reply: OwnerManagementReply) {
    const child = db.getSideChat(id)?.childSessionId;
    const affected = [id, ...(child ? [child] : [])].map(sessionId => ({sessionId, shells: deps.shellRegistry.list(sessionId)}));
    const result = svc.delete(id);
    // A refused Delete must retain its terminal tabs. Accepted deletion purges the same parent
    // and side-chat sessions the shared lifecycle service removed, including offline tombstones.
    if (result.ok) for (const {sessionId, shells} of affected) {
      deps.shellRegistry.removeForSession(sessionId);
      for (const shell of shells) hub.shellExit(shell.sessionId, shell.shellId, null, shell.outputEndSeq);
    }
    return respond(reply, result);
  }
  return {project, workspace, rewind, fork, remove};
}
