import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  runnerCapabilityRequirementError,
  runnerSupportsProtocol,
  TERMINAL_STATUSES,
  type ProviderAccountDefinition,
  type ProviderProfileGrantView,
  type SessionStatus,
} from "@wollipog/protocol";
import { parseBoxLifecycleForce } from "./box-lifecycle.js";
import type { ControlPlaneDb, ProviderProfileGrantRecord } from "./db.js";
import type { Hub } from "./hub.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL_SESSION_STATUSES = new Set<SessionStatus>(TERMINAL_STATUSES);
const CAPABILITY_LABEL = "provider profiles";

/** Only an organization Owner or Admin may grant or revoke a control plane's profile access. */
export function canAuthorizeProviderProfileGrant(
  principal: Pick<HumanPrincipal, "role"> | null,
): principal is Pick<HumanPrincipal, "role"> & { role: "owner" | "admin" } {
  return principal?.role === "owner" || principal?.role === "admin";
}

/** Adoption is explicit: the request must acknowledge that only granted control planes may use the
 * HOME afterwards. */
export function parseProviderProfileAdoption(body: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "request body must be an object" };
  if ((body as { acknowledgeProfileAdoption?: unknown }).acknowledgeProfileAdoption !== true) {
    return { ok: false, error: "acknowledgeProfileAdoption must be true: after adoption only control planes granted this profile can use its HOME" };
  }
  return { ok: true };
}

/** The `registered` list for a v225+ runner: this control plane's complete live grants in the
 * runner's scope. Undefined (omit the field) when the runner has no recorded scope, because an
 * empty list would tell the runner that every grant was revoked. */
export function providerProfileGrantsForRunner(db: ControlPlaneDb, runnerId: string): ProviderProfileGrantView[] | undefined {
  const scope = db.runnerScope(runnerId);
  if (!scope) return undefined;
  return db.activeProviderProfileGrants(scope).map((grant) => ({
    grantId: grant.grantId,
    status: grant.status === "active" ? "active" : "pending",
    ...(grant.profileId ? { profileId: grant.profileId } : {}),
  }));
}

/** The lost-reply path: a runner reports an account whose HOME records this control plane's grant
 * (`granted` or `pending`) while the account's authorization is still pending here. */
export function reconcileProviderProfileGrants(
  db: ControlPlaneDb,
  runnerId: string,
  accounts: readonly ProviderAccountDefinition[] | undefined,
  now: number,
): string[] {
  const completed: string[] = [];
  for (const account of accounts ?? []) {
    const profile = account.profile;
    if (!profile || profile.access === "not_granted" || !PROFILE_ID.test(profile.id)) continue;
    for (const grant of db.liveProviderProfileGrantsForAccount(runnerId, account.id)) {
      if (grant.status !== "pending" || grant.runnerId !== runnerId || grant.providerAccountId !== account.id) continue;
      if (db.completeProviderProfileGrant(grant.grantId, profile.id, now)) completed.push(grant.grantId);
    }
  }
  return completed;
}

/** Account removal revokes only this control plane's grants for the account's profile; the runner
 * keeps a HOME whose marker still grants another control plane. Recorded before the runner is
 * told, so a lost reply can never leave the grant usable. */
export function revokeProviderProfileGrantsForAccountRemoval(
  db: ControlPlaneDb,
  runnerId: string,
  account: Pick<ProviderAccountDefinition, "id" | "profile"> | undefined,
  principal: AuthPrincipal,
  now: number,
): ProviderProfileGrantRecord[] {
  if (!account) return [];
  return revokeLiveGrants(db, db.liveProviderProfileGrantsForAccount(runnerId, account.id, account.profile?.id), principal, now);
}

function revokeLiveGrants(db: ControlPlaneDb, grants: readonly ProviderProfileGrantRecord[], principal: AuthPrincipal, now: number): ProviderProfileGrantRecord[] {
  const revokedBy = principal.kind === "human" ? principal.userId : principal.actorId;
  const revokedRole = principal.kind === "human" ? principal.role : null;
  return grants.flatMap((grant) => {
    const revoked = db.revokeProviderProfileGrant({ grantId: grant.grantId, revokedBy, revokedRole, now });
    return revoked ? [revoked] : [];
  });
}

export function registerProviderProfileRoutes(
  app: FastifyInstance,
  deps: {
    db: ControlPlaneDb;
    hub: Pick<Hub, "isRunnerOnline" | "requestFromRunner" | "runnerChanged">;
    requestHuman(req: FastifyRequest): HumanPrincipal | null;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;

  /** Shared preconditions, in the order of the legacy-data adoption route. */
  function authorize(req: FastifyRequest, reply: { code(status: number): { send(body: unknown): unknown } }) {
    const { id, accountId } = req.params as { id: string; accountId: string };
    if (!ACCOUNT_ID.test(accountId)) return { error: reply.code(400).send({ error: "accountId is invalid" }) };
    const principal = deps.requestHuman(req);
    if (!canAuthorizeProviderProfileGrant(principal)) {
      return { error: reply.code(403).send({ error: "organization owner or admin permission is required" }) };
    }
    const runner = deps.db.getRunner(id);
    if (!runner || !deps.db.canAccessRunner(principal, id)) return { error: reply.code(404).send({ error: "runner not found" }) };
    return { id, accountId, principal, runner };
  }

  app.post("/api/runners/:id/provider-accounts/:accountId/adopt-profile", async (req, reply) => {
    const checked = authorize(req, reply);
    if ("error" in checked) return checked.error;
    const { id, accountId, principal, runner } = checked;
    const adoption = parseProviderProfileAdoption(req.body);
    if (!adoption.ok) return reply.code(400).send({ error: adoption.error });
    if (!runnerSupportsProtocol(runner.protocolVersion, "providerProfiles")) {
      return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "providerProfiles", CAPABILITY_LABEL));
    }
    if (!deps.hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is offline" });
    const account = runner.providerAccounts?.find((candidate) => candidate.id === accountId);
    if (!account) return reply.code(404).send({ error: "The provider account is not available on this Machine." });
    const live = deps.db.liveProviderProfileGrantsForAccount(id, accountId, account.profile?.id);
    const active = account.profile && account.profile.access !== "not_granted"
      ? live.find((grant) => grant.status === "active" && grant.profileId === account.profile!.id)
      : undefined;
    if (active) return { status: "active", profileId: active.profileId, grantId: active.grantId };
    const authorized = deps.db.authorizeProviderProfileGrant({
      grantId: randomUUID(), runnerId: id, providerAccountId: accountId, provider: account.provider, origin: "adopted",
      grantedBy: principal.userId, grantedRole: principal.role, now: now(),
    });
    if (!authorized) return reply.code(404).send({ error: "runner not found" });
    const { grantId } = authorized.grant;
    const requestId = `provider_profile_adopt_${randomUUID()}`;
    let result;
    try {
      result = await deps.hub.requestFromRunner(id, requestId, { type: "adopt_provider_profile", requestId, accountId, grantId });
    } catch (error) {
      // The grant stays pending: the runner reports the profile it wrote, and that completes it.
      return reply.code(504).send({ error: (error as Error).message, status: "pending", grantId });
    }
    if (result.type !== "adopt_provider_profile_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!result.ok) {
      // A coded refusal happened before the marker changed, so this authorization is spent.
      if (result.code) {
        deps.db.revokeProviderProfileGrant({ grantId, revokedBy: principal.userId, revokedRole: principal.role, now: now() });
      }
      return reply.code(409).send({
        error: result.error ?? "The provider profile could not be adopted.",
        code: result.code ?? "PROVIDER_PROFILE_ADOPTION_FAILED",
        ...(result.code ? {} : { status: "pending", grantId }),
      });
    }
    if (typeof result.profileId !== "string" || !PROFILE_ID.test(result.profileId)) {
      return reply.code(502).send({ error: "unexpected runner reply" });
    }
    if (!deps.db.completeProviderProfileGrant(grantId, result.profileId, now())) {
      // Revoked while the runner wrote it; the runner drops it from the marker at registration.
      return reply.code(409).send({ error: "This profile grant was revoked before adoption completed.", code: "PROVIDER_PROFILE_GRANT_REVOKED" });
    }
    deps.hub.runnerChanged(id);
    return { status: "active", profileId: result.profileId, grantId };
  });

  app.post("/api/runners/:id/provider-accounts/:accountId/revoke-profile-access", async (req, reply) => {
    const checked = authorize(req, reply);
    if ("error" in checked) return checked.error;
    const { id, accountId, principal, runner } = checked;
    const parsed = parseBoxLifecycleForce(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (!runnerSupportsProtocol(runner.protocolVersion, "providerProfiles")) {
      return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "providerProfiles", CAPABILITY_LABEL));
    }
    const account = runner.providerAccounts?.find((candidate) => candidate.id === accountId);
    if (!account) return reply.code(404).send({ error: "The provider account is not available on this Machine." });
    const profileId = account.profile?.id;
    const live = deps.db.liveProviderProfileGrantsForAccount(id, accountId, profileId);
    if (live.length === 0) return reply.code(404).send({ error: "This provider account has no profile access to revoke." });
    // Every runner account that uses the same profile loses access, so their sessions count too.
    const users = new Set<string>([`${id}\u0000${accountId}`]);
    if (profileId) {
      for (const candidate of deps.db.listRunners()) {
        for (const other of candidate.providerAccounts ?? []) {
          if (other.profile?.id === profileId) users.add(`${candidate.runnerId}\u0000${other.id}`);
        }
      }
    }
    const activeSessions = deps.db.listSessions({ includeArchived: true })
      .filter((session) => session.providerAccountId !== undefined && users.has(`${session.runnerId}\u0000${session.providerAccountId}`) &&
        !TERMINAL_SESSION_STATUSES.has(session.status))
      .map(({ id: sessionId, title, status }) => ({ id: sessionId, title, status }));
    if (activeSessions.length > 0 && !parsed.force) {
      const noun = activeSessions.length === 1 ? "session" : "sessions";
      return reply.code(409).send({
        error: `this provider profile has ${activeSessions.length} active ${noun}; revoking access would stop them from restarting. Let them settle or retry with force=true`,
        code: "PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS",
        activeSessions: activeSessions.filter((session) => deps.db.canAccessSession(principal, session.id)).slice(0, 20),
        activeSessionCount: activeSessions.length,
      });
    }
    // The authoritative row is revoked before any runner is told.
    const revoked = revokeLiveGrants(deps.db, live, principal, now());
    deps.hub.runnerChanged(id);
    let markerUpdated = false;
    let runnerNotified = false;
    const runnerIds = new Set([...users].map((key) => key.split("\u0000")[0]!));
    for (const runnerId of runnerIds) {
      const target = runnerId === id ? runner : deps.db.getRunner(runnerId);
      if (!target || !deps.hub.isRunnerOnline(runnerId) || !runnerSupportsProtocol(target.protocolVersion, "providerProfiles")) continue;
      for (const grant of revoked) {
        if (!grant.profileId) continue;
        const requestId = `provider_profile_revoke_${randomUUID()}`;
        try {
          const result = await deps.hub.requestFromRunner(runnerId, requestId, {
            type: "revoke_provider_profile_grant", requestId, profileId: grant.profileId, grantId: grant.grantId,
          });
          if (result.type === "revoke_provider_profile_grant_result") {
            if (runnerId === id) runnerNotified = true;
            markerUpdated ||= result.markerUpdated === true;
          }
        } catch {
          // Revocation already holds; the runner drops the grant from the marker at registration.
        }
      }
    }
    return { revoked: true, grantIds: revoked.map((grant) => grant.grantId), markerUpdated, runnerNotified, forced: parsed.force };
  });
}
