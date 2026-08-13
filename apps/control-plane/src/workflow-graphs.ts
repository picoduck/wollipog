import type {
  WorkflowDefinitionSpec,
  WorkflowNodeDefinition,
  WorkflowNodeStatus,
} from "@wollipog/protocol";

export type WorkflowValidation =
  | { ok: true; value: WorkflowDefinitionSpec }
  | { ok: false; error: string };

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ARTIFACT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const KINDS = new Set(["agent", "human_gate", "policy_gate"]);
const ARTIFACT_KINDS = new Set(["html_preview", "patch", "review_report", "screenshot", "test_log", "verdict"]);
const EDGE_CONDITIONS = new Set(["success", "failure", "accepted", "changes_requested", "always"]);
const TOP_FIELDS = new Set(["name", "description", "maxTransitions", "nodes", "edges"]);
const NODE_FIELDS = new Set(["nodeId", "kind", "role", "agentId", "policyId", "prompt", "inputs", "outputs", "retry", "timeoutMs", "stopCondition"]);
const CONTRACT_FIELDS = new Set(["name", "kind", "required"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

function validateContracts(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.length > 16) return `${label} must contain at most 16 artifact contracts`;
  const names = new Set<string>();
  for (const contract of value) {
    if (!record(contract) || !exactFields(contract, CONTRACT_FIELDS)) return `${label} contains an invalid artifact contract`;
    if (typeof contract.name !== "string" || !ARTIFACT_NAME.test(contract.name)) return `${label} contains an invalid artifact name`;
    if (typeof contract.kind !== "string" || !ARTIFACT_KINDS.has(contract.kind)) return `${label} contains an invalid artifact kind`;
    if (contract.required !== undefined && typeof contract.required !== "boolean") return `${label} contains an invalid required flag`;
    if (names.has(contract.name)) return `${label} contains duplicate artifact '${contract.name}'`;
    names.add(contract.name);
  }
  return null;
}

function validateNode(value: unknown): value is WorkflowNodeDefinition {
  if (!record(value) || !exactFields(value, NODE_FIELDS)) return false;
  if (typeof value.nodeId !== "string" || !ID.test(value.nodeId)) return false;
  if (typeof value.kind !== "string" || !KINDS.has(value.kind)) return false;
  if (!validText(value.role, 80)) return false;
  if (value.prompt !== undefined && !validText(value.prompt, 32_000, true)) return false;
  if (!record(value.retry) || !exactFields(value.retry, new Set(["maxAttempts", "backoffMs"]))) return false;
  if (!Number.isInteger(value.retry.maxAttempts) || (value.retry.maxAttempts as number) < 1 || (value.retry.maxAttempts as number) > 10) return false;
  if (!Number.isInteger(value.retry.backoffMs) || (value.retry.backoffMs as number) < 0 || (value.retry.backoffMs as number) > 86_400_000) return false;
  if (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 1_000 || (value.timeoutMs as number) > 86_400_000) return false;
  if (validateContracts(value.inputs, `${value.nodeId}.inputs`) || validateContracts(value.outputs, `${value.nodeId}.outputs`)) return false;
  if (value.kind === "agent") {
    if (typeof value.agentId !== "string" || !ID.test(value.agentId) || value.policyId !== undefined) return false;
  } else if (value.kind === "policy_gate") {
    if (typeof value.policyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value.policyId) || value.agentId !== undefined) return false;
  } else if (value.agentId !== undefined || value.policyId !== undefined) return false;
  if (value.stopCondition !== undefined) {
    if (!record(value.stopCondition) || typeof value.stopCondition.kind !== "string") return false;
    if (value.stopCondition.kind === "verdict") {
      if (!exactFields(value.stopCondition, new Set(["kind", "artifact", "outcomes"])) ||
          typeof value.stopCondition.artifact !== "string" || !ARTIFACT_NAME.test(value.stopCondition.artifact) ||
          !Array.isArray(value.stopCondition.outcomes) || value.stopCondition.outcomes.length < 1 ||
          value.stopCondition.outcomes.length > 3 ||
          value.stopCondition.outcomes.some((outcome) => !["accepted", "changes_requested", "rejected"].includes(String(outcome)))) return false;
    } else if (value.stopCondition.kind === "attempt_limit") {
      if (!exactFields(value.stopCondition, new Set(["kind", "maxAttempts"])) ||
          !Number.isInteger(value.stopCondition.maxAttempts) || (value.stopCondition.maxAttempts as number) < 1 ||
          (value.stopCondition.maxAttempts as number) > (value.retry.maxAttempts as number)) return false;
    } else return false;
  }
  return true;
}

/** Validate an immutable workflow graph before it crosses the persistence boundary. Cycles are
 * intentional for review loops; maxTransitions is the mandatory global termination bound. */
export function validateWorkflowDefinition(input: unknown): WorkflowValidation {
  if (!record(input) || !exactFields(input, TOP_FIELDS)) return { ok: false, error: "workflow contains unsupported fields" };
  if (!validText(input.name, 120)) return { ok: false, error: "workflow name must be between 1 and 120 characters" };
  if (input.description !== undefined && !validText(input.description, 2_000, true)) return { ok: false, error: "workflow description is invalid" };
  if (!Number.isInteger(input.maxTransitions) || (input.maxTransitions as number) < 1 || (input.maxTransitions as number) > 1_000) {
    return { ok: false, error: "maxTransitions must be an integer between 1 and 1000" };
  }
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 64 || !input.nodes.every(validateNode)) {
    return { ok: false, error: "workflow nodes are invalid" };
  }
  if (!Array.isArray(input.edges) || input.edges.length > 256) return { ok: false, error: "workflow edges are invalid" };
  const nodes = input.nodes as WorkflowNodeDefinition[];
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  if (nodeIds.size !== nodes.length) return { ok: false, error: "workflow node ids must be unique" };
  const edgeIds = new Set<string>();
  const inbound = new Map(nodes.map((node) => [node.nodeId, 0]));
  const outgoing = new Map(nodes.map((node) => [node.nodeId, 0]));
  for (const edge of input.edges) {
    if (!record(edge) || !exactFields(edge, new Set(["edgeId", "from", "to", "on"])) ||
        typeof edge.edgeId !== "string" || !ID.test(edge.edgeId) || edgeIds.has(edge.edgeId) ||
        typeof edge.from !== "string" || typeof edge.to !== "string" || edge.from === edge.to ||
        !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || typeof edge.on !== "string" || !EDGE_CONDITIONS.has(edge.on)) {
      return { ok: false, error: "workflow contains an invalid edge" };
    }
    edgeIds.add(edge.edgeId);
    if (edge.on === "accepted" || edge.on === "changes_requested") {
      const source = nodes.find((node) => node.nodeId === edge.from)!;
      if (source.stopCondition?.kind !== "verdict" || !source.stopCondition.outcomes.includes(edge.on)) {
        return { ok: false, error: `edge '${edge.edgeId}' requires a matching verdict stop condition` };
      }
    }
    inbound.set(edge.to, inbound.get(edge.to)! + 1);
    outgoing.set(edge.from, outgoing.get(edge.from)! + 1);
  }
  const roots = nodes.filter((node) => inbound.get(node.nodeId) === 0);
  if (roots.length < 1) return { ok: false, error: "workflow must have at least one entry node" };
  const reachable = new Set(roots.map((node) => node.nodeId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of input.edges as Array<{ from: string; to: string }>) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; }
    }
  }
  if (reachable.size !== nodes.length) return { ok: false, error: "every workflow node must be reachable from an entry node" };

  const produced = new Map<string, Array<{ nodeId: string; kind: string }>>();
  for (const node of nodes) {
    for (const output of node.outputs) {
      const prior = produced.get(output.name) ?? [];
      if (prior.some((producer) => producer.kind !== output.kind)) return { ok: false, error: `artifact '${output.name}' has conflicting output kinds` };
      prior.push({ nodeId: node.nodeId, kind: output.kind });
      produced.set(output.name, prior);
    }
  }
  const canReach = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of input.edges as Array<{ from: string; to: string }>) {
        if (edge.from !== current) continue;
        if (edge.to === to) return true;
        if (!seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
      }
    }
    return false;
  };
  for (const node of nodes) {
    for (const inputContract of node.inputs.filter((contract) => contract.required !== false)) {
      const upstream = (produced.get(inputContract.name) ?? []).some((producer) =>
        producer.nodeId !== node.nodeId && producer.kind === inputContract.kind && canReach(producer.nodeId, node.nodeId));
      if (!upstream) {
        return { ok: false, error: `${node.nodeId} requires unproduced artifact '${inputContract.name}'` };
      }
    }
    const stopCondition = node.stopCondition;
    if (stopCondition?.kind === "verdict" &&
        !node.outputs.some((output) => output.name === stopCondition.artifact && output.kind === "verdict")) {
      return { ok: false, error: `${node.nodeId} verdict stop condition must reference its verdict output` };
    }
  }
  // Prove a first traversal can actually start. A producer that is only reachable after the
  // consumer runs (A needs x, A -> B produces x, B -> A) is graph-reachable but operationally
  // deadlocked. Grow the schedulable set from entry nodes using already-schedulable predecessors
  // and artifact producers; review loops remain valid once their initial builder is admitted.
  const schedulable = new Set<string>();
  changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (schedulable.has(node.nodeId)) continue;
      const dependencyReady = inbound.get(node.nodeId) === 0 ||
        (input.edges as Array<{ from: string; to: string }>).some((edge) => edge.to === node.nodeId && schedulable.has(edge.from));
      const inputsReady = node.inputs.filter((contract) => contract.required !== false).every((contract) =>
        (produced.get(contract.name) ?? []).some((producer) =>
          producer.nodeId !== node.nodeId && producer.kind === contract.kind && schedulable.has(producer.nodeId) && canReach(producer.nodeId, node.nodeId)));
      if (dependencyReady && inputsReady) { schedulable.add(node.nodeId); changed = true; }
    }
  }
  if (schedulable.size !== nodes.length) return { ok: false, error: "workflow artifact dependencies deadlock on the first traversal" };
  return { ok: true, value: input as unknown as WorkflowDefinitionSpec };
}

const NODE_TRANSITIONS: Record<WorkflowNodeStatus, readonly WorkflowNodeStatus[]> = {
  pending: ["ready", "skipped", "stopped"],
  ready: ["running", "waiting_gate", "skipped", "stopped"],
  running: ["ready", "succeeded", "failed", "stopped"],
  waiting_gate: ["succeeded", "failed", "stopped"],
  succeeded: ["ready"], // explicit review-loop re-entry; the instance transition cap remains authoritative
  failed: ["ready"],
  skipped: [],
  stopped: [],
};

export function canTransitionWorkflowNode(from: WorkflowNodeStatus, to: WorkflowNodeStatus): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}

export const BUILD_REVIEW_WORKFLOW: WorkflowDefinitionSpec = {
  name: "Build and independent review",
  description: "Claude builds, Codex reviews, and Claude addresses findings until accepted or capped.",
  maxTransitions: 24,
  nodes: [
    { nodeId: "build", kind: "agent", role: "builder", agentId: "claude", prompt: "Implement the requested change and publish a patch artifact.", inputs: [], outputs: [{ name: "implementation_patch", kind: "patch" }], retry: { maxAttempts: 2, backoffMs: 1_000 }, timeoutMs: 3_600_000 },
    { nodeId: "review", kind: "agent", role: "reviewer", agentId: "codex", prompt: "Review the implementation independently and publish a report and structured verdict.", inputs: [{ name: "implementation_patch", kind: "patch" }], outputs: [{ name: "review_report", kind: "review_report" }, { name: "review_verdict", kind: "verdict" }], retry: { maxAttempts: 2, backoffMs: 1_000 }, timeoutMs: 3_600_000, stopCondition: { kind: "verdict", artifact: "review_verdict", outcomes: ["accepted", "changes_requested", "rejected"] } },
    { nodeId: "address", kind: "agent", role: "remediator", agentId: "claude", prompt: "Address the independent review findings and publish an updated patch.", inputs: [{ name: "review_report", kind: "review_report" }], outputs: [{ name: "implementation_patch", kind: "patch" }], retry: { maxAttempts: 2, backoffMs: 1_000 }, timeoutMs: 3_600_000 },
  ],
  edges: [
    { edgeId: "build_to_review", from: "build", to: "review", on: "success" },
    { edgeId: "review_to_address", from: "review", to: "address", on: "changes_requested" },
    { edgeId: "address_to_review", from: "address", to: "review", on: "success" },
  ],
};
