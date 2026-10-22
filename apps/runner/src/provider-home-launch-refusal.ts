import { isProviderHomeRecoveryCause, PROVIDER_HOME_RECOVERY_CAUSE_CODES } from "@wollipog/protocol";
import type { AgentDriverKind, ProviderHomeLaunchRefusalCode, ProviderHomeLaunchRefusalView } from "@wollipog/protocol";
import { providerForDriver } from "./provider-accounts.js";
import { ProviderHomeLeaseError, type LeaseWorkerError } from "./provider-home-lease-worker-protocol.js";

/** A coarse code remains compatible with v233; v235 adds the specific recovery cause.
 * Cancellation, deadlines and recovery outcomes stay text only. */
const LAUNCH_REFUSALS: Partial<Record<LeaseWorkerError, ProviderHomeLaunchRefusalCode>> = {
  ...PROVIDER_HOME_RECOVERY_CAUSE_CODES,
  busy: "busy",
  foreign_owner: "foreign_owner",
  foreign_host: "foreign_host",
  unavailable: "unavailable",
  refusal: "unverifiable",
  profile_not_granted: "profile_not_granted",
  profile_changed: "profile_changed",
  profile_unverifiable: "profile_unverifiable",
};

export function providerHomeLaunchRefusalCode(error: unknown): ProviderHomeLaunchRefusalCode | undefined {
  return error instanceof ProviderHomeLeaseError ? LAUNCH_REFUSALS[error.code] : undefined;
}

/** The typed refusal for a session whose launch the provider-HOME lease refused, or undefined for
 * any other failure. Names the bound account, never the HOME's path. */
export function providerHomeLaunchRefusal(
  error: unknown,
  session: {
    driver: AgentDriverKind;
    providerAccountId?: string;
    providerAccountLabel?: string;
  },
  detectedAt = Date.now(),
): ProviderHomeLaunchRefusalView | undefined {
  const code = providerHomeLaunchRefusalCode(error);
  const provider = providerForDriver(session.driver);
  if (!code || !provider) return undefined;
  return {
    code,
    ...(error instanceof ProviderHomeLeaseError && isProviderHomeRecoveryCause(error.code) ? { cause: error.code } : {}),
    provider,
    ...(session.providerAccountId ? {
      providerAccountId: session.providerAccountId,
      providerAccountLabel: session.providerAccountLabel ?? session.providerAccountId,
    } : {}),
    detectedAt,
  };
}
