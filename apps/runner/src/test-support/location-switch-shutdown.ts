import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionManager } from "../session-manager.js";

const replacementsBeforeShutdown = new WeakMap<SessionManager, Set<Promise<void>>>();

/** Preserve continuations even when a fixture models a mid-test runner restart. */
export function stopLocationSwitchManager(manager: SessionManager): boolean {
  const state = manager as unknown as {
    providerAccountSwitches: Map<string, { promise: Promise<void> }>;
    worktreeRebindings: Map<string, { promise: Promise<void> }>;
  };
  const pending = replacementsBeforeShutdown.get(manager) ?? new Set<Promise<void>>();
  for (const { promise } of [...state.providerAccountSwitches.values(), ...state.worktreeRebindings.values()]) {
    pending.add(promise);
    // Keep the original rejection for final teardown without an unhandled rejection at restart.
    void promise.catch(() => undefined);
  }
  replacementsBeforeShutdown.set(manager, pending);
  return manager.shutdownAll();
}

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
  // Stop every manager even if one provider reports disposal failure.
  const clean = managers.map(stopLocationSwitchManager);
  assert.ok(clean.every(Boolean), "fixture provider disposal failed");
  const replacements = managers.flatMap((manager) => [...replacementsBeforeShutdown.get(manager) ?? []]);
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
