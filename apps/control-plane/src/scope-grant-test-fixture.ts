/**
 * A fake Decision Model harness for Full Control scope grant tests (#4102). It runs the real
 * `DecisionRuntime` (occurrences, attempts, retries and the failure rule) against a scripted
 * transport, so no test ever calls a real provider.
 */
import type { DecisionErrorClass, DecisionModelResolvedTarget, RunDecisionMessage, RunDecisionResultMessage } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { DECISION_KINDS } from "./decision-kinds.js";
import { DecisionRuntime } from "./decision-runtime.js";
import { issueReferenceSpans } from "./first-message-issue-intent.js";
import type { ScopeGrantFields } from "./scope-grant.js";
import { typedOutput } from "./typed-decision-test-fixture.js";

export const FAKE_DECISION_TARGET: DecisionModelResolvedTarget = {
  source: "automatic", runnerId: "r", machineName: "Fixture", agentId: "claude", harnessName: "Claude",
  driver: "claude-code", provider: "claude", model: "claude-haiku-4-5", effort: "low",
};

export type ScopeGrantAnswer = { ok: true; outputText: string } | { ok: false; errorClass: DecisionErrorClass };

export const EMPTY_GRANT: ScopeGrantFields = {
  explicit: [], ranges: [], context: [], selectionRequested: false, selectionRepository: "", selectionCount: 0,
  selectionCriteria: "", selectionConstraints: [], narrowsOperations: false, operations: [],
};

/** A healthy `grant` verdict with these fields over an empty grant. */
export function grantVerdict(fields: Partial<ScopeGrantFields>, reason = "The owner names the issues to fix."): ScopeGrantAnswer {
  return { ok: true, outputText: JSON.stringify({ verdict: "grant", reason, ...EMPTY_GRANT, ...fields }) };
}

export function uncertainVerdict(reason = "The message does not say which issues to work on."): ScopeGrantAnswer {
  return { ok: true, outputText: JSON.stringify({ verdict: "uncertain", reason, ...EMPTY_GRANT }) };
}

export const issues = (...numbers: number[]) => numbers.map((number) => ({ repository: "", number }));

/** The owner's exact message, read back from the rendered Decision input. */
export function ownerMessageOf(message: RunDecisionMessage): string {
  const quoted = /<owner_message>\n([\s\S]*?)\n<\/owner_message>/u.exec(message.input)?.[1];
  if (quoted === undefined) throw new Error("the Decision input carries no owner message");
  return JSON.parse(quoted) as string;
}

/** The default healthy model of these tests: it asks for every exact reference the message writes,
 * and a test whose message also mentions issues as background scripts the model's reading itself.
 * Ranges are named as ranges; the ends of a range that names nothing are context. Test-only:
 * production never derives a grant from text (#4104). */
export function exactReferenceAnswer(text: string, repository = "owner/repo"): ScopeGrantAnswer {
  const explicit = new Set<number>();
  const context = new Set<number>();
  // Each expanded range is one reference: its members share the span's start.
  const members = new Map<number, number[]>();
  for (const span of issueReferenceSpans(text, repository)) {
    if (span.context) context.add(span.number);
    else if (span.range) members.set(span.start, [...members.get(span.start) ?? [], span.number]);
    else explicit.add(span.number);
  }
  const ranges = [...members.values()].map((numbers) => ({ repository: "", first: Math.min(...numbers), last: Math.max(...numbers) }));
  return grantVerdict({ explicit: issues(...[...explicit].filter((n) => !context.has(n))), ranges,
    context: issues(...[...context].filter((n) => !explicit.has(n))) });
}

/** One typed answer of a `scope_check` attempt (#4282): its value, confidence and evidence. */
export type ScopeCheckAnswerOverride = { value: string; confidence?: number; evidence?: string };

/** The satisfying value of each `scope_check` question template. */
const SCOPE_CHECK_SATISFIED: Record<string, string> = {
  count_consistent: "consistent", named_asked_for: "asked_for", constraint_met: "satisfies",
  constraints_complete: "complete", nothing_omitted: "complete", operations_respected: "respected",
};

/** The question parameters a `scope_check` attempt carries, by instance id, read from its rendered input. */
export function scopeCheckParametersOf(message: RunDecisionMessage): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of message.input.matchAll(/<question id="([a-z_]+__\d+)"[^>]*>[\s\S]*?<untrusted_data name="parameter">\n([\s\S]*?)\n<\/untrusted_data>/gu)) {
    found[match[1]!] = JSON.parse(match[2]!) as string;
  }
  return found;
}

/** A complete `scope_check` output for the attempt's own schema: every question satisfied with
 * confidence 0.95, except where `override` returns an answer for an instance id and its parameter. */
export function scopeCheckAnswer(message: RunDecisionMessage,
  override: (questionId: string, parameter: string | undefined) => ScopeCheckAnswerOverride | undefined = () => undefined): ScopeGrantAnswer {
  const properties = (message.outputSchema as { properties: Record<string, unknown> }).properties;
  const parameters = scopeCheckParametersOf(message);
  const output = Object.fromEntries(Object.keys(properties).map((questionId) => {
    const chosen = override(questionId, parameters[questionId]);
    const template = questionId.split("__")[0]!;
    return [questionId, { value: chosen?.value ?? SCOPE_CHECK_SATISFIED[template], confidence: chosen?.confidence ?? 0.95,
      evidence: chosen?.evidence ?? "The owner's words say so." }];
  }));
  return { ok: true, outputText: JSON.stringify(output) };
}

/** A `scope_review` verdict (#4103). */
export function reviewVerdict(verdict: "admit" | "refuse" | "uncertain", reason = "The issues fit the owner's selection."): ScopeGrantAnswer {
  return { ok: true, outputText: JSON.stringify({ verdict, reason }) };
}

/** A runtime whose harness answers each `scope_grant` attempt with `answer`, on the fixture runner's
 * harness. Each `scope_review` attempt (#4103) gets `state.review`'s answer, by default an admit, and
 * is kept in `reviewCalls`. Every other kind gets `other`'s answer: by default a healthy credential
 * screen (#4104) that reads each question as a design subject. `calls` holds only the `scope_grant`
 * attempts; `resolution`, like the real setting, applies to every kind. */
export function fakeScopeGrantRuntime(db: ControlPlaneDb, options: {
  answer?: (ownerMessage: string, attempt: number) => ScopeGrantAnswer;
  other?: (message: RunDecisionMessage) => ScopeGrantAnswer;
  resolution?: { ok: false; errorClass: DecisionErrorClass };
} = {}) {
  const calls: RunDecisionMessage[] = [];
  const reviewCalls: RunDecisionMessage[] = [];
  /** Every `scope_check` attempt (#4282); by default each is answered with every question satisfied. */
  const checkCalls: RunDecisionMessage[] = [];
  const state = { answer: options.answer ?? ((text: string) => exactReferenceAnswer(text)), resolution: options.resolution,
    review: ((_message: RunDecisionMessage, _attempt: number) => reviewVerdict("admit")) as (message: RunDecisionMessage, attempt: number) => ScopeGrantAnswer | Promise<ScopeGrantAnswer>,
    check: ((message: RunDecisionMessage, _attempt: number) => scopeCheckAnswer(message)) as
      (message: RunDecisionMessage, attempt: number) => ScopeGrantAnswer | Promise<ScopeGrantAnswer> };
  const scopeCheck = (message: RunDecisionMessage) => message.instructions === DECISION_KINDS.scope_check.instructions;
  // Every other kind confirms: a typed kind (#4283) answers its questions satisfied, so the server
  // derives its confirming verdict (the credential screen's `discusses`).
  const other = options.other ?? ((message: RunDecisionMessage) => {
    const typed = Object.values(DECISION_KINDS).find((definition) => definition.instructions === message.instructions)?.typed;
    return { ok: true as const, outputText: JSON.stringify(typed ? typedOutput(typed)
      : { verdict: "discusses", reason: "The request discusses access as a design subject." }) };
  });
  const scopeGrant = (message: RunDecisionMessage) => message.instructions === DECISION_KINDS.scope_grant.instructions;
  const scopeReview = (message: RunDecisionMessage) => message.instructions === DECISION_KINDS.scope_review.instructions;
  const runtime = new DecisionRuntime({
    db,
    settings: { resolve: () => state.resolution ?? { ok: true, target: FAKE_DECISION_TARGET } },
    transport: async (_runnerId, message) => {
      if (scopeGrant(message)) calls.push(message);
      if (scopeReview(message)) reviewCalls.push(message);
      if (scopeCheck(message)) checkCalls.push(message);
      const answer = scopeGrant(message) ? state.answer(ownerMessageOf(message), message.attempt)
        : scopeReview(message) ? await state.review(message, message.attempt)
          : scopeCheck(message) ? await state.check(message, message.attempt) : other(message);
      return { type: "run_decision_result", requestId: message.requestId, provider: "claude", model: FAKE_DECISION_TARGET.model,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, ...answer } as RunDecisionResultMessage;
    },
    sleep: async () => {},
    random: () => 0.5,
  });
  return { runtime, calls, reviewCalls, checkCalls, state };
}
