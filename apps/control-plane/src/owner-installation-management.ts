import type { ControlPlaneDb } from "./db.js";
import { PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { AssistantRefusal } from "./assistant-connections.js";
import type { OwnerManagementResult } from "./owner-management.js";

/** Display metadata only: never alters connection grants, credentials or installation identity. */
export function renameAssistantInstallation(db: ControlPlaneDb, owner: HumanPrincipal, name: unknown): OwnerManagementResult {
  if (owner.role !== "owner" || owner.organizationId !== PERSONAL_ORGANIZATION_ID) return {status: 403,
    body: {error: "Only an owner of the installation's personal organization can rename this control plane."}};
  try {
    db.assistantConnections.renameInstallation(name);
    return {status: 200, body: {id: db.instanceId(), name: db.assistantConnections.installationName()}};
  } catch (error) {
    if (error instanceof AssistantRefusal) return {status: 400, body: {error: error.message}};
    throw error;
  }
}
