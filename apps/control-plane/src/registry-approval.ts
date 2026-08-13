import type { AgentDefinition, AcpRegistryApprovalAction } from "@wollipog/protocol";

export interface RegistryApprovalInput {
  action?: unknown;
  schemaVersion?: unknown;
  adapterVersion?: unknown;
  confirmation?: unknown;
}

export type RegistryApprovalValidation =
  | { ok: true; action: AcpRegistryApprovalAction; schemaVersion: string; adapterVersion: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** Validate the user's confirmation against the exact Registry row currently advertised by the
 * runner. The runner independently repeats these checks before changing its local approval file. */
export function validateRegistryApproval(
  agents: AgentDefinition[],
  agentId: string,
  body: RegistryApprovalInput,
): RegistryApprovalValidation {
  if (body?.action !== "approve" && body?.action !== "revoke") {
    return { ok: false, status: 400, error: "action must be approve or revoke" };
  }
  if (body.confirmation !== "explicit") return { ok: false, status: 400, error: "explicit confirmation is required" };
  if (typeof body.schemaVersion !== "string" || typeof body.adapterVersion !== "string") {
    return { ok: false, status: 400, error: "schemaVersion and adapterVersion are required" };
  }
  const agent = agents.find((item) => item.id === agentId);
  if (!agent?.registry) return { ok: false, status: 404, error: "Registry agent not found on this runner" };
  if (agent.registry.schemaVersion !== body.schemaVersion || agent.registry.adapterVersion !== body.adapterVersion) {
    return { ok: false, status: 409, error: "Registry metadata changed; refresh and confirm again" };
  }
  const expectedStatus = body.action === "approve" ? "approval-required" : "approved";
  if (agent.registry.installStatus !== expectedStatus) {
    return {
      ok: false,
      status: 409,
      error: body.action === "approve"
        ? "this Registry distribution cannot be automatically approved"
        : "this Registry launch is not currently approved",
    };
  }
  return {
    ok: true,
    action: body.action,
    schemaVersion: body.schemaVersion,
    adapterVersion: body.adapterVersion,
  };
}
