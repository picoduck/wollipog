import type {
  WorkflowArtifactContract,
  WorkflowArtifactKind,
  WorkflowArtifactView,
  WorkflowAttemptStatus,
  WorkflowAttemptView,
  WorkflowEdgeCondition,
  WorkflowInstanceDetail,
  WorkflowNodeDefinition,
  WorkflowNodeOutcome,
  WorkflowNodeState,
} from "@wollipog/protocol";
import { titleCaseLabel } from "./format.js";

/**
 * A workflow run as numbered steps (#2977): the definition's nodes in order with their states, the
 * step that needs the person, each step's sub-line and what it waits for, the artifact a gate
 * approves and the facts its panel shows. Pure, so the run page and its tests share one answer.
 */

export interface WorkflowStep {
  nodeId: string;
  /** 1-based, in the definition's node order. */
  number: number;
  node: WorkflowNodeDefinition;
  state: WorkflowNodeState;
  /** The role in Title Case: "Builder", "Approver". */
  role: string;
  /** The run member whose session runs an agent step, when it is known; null for a gate. */
  sessionId: string | null;
  /** Its attempts, oldest first. */
  attempts: readonly WorkflowAttemptView[];
}

/** The last item that passes, as `Array.prototype.findLast` does (ES2023, past this build's lib). */
function lastOf<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) if (test(items[index]!)) return items[index];
  return undefined;
}

const roleLabel = (role: string, number: number) => {
  const words = role.replace(/[_-]+/g, " ").trim();
  return words ? titleCaseLabel(words) : `Step ${number}`;
};

/**
 * The steps in the definition's order. An agent step's session is the one its node or latest attempt
 * ran in, else the one another step of the same agent ran in. Before any of them has run, a run's
 * members are its agents in the order their steps first appear (the control plane creates one member
 * per agent that way, then an optional orchestrator), so the member at the agent's position is used,
 * but only while the member count proves that order still holds.
 */
export function workflowSteps(detail: WorkflowInstanceDetail, runSessionIds: readonly string[]): WorkflowStep[] {
  const states = new Map(detail.nodeStates.map((state) => [state.nodeId, state]));
  const attemptsByNode = new Map<string, WorkflowAttemptView[]>();
  for (const attempt of [...detail.attempts].sort((left, right) => left.attempt - right.attempt || left.startedAt - right.startedAt)) {
    const list = attemptsByNode.get(attempt.nodeId) ?? [];
    list.push(attempt);
    attemptsByNode.set(attempt.nodeId, list);
  }
  const ranIn = (node: WorkflowNodeDefinition) =>
    states.get(node.nodeId)?.sessionId ?? lastOf(attemptsByNode.get(node.nodeId) ?? [], (attempt) => Boolean(attempt.sessionId))?.sessionId ?? null;
  const agents = [...new Set(detail.definition.nodes.flatMap((node) => node.kind === "agent" && node.agentId ? [node.agentId] : []))];
  const byAgent = new Map<string, string>();
  for (const node of detail.definition.nodes) {
    const session = node.kind === "agent" && node.agentId ? ranIn(node) : null;
    if (session && !byAgent.has(node.agentId!)) byAgent.set(node.agentId!, session);
  }
  const positional = runSessionIds.length === agents.length || runSessionIds.length === agents.length + 1;
  return detail.definition.nodes.map((node, index): WorkflowStep => {
    const agentIndex = node.kind === "agent" && node.agentId ? agents.indexOf(node.agentId) : -1;
    const sessionId = node.kind !== "agent" ? null
      : ranIn(node) ?? (node.agentId ? byAgent.get(node.agentId) : undefined) ?? (positional && agentIndex >= 0 ? runSessionIds[agentIndex]! : null);
    return {
      nodeId: node.nodeId,
      number: index + 1,
      node,
      state: states.get(node.nodeId) ?? { nodeId: node.nodeId, status: "pending", attemptCount: 0 },
      role: roleLabel(node.role, index + 1),
      sessionId,
      attempts: attemptsByNode.get(node.nodeId) ?? [],
    };
  });
}

/**
 * The step the page selects until the person picks one: a gate waiting on a decision, else a failed
 * or ready step, else the running one, else the last step that has started, else the first.
 */
export function attentionStepId(steps: readonly WorkflowStep[]): string | null {
  const first = (test: (step: WorkflowStep) => boolean) => steps.find(test)?.nodeId;
  return first((step) => step.state.status === "waiting_gate")
    ?? first((step) => step.state.status === "failed" || step.state.status === "ready")
    ?? first((step) => step.state.status === "running")
    ?? lastOf(steps, (step) => step.state.status !== "pending")?.nodeId
    ?? steps[0]?.nodeId
    ?? null;
}

const KIND_NOUNS: Record<WorkflowArtifactKind, string> = {
  html_preview: "HTML preview",
  patch: "patch",
  review_report: "review report",
  screenshot: "screenshot",
  video: "video",
  test_log: "test log",
  verdict: "verdict",
};

/** An artifact kind in words, sentence case: "patch", "review report". */
export const artifactNoun = (kind: WorkflowArtifactKind) => KIND_NOUNS[kind] ?? "artifact";

const withArticle = (noun: string) => `${/^(?:[aeiou]|HTML)/i.test(noun) ? "an" : "a"} ${noun}`;

const listSentence = (items: readonly string[], joiner: "and" | "or") =>
  items.length < 2 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`;

/** The input a gate decides on, or null for a gate that consumes nothing. */
export const gateInput = (node: WorkflowNodeDefinition): WorkflowArtifactContract | null =>
  node.kind === "agent" ? null : node.inputs[0] ?? null;

/**
 * The line under a step's role: what its agent produces, or what the person or a policy decides.
 * "Claude Code produces a patch", "You approve or reject the patch".
 */
export function stepSubline(step: WorkflowStep, agent: string | null): string {
  const { node } = step;
  if (node.kind === "agent") {
    const who = agent || "The agent";
    const outputs = [...new Set(node.outputs.map((output) => artifactNoun(output.kind)))];
    return outputs.length ? `${who} produces ${listSentence(outputs.map(withArticle), "and")}` : `${who} works on the task`;
  }
  const input = gateInput(node);
  if (node.kind === "human_gate") {
    return input ? `You approve or reject the ${artifactNoun(input.kind)}` : "You decide whether the run goes on";
  }
  return input ? `A policy checks the ${artifactNoun(input.kind)}` : "A policy decides whether the run goes on";
}

function edgeWords(from: WorkflowStep, on: WorkflowEdgeCondition): string {
  if (from.node.kind === "agent") {
    switch (on) {
      case "success": return `${from.role} succeeds`;
      case "failure": return `${from.role} fails`;
      case "accepted": return `${from.role} accepts`;
      case "changes_requested": return `${from.role} requests changes`;
      default: return `${from.role} finishes`;
    }
  }
  const input = gateInput(from.node);
  const what = input ? ` the ${artifactNoun(input.kind)}` : "";
  if (from.node.kind === "human_gate") {
    if (on === "success" || on === "accepted") return `you approve${what}`;
    if (on === "failure" || on === "changes_requested") return `you reject${what}`;
    return "you decide";
  }
  if (on === "success" || on === "accepted") return "the policy passes";
  if (on === "failure" || on === "changes_requested") return "the policy fails";
  return "the policy decides";
}

/** What a waiting step waits for: "Starts when Builder succeeds", or why it never will. */
export function stepWaitLine(step: WorkflowStep, steps: readonly WorkflowStep[], edges: WorkflowInstanceDetail["definition"]["edges"]): string {
  const incoming = edges.flatMap((edge) => {
    const from = edge.to === step.nodeId ? steps.find((candidate) => candidate.nodeId === edge.from) : undefined;
    return from ? [edgeWords(from, edge.on)] : [];
  });
  return incoming.length ? `Starts when ${listSentence([...new Set(incoming)], "or")}` : "Waiting to start";
}

/** The roles a gate's Continue starts: "Reviewer", "Reviewer and Tester". */
export function stepsAfter(step: WorkflowStep, steps: readonly WorkflowStep[], edges: WorkflowInstanceDetail["definition"]["edges"], on: "success" | "failure"): string[] {
  return [...new Set(edges.flatMap((edge) => {
    if (edge.from !== step.nodeId || !(edge.on === on || edge.on === "always" || (on === "success" && edge.on === "accepted"))) return [];
    const to = steps.find((candidate) => candidate.nodeId === edge.to);
    return to ? [to.role] : [];
  }))];
}

export const rolesSentence = (roles: readonly string[]) => listSentence(roles, "and");

/**
 * The artifact a gate decides on, among the run's loaded artifacts: the newest of its input's kind
 * that a step producing that input saved, else the newest of that kind. The control plane does not
 * say which artifact satisfied the contract, so this is the closest match the page can show.
 */
export function gateArtifact(
  gate: WorkflowStep,
  steps: readonly WorkflowStep[],
  artifacts: readonly WorkflowArtifactView[],
): WorkflowArtifactView | null {
  const input = gateInput(gate.node);
  if (!input) return null;
  const producers = new Set(steps.flatMap((step) =>
    step.sessionId && step.node.outputs.some((output) => output.name === input.name) ? [step.sessionId] : []));
  const ofKind = artifacts.filter((artifact) => artifact.kind === input.kind).sort((left, right) => right.createdAt - left.createdAt);
  return ofKind.find((artifact) => artifact.sessionId && producers.has(artifact.sessionId)) ?? ofKind[0] ?? null;
}

const ATTEMPT_LABELS: Record<WorkflowAttemptStatus, string> = {
  dispatching: "Starting",
  running: "Running",
  awaiting_output: "Awaiting Output",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed Out",
  cancelled: "Canceled",
};

/** An attempt's status in words ("Canceled", never the wire's "cancelled"). */
export const attemptStatusLabel = (status: WorkflowAttemptStatus) => ATTEMPT_LABELS[status] ?? "Status Unavailable";

const OUTCOME_LABELS: Record<WorkflowNodeOutcome, string> = {
  success: "Succeeded",
  failure: "Failed",
  accepted: "Accepted",
  changes_requested: "Changes Requested",
  rejected: "Rejected",
};

/**
 * A step's outcome in words, only while its status agrees with it: a succeeded step's outcome other
 * than a failure, or a failed step's failure or rejection. An outcome left from an earlier round is
 * never shown beside a status it contradicts, so a failed attempt never reads Succeeded.
 */
export function stepOutcomeLabel(step: WorkflowStep): string | null {
  const { status, outcome } = step.state;
  if (!outcome) return null;
  if (step.node.kind !== "agent") {
    if (status !== "succeeded" && status !== "failed") return null;
    return outcome === "failure" || outcome === "rejected" || outcome === "changes_requested" ? "Rejected" : "Approved";
  }
  if (status === "succeeded" && outcome !== "failure") return OUTCOME_LABELS[outcome] ?? null;
  if (status === "failed" && (outcome === "failure" || outcome === "rejected")) return OUTCOME_LABELS[outcome];
  return null;
}

/** "2 of 3": the attempts used of those the step may make. */
export const attemptsLabel = (step: WorkflowStep) => `${step.state.attemptCount} of ${step.node.retry.maxAttempts}`;

/** A failed attempt in one sentence: "Attempt 1 of 2 failed.", "… timed out.", "… was canceled." */
export function attemptFailureSentence(step: WorkflowStep): string {
  const latest = step.attempts.at(-1);
  const which = `Attempt ${latest?.attempt ?? step.state.attemptCount} of ${step.node.retry.maxAttempts}`;
  if (latest?.status === "timed_out") return `${which} timed out.`;
  if (latest?.status === "cancelled") return `${which} was canceled.`;
  return `${which} failed.`;
}

/** The server's own words for a failure, for Show Details. */
export const stepError = (step: WorkflowStep) => step.state.error ?? step.attempts.at(-1)?.error ?? null;

/** A ready agent step that has failed before and may retry. */
export const isRetry = (step: WorkflowStep) => step.node.kind === "agent" && step.state.status === "ready" && step.state.attemptCount > 0;
