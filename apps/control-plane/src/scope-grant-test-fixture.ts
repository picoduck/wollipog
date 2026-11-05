/**
 * A fake Decision Model harness for Full Control scope grant tests (#4102). It runs the real
 * `DecisionRuntime` (occurrences, attempts, retries and the failure rule) against a scripted
 * transport, so no test ever calls a real provider.
 */
import type { DecisionErrorClass, DecisionModelResolvedTarget, RunDecisionMessage, RunDecisionResultMessage } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { DECISION_KINDS } from "./decision-kinds.js";
import { DecisionRuntime } from "./decision-runtime.js";
import { firstMessageIssueIntent, issueReferenceSpans } from "./first-message-issue-intent.js";
import type { ScopeGrantFields } from "./scope-grant.js";

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

/** A stand-in for a healthy model in the tests that predate the Decision Model: it answers what the
 * retired first-message classifier read, so those tests keep exercising the floors and ceilings.
 * Test-only; production never derives a grant from text. */
export function classifierAnswer(text: string, repository = "owner/repo"): ScopeGrantAnswer {
  const intent = firstMessageIssueIntent(text, repository);
  // Each expanded range is one reference: its members share the span's start.
  const members = new Map<number, number[]>();
  for (const span of issueReferenceSpans(text, repository)) {
    if (span.range && !span.context) members.set(span.start, [...members.get(span.start) ?? [], span.number]);
  }
  const ranges: ScopeGrantFields["ranges"] = [];
  const ranged = new Set<number>();
  for (const numbers of members.values()) {
    if (!numbers.every((n) => intent.scope.includes(n))) continue;
    ranges.push({ repository: "", first: Math.min(...numbers), last: Math.max(...numbers) });
    for (const n of numbers) ranged.add(n);
  }
  return grantVerdict({ explicit: issues(...intent.scope.filter((n) => !ranged.has(n))), ranges, context: issues(...intent.context) });
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
  const state = { answer: options.answer ?? ((text: string) => classifierAnswer(text)), resolution: options.resolution,
    review: ((_message: RunDecisionMessage, _attempt: number) => reviewVerdict("admit")) as (message: RunDecisionMessage, attempt: number) => ScopeGrantAnswer | Promise<ScopeGrantAnswer> };
  const other = options.other ??
    (() => ({ ok: true as const, outputText: JSON.stringify({ verdict: "discusses", reason: "The request discusses access as a design subject." }) }));
  const scopeGrant = (message: RunDecisionMessage) => message.instructions === DECISION_KINDS.scope_grant.instructions;
  const scopeReview = (message: RunDecisionMessage) => message.instructions === DECISION_KINDS.scope_review.instructions;
  const runtime = new DecisionRuntime({
    db,
    settings: { resolve: () => state.resolution ?? { ok: true, target: FAKE_DECISION_TARGET } },
    transport: async (_runnerId, message) => {
      if (scopeGrant(message)) calls.push(message);
      if (scopeReview(message)) reviewCalls.push(message);
      const answer = scopeGrant(message) ? state.answer(ownerMessageOf(message), message.attempt)
        : scopeReview(message) ? await state.review(message, message.attempt) : other(message);
      return { type: "run_decision_result", requestId: message.requestId, provider: "claude", model: FAKE_DECISION_TARGET.model,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, ...answer } as RunDecisionResultMessage;
    },
    sleep: async () => {},
    random: () => 0.5,
  });
  return { runtime, calls, reviewCalls, state };
}
