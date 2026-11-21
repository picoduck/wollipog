/** Google Antigravity setup from Connections (protocol v403, Refs #4780).
 *
 * The runner checks whether Google's `agy` CLI is installed, whether its ACP server answers, and
 * whether the runner's own sign-in can open an ACP session. It also supervises Google's remote
 * `agy acp --login` paste-code sign-in. This is setup only: Antigravity is not an agent the runner
 * advertises for New Session, and sessions are a separate feature (#4779). Session launch reuses
 * the same credential context (`antigravityCredentialContext` on the runner) when it lands.
 *
 * Protocol v404 adds a managed install: on a person's explicit Install or Update, the runner fetches
 * Google's release through the chain Google's own installer uses (the installer script from
 * antigravity.google names its manifest service, whose manifest names the archive and its SHA-512),
 * verifies it, validates the staged CLI and activates it atomically, keeping the last working
 * version when anything fails. Wollipog never runs Google's installer script. Google's install
 * command stays available as terminal guidance, and an operator-installed `agy` on PATH keeps
 * working as a fallback.
 *
 * The behavior of `agy` behind these checks (its sign-in output, exit codes and session errors) is
 * verified only against credential-free fixtures. Anything the runner does not recognize reports
 * `sign_in_required` or `verification_failed`, never `ready`. */

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
  /** The executable the runner found and checked. `source` (v404) says whether it is the managed
   * copy Wollipog installed or one found on the runner user's PATH. */
  executable?: { path: string; version?: string; source?: AntigravityExecutableSource };
  /** The models the account's ACP session advertised during the last successful check. */
  models?: Array<{ id: string; name: string }>;
  /** Antigravity keeps its sign-in in the OS keyring of the runner's user. Every process of that
   * user shares it, so it is one shared sign-in per Machine user, never per Wollipog account. */
  credentialStore: "shared_os_keyring";
  signIn?: AntigravitySignInView;
  /** v404 managed install. Absent from older runners and on platforms without setup support. */
  managedInstall?: AntigravityManagedInstallView;
}

/** v404: where the checked executable came from. A working managed copy is preferred; the copy on
 * the runner user's PATH is used when there is no managed copy, or when the managed copy fails its
 * version check. */
export type AntigravityExecutableSource = "managed" | "path";

/** What a running install is doing. */
export type AntigravityInstallStage =
  | "fetching_installer"
  | "fetching_manifest"
  | "downloading"
  | "extracting"
  | "validating"
  | "activating";

export const ANTIGRAVITY_INSTALL_STAGES: readonly AntigravityInstallStage[] = [
  "fetching_installer", "fetching_manifest", "downloading", "extracting", "validating", "activating",
];

/** Why an install or update failed. A closed set: a client treats an unknown value as a plain
 * failure. Every failure leaves the active managed version (if any) untouched.
 * - `platform_not_supported`: Google publishes no release for this machine's OS, architecture or C library.
 * - `installer_not_recognized`: Google's installer script, the manifest service it names, the
 *   manifest or the archive address it lists did not have the shape Wollipog verifies.
 * - `redirect_refused`: a download redirected to another origin.
 * - `download_failed`: a download failed or exceeded its size limit.
 * - `timed_out`: a download or validation step did not finish in time.
 * - `checksum_mismatch`: the archive's SHA-512 differs from the manifest's.
 * - `archive_invalid`: the archive is unsafe (links, devices, absolute or `..` paths) or lacks a
 *   single regular `antigravity` file.
 * - `validation_failed`: the staged CLI failed `--version`, `acp --help` or the ACP handshake.
 * - `activation_failed`: the runner could not stage or activate the files, or it stopped first.
 * - `access_check_failed`: the new version was activated, but it failed the access check the version
 *   before it passed, so the runner restored that version. */
export type AntigravityInstallFailure =
  | "platform_not_supported"
  | "installer_not_recognized"
  | "redirect_refused"
  | "download_failed"
  | "timed_out"
  | "checksum_mismatch"
  | "archive_invalid"
  | "validation_failed"
  | "activation_failed"
  | "access_check_failed";

export const ANTIGRAVITY_INSTALL_FAILURES: readonly AntigravityInstallFailure[] = [
  "platform_not_supported", "installer_not_recognized", "redirect_refused", "download_failed", "timed_out",
  "checksum_mismatch", "archive_invalid", "validation_failed", "activation_failed", "access_check_failed",
];

/** The provenance of one managed release: what was fetched and verified before activation. */
export interface AntigravityManagedRelease {
  /** The version Google's manifest named. */
  version: string;
  activatedAt: number;
  /** SHA-256 of the installer script the manifest service was read from. */
  installerSha256: string;
  manifestUrl: string;
  archiveUrl: string;
  /** The manifest's SHA-512, which the downloaded archive matched. */
  archiveSha512: string;
}

export interface AntigravityInstallOperationView {
  operationId: string;
  /** `update` replaces an active managed copy; `install` creates the first one. */
  kind: "install" | "update";
  status: "running" | "succeeded" | "failed";
  /** While running. */
  stage?: AntigravityInstallStage;
  startedAt: number;
  /** Once finished. */
  finishedAt?: number;
  /** Only when failed. */
  failure?: AntigravityInstallFailure;
  /** The release version, once the manifest was read. */
  targetVersion?: string;
}

export interface AntigravityManagedInstallView {
  /** Whether this machine can install a managed copy. False on a platform Google publishes no
   * release for: setup then shows the terminal guidance only. */
  available: boolean;
  /** The active managed release. A failed update leaves it in place. */
  active?: AntigravityManagedRelease;
  /** The active managed copy failed its version check, so the PATH copy is in use. */
  activeCheckFailed?: true;
  /** The release kept from before the last update. */
  previousVersion?: string;
  /** Google's latest release, read on a person's Check Again or at runner start, never on a timer. */
  latest?: { version: string; checkedAt: number };
  /** An operator-installed `agy` on the runner user's PATH, kept as the fallback. */
  pathExecutable?: string;
  /** The current or most recent install or update since the runner started. */
  operation?: AntigravityInstallOperationView;
}

/** Google's installer and release hosts that a managed install accepts (v404). The installer is
 * read as text and never run; it names the manifest service, which must be HTTPS on run.app. */
export const ANTIGRAVITY_MANAGED_INSTALL_SOURCE = {
  installerUrl: "https://antigravity.google/cli/install.sh",
  manifestHostSuffix: ".run.app",
  archiveHost: "storage.googleapis.com",
} as const;

/** Whether `candidate` is a newer dotted release version than `current`, comparing numeric parts.
 * Undefined when either is not a plain dotted version, so nothing is offered on doubt. */
export function antigravityVersionNewer(candidate: string, current: string): boolean | undefined {
  const parse = (value: string) => /^\d+(?:\.\d+){0,3}$/u.test(value) ? value.split(".").map(Number) : undefined;
  const next = parse(candidate);
  const now = parse(current);
  if (!next || !now) return undefined;
  for (let index = 0; index < Math.max(next.length, now.length); index += 1) {
    const difference = (next[index] ?? 0) - (now[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
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

/** `install` (v404) installs Google's latest release as the managed copy, or updates it. */
export type AntigravitySetupAction = "check" | "start_sign_in" | "submit_code" | "cancel_sign_in" | "install";

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
const ANTIGRAVITY_INSTALL_OPERATION_ID = /^agy_install_[A-Za-z0-9-]{1,100}$/u;
const RELEASE_VERSION = /^[0-9A-Za-z.+_-]+$/u;
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

function releaseVersion(value: unknown): value is string {
  return boundedText(value, 64) && RELEASE_VERSION.test(value);
}

function hex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/u.test(value);
}

/** An HTTPS URL whose host is `host`, or ends in `.suffix` labels, without credentials, a port, a
 * query or a fragment. Google's release addresses carry none, and a query could carry a signed
 * download token into the setup report and the runner log. */
export function antigravityReleaseUrlAllowed(value: unknown, host: { exact?: string; suffix?: string }): value is string {
  if (typeof value !== "string" || value.length > 2_048 || CONTROL.test(value) || /[?#]/u.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return false;
    if (host.exact !== undefined) return url.hostname === host.exact;
    return host.suffix !== undefined && url.hostname.length > host.suffix.length && url.hostname.endsWith(host.suffix) &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u.test(url.hostname);
  } catch {
    return false;
  }
}

/** A managed release record: what the runner verified before activating it. */
export function validAntigravityManagedRelease(value: unknown): value is AntigravityManagedRelease {
  return record(value) &&
    onlyKeys(value, ["version", "activatedAt", "installerSha256", "manifestUrl", "archiveUrl", "archiveSha512"]) &&
    releaseVersion(value.version) && timestamp(value.activatedAt) && hex(value.installerSha256, 64) &&
    antigravityReleaseUrlAllowed(value.manifestUrl, { suffix: ANTIGRAVITY_MANAGED_INSTALL_SOURCE.manifestHostSuffix }) &&
    antigravityReleaseUrlAllowed(value.archiveUrl, { exact: ANTIGRAVITY_MANAGED_INSTALL_SOURCE.archiveHost }) &&
    hex(value.archiveSha512, 128);
}

function validInstallOperation(value: unknown): boolean {
  if (!record(value) || !onlyKeys(value, ["operationId", "kind", "status", "stage", "startedAt", "finishedAt", "failure", "targetVersion"])) return false;
  if (typeof value.operationId !== "string" || !ANTIGRAVITY_INSTALL_OPERATION_ID.test(value.operationId) ||
      (value.kind !== "install" && value.kind !== "update") || !timestamp(value.startedAt) ||
      (value.targetVersion !== undefined && !releaseVersion(value.targetVersion))) return false;
  if (value.status === "running") {
    return ANTIGRAVITY_INSTALL_STAGES.includes(value.stage as AntigravityInstallStage) &&
      value.finishedAt === undefined && value.failure === undefined;
  }
  if (value.stage !== undefined || !timestamp(value.finishedAt)) return false;
  if (value.status === "succeeded") return value.failure === undefined && value.targetVersion !== undefined;
  return value.status === "failed" && ANTIGRAVITY_INSTALL_FAILURES.includes(value.failure as AntigravityInstallFailure);
}

function validManagedInstall(value: unknown): boolean {
  if (!record(value) || !onlyKeys(value, ["available", "active", "activeCheckFailed", "previousVersion", "latest", "pathExecutable", "operation"])) return false;
  if (typeof value.available !== "boolean") return false;
  if (value.active !== undefined && !validAntigravityManagedRelease(value.active)) return false;
  if (value.activeCheckFailed !== undefined && (value.activeCheckFailed !== true || value.active === undefined)) return false;
  if (value.previousVersion !== undefined && !releaseVersion(value.previousVersion)) return false;
  if (value.latest !== undefined && !(record(value.latest) && onlyKeys(value.latest, ["version", "checkedAt"]) &&
      releaseVersion(value.latest.version) && timestamp(value.latest.checkedAt))) return false;
  if (value.pathExecutable !== undefined && !boundedText(value.pathExecutable, 4_096)) return false;
  if (value.operation !== undefined && !validInstallOperation(value.operation)) return false;
  // Nothing installs where no release exists.
  return value.available || (value.active === undefined && value.operation === undefined);
}

export function validAntigravityInstallOperationId(value: unknown): value is string {
  return typeof value === "string" && ANTIGRAVITY_INSTALL_OPERATION_ID.test(value);
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
  if (!record(value) || !onlyKeys(value, ["version", "status", "checkedAt", "failure", "executable", "models", "credentialStore", "signIn", "managedInstall"])) return false;
  if (value.version !== 1 || !ANTIGRAVITY_SETUP_STATUSES.includes(value.status as AntigravitySetupStatus) ||
      !timestamp(value.checkedAt) || value.credentialStore !== "shared_os_keyring") return false;
  if (value.failure !== undefined && !ANTIGRAVITY_SETUP_FAILURES.includes(value.failure as AntigravitySetupFailure)) return false;
  if (value.executable !== undefined) {
    const executable = value.executable;
    if (!record(executable) || !onlyKeys(executable, ["path", "version", "source"]) || !boundedText(executable.path, 4_096) ||
        (executable.version !== undefined && !releaseVersion(executable.version)) ||
        (executable.source !== undefined && executable.source !== "managed" && executable.source !== "path")) return false;
  }
  if (value.managedInstall !== undefined && !validManagedInstall(value.managedInstall)) return false;
  // A managed executable is the active managed release.
  if (record(value.executable) && value.executable.source === "managed" &&
      !(record(value.managedInstall) && value.managedInstall.active !== undefined)) return false;
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
