/** Google Antigravity setup from Connections (protocol v403, Refs #4780).
 *
 * The runner checks whether Google's `agy` CLI is installed, whether its ACP server answers, and
 * whether the runner's own sign-in can open an ACP session. It also supervises Google's remote
 * `agy acp --login` paste-code sign-in. A runner with Antigravity sessions (#4779) advertises the
 * agent `ANTIGRAVITY_AGENT_ID` from this setup: choosable in New Session only while the setup is
 * `ready`, and launched with the same executable and credential context
 * (`antigravityCredentialContext` on the runner). An older runner advertises no such agent.
 *
 * Wollipog never installs or updates Antigravity. A missing runtime shows Google's documented
 * install command for a person to run in the machine's terminal.
 *
 * The sign-in output and exit codes are verified only against a credential-free fixture. The ACP
 * session behavior was also observed with real agy 1.5.14 on Linux. Anything the runner does not
 * recognize reports `sign_in_required` or `verification_failed`, never `ready`. */

/** The agent id of Google Antigravity sessions in a runner's agent list (#4779). */
export const ANTIGRAVITY_AGENT_ID = "google-antigravity";

/** Where the setup stands on one Machine.
 * - `checking`: the runner is checking the runtime and its sign-in.
 * - `missing_runtime`: no `agy` executable was found for the runner's user.
 * - `unsupported`: setup from Connections is not available on this runner's platform.
 * - `sign_in_required`: the runtime works, and the runner's sign-in is missing or no longer valid.
 * - `verification_failed`: the runtime was found, but a check failed for a reason other than sign-in.
 * - `ready`: the runner opened an ACP session with its sign-in and read the account's models. */
export type AntigravitySetupStatus =
  | "checking"
  | "missing_runtime"
  | "unsupported"
  | "sign_in_required"
  | "verification_failed"
  | "ready";

export const ANTIGRAVITY_SETUP_STATUSES: readonly AntigravitySetupStatus[] = [
  "checking", "missing_runtime", "unsupported", "sign_in_required", "verification_failed", "ready",
];

/** Which check failed, beside `verification_failed` (or `unsupported`). A closed set: a client
 * treats an unknown value as a plain failure.
 * - `version_check_failed`: `agy --version` did not exit successfully.
 * - `handshake_failed`: `agy acp` did not return a valid ACP initialize response.
 * - `session_check_failed`: the ACP session check failed for a reason other than sign-in.
 * - `timed_out`: a check did not finish in time.
 * - `unsupported_platform`: setup from Connections supports Linux and macOS runners only. */
export type AntigravitySetupFailure =
  | "version_check_failed"
  | "handshake_failed"
  | "session_check_failed"
  | "timed_out"
  | "unsupported_platform";

export const ANTIGRAVITY_SETUP_FAILURES: readonly AntigravitySetupFailure[] = [
  "version_check_failed", "handshake_failed", "session_check_failed", "timed_out", "unsupported_platform",
];

/** One remote sign-in operation. `verifying` follows a sign-in command that exited successfully:
 * success is reported only once the runner's session check confirms access. */
export type AntigravitySignInStatus =
  | "starting"
  | "awaiting_code"
  | "waiting_for_provider"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export const ANTIGRAVITY_SIGN_IN_STATUSES: readonly AntigravitySignInStatus[] = [
  "starting", "awaiting_code", "waiting_for_provider", "verifying", "succeeded", "failed", "cancelled", "timed_out",
];

/** Sign-in statuses that are still running and accept Cancel. `verifying` is not one: the sign-in
 * command has exited and the runner's access check is deciding the outcome. */
export const ANTIGRAVITY_SIGN_IN_ACTIVE_STATUSES: readonly AntigravitySignInStatus[] = [
  "starting", "awaiting_code", "waiting_for_provider",
];

/** Why a sign-in failed. A closed set: a client treats an unknown value as a plain failure.
 * - `link_unavailable`: the sign-in command did not print a Google sign-in link in time.
 * - `not_completed`: the sign-in command exited without success (for example, a rejected or expired code).
 * - `not_verified`: the command exited successfully, but the session check did not confirm access.
 * - `input_closed`: the sign-in command stopped accepting the authorization code. */
export type AntigravitySignInFailure = "link_unavailable" | "not_completed" | "not_verified" | "input_closed";

export const ANTIGRAVITY_SIGN_IN_FAILURES: readonly AntigravitySignInFailure[] = [
  "link_unavailable", "not_completed", "not_verified", "input_closed",
];

export interface AntigravitySignInView {
  operationId: string;
  status: AntigravitySignInStatus;
  startedAt: number;
  /** Google's HTTPS sign-in page. Bearer-like: shown only to people who can manage the Machine. */
  verificationUrl?: string;
  failure?: AntigravitySignInFailure;
}

/** Secret-free setup projection. The CLI's output, the authorization code, tokens and the
 * runner's environment never enter it. */
export interface AntigravitySetupView {
  version: 1;
  status: AntigravitySetupStatus;
  /** When the runner last finished (or started) a check. */
  checkedAt: number;
  failure?: AntigravitySetupFailure;
  /** The executable the runner found and checked. */
  executable?: { path: string; version?: string };
  /** The models the account's ACP session advertised during the last successful check. */
  models?: Array<{ id: string; name: string }>;
  /** Antigravity keeps its sign-in in the OS keyring of the runner's user. Every process of that
   * user shares it, so it is one shared sign-in per Machine user, never per Wollipog account. */
  credentialStore: "shared_os_keyring";
  signIn?: AntigravitySignInView;
}

/** Google's documented install commands and guides (Antigravity CLI getting started: macOS/Linux
 * shell, Windows PowerShell). Wollipog shows them; it never runs them. */
export const ANTIGRAVITY_SETUP_GUIDANCE = {
  installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  windowsInstallCommand: "irm https://antigravity.google/cli/install.ps1 | iex",
  installDocsUrl: "https://antigravity.google/docs/getting-started?tab=cli",
  signInCommand: "agy acp --login",
  signInDocsUrl: "https://antigravity.google/docs/ide/extensions/acp/#authentication",
} as const;

export type AntigravitySetupAction = "check" | "start_sign_in" | "submit_code" | "cancel_sign_in";

/** Control plane → runner. `operationId` names the sign-in for `submit_code` and `cancel_sign_in`;
 * `code` is the transient authorization code for `submit_code`, which the runner writes to the
 * sign-in command and never retains. */
export interface AntigravitySetupCommandMessage {
  type: "antigravity_setup";
  requestId: string;
  runnerId: string;
  action: AntigravitySetupAction;
  operationId?: string;
  code?: string;
}

/** Runner → control plane: the command's outcome and the setup after it. */
export interface AntigravitySetupResultMessage {
  type: "antigravity_setup_result";
  requestId: string;
  ok: boolean;
  error?: string;
  setup?: AntigravitySetupView;
}

/** Runner → control plane: the authoritative setup whenever it changes. */
export interface AntigravitySetupUpdatedMessage {
  type: "antigravity_setup_updated";
  runnerId: string;
  setup: AntigravitySetupView;
}

const ANTIGRAVITY_OPERATION_ID = /^agy_login_[A-Za-z0-9-]{1,100}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function validAntigravityOperationId(value: unknown): value is string {
  return typeof value === "string" && ANTIGRAVITY_OPERATION_ID.test(value);
}

/** An HTTPS URL without credentials, as a sign-in link must be. */
export function safeAntigravitySignInUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || CONTROL.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !CONTROL.test(value);
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Strict validation of a runner's report. The control plane refuses anything else whole. */
export function validAntigravitySetupView(value: unknown): value is AntigravitySetupView {
  if (!record(value) || !onlyKeys(value, ["version", "status", "checkedAt", "failure", "executable", "models", "credentialStore", "signIn"])) return false;
  if (value.version !== 1 || !ANTIGRAVITY_SETUP_STATUSES.includes(value.status as AntigravitySetupStatus) ||
      !timestamp(value.checkedAt) || value.credentialStore !== "shared_os_keyring") return false;
  if (value.failure !== undefined && !ANTIGRAVITY_SETUP_FAILURES.includes(value.failure as AntigravitySetupFailure)) return false;
  if (value.executable !== undefined) {
    const executable = value.executable;
    if (!record(executable) || !onlyKeys(executable, ["path", "version"]) || !boundedText(executable.path, 4_096) ||
        (executable.version !== undefined && !(boundedText(executable.version, 64) && /^[0-9A-Za-z.+_-]+$/u.test(executable.version)))) return false;
  }
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length > 64) return false;
    const ids = new Set<string>();
    for (const model of value.models) {
      if (!record(model) || !onlyKeys(model, ["id", "name"]) || !boundedText(model.id, 256) ||
          !boundedText(model.name, 160) || ids.has(model.id)) return false;
      ids.add(model.id);
    }
  }
  // Ready is confirmed access: a checked executable and the models its session advertised. Models
  // belong to that confirmation only.
  if (value.status === "ready"
    ? !value.executable || value.failure !== undefined || !Array.isArray(value.models) || value.models.length === 0
    : value.models !== undefined) return false;
  if (value.signIn !== undefined) {
    const signIn = value.signIn;
    if (!record(signIn) || !onlyKeys(signIn, ["operationId", "status", "startedAt", "verificationUrl", "failure"]) ||
        !validAntigravityOperationId(signIn.operationId) ||
        !ANTIGRAVITY_SIGN_IN_STATUSES.includes(signIn.status as AntigravitySignInStatus) || !timestamp(signIn.startedAt) ||
        (signIn.verificationUrl !== undefined && !safeAntigravitySignInUrl(signIn.verificationUrl)) ||
        (signIn.failure !== undefined && !ANTIGRAVITY_SIGN_IN_FAILURES.includes(signIn.failure as AntigravitySignInFailure))) return false;
    // A link is only meaningful while the sign-in still waits for its code.
    if (signIn.verificationUrl !== undefined && signIn.status !== "awaiting_code") return false;
  }
  return true;
}
