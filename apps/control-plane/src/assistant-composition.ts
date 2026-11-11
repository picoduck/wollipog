import { createAssistantOperations } from "./assistant-routes.js";
import { registerAssistantWorkOperations } from "./assistant-work-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { AssistantDiscordIngress } from "./assistant-discord-ingress.js";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService } from "./sessions.js";

/** Shared by the actual control-plane entrypoint and integration tests. A session operation
 * cannot accidentally land in the default composition without the authenticated-origin seam. */
export function createAssistantManagement(db: ControlPlaneDb, svc: SessionsService) {
  const operations = createAssistantOperations(db);
  registerAssistantWorkOperations(db, operations);
  const ingress = new AssistantDiscordIngress(db, operations);
  const receipts = registerAssistantSessionOperations(operations, db, svc, {
    authenticatedOrigin: receipt => ingress.authenticatedOrigin(receipt),
  });
  return {operations, ingress, receipts};
}
