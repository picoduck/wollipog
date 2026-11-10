/** Secret-free observations. Installation compatibility never proves authentication or access. */
export interface ProviderReadiness {
  checkedAt: number;
  installation: "compatible" | "missing" | "incompatible" | "unknown";
  authentication: "authenticated" | "unauthenticated" | "unknown";
  reason: "ready" | "sign_in_required" | "in_use" | "restricted" | "unknown";
}

/** Copy only the bounded fields: arbitrary peer diagnostics must not enter metadata. */
export function safeProviderReadiness(value: unknown): ProviderReadiness | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.checkedAt) || (item.checkedAt as number) < 0 ||
      !["compatible", "missing", "incompatible", "unknown"].includes(item.installation as string) ||
      !["authenticated", "unauthenticated", "unknown"].includes(item.authentication as string) ||
      !["ready", "sign_in_required", "in_use", "restricted", "unknown"].includes(item.reason as string)) return undefined;
  return { checkedAt: item.checkedAt as number, installation: item.installation as ProviderReadiness["installation"],
    authentication: item.authentication as ProviderReadiness["authentication"], reason: item.reason as ProviderReadiness["reason"] };
}

/** Transport-independent SSH replacement verification. Failed stays failed for upgrade consumers. */
export interface SshHarnessReadiness {
  state: "checking" | "ready" | "failed";
  checkedAt: number;
  reason?: "ownership_blocked" | "installation_regressed" | "authentication_regressed" | "report_timeout";
}
