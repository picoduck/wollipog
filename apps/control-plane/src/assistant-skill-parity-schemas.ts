const string = {type: "string"};
const boolean = {type: "boolean"};
const reviewedImport = {acceptUpdate: boolean, expectedDeploymentImpact: string};
const drift = {name: string, digest: string, variant: {enum: ["agent", "manual"]}, observedDigest: {type: ["string", "null"]}};
const orphan = {kind: {enum: ["deleted_skill", "kept_aside"]}, id: string, ...drift, observedFingerprint: string};

/** Discovery schemas describe the shared owner validators; they do not replace them. */
export function skillParityPayloadSchema(name: string): Record<string, unknown> {
  const shapes: Record<string, Record<string, unknown>> = {
    skill_group_create: {name: string},
    skill_group_assign: {scopeKind: {enum: ["instance", "runner"]}, runnerId: string,
      agentSelector: {oneOf: [
        {type: "object", properties: {kind: {const: "all"}}, required: ["kind"]},
        {type: "object", properties: {kind: {const: "driver"}, driver: string}, required: ["kind", "driver"]},
        {type: "object", properties: {kind: {const: "agent"}, agentId: string}, required: ["kind", "agentId"]}]},
      invocation: {enum: ["agent", "manual"]}, enabled: boolean},
    skill_group_assignment_edit: {enabled: boolean, invocation: {enum: ["agent", "manual"]}},
    skill_builtin_apply: {digest: string, expectedLatestVersionId: {type: ["string", "null"]}, accepted: {const: true}, expectedDeploymentImpact: string},
    skill_recommendation: {dismissed: boolean},
    skill_git_preview: {url: {...string, description: "Credential-free HTTPS/SSH Git URL or owner/repository."}, ref: string, subdirectory: string, commit: string},
    skill_git_import: {previewId: string, path: string, ...reviewedImport},
    skill_machine_preview: {candidateId: string},
    skill_adoption_preflight: {previewId: {...string, description: "The file preview ID, distinct from the top-level discovery ID."}},
    skill_machine_adopt: {previewId: string, adoptionToken: string, confirmation: {const: "explicit"}, acceptSharedImpact: boolean},
    skill_machine_import: {previewId: string, ...reviewedImport},
    skill_recovery_restore: {confirmation: {const: "explicit"}},
    skill_drift_preview: drift,
    skill_drift_restore: {...drift, confirmation: {const: "explicit"}},
    skill_drift_import: reviewedImport,
    skill_orphan_preview: orphan,
    skill_orphan_discard: {...orphan, confirmation: {const: "explicit"}},
    skill_orphan_import: reviewedImport,
  };
  return {type: "object", properties: shapes[name] ?? {}, additionalProperties: false};
}
