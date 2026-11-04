import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  PROVIDER_CREDENTIAL_IMPORT_CODES,
  PROVIDER_CREDENTIAL_IMPORT_DEFAULT_SOURCE_LABEL,
  runnerCapabilityRequirementError,
  runnerSupportsProtocol,
  runnerSupportsProviderCredentialImport,
  TERMINAL_STATUSES,
  type ProviderAccountDefinition,
  type ProviderCredentialImportSource,
  type ProviderProfileGrantView,
  type ResourceScope,
  type SessionStatus,
} from "@wollipog/protocol";
import { parseBoxLifecycleForce } from "./box-lifecycle.js";
import type { ControlPlaneDb, ProviderProfileGrantRecord } from "./db.js";
import { ProviderPublicationUnavailable, type PublicationObservation } from "./provider-profile-publication-store.js";
import { isRunnerRequestNotSentError, type Hub } from "./hub.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL_SESSION_STATUSES = new Set<SessionStatus>(TERMINAL_STATUSES);
const CAPABILITY_LABEL = "provider profiles";
const LEASE_CAPABILITY_LABEL = "provider HOME lease recovery";

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

/** #3241: a lease recovery is explicit and names the exact stale record the Owner or Admin saw. */
export function parseProviderHomeLeaseRecovery(body: unknown): { ok: true; staleTipHash: string } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "request body must be an object" };
  const { staleTipHash, acknowledgeLeaseRecovery } = body as { staleTipHash?: unknown; acknowledgeLeaseRecovery?: unknown };
  if (acknowledgeLeaseRecovery !== true) {
    return { ok: false, error: "acknowledgeLeaseRecovery must be true: the stale lease's runner and anything it started must no longer use this HOME" };
  }
  if (typeof staleTipHash !== "string" || !/^[a-f0-9]{64}$/u.test(staleTipHash)) return { ok: false, error: "staleTipHash must be the inspected lease record's hash" };
  return { ok: true, staleTipHash };
}

/** #3719: an import request. The confirmation must name the source (the account's label, or the
 * Machine's own sign-in) and the new profile's label exactly as the person confirmed them. */
export function parseProviderCredentialImport(body: unknown):
  | { ok: true; provider: "codex"; label: string; source: ProviderCredentialImportSource; sourceLabel: string }
  | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "request body must be an object" };
  const { provider, label, source, confirmation } = body as Record<string, unknown>;
  if (provider !== "codex") return { ok: false, error: "only a Codex sign-in can be imported" };
  if (typeof label !== "string" || !label.trim() || label.trim().length > 100 || /[\u0000-\u001f\u007f]/u.test(label)) {
    return { ok: false, error: "a 1 to 100 character label is required" };
  }
  let parsedSource: ProviderCredentialImportSource;
  if (typeof source === "object" && source !== null && !Array.isArray(source) &&
      (source as { kind?: unknown }).kind === "default_home" && Object.keys(source).length === 1) {
    parsedSource = { kind: "default_home" };
  } else if (typeof source === "object" && source !== null && !Array.isArray(source) &&
      (source as { kind?: unknown }).kind === "account" && Object.keys(source).length === 2 &&
      typeof (source as { accountId?: unknown }).accountId === "string" && ACCOUNT_ID.test((source as { accountId: string }).accountId)) {
    parsedSource = { kind: "account", accountId: (source as { accountId: string }).accountId };
  } else {
    return { ok: false, error: "source must be the Machine's own sign-in or a configured account" };
  }
  const confirmed = typeof confirmation === "object" && confirmation !== null && !Array.isArray(confirmation)
    ? confirmation as Record<string, unknown> : undefined;
  if (confirmed?.acknowledgeCredentialImport !== true || typeof confirmed.sourceLabel !== "string" ||
      typeof confirmed.destinationLabel !== "string" || confirmed.destinationLabel !== label.trim()) {
    return { ok: false, error: "confirmation must acknowledge the import and name its source and the new profile" };
  }
  return { ok: true, provider, label: label.trim(), source: parsedSource, sourceLabel: confirmed.sourceLabel };
}

const IMPORT_CODES = new Set<string>(PROVIDER_CREDENTIAL_IMPORT_CODES);
const IMPORT_CAPABILITY_LABEL = "provider sign-in import";

/** A runner's refusal sentence, passed on only when it is short plain text. */
function boundedRunnerText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 1000 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

export const PROVIDER_PROFILE_REVOKED_FOR_SESSION = "Access to this provider profile was revoked for this control plane.";

function scopeKey(scope: ResourceScope): string {
  const ownerId = scope.owner.kind === "organization" ? scope.owner.organizationId
    : scope.owner.kind === "user" ? scope.owner.userId : scope.owner.teamId;
  return `${scope.organizationId}\u0000${scope.owner.kind}\u0000${ownerId}`;
}

/**
 * Session creation's profile gate (#3239), for the provider account the new session will bind:
 * - a runner below v225 cannot honor a profile, so an account this control plane holds an active
 *   grant for is refused with the shared capability sentence instead of failing on the runner;
 * - an account whose reported profile this control plane's grant was revoked for, with no live
 *   grant left, is refused with a specific sentence instead of the runner's lease refusal.
 * Null when the session may start. Grants are read in the runner's scope only.
 */
export function providerProfileSessionRefusal(
  db: ControlPlaneDb,
  runner: { runnerId: string; protocolVersion?: number | null },
  account: Pick<ProviderAccountDefinition, "id" | "profile">,
): { capability: ReturnType<typeof runnerCapabilityRequirementError> } | { error: string } | null {
  const scope = db.runnerScope(runner.runnerId);
  const inScope = (grant: ProviderProfileGrantRecord) => !scope || scopeKey(grant.scope) === scopeKey(scope);
  const profileId = account.profile && PROFILE_ID.test(account.profile.id) ? account.profile.id : undefined;
  const live = db.liveProviderProfileGrantsForAccount(runner.runnerId, account.id, profileId).filter(inScope);
  if (!runnerSupportsProtocol(runner.protocolVersion, "providerProfiles")) {
    return live.some((grant) => grant.status === "active")
      ? { capability: runnerCapabilityRequirementError(runner.protocolVersion, "providerProfiles", CAPABILITY_LABEL) }
      : null;
  }
  if (live.length > 0 || !profileId) return null;
  const revoked = db.latestRevokedProviderProfileGrant(runner.runnerId, account.id, profileId);
  return revoked && inScope(revoked) ? { error: PROVIDER_PROFILE_REVOKED_FOR_SESSION } : null;
}

/** The account key of an Add Account grant until the runner names the new account. `:` is not
 * valid in an account id, so it can never match a reported account. */
function createdGrantPlaceholder(grantId: string): string {
  return `login:${grantId}`;
}

/**
 * Add Account's automatic grant (#3239): the control plane that creates an account on a v225
 * runner is granted its new managed profile. The pending row records the creating person and their
 * organization role (any role that can manage the Machine); its id goes to the runner in
 * `start_provider_login`, which writes it into the new HOME's marker. Undefined (the account keeps
 * today's HOME) for an older runner, a non-human caller, or a runner without a recorded scope.
 */
export function authorizeCreatedProviderProfileGrant(
  db: ControlPlaneDb,
  runner: { runnerId: string; protocolVersion?: number | null },
  principal: AuthPrincipal | null,
  provider: "claude" | "codex",
  now: number,
  requestId: string,
): string | undefined {
  if (!runnerSupportsProtocol(runner.protocolVersion, "providerProfiles") || principal?.kind !== "human") return undefined;
  const grantId = randomUUID();
  const authorized = db.authorizeAndEnrollProviderProfileDispatch({
    grantId, runnerId: runner.runnerId, providerAccountId: createdGrantPlaceholder(grantId), provider, origin: "created",
    grantedBy: principal.userId, grantedRole: principal.role, now, requestId, kind: "login",
  });
  return authorized?.grant.grantId;
}

/**
 * The start reply for an Add Account grant: a started sign-in names the new account, which the
 * pending grant is bound to so the account report completes it (`reconcileProviderProfileGrants`);
 * a refused start spends it. A lost reply leaves it pending and unbound: the account then reports
 * `pending` access until an Owner or Admin adopts it, which supersedes this grant in the marker.
 */
export function settleCreatedProviderProfileGrantStart(
  db: ControlPlaneDb,
  grantId: string,
  outcome: { started: true; accountId: unknown } | { started: false },
  principal: HumanPrincipal,
  now: number,
): void {
  if (outcome.started && typeof outcome.accountId === "string" && ACCOUNT_ID.test(outcome.accountId)) {
    try {
      if (db.bindCreatedProviderProfileGrant(grantId, createdGrantPlaceholder(grantId), outcome.accountId)) return;
    } catch (error) {
      if (error instanceof ProviderPublicationUnavailable) return;
      // A pending grant already exists for that account id; this one cannot be completed.
    }
  }
  db.revokeProviderProfileGrant({ grantId, revokedBy: principal.userId, revokedRole: principal.role, now });
}

const SETTLED_UNRECORDED_LOGIN = new Set(["failed", "cancelled", "timed_out"]);

/**
 * A new-account sign-in that settled without recording the account (failed, cancelled or timed
 * out) spends its Add Account grant; the runner already removed the unused HOME, or dropped the
 * grant from a HOME it kept. Returns the revoked grant ids.
 */
export function revokeUnrecordedCreatedProviderProfileGrants(
  db: ControlPlaneDb,
  runnerId: string,
  logins: ReadonlyArray<{ accountId: string; status: string; sessionId?: string }>,
  now: number,
): string[] {
  const revoked: string[] = [];
  for (const login of logins) {
    if (login.sessionId || !SETTLED_UNRECORDED_LOGIN.has(login.status) || !ACCOUNT_ID.test(login.accountId)) continue;
    for (const grant of db.liveProviderProfileGrantsForAccount(runnerId, login.accountId)) {
      if (grant.status !== "pending" || grant.origin !== "created" || grant.runnerId !== runnerId ||
          grant.providerAccountId !== login.accountId) continue;
      try {
        if (db.revokeProviderProfileGrant({ grantId: grant.grantId, revokedBy: grant.grantedBy, revokedRole: grant.grantedRole, now })) {
          revoked.push(grant.grantId);
        }
      } catch (error) {
        if (!(error instanceof ProviderPublicationUnavailable)) throw error;
        // Unexpected enclosing transaction: leave pending, retry on the next inventory frame.
      }
    }
  }
  return revoked;
}

/** A runner configures at most 32 provider accounts, so it reports at most 32 profile ids. */
const REPORTED_PROFILE_ID_LIMIT = 32;

/**
 * The `registered` list for a v225+ runner: the complete set of this control plane's grants, in
 * the runner's scope, for the profiles this runner reports (`reportedProfileIds` from its register
 * frame, and its accounts' profiles), plus the pending grants recorded for its accounts. The runner
 * removes every marker grant of this control plane that a present list omits, so this fails closed:
 * undefined (omit the field) when the runner's scope, accounts or reported profile ids are unknown,
 * or when the relevant grants exceed their bound. Never a partial list.
 */
export function providerProfileGrantsForRunner(
  db: ControlPlaneDb,
  runnerId: string,
  reportedProfileIds: unknown,
): ProviderProfileGrantView[] | undefined {
  const scope = db.runnerScope(runnerId);
  const accounts = db.getRunner(runnerId)?.providerAccounts;
  if (!scope || !accounts || !Array.isArray(reportedProfileIds) || reportedProfileIds.length > REPORTED_PROFILE_ID_LIMIT ||
      !reportedProfileIds.every((id) => typeof id === "string" && PROFILE_ID.test(id))) return undefined;
  const profileIds = [...reportedProfileIds as string[], ...accounts.flatMap((account) => account.profile ? [account.profile.id] : [])];
  const grants = db.providerProfileGrantsForRunnerProfiles(runnerId, scope, profileIds);
  return grants?.map((grant) => ({
    grantId: grant.grantId,
    status: grant.status === "active" ? "active" : "pending",
    ...(grant.profileId ? { profileId: grant.profileId } : {}),
  }));
}

/** The lost-reply path: a runner reports an account whose HOME records this control plane's grant
 * (`granted` or `pending`) while the account's authorization is still pending here. This is also
 * how an Add Account grant completes: the new account is reported with the profile it was created
 * as. An account reported without any profile spends its Add Account grant, since the runner did
 * not create one (a Windows host, say). A report with no live grant at all is
 * `ProviderProfileInventoryRevocations`'s concern. */
export function reconcileProviderProfileGrants(
  db: ControlPlaneDb,
  runnerId: string,
  accounts: readonly ProviderAccountDefinition[] | undefined,
  now: number,
): string[] {
  const completed: string[] = [];
  for (const account of accounts ?? []) {
    const profile = account.profile;
    if (!profile) {
      for (const grant of db.liveProviderProfileGrantsForAccount(runnerId, account.id)) {
        if (grant.status !== "pending" || grant.origin !== "created" || grant.runnerId !== runnerId || grant.providerAccountId !== account.id) continue;
        try {
          db.revokeProviderProfileGrant({ grantId: grant.grantId, revokedBy: grant.grantedBy, revokedRole: grant.grantedRole, now });
        } catch (error) {
          if (!(error instanceof ProviderPublicationUnavailable)) throw error;
        }
      }
      continue;
    }
    if (profile.access === "not_granted" || !PROFILE_ID.test(profile.id)) continue;
    for (const grant of db.liveProviderProfileGrantsForAccount(runnerId, account.id)) {
      if (grant.status !== "pending" || grant.runnerId !== runnerId || grant.providerAccountId !== account.id) continue;
      try {
        if (db.completeProviderProfileGrant(grant.grantId, profile.id, now)) completed.push(grant.grantId);
      } catch (error) {
        if (!(error instanceof ProviderPublicationUnavailable)) throw error;
        // No RPC, mutation or false completion. The existing next report retries reconciliation.
      }
    }
  }
  return completed;
}

/** How long one inventory-driven revocation notice suppresses an identical one. */
const INVENTORY_REVOCATION_RESEND_MS = 5 * 60_000;

/**
 * The inventory side of revocation (#3239): a runner reports an account whose HOME it may use
 * through this control plane (`granted` or `pending`), but no live grant here covers that runner
 * account or profile. The runner still holds a revoked grant, typically one revoked while its
 * adoption ran whose reply was lost, arrived after the request timeout, or failed without a code, so
 * it is told with `revoke_provider_profile_grant` and the most recent revoked grant id, without
 * waiting for a reconnect. Each (runner, account, grant) is told at most once per resend window, so
 * every account report does not repeat it.
 */
export class ProviderProfileInventoryRevocations {
  private readonly notified = new Map<string, number>();
  private readonly now: () => number;
  private readonly resendAfterMs: number;

  constructor(private readonly deps: {
    db: ControlPlaneDb;
    hub: Pick<Hub, "isRunnerOnline" | "requestFromRunner">;
    now?: () => number;
    resendAfterMs?: number;
  }) {
    this.now = deps.now ?? Date.now;
    this.resendAfterMs = deps.resendAfterMs ?? INVENTORY_REVOCATION_RESEND_MS;
  }

  /** Run after `reconcileProviderProfileGrants`, so a lost reply completes before this looks.
   * Resolves to the grant ids sent; it never rejects. */
  async reconcile(runnerId: string, accounts: readonly ProviderAccountDefinition[] | undefined): Promise<string[]> {
    const sent: string[] = [];
    try {
      const runner = this.deps.db.getRunner(runnerId);
      if (!runner || !this.deps.hub.isRunnerOnline(runnerId) || !runnerSupportsProtocol(runner.protocolVersion, "providerProfiles")) return sent;
      const now = this.now();
      for (const [key, at] of this.notified) if (now - at >= this.resendAfterMs) this.notified.delete(key);
      for (const account of accounts ?? []) {
        const profile = account.profile;
        if (!profile || profile.access === "not_granted" || !PROFILE_ID.test(profile.id)) continue;
        if (this.deps.db.liveProviderProfileGrantsForAccount(runnerId, account.id, profile.id).length > 0) continue;
        const revoked = this.deps.db.latestRevokedProviderProfileGrant(runnerId, account.id, profile.id);
        if (!revoked) continue;
        const key = `${runnerId}\u0000${account.id}\u0000${revoked.grantId}`;
        if (this.notified.has(key)) continue;
        this.notified.set(key, now);
        sent.push(revoked.grantId);
        await notifyRunnerOfRevocation(this.deps.hub, runnerId, profile.id, revoked.grantId);
      }
    } catch {
      // Advisory: the revoked row already holds, and the runner's next registration drops the grant.
    }
    return sent;
  }
}

/** Account removal revokes only this control plane's grants for the account's profile; the runner
 * keeps a HOME whose marker still grants another control plane. Recorded before the runner is
 * told, so a lost reply can never leave the grant usable. See also
 * `revokeProviderProfileAccessForAccountRemoval`, which also tells the runner. */
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

/**
 * The DELETE account route's profile step (#3239): revoke this control plane's grants for the
 * account, then tell the runner about each one with `revoke_provider_profile_grant` before
 * `remove_provider_account` is sent, so the grant stops on the runner even when the removal itself
 * is refused (an agent default, a running sign-in). A lost reply is harmless: the row is revoked,
 * and the runner also drops the grant while handling the removal.
 */
export async function revokeProviderProfileAccessForAccountRemoval(
  deps: { db: ControlPlaneDb; hub: Pick<Hub, "isRunnerOnline" | "requestFromRunner" | "runnerChanged"> },
  runnerId: string,
  account: Pick<ProviderAccountDefinition, "id" | "profile"> | undefined,
  principal: AuthPrincipal,
  now: number,
): Promise<ProviderProfileGrantRecord[]> {
  const revoked = revokeProviderProfileGrantsForAccountRemoval(deps.db, runnerId, account, principal, now);
  if (revoked.length === 0) return revoked;
  deps.hub.runnerChanged(runnerId);
  const runner = deps.db.getRunner(runnerId);
  if (!runner || !deps.hub.isRunnerOnline(runnerId) || !runnerSupportsProtocol(runner.protocolVersion, "providerProfiles")) return revoked;
  for (const grant of revoked) {
    // A pending grant has no profile id yet; the account's reported profile names the marker.
    const profileId = grant.profileId ?? account?.profile?.id;
    if (!profileId) continue;
    await notifyRunnerOfRevocation(deps.hub, runnerId, profileId, grant.grantId);
  }
  return revoked;
}

/** Send one `revoke_provider_profile_grant`; the result is advisory because the row already holds. */
async function notifyRunnerOfRevocation(
  hub: Pick<Hub, "requestFromRunner">,
  runnerId: string,
  profileId: string,
  grantId: string,
): Promise<{ notified: boolean; markerUpdated: boolean }> {
  const requestId = `provider_profile_revoke_${randomUUID()}`;
  try {
    const result = await hub.requestFromRunner(runnerId, requestId, { type: "revoke_provider_profile_grant", requestId, profileId, grantId });
    return result.type === "revoke_provider_profile_grant_result"
      ? { notified: true, markerUpdated: result.markerUpdated === true }
      : { notified: false, markerUpdated: false };
  } catch {
    // Revocation already holds; the runner drops the grant from the marker at registration.
    return { notified: false, markerUpdated: false };
  }
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
    const requestId = `provider_profile_adopt_${randomUUID()}`;
    let authorized;
    try {
      authorized = deps.db.authorizeAndEnrollProviderProfileDispatch({
        grantId: randomUUID(), runnerId: id, providerAccountId: accountId, provider: account.provider, origin: "adopted",
        grantedBy: principal.userId, grantedRole: principal.role, now: now(), requestId, kind: "adopt",
      });
    } catch (error) {
      if (!(error instanceof ProviderPublicationUnavailable)) throw error;
      return reply.code(503).send({ error: error.message, code: error.code });
    }
    if (!authorized) return reply.code(404).send({ error: "runner not found" });
    const { grantId } = authorized.grant;
    const observe = (observation: PublicationObservation) => {
      try { deps.db.observeProviderProfileDispatch(requestId, observation); }
      catch {
        // The original durable intent remains unresolved. Observations cannot cause redispatch.
        app.log.warn({ event: "provider_publication_observation_unavailable", entryPoint: "profile_adoption", requestId },
          "Provider publication observation could not be recorded.");
      }
    };
    let result;
    try {
      result = await deps.hub.requestFromRunner(id, requestId, { type: "adopt_provider_profile", requestId, accountId, grantId });
    } catch (error) {
      observe("uncertain");
      // The grant stays pending: the runner reports the profile it wrote, and that completes it.
      return reply.code(504).send({ error: (error as Error).message, status: "pending", grantId });
    }
    observe("reply");
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
      // Revoked (or otherwise no longer pending) while the runner wrote it. The runner already
      // recorded the grant and uses it, and a pending revocation could not name the profile, so
      // tell the runner now with the profile id it returned.
      await notifyRunnerOfRevocation(deps.hub, id, result.profileId, grantId);
      return reply.code(409).send({ error: "This profile grant was revoked before adoption completed.", code: "PROVIDER_PROFILE_GRANT_REVOKED" });
    }
    deps.hub.runnerChanged(id);
    return { status: "active", profileId: result.profileId, grantId };
  });

  /**
   * #3719: an Owner or Admin creates a managed profile from an existing sign-in on the same Machine,
   * after confirming the source and the new profile. The authorization and the new profile's
   * pending grant are recorded first; the runner resolves the source and copies only the
   * credential, and its account report completes the grant as for Add Account. No path or
   * credential value reaches the control plane.
   */
  app.post("/api/runners/:id/provider-imports", async (req, reply) => {
    const { id } = req.params as { id: string };
    const principal = deps.requestHuman(req);
    if (!canAuthorizeProviderProfileGrant(principal)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const runner = deps.db.getRunner(id);
    if (!runner || !deps.db.canAccessRunner(principal, id)) return reply.code(404).send({ error: "runner not found" });
    const parsed = parseProviderCredentialImport(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (!runnerSupportsProtocol(runner.protocolVersion, "providerCredentialImport")) {
      return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "providerCredentialImport", IMPORT_CAPABILITY_LABEL));
    }
    if (!runnerSupportsProviderCredentialImport(runner)) {
      return reply.code(409).send({ error: "This Machine can't copy an existing sign-in. Sign in to create the profile instead.", code: "UNSUPPORTED" });
    }
    if (!deps.hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is offline" });
    const { source } = parsed;
    if (source.kind === "account") {
      const account = runner.providerAccounts?.find((candidate) => candidate.id === source.accountId);
      if (!account) return reply.code(404).send({ error: "The provider account is not available on this Machine.", code: "SOURCE_NOT_FOUND" });
      if (account.provider !== parsed.provider) return reply.code(409).send({ error: "This account belongs to another provider.", code: "SOURCE_FOREIGN" });
      if (parsed.sourceLabel !== account.label) {
        return reply.code(409).send({ error: "The confirmation names a different source. Review the source and confirm again.", code: "CONFIRMATION_MISMATCH" });
      }
    } else if (parsed.sourceLabel !== PROVIDER_CREDENTIAL_IMPORT_DEFAULT_SOURCE_LABEL) {
      return reply.code(409).send({ error: "The confirmation names a different source. Review the source and confirm again.", code: "CONFIRMATION_MISMATCH" });
    }
    const requestId = `provider_credential_import_${randomUUID()}`;
    // The control plane names the new account, and the new profile's pending grant is bound to that
    // account from the start. However the reply goes (lost, or a publication whose outcome is
    // unknown), a later account report that names the account and its profile completes the grant,
    // as for an adopted account.
    const accountId = `import-${randomUUID().slice(0, 8)}`;
    let authorized;
    try {
      authorized = deps.db.authorizeAndEnrollProviderProfileDispatch({
        grantId: randomUUID(), runnerId: id, providerAccountId: accountId, provider: parsed.provider, origin: "created",
        grantedBy: principal.userId, grantedRole: principal.role, now: now(), requestId, kind: "login",
      });
    } catch (error) {
      if (!(error instanceof ProviderPublicationUnavailable)) throw error;
      return reply.code(503).send({ error: error.message, code: error.code });
    }
    if (!authorized) return reply.code(404).send({ error: "runner not found" });
    const { grantId } = authorized.grant;
    const importId = randomUUID();
    const audit = deps.db.authorizeProviderCredentialImport({ importId, runnerId: id, provider: parsed.provider, source, grantId,
      authorizedBy: principal.userId, authorizedRole: principal.role, now: now() });
    // Only an outcome that proves the account was not recorded spends the grant.
    const spendGrant = () => deps.db.revokeProviderProfileGrant({ grantId, revokedBy: principal.userId, revokedRole: principal.role, now: now() });
    if (!audit) {
      spendGrant();
      return reply.code(404).send({ error: "runner not found" });
    }
    const observe = (observation: PublicationObservation) => {
      try { deps.db.observeProviderProfileDispatch(requestId, observation); }
      catch {
        app.log.warn({ event: "provider_publication_observation_unavailable", entryPoint: "credential_import", requestId },
          "Provider publication observation could not be recorded.");
      }
    };
    let result;
    try {
      result = await deps.hub.requestFromRunner(id, requestId, {
        type: "import_provider_credential", requestId, runnerId: id, provider: parsed.provider, label: parsed.label, source,
        accountId, profileGrantId: grantId,
      });
    } catch (error) {
      const notSent = isRunnerRequestNotSentError(error);
      observe(notSent ? "not_sent" : "uncertain");
      if (notSent) {
        spendGrant();
        deps.db.settleProviderCredentialImport(importId, { status: "refused", code: "FAILED" }, now());
      } else {
        // A lost reply leaves the grant pending and bound to the named account; its report completes it.
        deps.db.settleProviderCredentialImport(importId, { status: "unknown", accountId }, now());
      }
      return reply.code(504).send({ error: (error as Error).message });
    }
    observe("reply");
    if (result.type !== "import_provider_credential_result") {
      deps.db.settleProviderCredentialImport(importId, { status: "unknown", accountId }, now());
      return reply.code(502).send({ error: "unexpected runner reply" });
    }
    if (!result.ok && result.code === "PUBLICATION_UNKNOWN") {
      // The runner copied the credential but cannot say whether its configuration recorded the
      // account (#3506). The grant stays pending and bound to the named account, so a report of
      // that account and its profile completes it. Never reported as a success.
      deps.db.settleProviderCredentialImport(importId, { status: "unknown", accountId }, now());
      return reply.code(409).send({
        error: boundedRunnerText(result.error) ?? "The sign-in was copied, but whether the account was recorded is unknown.",
        code: "PUBLICATION_UNKNOWN", status: "pending", grantId,
      });
    }
    if (!result.ok) {
      spendGrant();
      const code = typeof result.code === "string" && IMPORT_CODES.has(result.code) ? result.code : "FAILED";
      deps.db.settleProviderCredentialImport(importId, { status: "refused", code }, now());
      return reply.code(409).send({ error: boundedRunnerText(result.error) ?? "The sign-in could not be copied.", code });
    }
    if (result.accountId !== accountId || typeof result.profileId !== "string" || !PROFILE_ID.test(result.profileId)) {
      // A success naming another account or no profile cannot be trusted; its account report decides.
      deps.db.settleProviderCredentialImport(importId, { status: "unknown", accountId }, now());
      return reply.code(502).send({ error: "unexpected runner reply" });
    }
    deps.db.settleProviderCredentialImport(importId, { status: "imported", accountId, profileId: result.profileId }, now());
    deps.hub.runnerChanged(id);
    return reply.code(201).send({ accountId, profileId: result.profileId, grantId });
  });

  /** The online v229+ runner and configured account a lease route acts on, or the reply already sent. */
  function leaseTarget(id: string, accountId: string, runner: NonNullable<ReturnType<ControlPlaneDb["getRunner"]>>,
    reply: { code(status: number): { send(body: unknown): unknown } }) {
    if (!runnerSupportsProtocol(runner.protocolVersion, "providerHomeLeaseRecovery")) {
      return { error: reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "providerHomeLeaseRecovery", LEASE_CAPABILITY_LABEL)) };
    }
    if (!deps.hub.isRunnerOnline(id)) return { error: reply.code(409).send({ error: "runner is offline" }) };
    if (!runner.providerAccounts?.some((candidate) => candidate.id === accountId)) {
      return { error: reply.code(404).send({ error: "The provider account is not available on this Machine." }) };
    }
    return { ok: true as const };
  }

  /** #3241: the account HOME's lease state an Owner or Admin decides a recovery from. */
  app.get("/api/runners/:id/provider-accounts/:accountId/home-lease", async (req, reply) => {
    const checked = authorize(req, reply);
    if ("error" in checked) return checked.error;
    const { id, accountId, runner } = checked;
    const target = leaseTarget(id, accountId, runner, reply);
    if ("error" in target) return target.error;
    const requestId = `provider_home_lease_inspect_${randomUUID()}`;
    let result;
    try {
      result = await deps.hub.requestFromRunner(id, requestId, { type: "inspect_provider_home_lease", requestId, accountId });
    } catch (error) {
      return reply.code(504).send({ error: (error as Error).message });
    }
    if (result.type !== "inspect_provider_home_lease_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!result.ok) {
      return reply.code(409).send({ error: result.error ?? "The provider HOME's lease could not be read.", code: result.code ?? "PROVIDER_HOME_LEASE_INSPECTION_FAILED" });
    }
    if (!result.inspection) return reply.code(502).send({ error: "unexpected runner reply" });
    return result.inspection;
  });

  /**
   * #3241: an Owner or Admin authorizes recovering the exact stale lease record they inspected.
   * The authorization is recorded first and used once; the runner still requires the record to be
   * provably abandoned (its process evidence, or a host boot after it was written).
   */
  app.post("/api/runners/:id/provider-accounts/:accountId/recover-lease", async (req, reply) => {
    const checked = authorize(req, reply);
    if ("error" in checked) return checked.error;
    const { id, accountId, principal, runner } = checked;
    const parsed = parseProviderHomeLeaseRecovery(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const target = leaseTarget(id, accountId, runner, reply);
    if ("error" in target) return target.error;
    const authorization = deps.db.authorizeProviderHomeLeaseRecovery({
      authorizationId: randomUUID(), runnerId: id, providerAccountId: accountId, staleTipHash: parsed.staleTipHash,
      authorizedBy: principal.userId, authorizedRole: principal.role, now: now(),
    });
    if (!authorization) return reply.code(404).send({ error: "runner not found" });
    const { authorizationId } = authorization;
    const requestId = `provider_home_lease_recover_${randomUUID()}`;
    let result;
    try {
      result = await deps.hub.requestFromRunner(id, requestId, {
        type: "recover_provider_home_lease", requestId, accountId, staleTipHash: parsed.staleTipHash, authorizationId,
      });
    } catch (error) {
      // The runner may have recovered the lease; its journal records this authorization either way.
      deps.db.settleProviderHomeLeaseRecovery(authorizationId, "unknown", null, now());
      return reply.code(504).send({ error: (error as Error).message, status: "unknown", authorizationId });
    }
    if (result.type !== "recover_provider_home_lease_result") {
      deps.db.settleProviderHomeLeaseRecovery(authorizationId, "unknown", null, now());
      return reply.code(502).send({ error: "unexpected runner reply" });
    }
    if (!result.ok) {
      if (result.code) {
        deps.db.settleProviderHomeLeaseRecovery(authorizationId, "refused", result.code, now());
        return reply.code(409).send({ error: result.error ?? "The provider HOME's lease could not be recovered.", code: result.code });
      }
      deps.db.settleProviderHomeLeaseRecovery(authorizationId, "unknown", null, now());
      return reply.code(409).send({
        error: result.error ?? "The provider HOME's lease could not be recovered.", code: "PROVIDER_HOME_LEASE_RECOVERY_FAILED", status: "unknown", authorizationId,
      });
    }
    deps.db.settleProviderHomeLeaseRecovery(authorizationId, "recovered", null, now());
    deps.hub.runnerChanged(id);
    return { status: "recovered", authorizationId };
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
        // A pending grant names no profile yet; when the account already reports one (a lost
        // adoption reply), that is the marker to drop it from. Otherwise the adoption route tells
        // the runner if the adoption it is waiting for still succeeds.
        const grantProfileId = grant.profileId ?? profileId;
        if (!grantProfileId) continue;
        const notice = await notifyRunnerOfRevocation(deps.hub, runnerId, grantProfileId, grant.grantId);
        if (notice.notified && runnerId === id) runnerNotified = true;
        markerUpdated ||= notice.markerUpdated;
      }
    }
    return { revoked: true, grantIds: revoked.map((grant) => grant.grantId), markerUpdated, runnerNotified, forced: parsed.force };
  });
}
