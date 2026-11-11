/** Observations only: this DTO grants no sign-in, repair or retry authority. */
export type ManagedProfileDiagnosticComponent = "os_home" | "manager_root" | "profiles_root" | "profile_home";
export type ManagedProfileDiagnosticFailureReason =
  | "symlink" | "not_directory" | "wrong_owner" | "group_or_other_write" | "unavailable"
  | "unsupported_layout" | "unsupported_acl" | "unsupported_platform" | "unsupported_helper"
  | "already_exists" | "identity_changed";
export type ManagedProfileDirectoryDiagnostic = {
  code: "managed_profile_directory";
  component: ManagedProfileDiagnosticComponent;
} & (
  | { reason: ManagedProfileDiagnosticFailureReason; failureReason?: never }
  | { reason: "may_have_changed"; failureReason?: ManagedProfileDiagnosticFailureReason }
);

const components = new Set(["os_home", "manager_root", "profiles_root", "profile_home"]);
const failures = new Set(["symlink", "not_directory", "wrong_owner", "group_or_other_write", "unavailable",
  "unsupported_layout", "unsupported_acl", "unsupported_platform", "unsupported_helper", "already_exists", "identity_changed"]);

function consistent(component: unknown, reason: unknown): boolean {
  return typeof reason === "string" && failures.has(reason) &&
    (!["already_exists", "unsupported_platform", "unsupported_helper"].includes(reason) || component === "profile_home");
}

/** Reconstruct only fixed data fields. Reject unknown variants and inconsistent uncertainty;
 * never copy paths, exception causes, source payloads, messages or accessor properties. */
export function normalizeManagedProfileDirectoryDiagnostic(value: unknown): ManagedProfileDirectoryDiagnostic | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const fields = Object.getOwnPropertyDescriptors(value);
    const data = (key: string): unknown => fields[key] && "value" in fields[key] ? fields[key].value : undefined;
    const code = data("code"), component = data("component"), reason = data("reason");
    if (code !== "managed_profile_directory" || typeof component !== "string" || !components.has(component)) return undefined;
    const base = { code, component: component as ManagedProfileDiagnosticComponent } as const;
    if (reason === "may_have_changed") {
      if (!fields.failureReason) return { ...base, reason };
      const failureReason = data("failureReason");
      return consistent(component, failureReason)
        ? { ...base, reason, failureReason: failureReason as ManagedProfileDiagnosticFailureReason } : undefined;
    }
    if (fields.failureReason || !consistent(component, reason)) return undefined;
    return { ...base, reason: reason as ManagedProfileDiagnosticFailureReason };
  } catch { return undefined; }
}

export const PROVIDER_LOGIN_START_FAILURE =
  "Provider sign-in could not be started. Preserve any existing profile directories and ask the Machine operator for guidance.";
export const PROVIDER_LOGIN_START_UNCERTAIN =
  "Managed profile directories may have changed. Preserve them and ask the Machine operator for guidance. Do not retry automatically.";

/** Exact business-validation sentences only. Never use prefix/regex/general message passthrough. */
const businessErrors = new Set([
  "Provider account is not configured on this Machine.",
  "The profile grant is invalid.",
  "No Claude agent is available on this Machine.",
  "No Codex agent is available on this Machine.",
  "The selected installation changed. Rediscover this Machine before signing in.",
  "Account label must contain 1 to 100 characters.",
  "This Machine already has 32 provider accounts.",
  "A Claude account with this label is already on this Machine. Use Sign In on that account to refresh its login.",
  "A Codex account with this label is already on this Machine. Use Sign In on that account to refresh its login.",
  "A sign-in for an account with this label is already running.",
  "The provider sign-in supervisor has stopped.",
  "A sign-in is already running for this account.",
  "The provider credential home is unavailable or already in use.",
  "The provider sign-in was canceled before launch.",
  "The provider sign-in command could not be started.",
  "Provider sign-in targeted a different Machine.",
  "Codex sign-in could not identify a supported launcher form. Use a supported Codex launcher form; see docs/codex-plugin-launchers.md.",
  "Codex plugin inheritance could not identify a supported launcher form. Use a supported Codex launcher form; see docs/codex-plugin-launchers.md.",
  "Codex plugin inheritance could not read the default config.toml.",
  "Codex plugin inheritance could not read the account config.toml.",
  "Codex plugin inheritance could not reconcile the account plugin cache.",
  "Claude plugin inheritance could not read plugin settings or installation records.",
  "Claude plugin inheritance could not read this plugin registry version.",
  "Claude plugin inheritance could not read plugin installation records.",
  "Claude plugin inheritance could not reconcile the account plugin cache.",
  "A managed provider profile with this identity already exists.",
  "The managed provider profile path is invalid.",
  "Managed provider profiles are not supported on this Machine.",
]);

export function safeProviderLoginStartError(value: unknown): string {
  return typeof value === "string" && businessErrors.has(value) ? value : PROVIDER_LOGIN_START_FAILURE;
}
