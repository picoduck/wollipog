import { resolve } from "node:path";
import {
  runnerSupportsProtocol,
  type ProviderAccountDefinition,
  type ProviderAccountProfileView,
  type ProviderProfileGrantView,
} from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { LEASE_WORKER_PROFILE_LIMIT } from "./provider-home-lease-worker-protocol.js";
import {
  decideProviderProfileAccess,
  isProviderProfileGrantId,
  isProviderProfileId,
  providerProfileGrantFor,
  readProviderProfileMarker,
  type ProviderProfileRead,
} from "./provider-profile.js";

/** Bound on the grant list one registration may carry; larger lists are ignored as a whole. */
export const PROVIDER_PROFILE_GRANT_LIST_LIMIT = 256;
/** A runner configures at most 32 provider accounts, so it reports at most 32 profile ids. */
const PROVIDER_PROFILE_ID_REPORT_LIMIT = 32;

/** One of this control plane's grants still recorded in a configured HOME's marker after the
 * control plane stopped listing it, so the runner removes it under the HOME's lease. */
export interface StaleProviderProfileGrant {
  account: RunnerProviderAccount;
  profileId: string;
  grantId: string;
}

interface KnownGrant {
  /** Known from the control plane (active) or from this HOME's marker (pending or adopted here). */
  profileId?: string;
  status: "active" | "pending";
}

/**
 * The runner's view of the connected control plane's provider-profile grants (#3239). The control
 * plane's grant rows are authoritative; this keeps the last complete list it sent, plus grants this
 * runner recorded in a marker since then, and turns them into the lease worker's access context.
 */
export class ProviderProfileGrants {
  private supported = false;
  private readonly grants = new Map<string, KnownGrant>();
  /** The exact profile ids the most recent register frame reported. The control plane lists grants
   * only for those, so only a marker holding one of them can carry a grant the list omitted. */
  private reportedSnapshot: ReadonlySet<string> = new Set();
  /** Grants this runner wrote into the marker of a managed profile it is creating (Add Account),
   * keyed by grant id, until the sign-in settles. The HOME is not a configured account yet, so a
   * registration's marker scan cannot find it; this keeps the grant usable across a reconnect. */
  private readonly creations = new Map<string, string>();
  private readonly readMarker: (account: RunnerProviderAccount) => ProviderProfileRead;

  constructor(private readonly deps: {
    controlPlaneInstanceId: string | undefined;
    accounts: () => readonly RunnerProviderAccount[];
    readMarker?: (account: RunnerProviderAccount) => ProviderProfileRead;
  }) {
    this.readMarker = deps.readMarker ?? ((account) => readProviderProfileMarker(account.directory, { provider: account.provider }));
  }

  /**
   * Apply a `registered` frame. Below v225 nothing is granted. A present list replaces the known
   * grants and names the stale grants to remove from markers; an absent or malformed list never
   * means "revoke all", so it changes nothing. Only a marker whose profile id the answered register
   * frame reported can be stale: a HOME adopted after that frame (by another runner on this OS
   * account, say) holds a grant the control plane could not list yet, so it is left alone until the
   * next registration.
   */
  synchronize(protocolVersion: number | null, list: unknown): StaleProviderProfileGrant[] {
    this.supported = runnerSupportsProtocol(protocolVersion, "providerProfiles");
    if (!this.supported) {
      this.grants.clear();
      return [];
    }
    const parsed = parseGrantList(list);
    if (!parsed) return [];
    this.grants.clear();
    for (const grant of parsed) {
      const profileId = grant.profileId ?? (grant.status === "pending" ? this.creations.get(grant.grantId) : undefined);
      this.grants.set(grant.grantId, { status: grant.status, ...(profileId ? { profileId } : {}) });
    }
    const stale: StaleProviderProfileGrant[] = [];
    for (const account of this.deps.accounts()) {
      const read = this.safeRead(account);
      if (read.state !== "present") continue;
      const mine = providerProfileGrantFor(read.marker, this.deps.controlPlaneInstanceId);
      if (!mine) continue;
      const known = this.grants.get(mine.grantId);
      if (!known) {
        if (!this.reportedSnapshot.has(read.marker.profileId)) continue;
        stale.push({ account, profileId: read.marker.profileId, grantId: mine.grantId });
        continue;
      }
      // A pending grant this HOME already records was adopted here; the control plane missed the
      // reply. It is usable now, and the account report lets the control plane complete it.
      if (known.status === "pending" && known.profileId === undefined) known.profileId = read.marker.profileId;
    }
    return stale;
  }

  /** The registration's `providerProfileIds`: each configured HOME's marker id, or the id its
   * account recorded, deduplicated. The control plane lists exactly the grants for these. Call once
   * per register frame sent: the result replaces the snapshot that the answering `registered` list
   * is compared against. */
  reportedProfileIds(): string[] {
    const ids = new Set<string>();
    for (const account of this.deps.accounts()) {
      const read = this.safeRead(account);
      const id = read.state === "present" ? read.marker.profileId : account.profileId;
      if (id && isProviderProfileId(id)) ids.add(id);
    }
    const reported = [...ids].slice(0, PROVIDER_PROFILE_ID_REPORT_LIMIT);
    this.reportedSnapshot = new Set(reported);
    return reported;
  }

  /** Whether a grant `synchronize` named stale still is when its removal runs: its profile is in the
   * registration's snapshot and no grant with that id has become known since. */
  stillStale(profileId: string, grantId: string): boolean {
    return this.supported && this.reportedSnapshot.has(profileId) && !this.grants.has(grantId);
  }

  supportsProfiles(): boolean {
    return this.supported;
  }

  /** Record a grant this runner just wrote into a marker on the control plane's request. The reply
   * carrying the profile id is what activates the control plane's row, so it counts as active. */
  recordAdopted(profileId: string, grantId: string): void {
    if (!this.supported) return;
    this.grants.set(grantId, { status: "active", profileId });
  }

  /** Record the grant a new managed profile's marker was just created with (Add Account). The
   * control plane recorded it as pending for this sign-in, so the sign-in may use the HOME. */
  recordCreated(profileId: string, grantId: string): void {
    if (!this.supported) return;
    this.creations.set(grantId, profileId);
    this.grants.set(grantId, { status: "pending", profileId });
  }

  /** The sign-in that created a managed profile settled. A recorded account counts its grant as
   * active: the account report carrying the profile id is what activates the control plane's row,
   * as an adoption's reply does. Otherwise the grant is never used again. */
  settleCreated(profileId: string, grantId: string, recorded: boolean): void {
    this.creations.delete(grantId);
    if (!recorded) { this.grants.delete(grantId); return; }
    // A registration while the sign-in ran drops a grant the control plane no longer lists.
    if (this.grants.has(grantId)) this.grants.set(grantId, { status: "active", profileId });
  }

  /** Forget a revoked grant at once, before its marker update, so no new reference uses it. A
   * control plane holds at most one active grant per profile, so its other entries go too. */
  recordRevoked(profileId: string | undefined, grantId: string): void {
    this.grants.delete(grantId);
    if (!profileId) return;
    for (const [id, grant] of this.grants) if (grant.profileId === profileId) this.grants.delete(id);
  }

  /** The lease worker's access context, read at each acquisition's dispatch. */
  access(): { controlPlaneSupportsProfiles: boolean; activeProfileIds: string[] } {
    if (!this.supported) return { controlPlaneSupportsProfiles: false, activeProfileIds: [] };
    const ids = new Set<string>();
    for (const grant of this.grants.values()) if (grant.profileId) ids.add(grant.profileId);
    // Prefer the profiles configured accounts record, so the bounded frame always carries those.
    const configured = new Set(this.deps.accounts().flatMap((account) => account.profileId ? [account.profileId] : []));
    const ordered = [...ids].sort((left, right) => Number(configured.has(right)) - Number(configured.has(left)));
    return { controlPlaneSupportsProfiles: true, activeProfileIds: ordered.slice(0, LEASE_WORKER_PROFILE_LIMIT) };
  }

  /** The profile id a configured account recorded for exactly this HOME path. */
  expectedProfileIdForHome(home: string): string | undefined {
    let target: string;
    try { target = resolve(home); } catch { return undefined; }
    return this.deps.accounts().find((account) => account.profileId !== undefined && resolve(account.directory) === target)?.profileId;
  }

  /** The profile id a new session binding records for a configured account (#3239): the id its
   * configuration records, else its HOME marker's identity when this control plane may use it
   * (`granted` or `pending`). A replacement runner's account may point at a HOME another runner
   * adopted without recording `profileId`; the marker is what the runner verified. Only the exact
   * configured account (id, provider and HOME path) counts. */
  bindingProfileId(binding: { id: string; provider: "claude" | "codex"; credentialHome: string }): string | undefined {
    let target: string;
    try { target = resolve(binding.credentialHome); } catch { return undefined; }
    const account = this.deps.accounts().find((candidate) => candidate.id === binding.id &&
      candidate.provider === binding.provider && resolve(candidate.directory) === target);
    if (!account) return undefined;
    if (account.profileId !== undefined) return account.profileId;
    const profile = this.accountProfile(account);
    return profile && (profile.access === "granted" || profile.access === "pending") ? profile.id : undefined;
  }

  /** Whether an acquisition for this account would pass the worker's profile check now. Background
   * passes skip accounts that fail it, so one refused HOME does not fail the whole pass. */
  usable(account: RunnerProviderAccount): boolean {
    const read = this.safeRead(account);
    if (read.state === "unverifiable" && read.cause === "ancestry") return true; // the lease refuses it as before
    return decideProviderProfileAccess(read, { ...(account.profileId ? { expectedId: account.profileId } : {}), ...this.access() },
      this.deps.controlPlaneInstanceId).allowed;
  }

  /** Whether the account's HOME carries a profile marker (or one that cannot be read). */
  profileBearing(account: RunnerProviderAccount): boolean {
    return account.profileId !== undefined || this.safeRead(account).state !== "absent";
  }

  /** The v225 account projection: the HOME's profile id and this control plane's access to it. */
  accountProfile(account: RunnerProviderAccount): ProviderAccountProfileView | undefined {
    const read = this.safeRead(account);
    const id = read.state === "present" ? read.marker.profileId : account.profileId;
    if (!id) return undefined;
    if (!this.usable(account) || read.state !== "present") return { id, access: "not_granted" };
    const mine = providerProfileGrantFor(read.marker, this.deps.controlPlaneInstanceId);
    const status = (mine ? this.grants.get(mine.grantId)?.status : undefined) ??
      ([...this.grants.values()].some((grant) => grant.profileId === id && grant.status === "active") ? "active" : "pending");
    return { id, access: status === "active" ? "granted" : "pending" };
  }

  /** The account list for the connected control plane: v225 peers see each account's profile;
   * older peers never see a profile-bearing account, which they could not use. */
  project(accounts: readonly RunnerProviderAccount[], definition: (account: RunnerProviderAccount) => ProviderAccountDefinition): ProviderAccountDefinition[] {
    return accounts.flatMap((account) => {
      if (!this.supported) return this.profileBearing(account) ? [] : [definition(account)];
      const profile = this.accountProfile(account);
      return [{ ...definition(account), ...(profile ? { profile } : {}) }];
    });
  }

  private safeRead(account: RunnerProviderAccount): ProviderProfileRead {
    try { return this.readMarker(account); } catch { return { state: "unverifiable", cause: "marker" }; }
  }
}

function parseGrantList(value: unknown): ProviderProfileGrantView[] | null {
  if (!Array.isArray(value) || value.length > PROVIDER_PROFILE_GRANT_LIST_LIMIT) return null;
  const seen = new Set<string>();
  const parsed: ProviderProfileGrantView[] = [];
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const grant = entry as Record<string, unknown>;
    if (!isProviderProfileGrantId(grant.grantId) || seen.has(grant.grantId)) return null;
    if (grant.status !== "active" && grant.status !== "pending") return null;
    if (grant.profileId !== undefined && !isProviderProfileId(grant.profileId)) return null;
    if (grant.status === "active" && grant.profileId === undefined) return null;
    seen.add(grant.grantId);
    parsed.push({ grantId: grant.grantId, status: grant.status, ...(grant.profileId !== undefined ? { profileId: grant.profileId as string } : {}) });
  }
  return parsed;
}
