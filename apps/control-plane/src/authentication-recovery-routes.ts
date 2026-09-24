import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type ProviderAuthenticationAccountOptionsResponse,
  type ProviderAuthenticationCurrentIdentityResponse,
  type SelectProviderAuthenticationAccountResponse,
  type SessionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import {
  providerAuthenticationAccountOptions,
  providerForSessionAccountSwitch,
} from "./provider-account-switch.js";
import { SUBSCRIPTION_USAGE_STALE_AFTER_MS } from "./subscription-usage.js";

const PROVIDER_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTITY_TIMEOUT_MS = 30_000;
/** Covers the runner's status probe of the chosen account plus a settling provider turn. */
const SELECTION_TIMEOUT_MS = 60_000;

export interface AuthenticationRecoveryRouteDeps {
  db: Pick<ControlPlaneDb, "canAccessSession" | "getSession" | "getRunner" | "subscriptionUsageForPrincipal">;
  hub: Pick<Hub, "isRunnerOnline" | "requestFromRunner">;
  requestHuman(req: FastifyRequest): HumanPrincipal | null;
}

type RecoveryTarget =
  | { ok: true; session: SessionView; principal: HumanPrincipal }
  | { ok: false; code: number; error: string; reason?: "recovery_changed" };

/**
 * Routes behind an Authentication Required card's account context (#1649). Only a person who can
 * see the session reaches the runner; agent credentials never receive the provider-reported
 * identity. Every action names the exact card it was taken from, so a card replaced while open
 * fails closed instead of acting on a newer incident.
 */
export function registerAuthenticationRecoveryRoutes(
  app: FastifyInstance,
  deps: AuthenticationRecoveryRouteDeps,
): void {
  const { db, hub } = deps;

  const target = (req: FastifyRequest, requestId?: unknown): RecoveryTarget => {
    const id = (req.params as { id: string }).id;
    const principal = deps.requestHuman(req);
    if (!principal) return { ok: false, code: 403, error: "authentication recovery is available to people only" };
    if (!db.canAccessSession(principal, id)) return { ok: false, code: 404, error: "session not found" };
    const session = db.getSession(id);
    if (!session) return { ok: false, code: 404, error: "session not found" };
    const protocolVersion = db.getRunner(session.runnerId)?.protocolVersion;
    if (!runnerSupportsProtocol(protocolVersion, "providerAuthenticationAccountRecovery")) {
      return {
        ok: false,
        code: 409,
        error: runnerCapabilityRequirement(
          protocolVersion,
          "providerAuthenticationAccountRecovery",
          "Account identity and selection during authentication recovery",
        ),
      };
    }
    if (requestId !== undefined && (typeof requestId !== "string" || !requestId || requestId.length > 256 ||
        session.pendingApproval?.kind !== "authentication" || session.pendingApproval.requestId !== requestId)) {
      return {
        ok: false,
        code: 409,
        error: "This Authentication Required card is no longer current. Review the latest card.",
        reason: "recovery_changed",
      };
    }
    return { ok: true, session, principal };
  };

  const recoveryOptions = (session: SessionView, principal: HumanPrincipal) =>
    providerAuthenticationAccountOptions(
      session,
      db.getRunner(session.runnerId)?.providerAccounts ?? [],
      db.subscriptionUsageForPrincipal(principal, Date.now(), SUBSCRIPTION_USAGE_STALE_AFTER_MS).sources,
    );

  app.get("/api/sessions/:id/authentication/accounts", async (req, reply) => {
    const resolved = target(req);
    if (!resolved.ok) return reply.code(resolved.code).send({ error: resolved.error });
    const { session, principal } = resolved;
    const response: ProviderAuthenticationAccountOptionsResponse = {
      accounts: providerForSessionAccountSwitch(session.driver) ? recoveryOptions(session, principal) : [],
    };
    return response;
  });

  app.post("/api/sessions/:id/authentication/current-identity", async (req, reply) => {
    // The body carries a provider-reported email. Keep it out of every shared or browser cache.
    reply.header("cache-control", "private, no-store");
    const body = (req.body ?? {}) as { requestId?: unknown };
    const resolved = target(req, body.requestId ?? "");
    if (!resolved.ok) return reply.code(resolved.code).send({ error: resolved.error });
    const { session } = resolved;
    if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
    const requestId = `auth_identity_${randomUUID()}`;
    try {
      const result = await hub.requestFromRunner(session.runnerId, requestId, {
        type: "inspect_provider_authentication",
        requestId,
        sessionId: session.id,
        recoveryRequestId: body.requestId as string,
      }, IDENTITY_TIMEOUT_MS);
      if (result.type !== "inspect_provider_authentication_result") {
        return reply.code(502).send({ error: "unexpected runner reply" });
      }
      if (!result.ok || !result.identity) {
        return reply.code(409).send({ error: result.error ?? "the provider identity could not be checked" });
      }
      const identity = result.identity;
      const response: ProviderAuthenticationCurrentIdentityResponse = {
        identity: {
          status: identity.status,
          emailSupported: identity.emailSupported === true,
          email: identity.status === "authenticated" && typeof identity.email === "string" ? identity.email : null,
          observedAt: identity.observedAt,
        },
      };
      return response;
    } catch (error) {
      return reply.code(504).send({ error: (error as Error).message });
    }
  });

  app.post("/api/sessions/:id/authentication/account", async (req, reply) => {
    const body = (req.body ?? {}) as {
      requestId?: unknown;
      providerAccountId?: unknown;
      expectedProviderAccountId?: unknown;
    };
    const resolved = target(req, body.requestId ?? "");
    if (!resolved.ok) {
      return reply.code(resolved.code).send({
        error: resolved.error,
        ...(resolved.reason ? { code: resolved.reason } : {}),
      });
    }
    const { session, principal } = resolved;
    if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
    if (typeof body.providerAccountId !== "string" || !PROVIDER_ACCOUNT_ID.test(body.providerAccountId)) {
      return reply.code(400).send({ error: "providerAccountId is invalid" });
    }
    if (typeof body.expectedProviderAccountId !== "string" ||
        !PROVIDER_ACCOUNT_ID.test(body.expectedProviderAccountId)) {
      return reply.code(400).send({ error: "expectedProviderAccountId is invalid" });
    }
    if (session.providerAccountId !== body.expectedProviderAccountId) {
      return reply.code(409).send({
        error: "The session's configured account changed while this card was open. Review the updated card.",
        code: "account_changed",
      });
    }
    const option = recoveryOptions(session, principal).find((account) => account.id === body.providerAccountId);
    if (!option || option.availability === "current") {
      return reply.code(409).send({
        error: "That account is not a compatible alternative on this session's Machine.",
        code: "account_unavailable",
      });
    }
    const requestId = `auth_account_${randomUUID()}`;
    try {
      const result = await hub.requestFromRunner(session.runnerId, requestId, {
        type: "select_provider_authentication_account",
        requestId,
        sessionId: session.id,
        recoveryRequestId: body.requestId as string,
        providerAccountId: body.providerAccountId,
        expectedProviderAccountId: body.expectedProviderAccountId,
      }, SELECTION_TIMEOUT_MS);
      if (result.type !== "select_provider_authentication_account_result") {
        return reply.code(502).send({ error: "unexpected runner reply" });
      }
      if (!result.ok) {
        return reply.code(409).send({
          error: result.error ?? "the account could not be selected",
          ...(result.code ? { code: result.code } : {}),
        });
      }
      const response: SelectProviderAuthenticationAccountResponse = { accepted: true };
      return response;
    } catch (error) {
      return reply.code(504).send({ error: (error as Error).message });
    }
  });
}
