import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import type { SessionsService } from "./sessions.js";
import { scopeView } from "./campaign-issue-scope.js";

export function registerCampaignIssueScopeRoutes(app: FastifyInstance, deps: {
  db: ControlPlaneDb; svc: SessionsService; requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
}): void {
  const { db, svc, requestPrincipal } = deps;
  const respond = (reply: { code(n:number): {send(value:unknown):unknown} }, result: {ok:boolean;status:number;data?:unknown;error?:string}) =>
    reply.code(result.status).send(result.ok ? result.data : {error:result.error});
app.get("/api/sessions/:id/campaign/issue-scope", async (req, reply) => {
  const { id } = req.params as { id: string };
  const principal = requestPrincipal(req);
  if (!principal || !db.canAccessSession(principal, id)) return reply.code(404).send({ error: "session not found" });
  const rootId = db.campaignRootForMember(id);
  if (!rootId || !db.canAccessSession(principal, rootId) || principal.kind === "agent" &&
      (!principal.orchestrator || db.resolvedCampaignSessionId(principal.credentialSessionId ?? "") !== rootId)) return reply.code(403).send({ error: "campaign scope requires access to its Orchestrator" });
  const root = db.getSession(rootId)!;
  if (principal.kind !== "agent" && !db.canAccessRunner(principal, root.runnerId)) {
    return reply.send(scopeView(db, root, root.orchestratorPolicy?.issueScope?.repository ?? ""));
  }
  const epicRaw = (req.query as { epic?: string }).epic;
  const epic = epicRaw === undefined ? undefined : /^[1-9][0-9]*$/u.test(epicRaw) ? Number(epicRaw) : Number.NaN;
  const result = await svc.campaignIssueScope(id, epic, (sessionId) => db.canAccessSession(principal, sessionId));
  if (result.ok && result.data) result.data.canPropose = principal.kind !== "agent" && principal.role !== "viewer" && db.isSessionOwner(principal, rootId);
  return respond(reply, result);
});

app.post("/api/sessions/:id/campaign/issue-scope/proposals", async (req, reply) => {
  const { id } = req.params as { id: string };
  const principal = requestPrincipal(req);
  if (!principal || !db.canAccessSession(principal, id)) return reply.code(404).send({ error: "session not found" });
  if (principal.kind === "agent" ? principal.credentialSessionId !== id || !principal.orchestrator : principal.role === "viewer" || !db.isSessionOwner(principal, id) || !db.canAccessRunner(principal, db.getSession(id)!.runnerId)) {
    return reply.code(403).send({ error: "only the campaign owner or its root Orchestrator may propose a scope change" });
  }
  return respond(reply, await svc.proposeCampaignIssueScope(id, req.body as import("@wollipog/protocol").CampaignIssueScopeRequest,
    (sessionId) => db.canAccessSession(principal, sessionId)));
});


}
