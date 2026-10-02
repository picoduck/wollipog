import {
  runnerCapabilityRequirement,
  runnerCapabilityRequirementDetails,
  type RunnerCapabilityRequirementDetails,
  type RunnerProtocolCapability,
} from "@wollipog/protocol";

/** A refused runner capability gate inside a service result: the shared sentence as `error`, plus
 * the versions that `failureBody` returns beside it. */
export interface CapabilityRefusal {
  error: string;
  capabilityRequirement: RunnerCapabilityRequirementDetails;
}

export function capabilityRefusal(
  protocolVersion: number | null | undefined,
  capability: RunnerProtocolCapability,
  label: string,
): CapabilityRefusal {
  return {
    error: runnerCapabilityRequirement(protocolVersion, capability, label),
    capabilityRequirement: runnerCapabilityRequirementDetails(protocolVersion, capability),
  };
}

/** JSON body for a failed result. A capability refusal adds the required and reported runner
 * protocol versions as additive fields; they are never part of the sentence. */
export function failureBody(
  result: {
    error?: string;
    capabilityRequirement?: RunnerCapabilityRequirementDetails;
    errorDetails?: Record<string, string | number>;
  },
  fallback?: string,
): { error?: string } & Partial<RunnerCapabilityRequirementDetails> & Record<string, unknown> {
  return { ...result.errorDetails, error: result.error ?? fallback, ...result.capabilityRequirement };
}
