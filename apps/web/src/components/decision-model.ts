import type {
  DecisionErrorClass,
  DecisionModelResolvedTarget,
  DecisionModelSettingsView,
  DecisionModelTestResult,
  DecisionOccurrenceView,
  DecisionUsageView,
} from "@wollipog/protocol";
import { effortLabel } from "../format.js";
import type { SelectOption } from "./ui/ChoiceControls.js";

/**
 * Settings › Orchestrator › Decision Model (#4101): the words the group, its dialog and Campaign
 * Status share.
 */

export const DECISION_MODEL_NO_PERMISSION = "Only an organization owner or admin can change this.";
export const DECISION_MODEL_LOAD_FAILED = "Couldn't load the Decision Model setting.";

/** Shown under the group, so the provider boundary is stated wherever the setting is. */
export const DECISION_MODEL_DISCLOSURE =
  "Decision calls send the campaign owner's first message, issue facts and Orchestrator rationale to the selected agent's provider. Credentials stay on the machine.";

export type DecisionModelSource = DecisionModelSettingsView["source"];

const SOURCES: ReadonlyArray<{ value: DecisionModelSource; label: string; description: string }> = [
  {
    value: "automatic",
    label: "Automatic",
    description: "Each campaign uses its own agent, with the smallest model that agent offers.",
  },
  {
    value: "organization",
    label: "Chosen Agent",
    description: "One agent you choose decides for every campaign.",
  },
];

export function decisionModelSourceOptions(settings: DecisionModelSettingsView | null): SelectOption<DecisionModelSource>[] {
  return SOURCES.map((source) => {
    if (!settings) return { ...source };
    const reason = !settings.canManage
      ? source.value === settings.source ? undefined : DECISION_MODEL_NO_PERMISSION
      : source.value === "organization" && !settings.machines.length && !settings.target
        ? "No connected machine has an agent that can make decisions."
        : undefined;
    return reason ? { ...source, disabled: true, disabledReason: reason } : { ...source };
  });
}

/** The chosen agent's row: which agent on which machine, then its model and effort or why it can't run. */
export function decisionModelTargetSummary(settings: DecisionModelSettingsView): { title: string; description: string } | null {
  const target = settings.target;
  if (!target) return null;
  return {
    title: `${target.harnessName} on ${target.machineName}`,
    description: target.available
      ? `${target.modelName} · ${effortLabel(target.effort)} effort`
      : target.reason ?? "This agent can't make decisions right now.",
  };
}

const FAILURES: Record<DecisionErrorClass, string> = {
  timed_out: "it ran out of time",
  transport: "the machine couldn't be reached",
  rate_limited: "the provider asked to slow down",
  provider_overloaded: "the provider was overloaded",
  invalid_output: "the answer didn't match the required format",
  provider_failed: "the provider failed",
  authentication: "the agent isn't signed in",
  configuration: "the setting needs to be saved again",
  model_unavailable: "the model isn't available",
  harness_unavailable: "the agent can't make decisions",
  runner_incapable: "no connected machine can make decisions",
  refused: "the provider refused the request",
};

export function decisionFailureText(failure: DecisionErrorClass | undefined): string {
  return failure ? FAILURES[failure] ?? "it failed" : "it failed";
}

/** The model's display name, as Settings shows it; the id when the server recorded none. */
export function decisionModelName(target: Pick<DecisionModelResolvedTarget, "model" | "modelName">): string {
  return target.modelName ?? target.model;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function attempts(count: number): string {
  return `${count} ${count === 1 ? "attempt" : "attempts"}`;
}

export function verdictLabel(verdict: string): string {
  return verdict.split("_").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

/** One sentence for a Test Decision Model result: verdict, latency and attempts, and where it ran. */
export function decisionTestSummary(result: DecisionModelTestResult): string {
  const occurrence = result.occurrence;
  const where = occurrence.target
    ? ` on ${occurrence.target.harnessName} (${decisionModelName(occurrence.target)}, ${effortLabel(occurrence.target.effort)} effort)`
    : "";
  const facts = `${seconds(result.latencyMs)}, ${attempts(occurrence.attempts.length)}${where}.`;
  if (occurrence.state === "decided" || occurrence.state === "uncertain") {
    return `Verdict: ${verdictLabel(occurrence.verdict ?? "")}. ${facts}`;
  }
  return `No verdict: ${decisionFailureText(occurrence.failureClass)}. A campaign would ask its owner instead. ${facts}`;
}

/** Campaign Status: one decision's outcome in plain words. */
export function decisionOutcomeText(decision: DecisionOccurrenceView): string {
  if (decision.state === "pending") return "Deciding…";
  if (decision.state === "decided") return `Verdict: ${verdictLabel(decision.verdict ?? "")}`;
  if (decision.state === "uncertain") return "Uncertain: the owner decides";
  return `No verdict (${decisionFailureText(decision.failureClass)}): the owner decides`;
}

/** Every token the provider processed: uncached input, cache reads, cache writes and output. */
export function decisionTokenTotal(usage: Pick<DecisionUsageView, "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens">): number {
  return usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens + usage.outputTokens;
}

export function decisionCostText(usage: DecisionUsageView): string {
  const tokens = `${decisionTokenTotal(usage).toLocaleString("en-US")} tokens`;
  return usage.costUsd === null ? `${tokens}, cost unknown` : `${tokens}, $${usage.costUsd.toFixed(4)}`;
}
