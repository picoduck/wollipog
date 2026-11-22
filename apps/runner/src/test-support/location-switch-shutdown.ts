import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionManager } from "../session-manager.js";

/** shutdownAll initiates cancellation; these fixtures must also wait for its writers to finish.
 * Keep this test-only observation next to the Location-switch fixtures, rather than treating
 * the synchronous shutdown return as an asynchronous production shutdown contract. */
export async function shutdownLocationSwitchManagers(managers: SessionManager[]): Promise<void> {
  const states = managers.map((manager) => manager as unknown as {
    store: { flushAll(): void };
    providerAccountSwitches: Map<string, { promise: Promise<void> }>;
    worktreeRebindings: Map<string, { promise: Promise<void> }>;
    worktreeOperations: Map<string, Promise<unknown>>;
    worktreeReapsInFlight: Map<string, Promise<void>>;
    worktreeSetupRuns: Map<string, unknown>;
    lockTimers: Map<string, unknown>;
    worktreePullRequestReconciling: boolean;
    historyMaintenanceRunning: boolean;
    providerStateReconciling: boolean;
  });
  // shutdownAll clears the replacement maps before their asynchronous continuations settle.
  const replacements = states.flatMap((state) => [
    ...state.providerAccountSwitches.values(), ...state.worktreeRebindings.values(),
  ].map(({ promise }) => promise));
  for (const manager of managers) assert.equal(manager.shutdownAll(), true, "fixture provider disposal failed");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  try {
    await Promise.race([
      (async () => {
        await Promise.all(replacements);
        while (!finished && states.some((state) => state.worktreeOperations.size || state.worktreeReapsInFlight.size ||
          state.worktreeSetupRuns.size || state.lockTimers.size || state.worktreePullRequestReconciling ||
          state.historyMaintenanceRunning || state.providerStateReconciling)) {
          await delay(10);
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Location-switch fixture writers did not settle after shutdown")), 15_000);
      }),
    ]);
    // Continuations can queue fresh debounced metadata after shutdownAll's initial flush.
    for (const state of states) state.store.flushAll();
  } finally {
    finished = true;
    clearTimeout(timeout);
  }
}
