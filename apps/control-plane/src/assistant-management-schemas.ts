/** Transport descriptions only. The shared owner application validators remain authoritative. */
const text = {type: "string"};
const boolean = {type: "boolean"};
const positive = {type: "number", exclusiveMinimum: 0};
const object = (properties: Record<string, unknown>, required: string[] = []) => ({type: "object", properties, required});
const files = {type: "array", minItems: 1, items: object({path: text, content: text, encoding: {enum: ["utf8", "base64"]}}, ["path", "content", "encoding"])};
const nullableText = {type: ["string", "null"]};
const selector = {oneOf: [object({kind: {const: "all"}}, ["kind"]),
  object({kind: {const: "driver"}, driver: text}, ["kind", "driver"]),
  object({kind: {const: "agent"}, agentId: text}, ["kind", "agentId"])]};
const invocation = {enum: ["agent", "manual"]};

export function skillPayloadSchema(name: string): Record<string, unknown> {
  switch (name) {
    case "skill_create": return object({name: text, description: nullableText, groupId: nullableText, files, note: text}, ["name", "files"]);
    case "skill_update": return object({description: nullableText, groupId: nullableText});
    case "skill_version_add": return object({files, note: text}, ["files"]);
    case "skill_restore": return object({versionId: text, expectedLatestVersionId: text, expectedDeploymentImpact: text}, ["versionId", "expectedLatestVersionId"]);
    case "skill_assign": return object({scopeKind: {enum: ["instance", "runner"]}, runnerId: text, agentSelector: selector, invocation}, ["scopeKind", "agentSelector"]);
    case "skill_assign_update": return object({enabled: boolean, agentSelector: selector, invocation});
    case "skill_pin_set": return object({versionId: nullableText, expectedRevision: nullableText, expectedLatestVersionId: text}, ["versionId", "expectedRevision", "expectedLatestVersionId"]);
    default: return object({});
  }
}

const target = {runnerId: text, workspaceId: text, projectId: nullableText, projectLocationId: nullableText};
export const automationPayloadSchema = object({
  name: text, cron: {...text, description: "Five-field minute/hour/day-of-month/month/day-of-week cron."},
  timezone: {...text, description: "IANA timezone, for example America/Chicago."}, enabled: boolean,
  misfirePolicy: {oneOf: [object({kind: {enum: ["skip", "fire_once"]}}, ["kind"]),
    object({kind: {const: "catch_up"}, maxRuns: {type: "integer", minimum: 1}}, ["kind", "maxRuns"])]},
  runnerPolicy: {oneOf: [object({kind: {const: "wait"}}, ["kind"]),
    object({kind: {const: "expire"}, afterMinutes: positive}, ["kind", "afterMinutes"]),
    object({kind: {const: "alternate"}, targets: {type: "array", items: object({...target, agentId: text, agentBindings: {type: "object"}, orchestratorAgentId: text}, ["runnerId", "workspaceId"])}, expireAfterMinutes: positive}, ["kind", "targets"])]},
  concurrencyPolicy: {enum: ["wait", "skip", "parallel"]},
  limits: object({maxCostUsd: positive, maxToolCalls: {type: "integer", minimum: 1}}, ["maxCostUsd", "maxToolCalls"]),
  notifications: object({pushEvents: {type: "array", items: {enum: ["started", "succeeded", "failed", "expired"]}}}, ["pushEvents"]),
  action: {oneOf: [
    object({kind: {const: "create_session"}, request: object({...target, agentId: text, prompt: text, title: text,
      useWorktree: boolean, config: {type: "object"}, providerAccountId: text, role: text, orchestrator: boolean,
      campaign: {type: "object", description: "Scheduled campaign definition; shared campaign authority checks apply."}}, ["runnerId", "workspaceId", "agentId"])}, ["kind", "request"]),
    object({kind: {const: "prompt_session"}, sessionId: text, request: object({text, config: {type: "object"}, slashCommand: text}, ["text"])}, ["kind", "sessionId", "request"]),
    object({kind: {const: "workflow_run"}, request: object({...target, workflowId: text, workflowVersion: {type: "integer"}, task: text,
      title: text, agentBindings: {type: "object"}, orchestratorAgentId: text, config: {type: "object"},
      useWorktree: boolean}, ["runnerId", "workspaceId", "workflowId", "task"])}, ["kind", "request"]),
  ]},
}, ["name", "cron", "timezone", "enabled", "misfirePolicy", "runnerPolicy", "concurrencyPolicy", "limits", "notifications", "action"]);
