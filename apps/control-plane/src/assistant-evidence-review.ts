import { createHash } from "node:crypto";
import {
  ASSISTANT_EVIDENCE_RETENTION_DISCLOSURE,
  runnerSupportsProtocol,
  type AssistantEvidenceReviewAvailability,
  type SessionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { evaluateUiEvidenceReviewClient } from "./ui-evidence-review.js";

/** This capability is server-derived. Saving a grant compares the digest the owner was shown
 * against the current backing session, and every evidence operation checks it again. */
export function assistantEvidenceReviewAvailability(
  db: ControlPlaneDb,
  session: SessionView,
): AssistantEvidenceReviewAvailability {
  const client = db.uiEvidenceReviewClient(session, "orchestrator");
  if (!runnerSupportsProtocol(client.runnerProtocolVersion, "assistantEvidenceReview")) {
    return { available: false, reason: "Update this Machine’s runner to enable Assistant UI evidence approval." };
  }
  const model = session.model && session.model !== "default" ? session.model
    : client.capabilities?.models.find((candidate) => candidate.default && !candidate.hidden && candidate.id !== "default")?.id;
  if (!model || evaluateUiEvidenceReviewClient({ ...client, modelId: model }).effectiveOwner !== "orchestrator") {
    return { available: false, reason: "This thread’s harness or model cannot receive verified evidence images." };
  }
  const provider = session.driver === "claude-code" ? "Claude Code" : "Codex App Server";
  const disclosureDigest = createHash("sha256").update(JSON.stringify([
    ASSISTANT_EVIDENCE_RETENTION_DISCLOSURE, session.id, session.runnerId, session.agentId,
    session.driver, model, session.providerAccountId ?? null,
  ])).digest("hex");
  return { available: true, provider, model, disclosureDigest };
}
