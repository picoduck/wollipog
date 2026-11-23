/** Transport descriptions only. The shared owner application validators remain authoritative. */
import { WORKFLOW_DECISION_CATEGORIES } from "@wollipog/protocol";
import { FULL_CONTROL_LAUNCH_OPERATIONS } from "./campaign-launch-admission.js";

const text = {type: "string"};
const boolean = {type: "boolean"};
const positive = {type: "number", exclusiveMinimum: 0};
// Discovery returns each schema within a bounded tool result, so omit empty `required` lists.
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({type: "object", properties, ...(required.length ? {required} : {})});
const strict = (properties: Record<string, unknown>, required: string[] = []) => ({...object(properties, required), additionalProperties: false});
const integer = (minimum: number, maximum?: number) => ({type: "integer", minimum, ...(maximum === undefined ? {} : {maximum})});
const safe = Number.MAX_SAFE_INTEGER;
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
// Identifiers are nonempty and trimmed; free text needs one non-space character.
const identifier = {type: "string", pattern: "^\\S(.*\\S)?$", maxLength: 256};
const nullableIdentifier = (maxLength = 256) => ({...identifier, type: ["string", "null"], maxLength});
const prose = (maxLength: number) => ({type: "string", pattern: "\\S", maxLength});
/** Mirrors parseOrchestratorOverrides: every field is optional and omitted ones use the owner's
 * saved Orchestrator defaults. Null selects Automatic, or inherits for parentControl. */
const orchestrator = strict({
  behavior: strict({
    childHarness: {type: ["object", "null"], properties: {agentId: identifier, driver: {enum: ["acp", "claude-code", "codex", "codex-app-server", "pi"]},
      context: {oneOf: [object({kind: {const: "native"}}, ["kind"]), object({kind: {const: "wsl"}, distro: identifier}, ["kind", "distro"])]}},
    required: ["agentId", "driver", "context"]},
    childModel: nullableIdentifier(), childEffort: nullableIdentifier(64), maximumConcurrentChildren: integer(0, 64),
    followUps: {enum: ["recommend_only", "execute_approved"]}, completion: {enum: ["retain", "stop_and_archive"]},
    reviewHarness: {enum: ["codex", "claude-code", null]}, reviewModel: nullableIdentifier(), reviewEffort: nullableIdentifier(64),
    reviewRoundBudget: {type: ["integer", "null"], minimum: 1, maximum: 32},
  }),
  delegation: strict({parentControl: {enum: ["off", "questions", "questions_and_approvals", null]},
    decisions: {type: "object", propertyNames: {enum: WORKFLOW_DECISION_CATEGORIES}, additionalProperties: {enum: ["human", "orchestrator"]}}}),
  execution: strict({strictProjectIsolation: boolean, integrationIsolation: boolean}),
});
/** Mirrors automationCampaignError and the Full Control launch overrides it accepts. */
const campaign = {...strict({
  controlMode: {enum: ["custom", "full_control"]},
  repository: {type: "string", maxLength: 256, description: "Lowercase owner/name, or GitLab host/group/project.",
    pattern: "^([a-z0-9_.-]+/[a-z0-9_.-]+|[a-z0-9-]+(\\.[a-z0-9-]+)+(:[0-9]{1,5})?(/[a-z0-9_][a-z0-9_.-]*){2,22})$"},
  tasks: {type: "array", maxItems: 100, items: strict({key: {type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$"},
    title: prose(120), prompt: prose(16_384)}, ["key", "title", "prompt"])},
  fullControl: strict({objective: prose(4000), operations: {type: "array", minItems: 1, uniqueItems: true, items: {enum: FULL_CONTROL_LAUNCH_OPERATIONS}},
    delegatablePolicyIds: {type: "array", maxItems: 100, items: prose(256)},
    budget: strict({costUsd: positive, toolCalls: integer(1, safe), concurrency: integer(1, safe), acceptedFollowUps: integer(0, safe), checkpointsUsd: {type: "array", maxItems: 100, items: positive, description: "Increasing, within the smaller of limits.maxCostUsd and costUsd."}}),
    issues: strict({relatedFollowUps: boolean, maxIssues: integer(1, 100), closureReasons: {type: "array", uniqueItems: true, items: {enum: ["completed", "not_planned"]}}})}),
}, ["controlMode", "repository", "tasks"]),
  // fullControl applies only to full_control.
  if: {properties: {controlMode: {const: "custom"}}, required: ["controlMode"]}, then: {not: {required: ["fullControl"]}}};
export const automationPayloadSchema = object({
  name: text, cron: {...text, description: "Five-field cron."},
  timezone: {...text, description: "IANA timezone."}, enabled: boolean,
  misfirePolicy: {oneOf: [object({kind: {enum: ["skip", "fire_once"]}}, ["kind"]),
    object({kind: {const: "catch_up"}, maxRuns: {type: "integer", minimum: 1}}, ["kind", "maxRuns"])]},
  runnerPolicy: {oneOf: [object({kind: {const: "wait"}}, ["kind"]),
    object({kind: {const: "expire"}, afterMinutes: positive}, ["kind", "afterMinutes"]),
    object({kind: {const: "alternate"}, targets: {type: "array", items: object({...target, agentId: text}, ["runnerId", "workspaceId"])}, expireAfterMinutes: positive}, ["kind", "targets"])]},
  concurrencyPolicy: {enum: ["wait", "skip", "parallel"]},
  limits: object({maxCostUsd: positive, maxToolCalls: {type: "integer", minimum: 1}}, ["maxCostUsd", "maxToolCalls"]),
  notifications: object({pushEvents: {type: "array", items: {enum: ["started", "succeeded", "failed", "expired"]}}}, ["pushEvents"]),
  action: {oneOf: [
    object({kind: {const: "create_session"}, request: object({...target, agentId: text, prompt: text, title: text,
      useWorktree: boolean, config: {type: "object"}, providerAccountId: text, executionTargetId: text, role: {enum: ["normal", "orchestrator"]},
      orchestrator, campaign}, ["runnerId", "workspaceId", "agentId"])}, ["kind", "request"]),
    object({kind: {const: "prompt_session"}, sessionId: text, request: object({text, config: {type: "object"}, slashCommand: text}, ["text"])}, ["kind", "sessionId", "request"]),
  ]},
}, ["name", "cron", "timezone", "enabled", "misfirePolicy", "runnerPolicy", "concurrencyPolicy", "limits", "notifications", "action"]);
