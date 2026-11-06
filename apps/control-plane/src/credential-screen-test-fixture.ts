import type { DecisionErrorClass, DecisionKind, DecisionModelResolvedTarget, RunDecisionMessage } from "@wollipog/protocol";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { DECISION_KINDS } from "./decision-kinds.js";
import { DecisionRuntime } from "./decision-runtime.js";
import { EMPTY_GRANT } from "./scope-grant-test-fixture.js";
import { typedAnswersFor, typedOutput, type FakeTypedAnswer } from "./typed-decision-test-fixture.js";

export { typedAnswersFor, typedOutput, type FakeTypedAnswer } from "./typed-decision-test-fixture.js";

/** One fake attempt, never a real provider:
 * - a verdict, with a single-verdict kind's fields (such as a scope grant's). For a typed kind the
 *   fake model answers its questions so that the server derives that verdict (`typedAnswersFor`);
 * - a typed kind's answers by question id, every unlisted question answered satisfied;
 * - raw output text, returned as the harness's structured output;
 * - a typed failure. */
export type FakeDecisionStep =
  | { verdict: string; reason?: string; fields?: Record<string, unknown> }
  | { answers: Readonly<Record<string, FakeTypedAnswer>> }
  | { outputText: string }
  | { errorClass: DecisionErrorClass; retryAfterMs?: number };

/** One fake question-screen attempt. */
export type FakeScreenStep =
  | { verdict: "ask" | "discusses" | "uncertain"; reason?: string }
  | { answers: Readonly<Record<string, FakeTypedAnswer>> }
  | { outputText: string }
  | { errorClass: DecisionErrorClass; retryAfterMs?: number };

/** The request the screen sent, as the model would read it. */
export interface FakeScreenRequest {
  surface: string;
  text?: string;
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  material?: string;
}

const TARGET: DecisionModelResolvedTarget = {
  source: "automatic", runnerId: "r", machineName: "Test Machine", agentId: "claude", harnessName: "Claude Code",
  driver: "claude-code", provider: "claude", model: "haiku", effort: "low",
};

/** The verdict a healthy model gives each #4104 kind when nothing is wrong: it confirms. A scope
 * grant's healthy default names nothing (`EMPTY_GRANT`), so a Custom epic seed holds nothing. */
export const HEALTHY_VERDICTS: Partial<Record<DecisionKind, string>> = {
  credential_screen: "discusses",
  follow_up_relatedness: "related",
  closure_reason: "fits",
  scope_grant: "grant",
};

/** Which kind one attempt is for: every kind has its own fixed instructions. */
export function fakeDecisionKind(message: RunDecisionMessage): DecisionKind {
  const kind = (Object.keys(DECISION_KINDS) as DecisionKind[]).find((name) => DECISION_KINDS[name].instructions === message.instructions);
  if (!kind) throw new Error("the attempt carried unknown instructions");
  return kind;
}

/** The structured output one fake step answers with, or null for a failure. A typed kind's verdict
 * step becomes the answers that derive it: the fake model never names a typed kind's verdict. */
function fakeOutputText(message: RunDecisionMessage, step: FakeDecisionStep): string | null {
  if ("errorClass" in step) return null;
  if ("outputText" in step) return step.outputText;
  const typed = DECISION_KINDS[fakeDecisionKind(message)].typed;
  if ("answers" in step) {
    if (!typed) throw new Error("only a typed kind takes typed answers");
    return JSON.stringify(typedOutput(typed, step.answers));
  }
  if (typed) {
    // A step's reason becomes the deciding answer's evidence, which a refusal shows the Orchestrator.
    const answers = typedAnswersFor(typed, step.verdict);
    const decisive = Object.keys(answers)[0];
    if (decisive && step.reason) answers[decisive] = { ...answers[decisive]!, evidence: step.reason };
    return JSON.stringify(typedOutput(typed, answers));
  }
  const fields = message.instructions === DECISION_KINDS.scope_grant.instructions ? { ...EMPTY_GRANT } : {};
  return JSON.stringify({ verdict: step.verdict, reason: step.reason ?? `The fake model answered ${step.verdict}.`, ...fields, ...step.fields });
}

/** Read one quoted data field back out of one rendered attempt input, parsed as JSON. */
export function fakeDecisionData<T = unknown>(message: RunDecisionMessage, field: string): T {
  const quoted = new RegExp(`<untrusted_data name="${field}">\\n(.*?)\\n</untrusted_data>`, "su").exec(message.input)?.[1];
  if (!quoted) throw new Error(`the attempt carried no ${field} data`);
  return JSON.parse(JSON.parse(quoted) as string) as T;
}

/** Read the quoted `request` data back out of one rendered question-screen attempt input. */
export function fakeScreenRequest(message: RunDecisionMessage): FakeScreenRequest {
  return fakeDecisionData<FakeScreenRequest>(message, "request");
}

/** A Decision runtime on the test's database whose harness answers every kind through `answer`,
 * with a fake clock so backoff never sleeps. `calls` records every attempt the runtime sent. The
 * fake target's runner reports `runnerProtocolVersion` (the current protocol by default), so a typed
 * kind reaches the fake harness unless a test sets an older runner. */
export function fakeDecisionRuntime(db: ControlPlaneDb,
  answer: (message: RunDecisionMessage, attempt: number) => FakeDecisionStep | Promise<FakeDecisionStep>,
  options: { runnerProtocolVersion?: number; target?: DecisionModelResolvedTarget } = {}) {
  const calls: RunDecisionMessage[] = [];
  let clock = Date.now();
  const target = options.target ?? TARGET;
  const protocolVersion = options.runnerProtocolVersion ?? PROTOCOL_VERSION;
  // Only the runtime's capability check sees the fake runner's protocol; everything else is the real database.
  const runtimeDb = Object.assign(Object.create(db) as ControlPlaneDb, {
    getRunner: (id: string) => {
      const real = db.getRunner(id);
      return id === target.runnerId ? { ...(real ?? { runnerId: id }), protocolVersion } as NonNullable<typeof real> : real;
    },
  });
  const runtime = new DecisionRuntime({
    db: runtimeDb,
    settings: { resolve: () => ({ ok: true, target }) },
    transport: async (_runnerId, message) => {
      calls.push(message);
      clock += 100;
      const step = await answer(message, message.attempt);
      const outputText = fakeOutputText(message, step);
      if (outputText !== null) {
        return { type: "run_decision_result", requestId: message.requestId, ok: true, provider: target.provider, model: "claude-haiku-4-5",
          outputText, usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
      }
      const failure = step as Extract<FakeDecisionStep, { errorClass: DecisionErrorClass }>;
      return { type: "run_decision_result", requestId: message.requestId, ok: false, errorClass: failure.errorClass,
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    random: () => 0.5,
  });
  return { runtime, calls };
}

/** A runtime whose question screen answers through `answer`; every other #4104 check gets a
 * healthy, confirming verdict, so a test of one decision is not disturbed by another. */
export function fakeScreenRuntime(db: ControlPlaneDb,
  answer: (request: FakeScreenRequest, attempt: number) => FakeScreenStep | Promise<FakeScreenStep>) {
  return fakeDecisionRuntime(db, (message, attempt) => {
    const kind = fakeDecisionKind(message);
    if (kind === "credential_screen") return answer(fakeScreenRequest(message), attempt);
    const verdict = HEALTHY_VERDICTS[kind];
    if (!verdict) throw new Error(`no healthy verdict for ${kind}`);
    return { verdict };
  });
}

/** A runtime whose every #4104 check confirms what its floor admitted. */
export function healthyDecisionRuntime(db: ControlPlaneDb) {
  return fakeScreenRuntime(db, () => ({ verdict: "discusses" }));
}

/** Wait until every in-flight screen settles: the runtime and its callbacks run on microtasks. */
export async function settleScreens(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}
