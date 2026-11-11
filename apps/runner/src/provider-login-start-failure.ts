import { normalizeManagedProfileDirectoryDiagnostic, PROVIDER_LOGIN_START_FAILURE, safeProviderLoginStartError,
  type ManagedProfileDirectoryDiagnostic } from "@wollipog/protocol";
import { ManagedProfileDirectoryError } from "./provider-profile-home.js";

/** Only the genuine landed class supplies observations. Do not call exception toJSON or follow
 * causes. Future creation variants require a separate producer change after they actually land. */
export function providerLoginStartFailure(error: unknown): { error: string; directoryDiagnostic?: ManagedProfileDirectoryDiagnostic } {
  if (error instanceof ManagedProfileDirectoryError) {
    if (!["manager_root", "profiles_root", "profile_home"].includes(error.component) ||
        !["symlink", "not_directory", "wrong_owner", "group_or_other_write", "unavailable"].includes(error.reason))
      return { error: PROVIDER_LOGIN_START_FAILURE };
    const directoryDiagnostic = normalizeManagedProfileDirectoryDiagnostic({
      code: "managed_profile_directory", component: error.component, reason: error.reason,
    });
    return { error: PROVIDER_LOGIN_START_FAILURE, ...(directoryDiagnostic ? { directoryDiagnostic } : {}) };
  }
  return { error: safeProviderLoginStartError(error instanceof Error ? error.message : undefined) };
}
