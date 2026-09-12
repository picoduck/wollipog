import assert from "node:assert/strict";
import test from "node:test";
import { nativeTuiUnavailableReason } from "./native-tui-availability.js";

/**
 * The six sentences this replaced were rendered as siblings of the control rather than on it, and
 * the predicate that disabled the option was assembled from the same conditions a second time. That
 * duplication is what let one condition — an agent still needing setup — disable Native TUI with no
 * sentence anywhere. These pin each cause to its own message and pin the order.
 */

const AVAILABLE = {
  launchSupported: true,
  agentReady: true,
  orchestrator: false,
  orchestratorTuiSupported: true,
  orchestratorTuiHostContext: true,
  runnerSupported: true,
  startFenceSupported: true,
  hostExecutionTarget: true,
  orchestratorTuiRequirement: "Runner protocol is v108; Orchestrator Native TUI requires v112.",
  startFenceHint: "Initial Native TUI launch requires a newer runner.",
} as const;

const reason = (overrides: Partial<typeof AVAILABLE>) =>
  nativeTuiUnavailableReason({ ...AVAILABLE, ...overrides });

test("a fully supported target says nothing", () => {
  assert.equal(nativeTuiUnavailableReason(AVAILABLE), undefined);
});

test("each cause names itself", () => {
  assert.match(reason({ launchSupported: false }) ?? "", /newer control plane/);
  assert.match(reason({ runnerSupported: false }) ?? "", /Windows or Linux runner/);
  assert.match(reason({ startFenceSupported: false }) ?? "", /newer runner/);
  assert.match(reason({ hostExecutionTarget: false }) ?? "", /host execution target/);
});

test("an agent that needs setup finally has a sentence", () => {
  // This is the regression the refactor exists for. `nativeTuiSupported` included
  // `!selectedAgentOption?.disabled`, so the option went grey and nothing on screen said why.
  assert.match(reason({ agentReady: false }) ?? "", /needs setup/);
});

test("the orchestrator branches apply only under the Orchestrator preset", () => {
  // Both orchestrator conditions were previously guarded on `orchestrator &&`, and dropping that
  // guard would report an Orchestrator requirement to someone who never chose Orchestrator.
  assert.equal(reason({ orchestrator: false, orchestratorTuiSupported: false }), undefined);
  assert.equal(reason({ orchestrator: false, orchestratorTuiHostContext: false }), undefined);

  assert.match(reason({ orchestrator: true, orchestratorTuiSupported: false }) ?? "",
    /requires v112/, "the caller's capability sentence is passed through verbatim");
  assert.match(reason({ orchestrator: true, orchestratorTuiHostContext: false }) ?? "",
    /unavailable for WSL agents/);
});

test("a supported runner is not asked about its start fence before its protocol", () => {
  // Ordering is the order a user can act in. Asserting it keeps a later edit from surfacing
  // "host execution target" to someone whose control plane cannot launch a TUI at all.
  assert.match(reason({
    launchSupported: false,
    agentReady: false,
    runnerSupported: false,
    startFenceSupported: false,
    hostExecutionTarget: false,
  }) ?? "", /newer control plane/);

  assert.match(reason({
    agentReady: false,
    runnerSupported: false,
    hostExecutionTarget: false,
  }) ?? "", /needs setup/);

  assert.match(reason({
    runnerSupported: false,
    hostExecutionTarget: false,
  }) ?? "", /Windows or Linux runner/);
});

test("availability is exactly the absence of a reason", () => {
  // The property the dialog relies on: `nativeTuiSupported` is derived from this function, so the
  // two cannot drift the way the original hand-assembled predicate did. Exhaustive over the seven
  // booleans rather than argued.
  const flags = [
    "launchSupported", "agentReady", "orchestrator", "orchestratorTuiSupported",
    "orchestratorTuiHostContext", "runnerSupported", "startFenceSupported", "hostExecutionTarget",
  ] as const;
  for (let bits = 0; bits < 1 << flags.length; bits += 1) {
    const input = { ...AVAILABLE } as Record<string, unknown>;
    flags.forEach((flag, index) => { input[flag] = Boolean(bits & (1 << index)); });
    const typed = input as Parameters<typeof nativeTuiUnavailableReason>[0];
    const available = nativeTuiUnavailableReason(typed) === undefined;
    // The original predicate, restated independently. If these disagree for any combination, the
    // refactor changed behaviour rather than merely relocating it.
    const original = typed.launchSupported
      && (!typed.orchestrator || typed.orchestratorTuiSupported)
      && typed.runnerSupported
      && typed.startFenceSupported
      && typed.hostExecutionTarget
      && (!typed.orchestrator || typed.orchestratorTuiHostContext)
      && typed.agentReady;
    assert.equal(available, original,
      `disagreed for ${JSON.stringify(typed, flags as unknown as string[])}`);
  }
});
