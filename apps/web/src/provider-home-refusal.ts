import type { ProviderHomeBlockingProcess, ProviderHomeLaunchRefusalCode, ProviderHomeLaunchRefusalView, ProviderHomeRecoveryCause, ProviderHomeWaitView } from "@wollipog/protocol";

/** What a launch refusal's notice offers (#3240): restart the session waiting for a busy account,
 * restart it, switch its account, open the Machine's accounts, set up a managed profile there (Add
 * Account for this control plane), or recover the existing one (Adopt as Profile, then Recover
 * Account, for an Owner or Admin). */
export type ProviderHomeRefusalAction = "wait" | "restart" | "switch_account" | "open_accounts" | "set_up_profile" | "recover_profile";

export interface ProviderHomeRefusalOptions {
  /** The runner can wait for a busy account (protocol v244): a busy refusal offers Wait for Account. */
  canWait?: boolean;
  /** What the lease refused: a session's launch (the default) or a conversation fork's. A fork's
   * copy offers no restart, since the session itself is unaffected. */
  launch?: "session" | "fork";
}

export interface ProviderHomeRefusalCopy {
  title: string;
  /** Sentence case. */
  body: string;
  /** In order of preference; the first is the primary action. */
  actions: ProviderHomeRefusalAction[];
}

const PROVIDER_NAMES: Record<ProviderHomeLaunchRefusalView["provider"], string> = { claude: "Claude", codex: "Codex" };

/** Plain-language guidance shared by session notices and account recovery. Technical diagnostics
 * belong in the authorized recovery details, not the primary message. */
export function providerHomeRecoveryCauseCopy(cause: ProviderHomeRecoveryCause, subject: string): Omit<ProviderHomeRefusalCopy, "actions"> {
  const copy: Record<ProviderHomeRecoveryCause, { title: string; body: string }> = {
    holder_alive: { title: "Account in Use", body: `Another Wollipog runner is using ${subject}. Wait for its work to finish, then try again, or choose another account.` },
    boundary_survivor: { title: "Account Still in Use", body: `A program from an earlier session is still using ${subject}. Wait for that work to finish, then try again, or choose another account.` },
    process_survivor: { title: "Earlier Session Still Running", body: `A program started by an earlier Wollipog runner is still using ${subject}. Wait for that work to finish, then try again, or choose another account.` },
    boundary_unverifiable: { title: "Account Access Can't Be Checked", body: `Wollipog can't confirm that an earlier session has finished using ${subject}. Choose another account for now, or ask the person who manages this machine to check it.` },
    process_uninspectable: { title: "Account Is Locked", body: `Wollipog can't check whether another program is still using ${subject}. Choose another account for now, or save your work and restart the machine before trying again.` },
    process_uninspectable_not_delegated: { title: "Account Recovery Is Blocked", body: `Wollipog can't safely unlock ${subject} because it can't check a running program. Choose another account for now, or save your work and restart the machine before trying again.` },
    invalid_journal: { title: "Account Recovery Records Can't Be Read", body: `Wollipog can't read or verify the records that protect ${subject} from being used by two runners at once. Choose another account and ask the person who manages this machine to check the recovery details.` },
    profile_unsupported_control_plane: { title: "Wollipog Update Required", body: `This version of Wollipog can't approve access to ${subject}. Update the Wollipog server, then try again, or choose another account.` },
    profile_grant_limit: { title: "Account Access Limit Reached", body: `Too many Wollipog servers already have access to ${subject}. An Owner or Admin needs to remove an unused server's access before adding this one, or you can choose another account.` },
    no_reboot_proof: { title: "Machine Restart Needed", body: `Wollipog can't safely unlock ${subject} until this machine has restarted. Choose another account for now, or save your work, restart the machine, then recover the account in Connections.` },
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
  options: ProviderHomeRefusalOptions = {},
): ProviderHomeRefusalCopy {
  const provider = PROVIDER_NAMES[refusal.provider];
  // The runner's own HOME is not an account: no switch target names it, and nothing is adopted.
  const subject = account ?? `this Machine's ${provider} sign-in`;
  const fork = options.launch === "fork";
  // Only a busy HOME frees itself, so only it can be waited for; a fork is simply tried again. Wait
  // for Account replaces Restart Session: its launch starts at once when the account is already
  // free, so a restart would add nothing but a second refusal.
  const restart: ProviderHomeRefusalAction = options.canWait && !fork && refusal.code === "busy" ? "wait" : "restart";
  if (refusal.cause) {
    const contention = ["holder_alive", "boundary_survivor", "process_survivor"].includes(refusal.cause);
    return {
      ...providerHomeRecoveryCauseCopy(refusal.cause, subject),
      // The Machine's own HOME is shared by every control plane on the account; a managed profile
      // gives this one its own.
      actions: account ? contention ? [restart, "switch_account"] : ["switch_account", "open_accounts"]
        : contention ? [restart, "set_up_profile"] : ["set_up_profile"],
    };
  }
  const builders: Record<ProviderHomeLaunchRefusalCode, () => ProviderHomeRefusalCopy> = {
    busy: () => ({
      title: "Account in Use",
      body: `Another runner, provider, helper, or lease publication is using ${subject}, so ${fork ? "the fork" : "this session"} didn't start. ` +
        (fork
          ? account ? "Try again once it's free, or switch the session to another account." : "Try again once it's free."
          : restart === "wait"
            ? account ? "Wait for the account to start the session as soon as it's free, or switch to another account."
              : "Wait for it to start the session as soon as it's free, or set up a managed profile for this control plane's new sessions."
            : account ? "Restart the session once it's free, or switch to another account."
              : "Restart the session once it's free, or set up a managed profile for this control plane's new sessions."),
      actions: account ? [restart, "switch_account"] : [restart, "set_up_profile"],
    }),
    foreign_owner: () => ({
      title: "Account Locked by Another Runner",
      body: account
        ? `A runner or control plane that stopped left ${account} locked. An Owner or Admin can unlock it with Recover Existing Profile, or you can switch to another account.`
        : `A runner or control plane that stopped left ${subject} locked. Set up a managed profile for this control plane's new sessions.`,
      actions: account ? ["recover_profile", "switch_account"] : ["set_up_profile"],
    }),
    foreign_host: () => ({
      title: "Account in Use on Another Host",
      body: account
        ? `A runner on another host uses ${account}, so this Machine can't share it. Switch to another account, or set up a managed profile for this Machine.`
        : `A runner on another host uses ${subject}. Set up a managed profile for this control plane's new sessions.`,
      actions: account ? ["switch_account", "set_up_profile"] : ["set_up_profile"],
    }),
    unavailable: () => ({
      title: "Lease Helper Unavailable",
      body: `The runner's lease helper isn't available, so it couldn't check that ${subject} is free. ` +
        (fork ? "Update or restart the runner, then try again." : "Update or restart the runner, then restart the session."),
      actions: ["restart"],
    }),
    unverifiable: () => ({
      title: "Lease Can't Be Verified",
      body: `The runner couldn't verify the lease records of ${subject}, so it didn't start the ${fork ? "fork" : "session"}. ` +
        "Someone with access to the Machine must check them before it can be used.",
      actions: account ? ["switch_account"] : [],
    }),
    profile_not_granted: () => ({
      title: "Profile Not Granted",
      body: `The provider profile of ${subject} isn't granted to this control plane. ` +
        "An Owner or Admin can grant it with Recover Existing Profile.",
      actions: account ? ["recover_profile", "switch_account"] : ["open_accounts"],
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

/**
 * The actions this viewer can complete (#3240). Set Up Managed Profile needs manage rights on the
 * Machine; Recover Existing Profile needs an Owner or Admin of the personal organization as well.
 * Either one that isn't available falls back to Open Machine Accounts, which explains why there.
 */
export function availableProviderHomeRefusalActions(
  actions: readonly ProviderHomeRefusalAction[],
  viewer: { canSetUpProfile: boolean; canRecoverProfile: boolean },
): ProviderHomeRefusalAction[] {
  const available = actions.map((action): ProviderHomeRefusalAction =>
    action === "set_up_profile" && !viewer.canSetUpProfile ? "open_accounts"
      : action === "recover_profile" && !viewer.canRecoverProfile ? "open_accounts"
        : action);
  return [...new Set(available)];
}

/** What a starting session shows while its launch waits for a busy account (#3240). `account` is
 * named as for a refusal. */
export function providerHomeWaitCopy(
  wait: Pick<ProviderHomeWaitView, "provider" | "cause" | "waitingSince" | "waitUntil">,
  account: string | undefined,
): { title: string; body: string } {
  const subject = account ?? `this Machine's ${PROVIDER_NAMES[wait.provider]} sign-in`;
  const holder = wait.cause === "holder_alive" ? `Another Wollipog runner is using ${subject}.`
    : wait.cause === "boundary_survivor" ? `A program from an earlier session is still using ${subject}.`
      : wait.cause === "process_survivor" ? `A program started by an earlier Wollipog runner is still using ${subject}.`
        : `Another runner, provider, helper, or lease publication is using ${subject}.`;
  const hours = Math.max(1, Math.round((wait.waitUntil - wait.waitingSince) / 3_600_000));
  return {
    title: "Waiting for Account",
    body: `${holder} This session starts as soon as it's free. If it's still in use after ${hours} ${hours === 1 ? "hour" : "hours"}, ` +
      "the session stops waiting and doesn't start.",
  };
}
