import { providerAccountSelectionPreviewForAgent, type ResourceScope } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService } from "./sessions.js";
import type { AuthPrincipal } from "./identity.js";
import type { OwnerManagementResult } from "./owner-management.js";
import { resolveSessionCreationOwnership } from "./session-creation-route.js";

export function readProviderAccountSelection(db: ControlPlaneDb, svc: SessionsService, principal: AuthPrincipal | null,
  id: string, query: {agentId?: string; provider?: string; projectId?: string; workspaceId?: string; noProject?: string; model?: string}): OwnerManagementResult {
  let status = 200;
  const reply = {code(value: number) {status = value; return reply;}, send(body: unknown) {return {status, body};}};
  if (!principal || !db.canAccessRunner(principal, id)) return reply.code(404).send({ error: "runner not found" });
  if (Object.values(query).some(value => value !== undefined && typeof value !== "string")) return reply.code(400).send({error: "Selection query fields must be strings"});
  if (query.provider !== undefined && query.provider !== "claude" && query.provider !== "codex") {
    return reply.code(400).send({ error: "provider must be Claude or Codex" });
  }
  if (!query.agentId && !query.provider) return reply.code(400).send({ error: "agentId or provider is required" });
  if (query.workspaceId && !db.canAccessWorkspace(principal, id, query.workspaceId)) {
    return reply.code(404).send({ error: "workspace not found" });
  }
  // The project this caller's own launch would have. An agent's child follows its parent, as a human's
  // session follows its choice or, when it names none, the workspace's Location.
  const parentSessionId = principal.kind === "agent" ? principal.credentialSessionId : undefined;
  let project: { projectId?: string | null; scope?: ResourceScope } = {};
  if (principal.kind === "human") {
    const named = query.noProject ? { projectId: null } : query.projectId ? { projectId: query.projectId } : {};
    const ownership = query.workspaceId || "projectId" in named
      ? resolveSessionCreationOwnership(db, principal, { runnerId: id, workspaceId: query.workspaceId ?? "", agentId: query.agentId ?? "", ...named })
      : null;
    if (ownership && !ownership.ok) return reply.code(ownership.status).send({ error: ownership.error });
    if (ownership?.ok) {
      project = { ...(ownership.body.projectId !== undefined ? { projectId: ownership.body.projectId } : {}),
        ...(ownership.scope ? { scope: ownership.scope } : {}) };
    }
  }
  const preview = svc.providerAccountSelectionPreview(id, {
    ...(query.agentId ? { agentId: query.agentId } : {}),
    ...(query.provider ? { provider: query.provider as "claude" | "codex" } : {}),
    ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...project,
  });
  if (!preview.ok) return reply.code(preview.status).send({error: preview.error});
  return {status: 200, body: principal.kind === "agent" && preview.data ? providerAccountSelectionPreviewForAgent(preview.data) : preview.data};
}
