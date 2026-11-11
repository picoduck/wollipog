import {
  normalizeManagedProfileDirectoryDiagnostic,
  PROVIDER_LOGIN_START_FAILURE,
  PROVIDER_LOGIN_START_UNCERTAIN,
  safeProviderLoginStartError,
  type ManagedProfileDiagnosticComponent,
  type ManagedProfileDiagnosticFailureReason,
} from "@wollipog/protocol";
import { ApiError } from "./api.js";

const components: Record<ManagedProfileDiagnosticComponent, string> = {
  manager_root: "Wollipog's main directory",
  profiles_root: "the provider profiles directory",
  profile_home: "the account directory",
  os_home: "the OS user's home directory",
};
const reasons: Record<ManagedProfileDiagnosticFailureReason, string> = {
  symlink: "is a symbolic link",
  not_directory: "is not a directory",
  wrong_owner: "belongs to a different OS user",
  group_or_other_write: "allows other users to write to it",
  unavailable: "could not be inspected",
  unsupported_layout: "has an unsupported layout",
  unsupported_acl: "has access permissions that could not be verified",
  unsupported_platform: "cannot be managed on this platform",
  unsupported_helper: "cannot be checked by this installation",
  already_exists: "already exists",
  identity_changed: "changed during inspection",
};
export interface ProviderLoginStartFailure {
  message: string;
  detail?: string;
  guidance?: string;
  inspectCommand?: string;
  repairCommand?: string;
}

/** Only the start endpoint's closed observations and exact business sentences supply copy. */
export function providerLoginStartFailure(cause: unknown): ProviderLoginStartFailure {
  const diagnostic = cause instanceof ApiError && cause.status === 409
    ? normalizeManagedProfileDirectoryDiagnostic(cause.details?.directoryDiagnostic) : undefined;
  if (diagnostic) {
    const component = components[diagnostic.component];
    if (diagnostic.reason === "may_have_changed") return {
      message: PROVIDER_LOGIN_START_UNCERTAIN,
      detail: `On this Machine, ${component} may have changed.`,
      guidance: "Ask the operator of the affected Machine to inspect it locally. For SSH Machines, this is the remote Machine, not the control-plane host.",
    };
    const root = diagnostic.component === "manager_root" || diagnostic.component === "profiles_root";
    return {
      message: `On this Machine, ${component} ${reasons[diagnostic.reason]}.`,
      guidance: "Preserve existing directories and ask this Machine's operator to inspect them locally. For SSH Machines, use the remote Machine, not the control-plane host.",
      ...(root ? {
        inspectCommand: `wollipog profile-root inspect --component ${diagnostic.component}`,
        ...(diagnostic.reason === "group_or_other_write" ? {
          repairCommand: `wollipog profile-root repair --component ${diagnostic.component}`,
        } : {}),
      } : {}),
    };
  }
  if (cause instanceof ApiError) {
    const statusCopy: Record<number, string> = {
      403: "You do not have permission to start a provider sign-in on this Machine.",
      404: "This Machine or provider account is no longer available. Refresh the Machine before continuing.",
      503: "This Machine is unavailable. Check its connection before continuing.",
      504: "The runner did not answer in time.",
    };
    const statusMessage = statusCopy[cause.status];
    if (statusMessage) return { message: statusMessage };
    return { message: safeProviderLoginStartError(cause.message) };
  }
  return { message: PROVIDER_LOGIN_START_FAILURE };
}
