import type { DecisionErrorClass, DecisionModelResolvedTarget, RunDecisionMessage } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { DecisionRuntime } from "./decision-runtime.js";

/** One fake attempt: a verdict, or a typed failure. No test calls a real provider. */
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

/** Read the quoted `request` data back out of one rendered attempt input. */
export function fakeScreenRequest(message: RunDecisionMessage): FakeScreenRequest {
  const quoted = /<untrusted_data name="request">\n(.*)\n<\/untrusted_data>/su.exec(message.input)?.[1];
  if (!quoted) throw new Error("the attempt carried no request data");
  return JSON.parse(JSON.parse(quoted) as string) as FakeScreenRequest;
}

/** A Decision runtime on the test's database whose harness answers through `answer`, with a fake
 * clock so backoff never sleeps. `calls` records every attempt the runtime sent. */
export function fakeScreenRuntime(db: ControlPlaneDb,
  answer: (request: FakeScreenRequest, attempt: number) => FakeScreenStep | Promise<FakeScreenStep>) {
  const calls: RunDecisionMessage[] = [];
  let clock = Date.now();
  const runtime = new DecisionRuntime({
    db,
    settings: { resolve: () => ({ ok: true, target: TARGET }) },
    transport: async (_runnerId, message) => {
      calls.push(message);
      clock += 100;
      const step = await answer(fakeScreenRequest(message), message.attempt);
      return "verdict" in step
        ? { type: "run_decision_result", requestId: message.requestId, ok: true, provider: "claude", model: "claude-haiku-4-5",
          outputText: JSON.stringify({ verdict: step.verdict, reason: step.reason ?? `The request ${step.verdict === "ask" ? "asks for" : "discusses"} access.` }),
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

/** Wait until every in-flight screen settles: the runtime and its callbacks run on microtasks. */
export async function settleScreens(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}
