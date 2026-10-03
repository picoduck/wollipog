import type { SessionEventPayload } from "@wollipog/protocol";

type UsageEvent = Extract<SessionEventPayload, { kind: "token_usage" }>;
export type { ClaudeUsageCheckpoint } from "@wollipog/protocol";
import type { ClaudeUsageCheckpoint } from "@wollipog/protocol";
type ModelUsage = ClaudeUsageCheckpoint["models"][string];
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const cost = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Claude 2.1.277 changed resume/fork totals from process scope to persisted conversation scope. */
export function claudeRestoresUsage(version: string | undefined): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major! > 2 || major === 2 && (minor! > 1 || minor === 1 && patch! >= 277);
}

export function claudeUsageCheckpoint(sessionId: string, result: any): ClaudeUsageCheckpoint | null {
  const totalCostUsd = cost(result.total_cost_usd);
  if (totalCostUsd === undefined) return null;
  const models: Record<string, ModelUsage> = Object.create(null);
  for (const [model, raw] of Object.entries(result.modelUsage ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const usage = raw as Record<string, unknown>;
    models[model] = {
      ...(typeof usage.canonicalModel === "string" && usage.canonicalModel ? { canonicalModel: usage.canonicalModel } : {}),
      ...(typeof usage.thinkingTokens === "number" ? { thinkingTokens: Math.min(count(usage.outputTokens), count(usage.thinkingTokens)) } : {}),
      inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens),
      cacheReadInputTokens: count(usage.cacheReadInputTokens), cacheCreationInputTokens: count(usage.cacheCreationInputTokens),
      ...(usage.costBasis !== "unknown" && cost(usage.costUSD) !== undefined ? { costUSD: cost(usage.costUSD) } : {}),
    };
  }
  return { sessionId, totalCostUsd, models };
}

/** result.usage is main-loop/per-turn; modelUsage and USD are cumulative and include children. */
export class ClaudeUsageAccounting {
  checkpoint: ClaudeUsageCheckpoint | null;
  constructor(readonly restoresUsage: boolean, checkpoint?: ClaudeUsageCheckpoint) {
    this.checkpoint = checkpoint ?? null;
  }
  beginProcess(): void { if (!this.restoresUsage) this.checkpoint = null; }
  result(sessionId: string, result: any, model?: string | null): UsageEvent[] {
    const next = claudeUsageCheckpoint(sessionId, result);
    const previous = this.checkpoint?.sessionId === sessionId ? this.checkpoint : null;
    // A crash can zero every counter. It neither erases a baseline nor proves free work.
    if (result.subtype === "error_during_execution" && next?.totalCostUsd === 0 &&
        Object.values(next.models).every((u) => u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens === 0)) return [{ kind: "token_usage", accountingIncomplete: true }];
    if (next && previous && next.totalCostUsd < previous.totalCostUsd) return [];
    const deltaCost = next ? Math.max(0, next.totalCostUsd - (previous?.totalCostUsd ?? 0)) : undefined;
    const events: UsageEvent[] = [];
    if (next && Object.keys(next.models).length > 0) {
      for (const [name, usage] of Object.entries(next.models)) {
        const before = previous?.models[name];
        const delta = (field: "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "costUSD" | "thinkingTokens") => Math.max(0, (usage[field] ?? 0) - (before?.[field] ?? 0));
        const inputTokens = delta("inputTokens"), outputTokens = delta("outputTokens");
        const cachedInputTokens = delta("cacheReadInputTokens"), cacheCreationInputTokens = delta("cacheCreationInputTokens");
        const costUsd = usage.costUSD === undefined || before && before.costUSD === undefined ? undefined : delta("costUSD");
        if (!(inputTokens || outputTokens || cachedInputTokens || cacheCreationInputTokens || costUsd)) continue;
        events.push({ kind: "token_usage", model: usage.canonicalModel ?? name, inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens,
          ...(usage.thinkingTokens === undefined ? {} : { reasoningOutputTokens: Math.min(outputTokens, delta("thinkingTokens")) }),
          ...(costUsd === undefined ? {} : { costUsd, costIsEstimate: true }) });
      }
      // Non-token fees cannot be assigned to the last assistant model.
      const modelCosts = events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
      if (deltaCost !== undefined && deltaCost - modelCosts > 1e-9 && events.every((event) => event.costUsd !== undefined)) {
        events.push({ kind: "token_usage", model: "<provider-fees>", costUsd: deltaCost - modelCosts, costIsEstimate: true });
      }
    } else {
      const usage = result.usage ?? {};
      events.push({ kind: "token_usage", inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cachedInputTokens: usage.cache_read_input_tokens,
        ...(typeof usage.cache_creation_input_tokens === "number" ? { cacheCreationInputTokens: usage.cache_creation_input_tokens } : {}),
        ...(model ? { model } : {}), costUsd: deltaCost, ...(deltaCost === undefined ? {} : { costIsEstimate: true }) });
    }
    if (next) this.checkpoint = next;
    return events;
  }
}
