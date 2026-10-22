import type { AgentDriverKind, ProviderHomeLaunchRefusalCode, ProviderHomeLaunchRefusalView } from "@wollipog/protocol";
import { providerForDriver } from "./provider-accounts.js";
import { ProviderHomeLeaseError, type LeaseWorkerError } from "./provider-home-lease-worker-protocol.js";

/** The lease worker's codes a session launch reports to the control plane (#3240). Cancellation,
 * deadlines and recovery codes are not a state of the HOME, so they stay text only. */
const LAUNCH_REFUSALS: Partial<Record<LeaseWorkerError, ProviderHomeLaunchRefusalCode>> = {
  busy: "busy",
  holder_alive: "busy",
  boundary_survivor: "busy",
  process_survivor: "busy",
  foreign_owner: "foreign_owner",
  foreign_host: "foreign_host",
  unavailable: "unavailable",
  refusal: "unverifiable",
  boundary_unverifiable: "unverifiable",
  process_uninspectable: "unverifiable",
  process_uninspectable_not_delegated: "unverifiable",
  invalid_journal: "unverifiable",
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
    provider,
    ...(session.providerAccountId ? {
      providerAccountId: session.providerAccountId,
      providerAccountLabel: session.providerAccountLabel ?? session.providerAccountId,
    } : {}),
    detectedAt,
  };
}
