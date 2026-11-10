/** Secret-free observations. Installation compatibility never proves authentication or access. */
export interface ProviderReadiness {
  checkedAt: number;
  installation: "compatible" | "missing" | "incompatible" | "unknown";
  /** Admission of the installation probe itself, never the selected account's authentication. */
  installationAdmission?: "permitted" | "blocked" | "unknown";
  authentication: "authenticated" | "unauthenticated" | "unknown";
  reason: "ready" | "sign_in_required" | "in_use" | "restricted" | "unknown";
}

/** Copy only the bounded fields: arbitrary peer diagnostics must not enter metadata. */
export function safeProviderReadiness(value: unknown, now = Date.now()): ProviderReadiness | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.checkedAt) || (item.checkedAt as number) < 0 || (item.checkedAt as number) > now + 300_000 ||
      !["compatible", "missing", "incompatible", "unknown"].includes(item.installation as string) ||
      !["authenticated", "unauthenticated", "unknown"].includes(item.authentication as string) ||
      !["ready", "sign_in_required", "in_use", "restricted", "unknown"].includes(item.reason as string)) return undefined;
  if (item.authentication !== (item.reason === "ready" ? "authenticated" : item.reason === "sign_in_required" ? "unauthenticated" : "unknown")) return undefined;
  if (item.installationAdmission !== undefined && !["permitted", "blocked", "unknown"].includes(item.installationAdmission as string)) return undefined;
  return { checkedAt: item.checkedAt as number, installation: item.installation as ProviderReadiness["installation"],
    ...(item.installationAdmission !== undefined ? { installationAdmission: item.installationAdmission as ProviderReadiness["installationAdmission"] } : {}),
    authentication: item.authentication as ProviderReadiness["authentication"], reason: item.reason as ProviderReadiness["reason"] };
}

/** Transport-independent SSH replacement verification. Failed stays failed for upgrade consumers. */
export interface SshHarnessReadiness {
  state: "checking" | "ready" | "failed";
  checkedAt: number;
  reason?: "ownership_blocked" | "installation_regressed" | "authentication_regressed" | "report_timeout";
}

/** A failed session-integration probe is not evidence that the CLI cannot sign in. Legacy
 * Codex login in particular does not need App Server. Reject only proved missing installations. */
export function providerLoginInstallationMissing(agent: {
  providerReadiness?: ProviderReadiness;
  codexAppServer?: { status: string; failure?: { code: string; retryable?: boolean } };
  claudeCode?: { status: string; failure?: { code: string; retryable?: boolean } };
}): boolean {
  if (agent.providerReadiness?.installation === "missing") return true;
  const capability = agent.codexAppServer ?? agent.claudeCode;
  return capability?.status === "unavailable" && capability.failure?.retryable !== true;
}
