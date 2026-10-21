import type { ProviderHomeLaunchRefusalCode, ProviderHomeLaunchRefusalView } from "@wollipog/protocol";

/** What a launch refusal's notice offers (#3240): restart the session, switch its account, or open
 * the Machine's accounts, where an Owner or Admin adopts a profile or recovers a lease. */
export type ProviderHomeRefusalAction = "restart" | "switch_account" | "open_accounts";

export interface ProviderHomeRefusalCopy {
  title: string;
  /** Sentence case, at most two sentences. */
  body: string;
  /** In order of preference; the first is the primary action. */
  actions: ProviderHomeRefusalAction[];
}

const PROVIDER_NAMES: Record<ProviderHomeLaunchRefusalView["provider"], string> = { claude: "Claude", codex: "Codex" };

/**
 * The state and recovery a session shows for the lease refusal that stopped its launch. `account`
 * is the account's display name (already masked when identifiers are hidden), or undefined when the
 * refused HOME is the Machine's own provider HOME rather than an account's.
 */
export function providerHomeRefusalCopy(
  refusal: Pick<ProviderHomeLaunchRefusalView, "code" | "provider">,
  account: string | undefined,
): ProviderHomeRefusalCopy {
  const provider = PROVIDER_NAMES[refusal.provider];
  // The runner's own HOME is not an account: no switch target names it, and nothing is adopted.
  const subject = account ?? `this Machine's ${provider} sign-in`;
  const builders: Record<ProviderHomeLaunchRefusalCode, () => ProviderHomeRefusalCopy> = {
    busy: () => ({
      title: "Account In Use",
      body: `Another runner process is using ${subject}, so this session didn't start. ` +
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
