import type {
  AdoptProviderProfileMessage,
  AdoptProviderProfileResultMessage,
  RevokeProviderProfileGrantMessage,
  RevokeProviderProfileGrantResultMessage,
} from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { accountConfigPublicationMayHaveOccurred, type AccountConfigPreimage } from "./provider-account-config-publication.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import type { ProviderAccountRemovalOptions } from "./provider-login.js";
import type { ProviderProfileGrants, StaleProviderProfileGrant } from "./provider-profile-grants.js";
import { managedProviderProfileIdFor } from "./provider-profile-home.js";
import {
  isProviderProfileGrantId,
  isProviderProfileId,
  providerProfileGrantFor,
  providerProfileHomeShared,
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
  /** Under a removed account HOME's lease: drop this control plane's grants and report whether the
   * reference was last and the marker unshared. This is not physical deletion authority. With
   * `expectedProfileId` a marker holding another identity, or none, is kept unchanged (false). */
  retire(home: string, provider: "claude" | "codex", expectedProfileId?: string): Promise<boolean>;
  /** The managed profile root (`~/.agent-manager/profiles`); accounts at `<root>/<profileId>` are
   * managed profile HOMEs whose removal requires the marker to still hold that identity. */
  profileRoot?: string;
  /** Capture the source revision before awaiting a marker adoption. */
  captureAccountsPreimage(): AccountConfigPreimage;
  /** Publish the configured accounts against that exact source revision. */
  persistAccounts(accounts: RunnerProviderAccount[], preimage: AccountConfigPreimage): void;
  removeAccount(accountId: string, options: ProviderAccountRemovalOptions): Promise<{ credentialsRetained: boolean }>;
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
  let preimage: AccountConfigPreimage;
  try { preimage = deps.captureAccountsPreimage(); }
  catch { return fail("The runner configuration account source could not be verified."); }
  try {
    ({ profileId } = await deps.adopt(account.directory, account.provider, msg.grantId));
  } catch (error) {
    if (error instanceof ProviderHomeLeaseError && HOME_IN_USE.has(error.code)) return fail(error.message, "HOME_IN_USE");
    if (error instanceof ProviderHomeLeaseError && PROFILE_EXISTS.has(error.code)) return fail(error.message, "PROFILE_EXISTS");
    return fail(error instanceof Error ? error.message : "The provider profile could not be adopted.");
  }
  // The marker alone never makes a grant usable. Publish against the pre-await revision even
  // when its profile id was already present; stale decisions must not complete an adoption.
  try {
    deps.persistAccounts(preimage.accounts.map((candidate) => candidate.id === account.id ? { ...candidate, profileId } : { ...candidate }), preimage);
  } catch (error) {
    if (accountConfigPublicationMayHaveOccurred(error)) {
      // A committed or uncertain config may reference the marker. Retain it without granting
      // local access or claiming definitely-unpublished rollback; CP revocation still wins.
      deps.grants.recordRevoked(undefined, msg.grantId);
    } else {
      await rollBackAdoption(deps, account, profileId, msg.grantId);
    }
    deps.publish();
    return fail(accountConfigPublicationMayHaveOccurred(error) && error instanceof Error ? error.message : "The runner configuration could not be updated.");
  }
  account.profileId = profileId;
  deps.grants.recordAdopted(profileId, msg.grantId);
  deps.publish();
  return { type: "adopt_provider_profile_result", requestId: msg.requestId, ok: true, profileId };
}

/** Undo a failed adoption's marker write under the HOME's lease. The grant was never recorded as
 * usable; if the marker update fails too, the grant stays unusable here and the next registration
 * removes it once the control plane no longer lists it. */
async function rollBackAdoption(deps: ProviderProfileCommandDeps, account: RunnerProviderAccount, profileId: string, grantId: string): Promise<void> {
  deps.grants.recordRevoked(undefined, grantId);
  try {
    await deps.revoke(account.directory, account.provider, profileId, grantId);
  } catch (error) {
    deps.log(`a failed provider profile adoption could not be removed from the HOME's marker: ${error instanceof Error ? error.message : "unknown error"}`);
  }
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

/** `remove_provider_account` against a v225 control plane. This control plane's grant stops at
 * once and leaves the marker before removal is attempted, so it holds even when the removal is
 * refused (an agent default, a running sign-in, a configuration write). Physical cleanup retains
 * every HOME until exact retirement authority is proved (#3157); grant retirement still runs under
 * the lease for an unshared marker, but its legacy boolean never authorizes deletion.
 *
 * A managed profile HOME (`<root>/<profileId>`) must still hold the identity its account recorded.
 * When the directory holds another profile (or no readable marker) it is no longer this account's
 * HOME: its grants are left alone and it is kept, and grant retirement re-checks the identity. */
export async function removeProviderAccountWithProfile(
  deps: ProviderProfileCommandDeps,
  accountId: string,
): Promise<{ credentialsRetained: boolean }> {
  const account = deps.accounts().find((candidate) => candidate.id === accountId);
  const marker = account ? read(deps, account) : { state: "absent" as const };
  const present = marker.state === "present" ? marker.marker : undefined;
  const expectedProfileId = account ? managedProviderProfileIdFor(deps.profileRoot, account) : undefined;
  const substituted = expectedProfileId !== undefined && present?.profileId !== expectedProfileId;
  const mine = present && !substituted ? providerProfileGrantFor(present, deps.controlPlaneInstanceId) : undefined;
  let markerRevoked = true;
  if (account && present && mine) {
    deps.grants.recordRevoked(present.profileId, mine.grantId);
    markerRevoked = await dropGrant(deps, account, present.profileId, mine.grantId);
  }
  // Only an optimisation: a grant another runner records later is caught under the lease below.
  const shared = substituted || providerProfileHomeShared(marker, deps.controlPlaneInstanceId);
  const removed = await deps.removeAccount(accountId, shared ? { retainCredentialHome: true } : {
    retireCredentialHome: (removedAccount) => deps.retire(removedAccount.directory, removedAccount.provider, expectedProfileId),
    retainCredentialHomeIf: (removedAccount) => providerProfileHomeShared(read(deps, removedAccount), deps.controlPlaneInstanceId),
  });
  // A retained HOME must stop granting this control plane; retry a marker update that failed above.
  if (account && present && mine && !markerRevoked && removed.credentialsRetained) {
    await dropGrant(deps, account, present.profileId, mine.grantId);
  }
  return removed;
}

async function dropGrant(deps: ProviderProfileCommandDeps, account: RunnerProviderAccount, profileId: string, grantId: string): Promise<boolean> {
  try {
    await deps.revoke(account.directory, account.provider, profileId, grantId);
    return true;
  } catch (error) {
    deps.log(`provider profile grant could not be dropped from a removed account's HOME: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  }
}

/** After `registered`: drop grants of this control plane that it no longer lists. Only grants for
 * a profile the answered register frame reported, and still unknown when the removal runs. */
export async function revokeStaleProviderProfileGrants(
  deps: ProviderProfileCommandDeps,
  stale: readonly StaleProviderProfileGrant[],
): Promise<void> {
  if (stale.length === 0) return;
  for (const { account, profileId, grantId } of stale) {
    if (!deps.grants.stillStale(profileId, grantId)) continue;
    try {
      await deps.revoke(account.directory, account.provider, profileId, grantId);
    } catch (error) {
      deps.log(`provider profile grant the control plane no longer lists could not be dropped: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  deps.publish();
}
