import type { DecisionErrorClass, DecisionKind, DecisionModelResolvedTarget, RunDecisionMessage } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { DECISION_KINDS } from "./decision-kinds.js";
import { DecisionRuntime } from "./decision-runtime.js";
import { EMPTY_GRANT } from "./scope-grant-test-fixture.js";

/** One fake attempt: a verdict (with a kind's typed fields, such as a scope grant's), or a typed
 * failure. No test calls a real provider. */
export type FakeDecisionStep =
  | { verdict: string; reason?: string; fields?: Record<string, unknown> }
  | { errorClass: DecisionErrorClass; retryAfterMs?: number };

/** One fake question-screen attempt. */
export type FakeScreenStep =
  | { verdict: "ask" | "discusses" | "uncertain"; reason?: string }
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
 * with a fake clock so backoff never sleeps. `calls` records every attempt the runtime sent. */
export function fakeDecisionRuntime(db: ControlPlaneDb,
  answer: (message: RunDecisionMessage, attempt: number) => FakeDecisionStep | Promise<FakeDecisionStep>) {
  const calls: RunDecisionMessage[] = [];
  let clock = Date.now();
  const runtime = new DecisionRuntime({
    db,
    settings: { resolve: () => ({ ok: true, target: TARGET }) },
    transport: async (_runnerId, message) => {
      calls.push(message);
      clock += 100;
      const step = await answer(message, message.attempt);
      const fields = message.instructions === DECISION_KINDS.scope_grant.instructions ? { ...EMPTY_GRANT } : {};
      return "verdict" in step
        ? { type: "run_decision_result", requestId: message.requestId, ok: true, provider: "claude", model: "claude-haiku-4-5",
          outputText: JSON.stringify({ verdict: step.verdict, reason: step.reason ?? `The fake model answered ${step.verdict}.`, ...fields, ...step.fields }),
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }
        : { type: "run_decision_result", requestId: message.requestId, ok: false, errorClass: step.errorClass,
          ...(step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {}) };
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
