import type { ProviderHomeBlockingProcess, ProviderHomeLaunchRefusalCode, ProviderHomeLaunchRefusalView, ProviderHomeRecoveryCause } from "@wollipog/protocol";

/** What a launch refusal's notice offers (#3240): restart the session, switch its account, or open
 * the Machine's accounts, where an Owner or Admin adopts a profile or recovers a lease. */
export type ProviderHomeRefusalAction = "restart" | "switch_account" | "open_accounts";

export interface ProviderHomeRefusalCopy {
  title: string;
  /** Sentence case. */
  body: string;
  /** In order of preference; the first is the primary action. */
  actions: ProviderHomeRefusalAction[];
}

const PROVIDER_NAMES: Record<ProviderHomeLaunchRefusalView["provider"], string> = { claude: "Claude", codex: "Codex" };

/** Shared with authorized account inspection; every cause keeps the journal intact. */
export function providerHomeRecoveryCauseCopy(cause: ProviderHomeRecoveryCause, subject: string): Omit<ProviderHomeRefusalCopy, "actions"> {
  const copy: Record<ProviderHomeRecoveryCause, { title: string; body: string }> = {
    holder_alive: { title: "Account Held by a Live Runner", body: `The recorded runner still holds ${subject}. Wait for its work to finish, preserve the lease journal, then retry.` },
    boundary_survivor: { title: "Provider Work Still Running", body: `A provider or helper still runs in the recorded boundary for ${subject}. Ownership is retained until the recorded boundary is empty; wait for that work to finish and preserve the boundary and lease journal.` },
    process_survivor: { title: "Provider Descendant Still Running", body: `A process launched by the recorded runner still uses ${subject}. Wait for that work to finish and preserve the lease journal before retrying.` },
    boundary_unverifiable: { title: "Account Boundary Can't Be Verified", body: `The recorded boundary for ${subject} can't be verified, or its enclosing unit hasn't retired. Ask an operator to inspect ownership and preserve the boundary and lease journal.` },
    process_uninspectable: { title: "Account Ownership Can't Be Verified", body: `A process can't be inspected, so ownership of ${subject} can't be proved on the fallback recovery path. Preserve the lease journal and ask an operator to restore inspectability; unrelated processes must be left alone.` },
    process_uninspectable_not_delegated: { title: "Account Recovery Needs Delegation", body: `Ownership of ${subject} can't be proved because a process can't be inspected and the runner's systemd unit is not delegated. Ask an operator to use Delegate=yes for future leases and restore inspectability for this lease; preserve the journal.` },
    invalid_journal: { title: "Account Journal Can't Be Verified", body: `The lease journal for ${subject} is invalid or unreadable. Preserve all journal records and ask an operator to restore access or inspect the records before retrying.` },
    profile_unsupported_control_plane: { title: "Account Needs a Newer Control Plane", body: `The control plane can't authorize the profile for ${subject}. Update the control plane before retrying and preserve the lease journal.` },
    profile_grant_limit: { title: "Account Profile Grant Limit Reached", body: `The profile for ${subject} has reached its grant limit. An Owner or Admin must review unused grants before granting access; preserve the lease journal.` },
    no_reboot_proof: { title: "Account Recovery Needs Reboot Proof", body: `The lease for ${subject} has no process evidence and was recorded during this boot. Recovery requires a later host boot; preserve the lease journal and coordinate with an operator.` },
  };
  return copy[cause];
}

/** Only rendered from the Owner/Admin lease-inspection response, never session snapshots. */
export function providerHomeBlockingProcessCopy(process: ProviderHomeBlockingProcess): string {
  const kinds = { recorded_runner: "recorded runner", provider_descendant: "provider descendant", boundary_member: "boundary member", uninspectable: "uninspectable process" };
  const memberships = { recorded_boundary: "inside the recorded boundary", outside_recorded_boundary: "outside the recorded boundary", unavailable: "cgroup membership unavailable" };
  return `Blocking process: PID ${process.pid}${process.startTime ? `, start time ${process.startTime}` : ", start time unavailable"}, ${kinds[process.kind]}, ${memberships[process.cgroupMembership]}.`;
}

/**
 * The state and recovery a session shows for the lease refusal that stopped its launch. `account`
 * is the account's display name (already masked when identifiers are hidden), or undefined when the
 * refused HOME is the Machine's own provider HOME rather than an account's.
 */
export function providerHomeRefusalCopy(
  refusal: Pick<ProviderHomeLaunchRefusalView, "code" | "provider" | "cause">,
  account: string | undefined,
): ProviderHomeRefusalCopy {
  const provider = PROVIDER_NAMES[refusal.provider];
  // The runner's own HOME is not an account: no switch target names it, and nothing is adopted.
  const subject = account ?? `this Machine's ${provider} sign-in`;
  if (refusal.cause) {
    const contention = ["holder_alive", "boundary_survivor", "process_survivor"].includes(refusal.cause);
    return {
      ...providerHomeRecoveryCauseCopy(refusal.cause, subject),
      actions: account ? contention ? ["restart", "switch_account"] : ["open_accounts", "switch_account"] : contention ? ["restart"] : ["open_accounts"],
    };
  }
  const builders: Record<ProviderHomeLaunchRefusalCode, () => ProviderHomeRefusalCopy> = {
    busy: () => ({
      title: "Account in Use",
      body: `Another runner, provider, helper, or lease publication is using ${subject}, so this session didn't start. ` +
        (account ? "Restart the session once it's free, or switch to another account." : "Restart the session once it's free."),
      actions: account ? ["restart", "switch_account"] : ["restart"],
    }),
    foreign_owner: () => ({
      title: "Account Locked by Another Runner",
      body: account
        ? `A runner or control plane that stopped left ${account} locked. An Owner or Admin can recover the lease from the Machine's accounts, or you can switch to another account.`
        : `A runner or control plane that stopped left ${subject} locked. Add an account for this control plane in the Machine's accounts.`,
      actions: account ? ["open_accounts", "switch_account"] : ["open_accounts"],
    }),
    foreign_host: () => ({
      title: "Account in Use on Another Host",
      body: account
        ? `A runner on another host uses ${account}, so this Machine can't share it. Switch to another account, or add one for this Machine.`
        : `A runner on another host uses ${subject}. Add an account for this control plane in the Machine's accounts.`,
      actions: account ? ["switch_account", "open_accounts"] : ["open_accounts"],
    }),
    unavailable: () => ({
      title: "Lease Helper Unavailable",
      body: `The runner's lease helper isn't available, so it couldn't check that ${subject} is free. ` +
        "Update or restart the runner, then restart the session.",
      actions: ["restart"],
    }),
    unverifiable: () => ({
      title: "Lease Can't Be Verified",
      body: `The runner couldn't verify the lease records of ${subject}, so it didn't start the session. ` +
        "Someone with access to the Machine must check them before it can be used.",
      actions: account ? ["switch_account"] : [],
    }),
    profile_not_granted: () => ({
      title: "Profile Not Granted",
      body: `The provider profile of ${subject} isn't granted to this control plane. ` +
        "An Owner or Admin can grant it with Adopt as Profile in the Machine's accounts.",
      actions: account ? ["open_accounts", "switch_account"] : ["open_accounts"],
    }),
    profile_changed: () => ({
      title: "Profile Changed",
      body: `The directory of ${subject} no longer holds the profile this session recorded, so it wasn't used. ` +
        (account ? "Restore the original directory, or switch to another account." : "Restore the original directory."),
      actions: account ? ["switch_account", "open_accounts"] : ["open_accounts"],
    }),
    profile_unverifiable: () => ({
      title: "Profile Can't Be Read",
      body: `The profile record of ${subject} is unreadable or uses a newer format. ` +
        "Update the runner, or ask an Owner or Admin to check the profile in the Machine's accounts.",
      actions: account ? ["open_accounts", "switch_account"] : ["open_accounts"],
    }),
  };
  return builders[refusal.code]();
}
