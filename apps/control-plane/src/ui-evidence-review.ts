import {
  MAX_PROMPT_IMAGE_BYTES,
  PROMPT_IMAGE_MIME_TYPES,
  CODEX_APP_SERVER_IMAGE_MIME_TYPES,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type AgentCapabilities,
  type UiEvidenceReviewUnavailableCode,
  type WorkflowArtifactView,
  type WorkflowDecisionAuthority,
  type WorkflowDecisionResourceSnapshot,
} from "@wollipog/protocol";

/** Whether an Orchestrator assigned UI Evidence Approval can actually exercise it. Human is always
 * a safe owner, so every unknown, unsupported, or unverifiable input resolves to the human. */
export type UiEvidenceReviewEvaluation =
  | { effectiveOwner: "orchestrator" }
  | { effectiveOwner: "human"; fallback?: { code: UiEvidenceReviewUnavailableCode; reason: string } };

export type UiEvidenceItem = Extract<
  WorkflowDecisionResourceSnapshot,
  { category: "ui_evidence_approval" }
>["evidence"][number];

/** Harnesses whose MCP image tool-result path has been audited end to end. A runner's
 * `imageToolResults` attestation for any other harness is not trusted. */
const IMAGE_TOOL_RESULT_DRIVERS: ReadonlySet<string> = new Set(["claude-code", "codex-app-server"]);

export const MAX_UI_EVIDENCE_REVIEW_BYTES = MAX_PROMPT_IMAGE_BYTES;
/** A delivered image supports an approval only briefly; a later approval must look again. */
export const UI_EVIDENCE_REVIEW_RECEIPT_TTL_MS = 60 * 60 * 1000;

export interface UiEvidenceReviewClient {
  savedOwner: WorkflowDecisionAuthority;
  runnerProtocolVersion: number | undefined;
  driver: string | null | undefined;
  capabilities: AgentCapabilities | undefined;
  modelId: string | null | undefined;
}

function human(code: UiEvidenceReviewUnavailableCode, reason: string): UiEvidenceReviewEvaluation {
  return { effectiveOwner: "human", fallback: { code, reason } };
}

/** Campaign-scoped half: the reviewing harness, model, client, and runner. */
export function evaluateUiEvidenceReviewClient(client: UiEvidenceReviewClient): UiEvidenceReviewEvaluation {
  if (client.savedOwner !== "orchestrator") return { effectiveOwner: "human" };
  // v179 attests image tool results, and implies the v167 evidence reader.
  if (!runnerSupportsProtocol(client.runnerProtocolVersion, "orchestratorImageToolResults")) {
    return human("runner_unsupported", runnerCapabilityRequirement(
      client.runnerProtocolVersion,
      "orchestratorImageToolResults",
      "Orchestrator UI evidence review",
    ));
  }
  if (!client.driver || !IMAGE_TOOL_RESULT_DRIVERS.has(client.driver)) {
    return human(
      "harness_unsupported",
      `The ${client.driver ?? "unknown"} harness has no audited way to show evidence images to the Orchestrator.`,
    );
  }
  // Evidence reaches the model as an image in a tool result, so that is what the installation must
  // attest. Prompt-image transport (`supportsImages`) is a different path and decides nothing here.
  // Unlike prompt images, unknown is not permissive: delegated review must be positively supported.
  const capabilities = client.capabilities;
  if (capabilities?.imageToolResults !== true) {
    return human(
      "harness_unsupported",
      "This Orchestrator's agent installation does not attest that images returned by its tools reach the model.",
    );
  }
  // The default model stands in only when no model was selected. A selected model the catalog does
  // not know has advertised nothing, so it must not inherit the installation's attestation.
  const model = client.modelId
    ? capabilities.models.find((candidate) => candidate.id === client.modelId)
    : capabilities.models.find((candidate) => candidate.default && !candidate.hidden);
  if (!model) {
    return human(
      "model_unsupported",
      `The Orchestrator model ${JSON.stringify(client.modelId ?? "default")} is not in its installation's model catalog, so whether it accepts images is unknown.`,
    );
  }
  // A model that lists its input types must list images. One that lists none is covered by the
  // installation's attestation, as it is for prompt images; Claude Code's catalog never lists them.
  if (model.inputModalities && !model.inputModalities.includes("image")) {
    return human(
      "model_unsupported",
      `The Orchestrator model ${JSON.stringify(model.id)} does not accept image input.`,
    );
  }
  return { effectiveOwner: "orchestrator" };
}

/** Decision-scoped half: every required artifact must be an inspectable, digest-bound image that
 * the requesting child itself owns. One unsupported item routes the whole decision to the human. */
export function evaluateUiEvidenceItems(
  driver: string | null | undefined,
  childSessionId: string,
  evidence: readonly UiEvidenceItem[],
  artifactView: (artifactId: string) => WorkflowArtifactView | null,
): UiEvidenceReviewEvaluation {
  const imageTypes: readonly string[] = driver === "codex-app-server"
    ? CODEX_APP_SERVER_IMAGE_MIME_TYPES
    : PROMPT_IMAGE_MIME_TYPES;
  for (const item of evidence) {
    const label = JSON.stringify(item.evidenceId);
    const declared = item.mediaType?.toLowerCase();
    if (declared?.startsWith("video/")) {
      return human("media_video_unsupported", `Evidence ${label} is video, which no Orchestrator client can review yet.`);
    }
    if (!item.artifactId) {
      return human(
        "provider_untrusted",
        `Evidence ${label} is stored outside Wollipog Session artifacts, and no trusted evidence provider can deliver it.`,
      );
    }
    if (!declared || !imageTypes.includes(declared)) {
      return human("media_unsupported", `Evidence ${label} has an unknown or unsupported media type.`);
    }
    const artifact = artifactView(item.artifactId);
    if (!artifact || artifact.sessionId !== childSessionId) {
      return human("artifact_unavailable", `Evidence ${label} is not an artifact of the requesting Session.`);
    }
    if (artifact.kind !== "screenshot" || artifact.encoding !== "base64" ||
        artifact.mimeType.toLowerCase() !== declared || artifact.sha256 !== item.sha256 ||
        artifact.sizeBytes > MAX_UI_EVIDENCE_REVIEW_BYTES) {
      return human("artifact_mismatch", `Evidence ${label} does not match its artifact's type, size, or digest.`);
    }
  }
  return { effectiveOwner: "orchestrator" };
}
