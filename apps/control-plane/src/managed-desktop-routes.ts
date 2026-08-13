import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  EXIT_RISK_REQUEST_DOMAIN,
  EXIT_RISK_RESPONSE_DOMAIN,
  PROVISION_REQUEST_DOMAIN,
  PROVISION_RESPONSE_DOMAIN,
  managedDesktopMac,
  verifyManagedDesktopRequest,
  type ManagedDesktopIdentity,
} from "./managed-desktop-auth.js";

export const MANAGED_LAUNCH_ID_HEADER = "x-wollipog-launch-id";
export const MANAGED_CHALLENGE_HEADER = "x-wollipog-challenge";
export const MANAGED_REQUEST_MAC_HEADER = "x-wollipog-request-mac";
export const MANAGED_RESPONSE_MAC_HEADER = "x-wollipog-response-mac";
export const MANAGED_EXIT_RISK_PATH = "/internal/desktop/exit-risk";
export const MANAGED_PROVISION_PATH = "/internal/desktop/runner-credential";

interface ManagedSessionProjection {
  runnerId: string;
  status: string;
  pendingApproval: unknown;
}

export function managedDesktopSessionsForRunner<T extends ManagedSessionProjection>(
  listSessions: (options: { includeArchived: true }) => readonly T[],
  runnerId: string,
): ManagedSessionProjection[] {
  return listSessions({ includeArchived: true })
    .filter((session) => session.runnerId === runnerId)
    .map((session) => ({
      runnerId: session.runnerId,
      status: session.status,
      pendingApproval: session.pendingApproval === null ? null : true,
    }));
}

function runnerIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "runnerId") return null;
  const runnerId = (body as { runnerId?: unknown }).runnerId;
  if (typeof runnerId !== "string" || runnerId.length < 1 || runnerId.length > 128 ||
      runnerId.trim() !== runnerId || /[\u0000-\u0020\u007f/\\?#%]/u.test(runnerId)) return null;
  return runnerId;
}

function authorize(
  req: FastifyRequest,
  identity: ManagedDesktopIdentity,
  domain: string,
  trustedLoopback: (req: FastifyRequest) => boolean,
): { runnerId: string; challenge: Buffer } | null {
  // These routes authenticate with launch proof only. Accepting Bearer alongside it would make an
  // accidental owner-token regression invisible.
  if (req.headers.authorization || !trustedLoopback(req)) return null;
  const runnerId = runnerIdFromBody(req.body);
  if (!runnerId) return null;
  const proof = verifyManagedDesktopRequest({
    identity,
    domain,
    launchId: req.headers[MANAGED_LAUNCH_ID_HEADER],
    challenge: req.headers[MANAGED_CHALLENGE_HEADER],
    mac: req.headers[MANAGED_REQUEST_MAC_HEADER],
    runnerId,
  });
  return proof ? { runnerId, challenge: proof.challenge } : null;
}

function signedJson(
  reply: FastifyReply,
  identity: ManagedDesktopIdentity,
  domain: string,
  challenge: Buffer,
  value: unknown,
) {
  const body = JSON.stringify(value);
  return reply
    .header("cache-control", "private, no-store")
    .header(MANAGED_RESPONSE_MAC_HEADER, managedDesktopMac(identity, domain, challenge, body))
    .type("application/json; charset=utf-8")
    .send(body);
}

export function registerManagedDesktopRoutes(
  app: FastifyInstance,
  identity: ManagedDesktopIdentity | null,
  deps: {
    trustedLoopback(req: FastifyRequest): boolean;
    sessionsForRunner(runnerId: string): ManagedSessionProjection[];
    provisionRunner(runnerId: string): unknown;
  },
): void {
  // A dev/external control plane has no inherited secret and must expose no identity surface.
  if (!identity) return;

  app.post(MANAGED_EXIT_RISK_PATH, async (req, reply) => {
    const authorized = authorize(req, identity, EXIT_RISK_REQUEST_DOMAIN, deps.trustedLoopback);
    if (!authorized) return reply.code(401).send({ error: "managed desktop launch proof required" });
    return signedJson(
      reply,
      identity,
      EXIT_RISK_RESPONSE_DOMAIN,
      authorized.challenge,
      { sessions: deps.sessionsForRunner(authorized.runnerId) },
    );
  });

  app.post(MANAGED_PROVISION_PATH, async (req, reply) => {
    const authorized = authorize(req, identity, PROVISION_REQUEST_DOMAIN, deps.trustedLoopback);
    if (!authorized) return reply.code(401).send({ error: "managed desktop launch proof required" });
    try {
      return signedJson(
        reply,
        identity,
        PROVISION_RESPONSE_DOMAIN,
        authorized.challenge,
        deps.provisionRunner(authorized.runnerId),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/another (?:organization|owner)|reserved by another owner/u.test(message)) {
        return signedJson(
          reply.code(404),
          identity,
          PROVISION_RESPONSE_DOMAIN,
          authorized.challenge,
          { error: "runner not found" },
        );
      }
      throw error;
    }
  });
}
