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
const owner = {enum: ["human", "orchestrator"]};
/** Mirrors parseOrchestratorOverrides: every field is optional and omitted ones use the owner's
 * saved Orchestrator defaults. Null selects Automatic. */
const orchestrator = strict({
  behavior: strict({
    childHarness: {type: ["object", "null"], properties: {agentId: text, driver: {enum: ["acp", "claude-code", "codex", "codex-app-server", "pi"]},
      context: {oneOf: [object({kind: {const: "native"}}, ["kind"]), object({kind: {const: "wsl"}, distro: text}, ["kind", "distro"])]}},
    required: ["agentId", "driver", "context"]},
    childModel: nullableText, childEffort: nullableText, maximumConcurrentChildren: integer(0, 64),
    followUps: {enum: ["recommend_only", "execute_approved"]}, completion: {enum: ["retain", "stop_and_archive"]},
    reviewHarness: {enum: ["codex", "claude-code", null]}, reviewModel: nullableText, reviewEffort: nullableText,
    reviewRoundBudget: {type: ["integer", "null"], minimum: 1, maximum: 32},
  }),
  delegation: strict({parentControl: {enum: ["off", "questions", "questions_and_approvals"]},
    decisions: strict(Object.fromEntries(WORKFLOW_DECISION_CATEGORIES.map(category => [category, owner])))}),
  execution: strict({strictProjectIsolation: boolean, integrationIsolation: boolean}),
});
/** Mirrors validAutomationCampaign and the Full Control launch overrides it accepts. */
const campaign = {...strict({
  controlMode: {enum: ["custom", "full_control"]},
  repository: {...text, description: "Lowercase owner/name of the workspace origin."},
  tasks: {type: "array", maxItems: 100, items: strict({key: {type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$"},
    title: {type: "string", minLength: 1, maxLength: 120}, prompt: {type: "string", minLength: 1, maxLength: 16_384}}, ["key", "title", "prompt"])},
  fullControl: {...strict({objective: text, operations: {type: "array", minItems: 1, uniqueItems: true, items: {enum: FULL_CONTROL_LAUNCH_OPERATIONS}},
    delegatablePolicyIds: {type: "array", maxItems: 100, items: text},
    budget: object({costUsd: positive, toolCalls: integer(1), concurrency: integer(1), acceptedFollowUps: integer(0), checkpointsUsd: {type: "array", items: positive}}),
    issues: object({relatedFollowUps: boolean, maxIssues: integer(1, 100), closureReasons: {type: "array", items: {enum: ["completed", "not_planned"]}}})}),
  description: "full_control only; narrows limits."},
}, ["controlMode", "repository", "tasks"]), description: "Requires role orchestrator."};
export const automationPayloadSchema = object({
  name: text, cron: {...text, description: "Five-field minute/hour/day-of-month/month/day-of-week cron."},
  timezone: {...text, description: "IANA timezone, for example America/Chicago."}, enabled: boolean,
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
      orchestrator: {...orchestrator, description: "Campaign overrides; only with campaign."}, campaign}, ["runnerId", "workspaceId", "agentId"])}, ["kind", "request"]),
    object({kind: {const: "prompt_session"}, sessionId: text, request: object({text, config: {type: "object"}, slashCommand: text}, ["text"])}, ["kind", "sessionId", "request"]),
  ]},
}, ["name", "cron", "timezone", "enabled", "misfirePolicy", "runnerPolicy", "concurrencyPolicy", "limits", "notifications", "action"]);
