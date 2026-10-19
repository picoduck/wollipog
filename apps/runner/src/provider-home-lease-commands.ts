import type {
  InspectProviderHomeLeaseMessage,
  InspectProviderHomeLeaseResultMessage,
  ProviderHomeLeaseInspection,
  ProviderHomeLeaseRecoveryCode,
  RecoverProviderHomeLeaseMessage,
  RecoverProviderHomeLeaseResultMessage,
} from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { ProviderHomeLeaseError, type LeaseWorkerError, type LeaseWorkerInspection } from "./provider-home-lease-worker-protocol.js";

/** Everything the lease recovery commands touch (#3241 part 2); index.ts wires the runner. */
export interface ProviderHomeLeaseCommandDeps {
  platform?: NodeJS.Platform;
  accounts: () => RunnerProviderAccount[];
  /** Read the HOME's lease state with the account's profile context; creates nothing. */
  inspect(home: string): Promise<LeaseWorkerInspection>;
  /** Succeed exactly the stale record `staleTipHash` on this authorization, then release the HOME. */
  recover(home: string, provider: string, staleTipHash: string, authorizationId: string): Promise<void>;
  log(message: string): void;
}

const TIP = /^[a-f0-9]{64}$/u;
const AUTHORIZATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The control plane's code for a worker refusal. Transient failures (the worker unavailable, a
 * deadline, a cancellation) have none: nothing was decided, and the authorization may be retried. */
export function providerHomeLeaseRecoveryCode(code: LeaseWorkerError): ProviderHomeLeaseRecoveryCode | undefined {
  switch (code) {
    case "stale_tip_changed": return "TIP_CHANGED";
    case "no_reboot_proof": return "NO_REBOOT_PROOF";
    case "busy": return "HOME_IN_USE";
    case "foreign_host": return "FOREIGN_HOST";
    case "profile_unsupported_control_plane": case "profile_unverifiable": case "profile_not_granted": case "profile_changed": case "profile_grant_limit":
      return "PROFILE_REFUSED";
    case "unavailable": case "expired": case "cancelled": case "cancel_release_failed":
      return undefined;
    default: return "UNVERIFIABLE";
  }
}

function supported(deps: ProviderHomeLeaseCommandDeps, account: RunnerProviderAccount): boolean {
  // Like provider profiles, recovery is offered only for POSIX HOMEs: a Windows runner's leases
  // have no verified boot proof for a record (Fast Startup keeps uptime counting).
  return (deps.platform ?? process.platform) !== "win32" && account.directory.startsWith("/");
}

/** `inspect_provider_home_lease`: what an Owner or Admin sees before authorizing a recovery. */
export async function inspectProviderHomeLeaseCommand(
  deps: ProviderHomeLeaseCommandDeps,
  msg: InspectProviderHomeLeaseMessage,
): Promise<InspectProviderHomeLeaseResultMessage> {
  const fail = (error: string, code?: "UNSUPPORTED_HOME"): InspectProviderHomeLeaseResultMessage =>
    ({ type: "inspect_provider_home_lease_result", requestId: msg.requestId, ok: false, ...(code ? { code } : {}), error });
  const account = deps.accounts().find((candidate) => candidate.id === msg.accountId);
  if (!account) return fail("Provider account is not configured on this Machine.");
  if (!supported(deps, account)) return fail("Lease recovery is not supported for this account's home on this Machine.", "UNSUPPORTED_HOME");
  let found: LeaseWorkerInspection;
  try {
    found = await deps.inspect(account.directory);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The provider HOME's lease could not be read.");
  }
  const inspection: ProviderHomeLeaseInspection = found.state !== "stale" ? { state: found.state } : {
    state: "stale", tipHash: found.tipHash!, ...(found.createdAt ? { createdAt: found.createdAt } : {}),
    sameHost: found.sameHost === true, hasEvidence: found.hasEvidence === true,
    refusal: found.refusal === null || found.refusal === undefined ? null : providerHomeLeaseRecoveryCode(found.refusal) ?? "UNVERIFIABLE",
  };
  return { type: "inspect_provider_home_lease_result", requestId: msg.requestId, ok: true, inspection };
}

/** `recover_provider_home_lease`: succeed exactly the authorized stale record, then release. */
export async function recoverProviderHomeLeaseCommand(
  deps: ProviderHomeLeaseCommandDeps,
  msg: RecoverProviderHomeLeaseMessage,
): Promise<RecoverProviderHomeLeaseResultMessage> {
  const fail = (error: string, code?: ProviderHomeLeaseRecoveryCode): RecoverProviderHomeLeaseResultMessage =>
    ({ type: "recover_provider_home_lease_result", requestId: msg.requestId, ok: false, ...(code ? { code } : {}), error });
  if (!TIP.test(msg.staleTipHash) || !AUTHORIZATION.test(msg.authorizationId)) return fail("The lease recovery authorization is invalid.");
  const account = deps.accounts().find((candidate) => candidate.id === msg.accountId);
  if (!account) return fail("Provider account is not configured on this Machine.");
  if (!supported(deps, account)) return fail("Lease recovery is not supported for this account's home on this Machine.", "UNSUPPORTED_HOME");
  try {
    await deps.recover(account.directory, account.provider, msg.staleTipHash, msg.authorizationId);
  } catch (error) {
    if (error instanceof ProviderHomeLeaseError) return fail(error.message, providerHomeLeaseRecoveryCode(error.code));
    return fail(error instanceof Error ? error.message : "The provider HOME's lease could not be recovered.");
  }
  deps.log(`provider HOME lease of account ${account.id} recovered on authorization ${msg.authorizationId}`);
  return { type: "recover_provider_home_lease_result", requestId: msg.requestId, ok: true };
}
