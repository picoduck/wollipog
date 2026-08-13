export interface PolicyHookReconciler {
  reconcilePolicyHookTimeouts(now: number): number;
}

export interface PolicyHookMaintenanceLog {
  warn(fields: { error: string }, message: string): void;
}

/** Keep a malformed/conflicting durable approval row from escaping a timer callback and
 * terminating the control plane. A later tick still retries reconciliation. */
export function reconcilePolicyHooksSafely(
  service: PolicyHookReconciler,
  log: PolicyHookMaintenanceLog,
  now = Date.now(),
): boolean {
  try {
    service.reconcilePolicyHookTimeouts(now);
    return true;
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "policy-hook approval reconciliation deferred",
    );
    return false;
  }
}
