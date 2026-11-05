import {
  LOCATION_SWITCH_GUIDANCE, LOCATION_SWITCH_LIMITS, LOCATION_SWITCH_TRIGGERS, isTerminal, locationSwitchOptionId, locationSwitchRole,
  normalizeLocationSwitchRepository, parseLocationSwitchOption, runnerSupportsProtocol, sameLocationSwitchRepository, sessionRole,
  type CreateSessionRequest, type LocationSwitchAction, type LocationSwitchCandidate, type LocationSwitchPlace, type LocationSwitchRequest,
  type LocationSwitchResult, type LocationSwitchSnapshot, type LocationSwitchUnavailable, type ProjectLocationInspection,
  type ProjectLocationView, type SessionView, type WorkflowDecisionView, PROJECT_LOCATION_INSPECTION_FAILURES,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AgentPrincipal, HumanPrincipal } from "./identity.js";
import { LOCATION_SWITCH_MAX_LOCATIONS } from "./location-switch-snapshot.js";
import { auditDigest, type ServiceResult, type SessionsService } from "./sessions.js";

/** A pending card is answered within a day; an approval is executed within the hour. */
export const LOCATION_SWITCH_PROPOSAL_TTL_MS = 24 * 60 * 60_000;
export const LOCATION_SWITCH_APPROVAL_TTL_MS = 60 * 60_000;

/** The verified identity of one Project Location, or its fixed non-sensitive failure (#4117's
 * shared inspection: the Location is inspected by id, in its own resolved path). */
export type LocationInspection = ProjectLocationInspection | { ok: false; locationId: string; failure: "no_access"; reason: string };
export type LocationInspector = (locationId: string, options: { projectId: string }) => Promise<ProjectLocationInspection>;
/** Creates a session as the approving person, through the ordinary creation route's ownership rules. */
export type HandoffSessionCreator = (human: HumanPrincipal, request: CreateSessionRequest) => ServiceResult<SessionView>;

const fail = <T>(error: string, status = 409): ServiceResult<T> => ({ ok: false, status, error });
const ok = <T>(data: T, status = 200): ServiceResult<T> => ({ ok: true, status, data });
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const navigationPath = (sessionId: string) => `/sessions/~${Buffer.from(sessionId, "utf16le").toString("base64url")}`;
/** U+2028 and U+2029 end a line for some readers although JSON leaves them unescaped. */
const LINE_SEPARATOR_CHARACTERS = String.fromCharCode(0x2028, 0x2029);
const LINE_SEPARATORS = new RegExp(`[${LINE_SEPARATOR_CHARACTERS}]`, "gu");
const hasLineSeparator = (value: string) => [...LINE_SEPARATOR_CHARACTERS].some((separator) => value.includes(separator));

export const LOCATION_SWITCH_ACTION_LABELS: Record<LocationSwitchAction, string> = {
  switch: "Switch and Continue",
  new_session: "Start a New Session",
};

/** What the new session is told. The handoff is the requester's own words, shown to the person on
 * the card before they approved it; the frame around it is Wollipog's. */
export function locationSwitchHandoffPrompt(source: SessionView, snapshot: LocationSwitchSnapshot, target: LocationSwitchCandidate): string {
  // Only Wollipog's own facts sit inside the frame; names that people or agents chose are quoted as
  // single-line literals, and the requester's text follows the end marker.
  const literal = (value: string) => JSON.stringify(value).replace(LINE_SEPARATORS, (separator) => `\\u${separator.charCodeAt(0).toString(16)}`);
  return [
    `[Wollipog Location Handoff — from session ${source.id}]`,
    `This task was handed off from session ${literal(source.title || source.id)}` +
      (snapshot.current.repository ? `, which ran in repository ${snapshot.current.repository}` : "") +
      `, because it belongs to repository ${target.repository}. Its person approved continuing it here, in Location ` +
      `${literal(target.name)} on ${literal(target.machineName)}.`,
    "Everything below this frame was written by the requesting session; its person read it before approving.",
    "[End Wollipog Location Handoff]",
    "",
    `Why it belongs here: ${snapshot.reason}`,
    "",
    snapshot.handoff,
  ].join("\n");
}

/** A regular session recovers from a repository mismatch (#4138): it proposes, its owner chooses a
 * verified Location, and only this service consumes that exact choice. Orchestrators and children
 * never get a card: each is refused with its role's guidance. */
export class LocationSwitchService {
  /** Occurrences executing in this process. The durable claim below fences other attempts. */
  private readonly executing = new Set<string>();

  constructor(
    private db: ControlPlaneDb,
    private sessions: SessionsService,
    private hub: Hub,
    private deps: { inspect: LocationInspector; createSession: HandoffSessionCreator },
  ) {}

  private requester(principal: AgentPrincipal, sessionId: string): ServiceResult<SessionView> {
    if (principal.credentialSessionId !== sessionId || !this.db.canAccessSession(principal, sessionId)) return fail("session not found", 404);
    const session = this.db.getSession(sessionId);
    if (!session || session.archived || isTerminal(session.status)) return fail("A live session is required to switch Locations");
    if (!runnerSupportsProtocol(this.db.getRunner(session.runnerId)?.protocolVersion, "sessionLocationSwitch")) {
      return fail("Update this session's machine before requesting a Location switch");
    }
    const role = locationSwitchRole({ role: sessionRole(session), parentSessionId: session.parentSessionId });
    if (role !== "offer") return fail(LOCATION_SWITCH_GUIDANCE[role], 403);
    return ok(session);
  }

  private place(location: ProjectLocationView, repository?: string): LocationSwitchPlace {
    const runner = this.db.getRunner(location.runnerId);
    return {
      locationId: location.id, name: location.name, runnerId: location.runnerId,
      machineName: runner?.displayName?.trim() || runner?.hostname || location.runnerId,
      workspaceId: location.workspaceId, path: location.path, ...(repository ? { repository } : {}),
    };
  }

  /** Inspect every Location of the session's Project and keep the verified ones of `repository`.
   * Everything the card shows, and the digest that binds it, comes from here. */
  private async prepare(session: SessionView, principal: AgentPrincipal | HumanPrincipal, repository: string): Promise<ServiceResult<Pick<
    LocationSwitchSnapshot, "projectId" | "projectName" | "current" | "candidates" | "unavailable" | "options" | "targetDigest">>> {
    const project = session.projectId ? this.db.getProject(session.projectId) : null;
    if (!project || !this.db.canAccessProject(principal, project.id)) {
      return fail(`This session is not in a Project, so it has no other Locations to continue in. Start a session in a Location of ${repository} instead.`);
    }
    const locations = project.locations.filter((location) => location.availability !== "runner_removed");
    const inspected = locations.slice(0, LOCATION_SWITCH_MAX_LOCATIONS);
    const inspections = new Map((await Promise.all(inspected.map(async (location) => {
      const accessible = this.db.canAccessRunner(principal, location.runnerId) &&
        this.db.canAccessWorkspace(principal, location.runnerId, location.workspaceId);
      const result: LocationInspection = accessible
        ? await this.deps.inspect(location.id, { projectId: project.id }).catch((): LocationInspection =>
          ({ ok: false, locationId: location.id, failure: "read_failed", reason: PROJECT_LOCATION_INSPECTION_FAILURES.read_failed }))
        : { ok: false, locationId: location.id, failure: "no_access", reason: "You don't have access to this Location's folder." };
      return [location.id, result] as const;
    }))));
    const currentLocation = locations.find((location) => location.id === session.projectLocationId);
    const currentInspection = currentLocation ? inspections.get(currentLocation.id) : undefined;
    const currentRepository = currentInspection?.ok ? currentInspection.location.repository : undefined;
    const runner = this.db.getRunner(session.runnerId);
    const current: LocationSwitchPlace = currentLocation ? this.place(currentLocation, currentRepository) : {
      locationId: null, name: session.workspaceName ?? session.workspaceId ?? "", runnerId: session.runnerId,
      machineName: runner?.displayName?.trim() || runner?.hostname || session.runnerId, workspaceId: session.workspaceId ?? "",
      path: this.db.getWorkspacePath(session.runnerId, session.workspaceId ?? "") ?? "",
    };
    if (sameLocationSwitchRepository(currentRepository, repository)) {
      return fail(`This session is already in a Location of ${currentRepository}; no switch is needed.`);
    }
    const candidates: LocationSwitchCandidate[] = [];
    const unavailable: LocationSwitchUnavailable[] = [];
    for (const location of locations) {
      if (location.id === currentLocation?.id) continue;
      const inspection = inspections.get(location.id);
      if (!inspection) {
        unavailable.push({ ...this.unavailablePlace(location), reason: "The Project has too many Locations to check them all." });
      } else if (!inspection.ok) {
        unavailable.push({ ...this.unavailablePlace(location), reason: inspection.reason });
      } else if (sameLocationSwitchRepository(inspection.location.repository, repository) &&
          inspection.location.runnerId === location.runnerId && inspection.location.workspaceId === location.workspaceId) {
        const target = this.db.getRunner(location.runnerId);
        const agent = target?.agents.find((candidate) => candidate.id === session.agentId && candidate.available);
        const actions: LocationSwitchAction[] = agent ? ["new_session"] : [];
        candidates.push({
          ...this.place(location, inspection.location.repository), locationId: location.id, repository: inspection.location.repository,
          sameRunner: location.runnerId === session.runnerId, actions,
          ...(agent ? {} : { unavailableReason: `${session.agentName ?? "This session's agent"} isn't available on that machine.` }),
        });
      }
    }
    if (!candidates.some((candidate) => candidate.actions.length > 0)) {
      const reasons = [
        ...candidates.map((candidate) => `${candidate.name} on ${candidate.machineName}: ${candidate.unavailableReason}`),
        ...unavailable.map((item) => `${item.name} on ${item.machineName}: ${item.reason}`),
      ];
      return fail(reasons.length === 0
        ? `No Location in Project "${project.name}" belongs to ${repository}. Add a Location of that repository to the Project, or start a session there, then ask again.`
        : `No Location of ${repository} in Project "${project.name}" can continue this task. ${reasons.join(" ")}`);
    }
    const options = candidates.flatMap((candidate) => candidate.actions.map((action) => ({
      optionId: locationSwitchOptionId(action, candidate.locationId),
      label: LOCATION_SWITCH_ACTION_LABELS[action],
      description: `${candidate.name} on ${candidate.machineName}`,
    })));
    // Identity, not content: the Locations and the repositories they verified as. The runner's own
    // inspection digest also covers the checkout's HEAD, which may move between request and approval.
    const targetDigest = auditDigest({
      session: { id: session.id, runnerId: session.runnerId, workspaceId: session.workspaceId, projectLocationId: session.projectLocationId,
        agentId: session.agentId, model: session.model, effort: session.effort, permissionMode: session.permissionMode },
      current,
      candidates,
    })!;
    return ok({ projectId: project.id, projectName: project.name, current, candidates, unavailable, options, targetDigest });
  }

  private unavailablePlace(location: ProjectLocationView): Omit<LocationSwitchUnavailable, "reason"> {
    const place = this.place(location);
    return { locationId: location.id, name: place.name, machineName: place.machineName };
  }

  async request(sessionId: string, input: LocationSwitchRequest, principal: AgentPrincipal, now = Date.now()): Promise<ServiceResult<WorkflowDecisionView>> {
    const requester = this.requester(principal, sessionId);
    if (!requester.ok) return fail(requester.error!, requester.status);
    const session = requester.data!;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => !["requestId", "repository", "reason", "handoff", "trigger"].includes(key))) {
      return fail("A Location switch request names only requestId, repository, reason, handoff and trigger", 400);
    }
    const repository = normalizeLocationSwitchRepository(input.repository);
    if (!bounded(input.requestId, LOCATION_SWITCH_LIMITS.requestId) || !repository ||
        !bounded(input.reason, LOCATION_SWITCH_LIMITS.reason) || /[\r\n]/u.test(input.reason) || hasLineSeparator(input.reason) ||
        !bounded(input.handoff, LOCATION_SWITCH_LIMITS.handoff) ||
        (input.trigger !== undefined && !LOCATION_SWITCH_TRIGGERS.includes(input.trigger))) {
      return fail(`requestId, a repository such as owner/name, a one-line reason of at most ${LOCATION_SWITCH_LIMITS.reason} characters ` +
        `and a task handoff of at most ${LOCATION_SWITCH_LIMITS.handoff} characters are required`, 400);
    }
    // The handoff reaches a new session under Wollipog's frame, so it may not imitate one.
    if (/^\s*\[(End )?Wollipog\b/imu.test(input.handoff) || /^\s*\[(End )?Wollipog\b/iu.test(input.reason)) {
      return fail("The reason and handoff may not contain lines that look like Wollipog's own framing", 400);
    }
    const trigger = input.trigger ?? "early";
    const resourceKey = `location_switch:${repository.toLowerCase()}`;
    const existing = this.db.workflowDecisionByRequestId(sessionId, input.requestId);
    const trusted = { trustedLocationSwitch: true };
    if (existing) {
      const s = existing.resourceSnapshot;
      if (s.category !== "location_switch" || existing.resourceKey !== resourceKey || s.reason !== input.reason ||
          s.handoff !== input.handoff || s.trigger !== trigger) return fail("requestId was already used for a different Location switch request");
      return this.sessions.createWorkflowDecision(sessionId, { requestId: input.requestId, resourceKey, resourceSnapshot: s },
        (id) => this.db.canAccessSession(principal, id), trusted);
    }
    const prepared = await this.prepare(session, principal, repository);
    if (!prepared.ok) return fail(prepared.error!, prepared.status);
    // The inspections ran on other machines; the session may have ended or changed role meanwhile.
    const still = this.requester(principal, sessionId);
    if (!still.ok) return fail(still.error!, still.status);
    const snapshot: LocationSwitchSnapshot = { category: "location_switch", repository, reason: input.reason, handoff: input.handoff,
      trigger, ...prepared.data!, expiresAt: now + LOCATION_SWITCH_PROPOSAL_TTL_MS };
    return this.sessions.createWorkflowDecision(sessionId, { requestId: input.requestId, resourceKey, resourceSnapshot: snapshot },
      (id) => this.db.canAccessSession(principal, id), trusted);
  }

  get(sessionId: string, occurrenceId: string, principal: AgentPrincipal): ServiceResult<WorkflowDecisionView> {
    if (principal.credentialSessionId !== sessionId || !this.db.canAccessSession(principal, sessionId)) return fail("session not found", 404);
    const decision = this.db.workflowDecisionByOccurrence(occurrenceId);
    return decision?.sessionId === sessionId && decision.category === "location_switch" ? ok(decision) : fail("Location switch request not found", 404);
  }

  /** Revalidate everything the approval named, then continue the task exactly where the person chose. */
  async execute(sessionId: string, occurrenceId: string, digest: string, principal: AgentPrincipal, now = Date.now()): Promise<ServiceResult<WorkflowDecisionView>> {
    const read = this.get(sessionId, occurrenceId, principal);
    if (!read.ok) return read;
    const decision = read.data!;
    if (decision.resourceDigest !== digest) return fail("Location switch digest does not match");
    if (decision.status === "consumed" && decision.locationSwitchResult) return ok(decision);
    const snapshot = decision.resourceSnapshot;
    if (snapshot.category !== "location_switch" || decision.status !== "approved" || decision.authority !== "human" ||
        !decision.resolvedAt || now >= snapshot.expiresAt || now >= decision.resolvedAt + LOCATION_SWITCH_APPROVAL_TTL_MS) {
      return fail("This Location switch needs a current approval from the session's owner");
    }
    const chosen = parseLocationSwitchOption(decision.selectedOptionId);
    const target = chosen && snapshot.candidates.find((candidate) => candidate.locationId === chosen.locationId);
    if (!chosen || !target || !target.actions.includes(chosen.action)) return fail("The approval does not name an offered Location");
    if (chosen.action !== "new_session") return fail("This control plane cannot switch a live session yet; ask again and start a new session instead");
    const requester = this.requester(principal, sessionId);
    if (!requester.ok) return fail(requester.error!, requester.status);
    const session = requester.data!;
    const scope = this.db.sessionScope(sessionId);
    const approver = this.db.locationSwitchApprover(occurrenceId);
    const human = scope && approver ? this.db.operatingHumanPrincipal(approver, scope.organizationId) : null;
    if (!human || !this.db.isSessionOwner(human, sessionId)) return fail("The approver no longer owns this session or can no longer start sessions");
    if (this.executing.has(occurrenceId)) return fail("This Location switch is already being carried out");
    this.executing.add(occurrenceId);
    try {
      // Project membership alone grants nothing: the approver's own access, the Location's identity
      // and the repository it verifies as are all read again now.
      const prepared = await this.prepare(session, human, snapshot.repository);
      if (!prepared.ok) return fail(prepared.error!, prepared.status);
      if (prepared.data!.targetDigest !== snapshot.targetDigest) {
        return fail("The Project's Locations, their repositories or this session's settings changed; ask again for a fresh approval");
      }
      const result = this.startHandoffSession(occurrenceId, digest, session, snapshot, target, human, now);
      if (!result.ok) return fail(result.error!, result.status);
      this.hub.sessionChangedById(sessionId);
      return ok(this.db.workflowDecisionByOccurrence(occurrenceId)!, 201);
    } finally {
      this.executing.delete(occurrenceId);
    }
  }

  private startHandoffSession(occurrenceId: string, digest: string, session: SessionView, snapshot: LocationSwitchSnapshot,
    target: LocationSwitchCandidate, human: HumanPrincipal, now: number): ServiceResult<LocationSwitchResult> {
    // The claim is durable before anything starts, so neither a retry nor a crash between creation
    // and consumption can start a second session for one approval.
    if (!this.db.claimLocationSwitch(occurrenceId, digest, now)) {
      return fail("A previous attempt to carry out this approval may already have started a session; check Sessions before asking again");
    }
    const created = this.deps.createSession(human, {
      runnerId: target.runnerId, workspaceId: target.workspaceId, projectId: snapshot.projectId, projectLocationId: target.locationId,
      agentId: session.agentId!, useWorktree: true, prompt: locationSwitchHandoffPrompt(session, snapshot, target),
      ...(session.title ? { title: session.title } : {}),
      config: {
        ...(session.model ? { model: session.model } : {}), ...(session.effort ? { effort: session.effort } : {}),
        ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
      },
    });
    if (!created.ok || !created.data) {
      this.db.releaseLocationSwitchClaim(occurrenceId);
      return fail(`The new session could not start: ${created.error ?? "unknown error"}`, created.status);
    }
    const result: LocationSwitchResult = { action: "new_session", locationId: target.locationId, sessionId: created.data.id,
      navigationPath: navigationPath(created.data.id), completedAt: now };
    if (!this.db.completeLocationSwitch(occurrenceId, digest, result, now)) {
      throw new Error(`Location switch ${occurrenceId} started session ${created.data.id} but its receipt could not be recorded`);
    }
    return ok(result);
  }
}
