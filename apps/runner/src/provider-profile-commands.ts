import type {
  AdoptProviderProfileMessage,
  AdoptProviderProfileResultMessage,
  RevokeProviderProfileGrantMessage,
  RevokeProviderProfileGrantResultMessage,
} from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import type { ProviderProfileGrants, StaleProviderProfileGrant } from "./provider-profile-grants.js";
import {
  isProviderProfileGrantId,
  isProviderProfileId,
  providerProfileGrantFor,
  readProviderProfileMarker,
  type ProviderProfileRead,
} from "./provider-profile.js";

/** Everything the profile commands touch; index.ts wires the real runner, tests wire fakes. */
export interface ProviderProfileCommandDeps {
  platform?: NodeJS.Platform;
  controlPlaneInstanceId: string | undefined;
  /** The live configured account list (mutated in place when an account records its profile). */
  accounts: () => RunnerProviderAccount[];
  grants: ProviderProfileGrants;
  /** Record this control plane's grant in the HOME's marker under the HOME's lease. */
  adopt(home: string, provider: "claude" | "codex", grantId: string): Promise<{ profileId: string }>;
  /** Drop one exact grant of this control plane from the HOME's marker under the HOME's lease. */
  revoke(home: string, provider: "claude" | "codex", profileId: string, grantId: string): Promise<boolean>;
  /** Atomically replace the configured accounts (writeProviderAccountsConfig). */
  persistAccounts(accounts: RunnerProviderAccount[]): void;
  removeAccount(accountId: string, options: { retainCredentialHome?: boolean }): Promise<{ credentialsRetained: boolean }>;
  readMarker?: (account: RunnerProviderAccount) => ProviderProfileRead;
  /** Re-send the account inventory so the control plane sees the new profile state. */
  publish(): void;
  log(message: string): void;
}

function read(deps: ProviderProfileCommandDeps, account: RunnerProviderAccount): ProviderProfileRead {
  try {
    return (deps.readMarker ?? ((candidate) => readProviderProfileMarker(candidate.directory, { provider: candidate.provider })))(account);
  } catch {
    return { state: "unverifiable", cause: "marker" };
  }
}

const HOME_IN_USE = new Set(["busy", "foreign_owner", "foreign_host"]);
const PROFILE_EXISTS = new Set(["profile_grant_limit", "profile_unverifiable", "profile_changed"]);

/** `adopt_provider_profile`: record this control plane's grant in the account HOME's marker,
 * creating the identity when the HOME has none, and persist the profile id on the account. */
export async function adoptProviderProfileCommand(
  deps: ProviderProfileCommandDeps,
  msg: AdoptProviderProfileMessage,
): Promise<AdoptProviderProfileResultMessage> {
  const fail = (error: string, code?: AdoptProviderProfileResultMessage["code"]): AdoptProviderProfileResultMessage =>
    ({ type: "adopt_provider_profile_result", requestId: msg.requestId, ok: false, ...(code ? { code } : {}), error });
  if (!isProviderProfileGrantId(msg.grantId)) return fail("The profile grant is invalid.");
  const account = deps.accounts().find((candidate) => candidate.id === msg.accountId);
  if (!account) return fail("Provider account is not configured on this Machine.");
  // Markers need O_NOFOLLOW and POSIX ownership checks, which Windows (and the WSL homes a Windows
  // runner addresses) cannot provide; part 1 refuses every marker there.
  if ((deps.platform ?? process.platform) === "win32" || !account.directory.startsWith("/")) {
    return fail("Provider profiles are not supported for this account's home on this Machine.", "UNSUPPORTED_HOME");
  }
  if (!deps.controlPlaneInstanceId || !deps.grants.supportsProfiles()) {
    return fail("This control plane did not negotiate provider profiles.");
  }
  let profileId: string;
  try {
    ({ profileId } = await deps.adopt(account.directory, account.provider, msg.grantId));
  } catch (error) {
    if (error instanceof ProviderHomeLeaseError && HOME_IN_USE.has(error.code)) return fail(error.message, "HOME_IN_USE");
    if (error instanceof ProviderHomeLeaseError && PROFILE_EXISTS.has(error.code)) return fail(error.message, "PROFILE_EXISTS");
    return fail(error instanceof Error ? error.message : "The provider profile could not be adopted.");
  }
  // The marker now grants this control plane. Use it at once, before the configuration write, so
  // the control plane's lost-reply reconciliation and this runner agree.
  deps.grants.recordAdopted(profileId, msg.grantId);
  if (account.profileId !== profileId) {
    try {
      deps.persistAccounts(deps.accounts().map((candidate) => candidate === account ? { ...candidate, profileId } : candidate));
    } catch {
      deps.publish();
      return fail("The runner configuration could not be updated.");
    }
    account.profileId = profileId;
  }
  deps.publish();
  return { type: "adopt_provider_profile_result", requestId: msg.requestId, ok: true, profileId };
}

/** `revoke_provider_profile_grant`: stop using the grant at once, then drop it from every
 * configured HOME whose marker records it. */
export async function revokeProviderProfileGrantCommand(
  deps: ProviderProfileCommandDeps,
  msg: RevokeProviderProfileGrantMessage,
): Promise<RevokeProviderProfileGrantResultMessage> {
  const result = (ok: boolean, markerUpdated: boolean, error?: string): RevokeProviderProfileGrantResultMessage =>
    ({ type: "revoke_provider_profile_grant_result", requestId: msg.requestId, ok, markerUpdated, ...(error ? { error } : {}) });
  if (!isProviderProfileId(msg.profileId) || !isProviderProfileGrantId(msg.grantId)) return result(false, false, "The profile grant is invalid.");
  deps.grants.recordRevoked(msg.profileId, msg.grantId);
  let markerUpdated = false;
  const failures: string[] = [];
  for (const account of [...deps.accounts()]) {
    const marker = read(deps, account);
    if (marker.state !== "present" || marker.marker.profileId !== msg.profileId) continue;
    if (providerProfileGrantFor(marker.marker, deps.controlPlaneInstanceId)?.grantId !== msg.grantId) continue;
    try {
      if (await deps.revoke(account.directory, account.provider, msg.profileId, msg.grantId)) markerUpdated = true;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "The provider profile marker could not be updated.");
    }
  }
  deps.publish();
  return failures.length ? result(false, markerUpdated, failures[0]) : result(true, markerUpdated);
}

/** `remove_provider_account` against a v225 control plane. A profile other control planes are
 * still granted keeps its HOME; this control plane's grant is dropped from the marker either way
 * once the account is gone. A HOME only this control plane is granted keeps today's deletion. */
export async function removeProviderAccountWithProfile(
  deps: ProviderProfileCommandDeps,
  accountId: string,
): Promise<{ credentialsRetained: boolean }> {
  const account = deps.accounts().find((candidate) => candidate.id === accountId);
  const marker = account ? read(deps, account) : { state: "absent" as const };
  const present = marker.state === "present" ? marker.marker : undefined;
  const mine = present ? providerProfileGrantFor(present, deps.controlPlaneInstanceId) : undefined;
  const shared = present ? present.grants.some((grant) => grant !== mine) : false;
  const removed = await deps.removeAccount(accountId, shared ? { retainCredentialHome: true } : {});
  if (account && present && mine) {
    deps.grants.recordRevoked(present.profileId, mine.grantId);
    // A deleted HOME took its marker with it; a retained one must stop granting this control plane.
    if (removed.credentialsRetained) {
      try {
        await deps.revoke(account.directory, account.provider, present.profileId, mine.grantId);
      } catch (error) {
        deps.log(`provider profile grant could not be dropped from a removed account's HOME: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }
  return removed;
}

/** After `registered`: drop grants of this control plane that it no longer lists. */
export async function revokeStaleProviderProfileGrants(
  deps: ProviderProfileCommandDeps,
  stale: readonly StaleProviderProfileGrant[],
): Promise<void> {
  if (stale.length === 0) return;
  for (const { account, profileId, grantId } of stale) {
    try {
      await deps.revoke(account.directory, account.provider, profileId, grantId);
    } catch (error) {
      deps.log(`provider profile grant the control plane no longer lists could not be dropped: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  deps.publish();
}
