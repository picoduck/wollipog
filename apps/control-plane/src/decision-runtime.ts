import { randomUUID } from "node:crypto";
import type {
  DecisionErrorClass,
  DecisionPricingContext,
  DecisionKind,
  DecisionModelResolvedTarget,
  DecisionOccurrenceView,
  DecisionTypedAnswersView,
  RunDecisionMessage,
  RunDecisionResultMessage,
} from "@wollipog/protocol";
import {
  DECISION_ATTEMPT_BUDGET_MS,
  DECISION_ERROR_CLASSES,
  DECISION_OUTPUT_MAX_BYTES,
  DECISION_TRANSIENT_ERROR_CLASSES,
  DECISION_TRANSPORT_MARGIN_MS,
  runnerSupportsProtocol,
} from "@wollipog/protocol";
import type { ControlPlaneDb, DecisionAttemptRecord, DecisionOccurrenceRecord } from "./db.js";
import {
  assertDecisionKind,
  DECISION_KINDS,
  decisionInputDigests,
  decisionRequestDigest,
  prepareDecision,
  validateDecisionOutput,
  type DecisionInputs,
  type DecisionKindDefinition,
  type PreparedDecision,
} from "./decision-kinds.js";
import { deriveTypedVerdict, validateTypedAnswers } from "./decision-questions.js";
import type { DecisionAutomaticHarness, DecisionModelSettings } from "./decision-model-settings.js";
import { isRunnerRequestNotSentError, isRunnerRequestTimeoutError, type Hub } from "./hub.js";
import { priceUsage, sameRequestInputTier, type RateTable } from "./usage-pricing.js";

/** Small and fixed: at most this many attempts per occurrence. */
export const DECISION_MAX_ATTEMPTS = 3;
/** Every attempt and wait of one occurrence fits inside this bound, measured from its creation. */
export const DECISION_TOTAL_BOUND_MS = 90_000;
/** An attempt is not started with less time than this left in the bound. */
export const DECISION_MIN_ATTEMPT_MS = 5_000;
export const DECISION_BACKOFF_BASE_MS = 1_000;
export const DECISION_BACKOFF_CAP_MS = 8_000;

/** The outcome of one occurrence. A verdict other than `uncertain` is the only outcome a caller
 * may act on, and only to narrow or confirm what it proposed. */
export type DecisionOutcome =
  | {
      outcome: "verdict";
      occurrenceId: string;
      verdict: string;
      reason: string;
      fields: Record<string, unknown>;
    }
  | {
      outcome: "human_required";
      occurrenceId: string;
      cause: "uncertain" | "failed";
      /** The verdict's reason, when the model answered `uncertain`. */
      reason?: string;
      failureClass?: DecisionErrorClass;
      /** The caller's one typed, person-owned request; null when it creates none (the Test). */
      humanRequestId: string | null;
    };

export interface DecisionRequest {
  organizationId: string;
  kind: DecisionKind;
  inputs: DecisionInputs;
  /** The campaign root the decision serves, for attribution and Campaign Status. */
  campaignSessionId?: string | null;
  /** The caller's idempotency key for this decision. A repeated call with the same key joins the
   * same occurrence and never creates a second verdict or a second person-owned request. */
  occurrenceKey?: string | null;
  /** The campaign runner's own harness, which Automatic uses. */
  automaticHarness?: DecisionAutomaticHarness | null;
  /** Create the caller's one typed, person-owned request for an uncertain or failed occurrence and
   * return its id. A compare-and-set claim lets only one call route an occurrence; a throw releases
   * the claim. It must be idempotent per occurrence id: a claim interrupted by a restart is routed
   * again, and the existing request must be returned rather than a second one created. */
  routeToHuman(occurrence: DecisionOccurrenceRecord): Promise<string | null> | string | null;
}

/** One attempt on the wire. It must settle within `timeoutMs`, its whole round-trip allowance,
 * which already includes any transport margin. Tests replace it with a fake harness. */
export type DecisionAttemptTransport = (
  runnerId: string,
  message: RunDecisionMessage,
  timeoutMs: number,
) => Promise<RunDecisionResultMessage>;

export interface DecisionRuntimeOptions {
  db: ControlPlaneDb;
  settings: Pick<DecisionModelSettings, "resolve">;
  transport: DecisionAttemptTransport;
  rateTable?: () => RateTable | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** The kinds this runtime runs. Tests add typed kinds; production uses DECISION_KINDS. */
  kinds?: Readonly<Record<string, DecisionKindDefinition>>;
}

const TRANSIENT = new Set<DecisionErrorClass>(DECISION_TRANSIENT_ERROR_CLASSES);
const KNOWN_CLASSES = new Set<DecisionErrorClass>(DECISION_ERROR_CLASSES);

function knownClass(value: unknown): DecisionErrorClass {
  return typeof value === "string" && KNOWN_CLASSES.has(value as DecisionErrorClass)
    ? value as DecisionErrorClass
    : "provider_failed";
}

/** Map a hub failure onto an attempt error class. */
export function decisionTransportErrorClass(error: unknown): DecisionErrorClass {
  if (isRunnerRequestTimeoutError(error)) return "timed_out";
  if (isRunnerRequestNotSentError(error)) return "transport";
  return "transport";
}

/** The production transport: one correlated runner request per attempt. */
export function hubDecisionTransport(hub: Pick<Hub, "requestFromRunner">): DecisionAttemptTransport {
  return async (runnerId, message, timeoutMs) => {
    try {
      // The runner's own budget (message.timeoutMs) leaves the transport margin inside timeoutMs.
      const result = await hub.requestFromRunner(runnerId, message.requestId, message, timeoutMs);
      if (result.type !== "run_decision_result") {
        return { type: "run_decision_result", requestId: message.requestId, ok: false, errorClass: "invalid_output" };
      }
      return result;
    } catch (error) {
      return {
        type: "run_decision_result",
        requestId: message.requestId,
        ok: false,
        errorClass: decisionTransportErrorClass(error),
      };
    }
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 1e12) : 0;
}

/** A malformed coordinate is dropped, so a model whose rate depends on it stays unpriced. */
function sanitizedPricing(pricing: unknown): DecisionPricingContext | undefined {
  if (!pricing || typeof pricing !== "object") return undefined;
  const { serviceTier, requestInputTokens: range } = pricing as Record<string, unknown>;
  const tier = typeof serviceTier === "string" && serviceTier && serviceTier.length <= 64 ? serviceTier : undefined;
  const { min, max } = (range && typeof range === "object" ? range : {}) as { min?: unknown; max?: unknown };
  const requestInputTokens = Number.isSafeInteger(min) && Number.isSafeInteger(max) &&
      (min as number) >= 0 && (min as number) <= (max as number)
    ? { min: min as number, max: max as number }
    : undefined;
  return tier || requestInputTokens
    ? { ...(tier ? { serviceTier: tier } : {}), ...(requestInputTokens ? { requestInputTokens } : {}) }
    : undefined;
}

/** Validate the only runner fields allowed across the Decision boundary. */
export function sanitizeRunDecisionResult(message: RunDecisionResultMessage): RunDecisionResultMessage | null {
  if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 200) return null;
  const provider = message.provider === "claude" || message.provider === "codex" ? message.provider : undefined;
  const model = typeof message.model === "string" && message.model.length <= 200 ? message.model : undefined;
  const usage = message.usage && typeof message.usage === "object" ? {
    inputTokens: count(message.usage.inputTokens),
    outputTokens: count(message.usage.outputTokens),
    cacheReadInputTokens: count(message.usage.cacheReadInputTokens),
    cacheCreationInputTokens: count(message.usage.cacheCreationInputTokens),
  } : undefined;
  const pricing = sanitizedPricing(message.pricing);
  const common = {
    type: "run_decision_result" as const,
    requestId: message.requestId,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(pricing ? { pricing } : {}),
  };
  if (message.ok === true) {
    if (typeof message.outputText !== "string" ||
        Buffer.byteLength(message.outputText, "utf8") > DECISION_OUTPUT_MAX_BYTES) {
      return { ...common, ok: false, errorClass: "invalid_output" };
    }
    return { ...common, ok: true, outputText: message.outputText };
  }
  const retryAfterMs = typeof message.retryAfterMs === "number" && Number.isFinite(message.retryAfterMs) &&
      message.retryAfterMs >= 0
    ? Math.min(Math.floor(message.retryAfterMs), 24 * 60 * 60 * 1000)
    : undefined;
  return {
    ...common,
    ok: false,
    errorClass: knownClass(message.errorClass),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** Project an occurrence for clients: digests, verdict, bounded reason, attempts and usage only. */
export function decisionOccurrenceView(
  occurrence: DecisionOccurrenceRecord,
  attempts: readonly DecisionAttemptRecord[],
): DecisionOccurrenceView {
  const unpriced = attempts.some((attempt) => attempt.hasUsage && attempt.costUsd === null);
  return {
    occurrenceId: occurrence.occurrenceId,
    kind: occurrence.kind as DecisionKind,
    promptVersion: occurrence.promptVersion,
    state: occurrence.state,
    ...(occurrence.verdict !== null ? { verdict: occurrence.verdict } : {}),
    ...(occurrence.reason !== null ? { reason: occurrence.reason } : {}),
    ...(occurrence.failureClass !== null ? { failureClass: knownClass(occurrence.failureClass) } : {}),
    ...(occurrence.humanRequestId !== null ? { humanRequestId: occurrence.humanRequestId } : {}),
    ...(occurrence.target ? { target: occurrence.target } : {}),
    inputDigests: occurrence.inputDigests,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      ...(attempt.errorClass !== null ? { errorClass: knownClass(attempt.errorClass) } : {}),
      ...(attempt.model !== null ? { model: attempt.model } : {}),
      latencyMs: attempt.latencyMs ?? 0,
    })),
    usage: {
      inputTokens: attempts.reduce((total, attempt) => total + attempt.inputTokens, 0),
      outputTokens: attempts.reduce((total, attempt) => total + attempt.outputTokens, 0),
      cacheReadInputTokens: attempts.reduce((total, attempt) => total + attempt.cacheReadInputTokens, 0),
      cacheCreationInputTokens: attempts.reduce((total, attempt) => total + attempt.cacheCreationInputTokens, 0),
      costUsd: unpriced ? null : attempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0),
    },
    createdAt: occurrence.createdAt,
    ...(occurrence.decidedAt !== null ? { decidedAt: occurrence.decidedAt } : {}),
    ...(occurrence.typedAnswers ? { typedAnswers: occurrence.typedAnswers } : {}),
  };
}

/**
 * Runs typed control-plane decisions on the organization's Decision Model (#4101).
 *
 * The occurrence is created before the first attempt. Attempts reuse the same rendered input and
 * digest; transient failures are retried with exponential backoff and jitter, honoring a provider
 * Retry-After, inside a small attempt budget and a total time bound. The occurrence accepts exactly
 * one outcome by compare-and-set, so a late or duplicate attempt is discarded. `uncertain` is a
 * real answer and is never retried. A failed or uncertain occurrence gets exactly one call to the
 * caller's `routeToHuman`; nothing ever falls back to parsing text.
 */
export class DecisionRuntime {
  private readonly inflight = new Map<string, Promise<DecisionOutcome>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly kinds: Readonly<Record<string, DecisionKindDefinition>>;

  constructor(private readonly options: DecisionRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.kinds = options.kinds ?? DECISION_KINDS;
    for (const definition of Object.values(this.kinds)) assertDecisionKind(definition);
  }

  async decide(request: DecisionRequest): Promise<DecisionOutcome> {
    const definition = Object.hasOwn(this.kinds, request.kind) ? this.kinds[request.kind] : undefined;
    if (!definition) throw new Error(`unknown decision kind ${String(request.kind)}`);
    const prepared = prepareDecision(definition, request.inputs);
    const rendered = prepared.rendered;
    const { occurrence, created } = this.options.db.createDecisionOccurrence({
      occurrenceId: `dec_${randomUUID()}`,
      organizationId: request.organizationId,
      campaignSessionId: request.campaignSessionId ?? null,
      occurrenceKey: request.occurrenceKey ?? null,
      kind: definition.kind,
      promptVersion: definition.promptVersion,
      inputDigests: decisionInputDigests(request.inputs),
      inputDigest: decisionRequestDigest(definition, rendered),
      now: this.now(),
    });
    if (!created && occurrence.inputDigest !== decisionRequestDigest(definition, rendered)) {
      throw new Error("an occurrence key was reused with different decision inputs");
    }
    const running = this.inflight.get(occurrence.occurrenceId);
    if (running) return running;
    const work = (async () => {
      if (occurrence.state === "pending") await this.attempt(occurrence, definition, prepared, request);
      return this.outcome(occurrence.occurrenceId, request);
    })();
    this.inflight.set(occurrence.occurrenceId, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(occurrence.occurrenceId);
    }
  }

  /** Read an occurrence for clients. */
  view(occurrenceId: string): DecisionOccurrenceView | null {
    const occurrence = this.options.db.getDecisionOccurrence(occurrenceId);
    return occurrence ? decisionOccurrenceView(occurrence, this.options.db.listDecisionAttempts(occurrenceId)) : null;
  }

  private backoffMs(attempt: number): number {
    const ceiling = Math.min(DECISION_BACKOFF_CAP_MS, DECISION_BACKOFF_BASE_MS * 2 ** (attempt - 1));
    // Equal jitter: at least half the exponential step, so retries spread without collapsing to zero.
    return Math.round(ceiling / 2 + this.random() * (ceiling / 2));
  }

  private fail(occurrenceId: string, failureClass: DecisionErrorClass): void {
    this.options.db.settleDecisionOccurrence(occurrenceId, { state: "failed", failureClass, now: this.now() });
  }

  /** The rate table is the only source, so a Claude and a Codex cost mean the same thing and a model
   * the table can't price stays unpriced whatever the provider reports. A tier or size that's missing,
   * or a range of request sizes that spans a rate threshold, leaves a model that depends on it unpriced. */
  private cost(
    model: string | undefined,
    usage: RunDecisionResultMessage["usage"],
    pricing: RunDecisionResultMessage["pricing"],
  ): number | null {
    if (!usage) return null;
    const table = this.options.rateTable?.() ?? null;
    const input = pricing?.requestInputTokens;
    const priced = priceUsage(table, model, {
      uncachedInputTokens: usage.inputTokens,
      cachedInputTokens: usage.cacheReadInputTokens,
      cacheCreationTokens: usage.cacheCreationInputTokens,
      outputTokens: usage.outputTokens,
    }, null, {
      ...(pricing?.serviceTier ? { serviceTier: pricing.serviceTier } : {}),
      ...(input && sameRequestInputTier(table, model, input.min, input.max) ? { requestInputTokens: input.max } : {}),
    });
    return priced.costSource === "unpriced" ? null : priced.costUsd;
  }

  private async attempt(
    occurrence: DecisionOccurrenceRecord,
    definition: DecisionKindDefinition,
    prepared: PreparedDecision,
    request: DecisionRequest,
  ): Promise<void> {
    const { db } = this.options;
    const { rendered, outputSchema } = prepared;
    // A control plane that restarted mid-occurrence closes the attempts it lost and continues inside
    // the same attempt budget and time bound; it never starts the count again.
    const previous = db.listDecisionAttempts(occurrence.occurrenceId);
    for (const lost of previous.filter((attempt) => attempt.latencyMs === null)) {
      db.finishDecisionAttempt(occurrence.occurrenceId, lost.attempt, {
        latencyMs: this.now() - lost.startedAt,
        errorClass: "transport",
        costUsd: null,
      });
    }
    let attempt = previous.length;
    const deadline = occurrence.createdAt + DECISION_TOTAL_BOUND_MS;
    let lastClass: DecisionErrorClass = previous.at(-1)?.errorClass
      ? knownClass(previous.at(-1)!.errorClass)
      : "timed_out";
    const resolution = this.options.settings.resolve(occurrence.organizationId, request.automaticHarness ?? null);
    if (resolution.target) db.recordDecisionTarget(occurrence.occurrenceId, resolution.target);
    // A typed call goes only to a runner that accepts its schema and output (#4283). An older runner
    // is non-transient like any other incapable target: it never receives the call.
    const preflightFailure: DecisionErrorClass | null = !resolution.ok
      ? resolution.errorClass
      : prepared.questions && !runnerSupportsProtocol(db.getRunner(resolution.target.runnerId)?.protocolVersion, "typedDecisionQuestions")
        ? "runner_incapable"
        : null;
    if (!resolution.ok || preflightFailure) {
      // A missing runner, harness, model or credential is non-transient: one audited attempt that
      // never reached a provider, then the person-owned route. Never a silent pass.
      attempt++;
      db.startDecisionAttempt(occurrence.occurrenceId, attempt, `decision_preflight_${randomUUID()}`, this.now());
      db.finishDecisionAttempt(occurrence.occurrenceId, attempt, { latencyMs: 0, errorClass: preflightFailure!, costUsd: null });
      this.fail(occurrence.occurrenceId, preflightFailure!);
      return;
    }
    const target: DecisionModelResolvedTarget = resolution.target;
    while (attempt < DECISION_MAX_ATTEMPTS) {
      const remaining = deadline - this.now();
      if (remaining < DECISION_MIN_ATTEMPT_MS + DECISION_TRANSPORT_MARGIN_MS) break;
      attempt++;
      const requestId = `decision_${randomUUID()}`;
      const startedAt = this.now();
      db.startDecisionAttempt(occurrence.occurrenceId, attempt, requestId, startedAt);
      // The round trip, including the transport margin, ends inside the occurrence's bound.
      const timeoutMs = Math.min(DECISION_ATTEMPT_BUDGET_MS + DECISION_TRANSPORT_MARGIN_MS, remaining);
      const raw = await this.options.transport(target.runnerId, {
        type: "run_decision",
        requestId,
        occurrenceId: occurrence.occurrenceId,
        attempt,
        target: { agentId: target.agentId, driver: target.driver, model: target.model, effort: target.effort },
        instructions: definition.instructions,
        input: rendered,
        outputSchema,
        timeoutMs: timeoutMs - DECISION_TRANSPORT_MARGIN_MS,
      }, timeoutMs);
      const result = sanitizeRunDecisionResult(raw) ??
        { type: "run_decision_result" as const, requestId, ok: false, errorClass: "invalid_output" as const };
      // An answer after the occurrence's bound is late, whatever it says: it never settles a verdict.
      const late = this.now() > deadline;
      const answered = !late && result.ok && result.outputText !== undefined ? result.outputText : null;
      const validated = answered === null ? null : this.validate(definition, prepared, answered);
      const errorClass: DecisionErrorClass | null = validated
        ? null
        : late ? "timed_out" : result.ok ? "invalid_output" : knownClass(result.errorClass);
      db.finishDecisionAttempt(occurrence.occurrenceId, attempt, {
        latencyMs: this.now() - startedAt,
        errorClass,
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        // The model that answered sets the rate. With none reported, an exact target id can still be
        // priced, and an alias such as `haiku` can't: the table never prices a bare family name.
        costUsd: this.cost(result.model ?? target.model, result.usage, result.pricing),
      });
      if (validated) {
        // Compare-and-set: whichever answer settles first is the only verdict. A late or duplicate
        // answer for this occurrence changes nothing.
        db.settleDecisionOccurrence(occurrence.occurrenceId, {
          state: validated.verdict === "uncertain" ? "uncertain" : "decided",
          verdict: validated.verdict,
          reason: validated.reason,
          fields: validated.fields,
          ...(validated.typedAnswers ? { typedAnswers: validated.typedAnswers } : {}),
          now: this.now(),
        });
        return;
      }
      lastClass = errorClass!;
      if (!TRANSIENT.has(lastClass) || attempt >= DECISION_MAX_ATTEMPTS) break;
      const wait = Math.max(this.backoffMs(attempt), result.retryAfterMs ?? 0);
      // A Retry-After or backoff that would leave no room for another attempt ends the retries.
      if (this.now() + wait + DECISION_MIN_ATTEMPT_MS + DECISION_TRANSPORT_MARGIN_MS > deadline) break;
      await this.sleep(wait);
      if (db.getDecisionOccurrence(occurrence.occurrenceId)?.state !== "pending") return;
    }
    this.fail(occurrence.occurrenceId, lastClass);
  }

  /** Validate one attempt's output. A typed kind's answers are validated strictly and its verdict is
   * derived here from them; the model's output never names a verdict. Null means invalid output. */
  private validate(definition: DecisionKindDefinition, prepared: PreparedDecision, outputText: string): {
    verdict: string;
    reason: string;
    fields: Record<string, unknown>;
    typedAnswers?: DecisionTypedAnswersView;
  } | null {
    if (!prepared.questions || !definition.typed) return validateDecisionOutput(definition, outputText);
    const answers = validateTypedAnswers(prepared.questions, outputText);
    if (!answers) return null;
    const derived = deriveTypedVerdict(definition.typed, prepared.questions, answers);
    return { verdict: derived.verdict, reason: derived.reason, fields: {}, typedAnswers: derived.typedAnswers };
  }

  private async outcome(occurrenceId: string, request: DecisionRequest): Promise<DecisionOutcome> {
    const { db } = this.options;
    const occurrence = db.getDecisionOccurrence(occurrenceId)!;
    if (occurrence.state === "decided") {
      return {
        outcome: "verdict",
        occurrenceId,
        verdict: occurrence.verdict!,
        reason: occurrence.reason!,
        fields: occurrence.fields,
      };
    }
    if (occurrence.state === "pending") throw new Error("the decision occurrence has no outcome yet");
    let humanRequestId = occurrence.humanRequestId;
    // This process runs one outcome per occurrence at a time (the in-flight map), so a claim that
    // never finished belongs to a run that stopped mid-routing: route it again. The caller's
    // idempotency per occurrence returns the request it may already have created.
    const interrupted = occurrence.humanRouteClaimedAt !== null && occurrence.humanRoutedAt === null;
    if (interrupted || db.claimDecisionHumanRoute(occurrenceId, this.now())) {
      try {
        humanRequestId = await request.routeToHuman(db.getDecisionOccurrence(occurrenceId)!);
      } catch (error) {
        db.releaseDecisionHumanRoute(occurrenceId);
        throw error;
      }
      db.completeDecisionHumanRoute(occurrenceId, humanRequestId, this.now());
      humanRequestId = db.getDecisionOccurrence(occurrenceId)!.humanRequestId;
    }
    return {
      outcome: "human_required",
      occurrenceId,
      cause: occurrence.state,
      ...(occurrence.state === "uncertain" && occurrence.reason ? { reason: occurrence.reason } : {}),
      ...(occurrence.failureClass ? { failureClass: knownClass(occurrence.failureClass) } : {}),
      humanRequestId: humanRequestId ?? null,
    };
  }
}
