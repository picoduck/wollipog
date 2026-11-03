import type { SessionEventPayload } from "@wollipog/protocol";

type UsageEvent = Extract<SessionEventPayload, { kind: "token_usage" }>;
export type { ClaudeUsageCheckpoint } from "@wollipog/protocol";
import type { ClaudeUsageCheckpoint } from "@wollipog/protocol";
type ModelUsage = ClaudeUsageCheckpoint["models"][string];
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const cost = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Claude 2.1.277 changed resume/fork totals from process scope to persisted conversation scope.
 * Undefined when the version is missing or unreadable: the scope is then unknown, not process. */
export function claudeRestoresUsage(version: string | undefined): boolean | undefined {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major! > 2 || major === 2 && (minor! > 1 || minor === 1 && patch! >= 277);
}

export function claudeUsageCheckpoint(sessionId: string, result: any, restoresUsage = true): ClaudeUsageCheckpoint | null {
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
  return { sessionId, totalCostUsd, models, accountingScope: restoresUsage ? "conversation" : "process" };
}

/** One completed top-level API request, from its `message_start` usage and final `message_delta`. */
export interface ClaudeRequestUsage {
  model: string;
  inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number;
  /** The subset of `outputTokens` spent thinking (`output_tokens_details.thinking_tokens`). */
  thinkingTokens?: number;
  serviceTier?: string;
}

/** Live request records published since the last checkpoint, in the order they were published. */
export type ClaudeLiveUsage = UsageEvent[];

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens"] as const;
/** Whether `deltas` account at least every token the `live` requests observed. */
function covers(deltas: UsageEvent[], live: UsageEvent[]): boolean {
  const total = (events: UsageEvent[], field: typeof TOKEN_FIELDS[number]) => events.reduce((sum, event) => sum + count(event[field]), 0);
  return TOKEN_FIELDS.every((field) => total(deltas, field) >= total(live, field));
}

/**
 * result.usage is main-loop/per-turn; modelUsage and USD are cumulative and include children.
 *
 * Live usage (#3086): Claude reports cumulative cost only on a turn's `result`, so a long turn
 * shows nothing until it ends and an interrupted one has no result at all. Each completed
 * top-level request is therefore also published as a `provisional` record. Provisional records
 * are display-only: neither runner metadata nor the control plane's ledger accrues them, so the
 * cumulative checkpoint that follows is still accounted exactly as before and nothing can be
 * counted twice, whatever order a reconnecting control plane sees events and snapshots in.
 *
 * The window of provisional records closes in one of two ways. A checkpoint that covers them (a
 * result, or a resume probe whose restored prefix grew) marks its last record `settled`. A
 * baseline that cannot cover them (a killed process that never persisted its totals, an old CLI's
 * process-scoped totals, a new conversation) republishes each one, in order, as an ordinary
 * `republished` record, so the usage observed live is accounted rather than lost; a restart
 * between two of them resumes after the last one written. An inconclusive result (zeroed counters,
 * a lower total) leaves the window open for the next checkpoint to decide.
 *
 * Scope (#4069): the launch's recorded Claude Code version is only a hint. After a runner restart
 * it can be missing or stale while the installed CLI restores conversation totals, and treating
 * those as process totals bills the conversation's running total on every turn. Each process's
 * own version report therefore decides its scope. When no baseline proves which part of a
 * process's first result is new, that result is never billed as a delta: the requests observed
 * live are accounted and the record is marked incomplete.
 */
export class ClaudeUsageAccounting {
  checkpoint: ClaudeUsageCheckpoint | null;
  /** Whether Claude restores conversation totals on resume: the recorded version until a process
   * reports its own, and undefined while neither is known. */
  restoresUsage: boolean | undefined;
  private live: UsageEvent[];
  /** The persisted conversation baseline, for a CLI that turns out to restore conversation totals
   * although the launch's recorded version did not say so (and so no resume probe ran). */
  private readonly retained: ClaudeUsageCheckpoint | null;
  /** A process that has not yet reported its version; its totals cannot be interpreted until then. */
  private pending: { newConversation: boolean } | null = null;
  /** No baseline proves which part of the running process's next result is new. */
  private unproven = false;
  /** The baseline is a persisted checkpoint that no resume probe confirmed this process restored. */
  private unprobed = false;

  constructor(restoresUsage: boolean | undefined, checkpoint?: ClaudeUsageCheckpoint, live?: ClaudeLiveUsage) {
    this.restoresUsage = restoresUsage;
    this.checkpoint = checkpoint?.accountingScope === (restoresUsage ? "conversation" : "process") ? checkpoint : null;
    this.retained = checkpoint?.accountingScope === "conversation" ? checkpoint : null;
    this.live = (live ?? []).filter((event) => event.liveUsage === "provisional").map((event) => ({ ...event }));
  }

  /** A new provider process starts. Its totals are interpreted once it reports its version
   * (`confirmProcess`). `newConversation` is a conversation this process creates. */
  beginProcess(newConversation = false): void {
    this.pending = { newConversation };
  }

  /** The running process reported its Claude Code version, or produced usage without one. Its
   * report outranks the recorded version. Returns the live requests its baseline cannot cover,
   * and a new conversation's zero baseline for the caller to record before any provider work. */
  confirmProcess(sessionId: string, version?: string): { events: UsageEvent[]; baseline: ClaudeUsageCheckpoint | null } {
    const pending = this.pending;
    if (!pending) return { events: [], baseline: null };
    this.pending = null;
    const known = this.restoresUsage;
    const restores = claudeRestoresUsage(version) ?? known;
    this.restoresUsage = restores;
    if (restores === false) {
      // An old CLI's totals restart from zero and can never cover the previous process's live
      // requests, so they are accounted as observed.
      this.checkpoint = null;
      this.unproven = this.unprobed = false;
      return { events: this.accountLive(), baseline: null };
    }
    // The resume probe, or a new conversation's zero baseline, was prepared for this scope.
    if (restores === true && known === true) return { events: [], baseline: null };
    if (pending.newConversation) {
      // Every scope starts a new conversation at zero.
      this.checkpoint = restores ? { sessionId, totalCostUsd: 0, models: {}, accountingScope: "conversation" } : null;
      this.unproven = this.unprobed = false;
      return { events: [], baseline: this.checkpoint };
    }
    if (restores && this.retained?.sessionId === sessionId) {
      this.checkpoint = this.retained;
      this.unprobed = true;
    } else {
      // Unknown scope, or restored conversation totals without a baseline: the next result may
      // include earlier turns, so it must not be billed as this turn's delta.
      this.checkpoint = null;
      this.unproven = true;
    }
    return { events: [], baseline: null };
  }

  /** Adopt a baseline that publishes no delta: a restored prefix no higher than the last one, or a
   * new conversation. It cannot cover live requests, so they are accounted as observed. */
  adoptBaseline(checkpoint: ClaudeUsageCheckpoint | null): UsageEvent[] {
    this.checkpoint = checkpoint;
    // A process of unknown scope may keep its totals across a new conversation.
    if (checkpoint || this.restoresUsage === true) this.unproven = this.unprobed = false;
    return this.accountLive();
  }

  /** A completed top-level request, published while its turn still runs. */
  request(usage: ClaudeRequestUsage): UsageEvent | null {
    const inputTokens = count(usage.inputTokens), outputTokens = count(usage.outputTokens);
    const cachedInputTokens = count(usage.cacheReadInputTokens), cacheCreationInputTokens = count(usage.cacheCreationInputTokens);
    if (!(inputTokens || outputTokens || cachedInputTokens || cacheCreationInputTokens)) return null;
    const event: UsageEvent = { kind: "token_usage", model: usage.model, inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens,
      ...(usage.thinkingTokens === undefined ? {} : { reasoningOutputTokens: Math.min(outputTokens, count(usage.thinkingTokens)) }),
      pricingContext: { requestInputTokens: inputTokens + cachedInputTokens + cacheCreationInputTokens,
        ...(usage.serviceTier ? { serviceTier: usage.serviceTier } : {}) },
      liveUsage: "provisional" };
    this.live.push(event);
    return event;
  }

  result(sessionId: string, result: any, model?: string | null): UsageEvent[] {
    const next = claudeUsageCheckpoint(sessionId, result, this.restoresUsage === true);
    const previous = this.checkpoint?.sessionId === sessionId ? this.checkpoint : null;
    // A crash can zero every counter. It neither erases a baseline nor proves free work.
    if (result.subtype === "error_during_execution" && next?.totalCostUsd === 0 &&
        Object.values(next.models).every((u) => u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens === 0)) return [{ kind: "token_usage", accountingIncomplete: true }];
    if (next && this.unproven) {
      // The first total without a baseline. Later results of this process are differences from it.
      this.unproven = this.unprobed = false;
      this.checkpoint = next;
      return this.uncertain();
    }
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
    if (!next) return events;
    // A cumulative checkpoint covers every request since the previous one, live ones included.
    this.checkpoint = next;
    if (this.unprobed) {
      this.unprobed = false;
      // Without a probe, the restored prefix may lack an interrupted turn whose totals were never
      // persisted. A total that covers the open requests grew by at least what they observed.
      if (!covers(events, this.live)) return this.uncertain();
    }
    return this.settle(events);
  }

  /** Account the requests observed live, and mark the record incomplete rather than exact. The
   * marker comes first and carries the new baseline: a restart part-way through the batch then
   * recovers that baseline with only the requests not yet republished still open, so neither a
   * republished request nor the uncertainty is lost or counted again. */
  private uncertain(): UsageEvent[] {
    const observed = this.live.map((event): UsageEvent => ({ ...event, liveUsage: "republished" }));
    return this.settle([{ kind: "token_usage", accountingIncomplete: true, claudeUsageCheckpoint: this.checkpoint! }, ...observed]);
  }

  /** Close the live window with `events`, the last of which (or a content-free marker) is
   * `settled`. Without an open window the payloads stay exactly as an older peer expects. */
  private settle(events: UsageEvent[]): UsageEvent[] {
    if (this.live.length === 0) return events;
    this.live = [];
    if (events.length === 0) return [{ kind: "token_usage", liveUsage: "settled" }];
    return events.map((event, index) => index === events.length - 1 ? { ...event, liveUsage: "settled" } : event);
  }

  private accountLive(): UsageEvent[] {
    const observed = this.live.map((event): UsageEvent => ({ ...event, liveUsage: "republished" }));
    return this.settle(observed);
  }
}
