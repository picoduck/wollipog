import { normalizeManagedProfileDirectoryDiagnostic, PROVIDER_LOGIN_START_FAILURE, PROVIDER_LOGIN_START_UNCERTAIN,
  safeProviderLoginStartError, type ManagedProfileDirectoryDiagnostic } from "@wollipog/protocol";

/** The runner is a trust boundary, including older peers that return raw filesystem errors. */
export function providerLoginStartFailure(result: { error?: unknown; directoryDiagnostic?: unknown }): {
  error: string; directoryDiagnostic?: ManagedProfileDirectoryDiagnostic;
} {
  if (Object.hasOwn(result, "directoryDiagnostic")) {
    const directoryDiagnostic = normalizeManagedProfileDirectoryDiagnostic(result.directoryDiagnostic);
    if (!directoryDiagnostic) return { error: PROVIDER_LOGIN_START_FAILURE };
    return { error: directoryDiagnostic.reason === "may_have_changed" ? PROVIDER_LOGIN_START_UNCERTAIN : PROVIDER_LOGIN_START_FAILURE,
      directoryDiagnostic };
  }
  return { error: safeProviderLoginStartError(result.error) };
}
