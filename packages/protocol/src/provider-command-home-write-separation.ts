/** Runner-enforced separation between provider-owned credential-home writes and model command
 * subprocess writes. This says nothing about a provider's own nested sandbox. No current runner
 * implements complete mediation, so this version deliberately has no protected state. */
export interface ProviderCommandHomeWriteSeparation {
  version: 1;
  status: "unprotected" | "unavailable";
  reason: "unsupported_command_mediation" | "incomplete_adapter_coverage" | "unsupported_host";
}

/** Older runners omit the report. Missing, malformed or future reports are unknown, never proof
 * of protection. Return fixed content-free data rather than forwarding arbitrary diagnostics. */
export function knownProviderCommandHomeWriteSeparation(
  report: unknown,
): ProviderCommandHomeWriteSeparation | undefined {
  if (report && typeof report === "object") {
    const value = report as Record<string, unknown>;
    if (value.version === 1 && value.status === "unavailable" && value.reason === "unsupported_host") {
      return { version: 1, status: "unavailable", reason: "unsupported_host" };
    }
    if (value.version === 1 && value.status === "unprotected" &&
        (value.reason === "unsupported_command_mediation" || value.reason === "incomplete_adapter_coverage")) {
      return { version: 1, status: "unprotected", reason: value.reason };
    }
  }
  return undefined;
}

export function providerCommandHomeWriteSeparationReport(
  report: unknown,
): ProviderCommandHomeWriteSeparation | { status: "unknown"; reason: "report_unavailable" } {
  return knownProviderCommandHomeWriteSeparation(report) ?? { status: "unknown", reason: "report_unavailable" };
}
