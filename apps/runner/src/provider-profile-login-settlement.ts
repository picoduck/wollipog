import { existsSync } from "node:fs";
import type { ProviderLoginProfileOptions } from "./provider-login.js";
import type { ProviderProfileGrants } from "./provider-profile-grants.js";

/** The production Add Account settlement callback; unknown drops local use but retains evidence. */
export function createProviderProfileLoginSettlement(deps: {
  settleCreated: ProviderProfileGrants["settleCreated"];
  revoke: (home: string, provider: "claude" | "codex", profileId: string, grantId: string) => Promise<unknown>;
  log: (message: string) => void;
}): ProviderLoginProfileOptions["settle"] {
  return async ({ home, provider, profileId, grantId, recorded, homeRemoved }) => {
    deps.settleCreated(profileId, grantId, recorded === true);
    // Missing-path observation does not attest that cleanup removed the HOME.
    if (recorded === "unknown" || recorded || homeRemoved || !existsSync(home)) return;
    await deps.revoke(home, provider, profileId, grantId)
      .catch(() => deps.log("a discarded provider profile's grant could not be removed from its marker"));
  };
}
