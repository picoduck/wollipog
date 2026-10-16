import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RemoteAccessSetup } from "@wollipog/protocol";
import { RemoteAccess } from "./remote-access.js";

export function registerRemoteAccessRoutes(app: FastifyInstance, remote: RemoteAccess, canConfigure: (req: FastifyRequest) => boolean): void {
  // The short-lived challenge discloses no credential or configuration. Only its creator knows
  // the independently generated expected response, so another CP cannot impersonate this one.
  app.get<{ Params: { challenge: string } }>("/remote-access-proof/:challenge", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const proof = remote.proof(req.params.challenge);
    return proof ?? reply.code(404).send({ error: "verification expired" });
  });
  app.get("/api/remote-access", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return remote.status(canConfigure(req));
  });
  app.post("/api/remote-access", async (req, reply) => {
    if (!canConfigure(req)) return reply.code(403).send({ error: "Set up remote access from an administrator's local dashboard on the computer running Wollipog." });
    const body = req.body as Partial<RemoteAccessSetup> | null;
    if (!body || (body.provider !== "tailscale" && body.provider !== "https") ||
        (body.provider === "https" && typeof body.origin !== "string") ||
        Object.keys(body).some((key) => key !== "provider" && key !== "origin")) {
      return reply.code(400).send({ error: "Choose Tailscale or supply an HTTPS address." });
    }
    try { return await remote.setup(body as RemoteAccessSetup); }
    catch { return reply.code(409).send({ error: "Remote access setup is already running. Wait for it to finish and retry." }); }
  });
  app.post("/api/remote-access/cancel", async (req, reply) => {
    if (!canConfigure(req)) return reply.code(403).send({ error: "Cancel setup from an administrator's local dashboard." });
    try { return await remote.cancel(); }
    catch { return reply.code(409).send({ error: "Another remote access operation is finishing. Retry cancellation." }); }
  });
  app.delete("/api/remote-access", async (req, reply) => {
    if (!canConfigure(req)) return reply.code(403).send({ error: "Remote access can only be changed from an administrator's local dashboard." });
    try { return await remote.disable(); }
    catch { return reply.code(409).send({ error: "Remote access setup is already running. Wait for it to finish and retry." }); }
  });
}
