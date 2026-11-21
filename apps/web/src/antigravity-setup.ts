import {
  ANTIGRAVITY_SETUP_GUIDANCE,
  ANTIGRAVITY_SIGN_IN_ACTIVE_STATUSES,
  antigravityVersionNewer,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type AntigravityInstallFailure,
  type AntigravityInstallOperationView,
  type AntigravityInstallStage,
  type AntigravitySetupView,
  type OS,
  type RunnerView,
} from "@wollipog/protocol";

/** Google's install command for the machine's own shell: PowerShell on Windows, the shell script
 * on macOS and Linux. A bash command is never shown for a Windows machine. */
export function antigravityTerminalSetup(os: OS): { installCommand: string; shell: string } {
  return os === "windows"
    ? { installCommand: ANTIGRAVITY_SETUP_GUIDANCE.windowsInstallCommand, shell: "PowerShell" }
    : { installCommand: ANTIGRAVITY_SETUP_GUIDANCE.installCommand, shell: "terminal" };
}

/** What the Google Antigravity row and its setup dialog show for one machine (#4780). */
export type AntigravitySetupPhase =
  | "checking"
  | "installing"
  | "updating"
  | "missing_runtime"
  | "unsupported"
  | "update_runner"
  | "sign_in_required"
  | "signing_in"
  | "verification_failed"
  | "ready";

export interface AntigravitySetupPresentation {
  phase: AntigravitySetupPhase;
  /** The runner's report, absent on an older runner or before its first report. */
  setup?: AntigravitySetupView;
  /** Why the actions are unavailable right now, as a sentence. */
  blocked: string | null;
  /** Managed install (v404). Absent when the runner or its platform can't install. */
  install?: AntigravityInstallPresentation;
}

/** What the managed install offers and reports (#4780, protocol v404). */
export interface AntigravityInstallPresentation {
  /** The running install or update, if any. */
  running?: AntigravityInstallOperationView;
  /** The last install or update failed. For an update, `keptVersion` is the version still active. */
  failed?: { operation: AntigravityInstallOperationView; keptVersion?: string };
  /** Google's newer release, when a managed copy is active and older. */
  updateTo?: string;
  /** Whether the executable in use is the managed copy. */
  managedActive: boolean;
  /** The active managed version, if any. */
  activeVersion?: string;
}

/** Setup appears only for people who may manage the machine: the control plane sends the setup, its
 * sign-in link and its executable path to them alone. */
export function antigravitySetupVisible(runner: Pick<RunnerView, "canManage">): boolean {
  return runner.canManage === true;
}

export function antigravitySignInRunning(setup: AntigravitySetupView | undefined): boolean {
  return !!setup?.signIn && ANTIGRAVITY_SIGN_IN_ACTIVE_STATUSES.includes(setup.signIn.status);
}

export function antigravitySetupPresentation(
  runner: Pick<RunnerView, "protocolVersion" | "antigravitySetup">,
  online: boolean,
): AntigravitySetupPresentation {
  if (!runnerSupportsProtocol(runner.protocolVersion, "antigravitySetup")) {
    return { phase: "update_runner", blocked: runnerCapabilityRequirement(runner.protocolVersion, "antigravitySetup", "Google Antigravity setup") };
  }
  const setup = runner.antigravitySetup;
  const blocked = online ? null : "Wait for this machine to come back online.";
  if (!setup) return { phase: "checking", blocked };
  const install = antigravityInstallPresentation(runner, setup);
  const verifying = setup.signIn?.status === "verifying";
  const phase: AntigravitySetupPhase = install?.running ? (install.running.kind === "update" ? "updating" : "installing")
    : antigravitySignInRunning(setup) || verifying ? "signing_in" : setup.status;
  return { phase, setup, blocked, ...(install ? { install } : {}) };
}

function antigravityInstallPresentation(
  runner: Pick<RunnerView, "protocolVersion">,
  setup: AntigravitySetupView,
): AntigravityInstallPresentation | undefined {
  const managed = setup.managedInstall;
  if (!managed?.available || !runnerSupportsProtocol(runner.protocolVersion, "antigravityManagedInstall")) return undefined;
  const operation = managed.operation;
  const activeVersion = managed.active?.version;
  const running = operation?.status === "running" ? operation : undefined;
  const failed = operation?.status === "failed"
    // After a failed rollback the active version is the rejected one, so nothing is claimed kept.
    ? { operation, ...(operation.kind === "update" && activeVersion && operation.failure !== "rollback_failed" ? { keptVersion: activeVersion } : {}) }
    : undefined;
  const newer = activeVersion && managed.latest ? antigravityVersionNewer(managed.latest.version, activeVersion) : undefined;
  return {
    ...(running ? { running } : {}),
    ...(failed ? { failed } : {}),
    ...(newer && !running ? { updateTo: managed.latest!.version } : {}),
    managedActive: setup.executable?.source === "managed",
    ...(activeVersion ? { activeVersion } : {}),
  };
}

/** What a running install is doing, as a sentence. */
export function antigravityInstallStageSentence(stage: AntigravityInstallStage | undefined): string {
  switch (stage) {
    case "fetching_installer": return "Reading Google's installer…";
    case "fetching_manifest": return "Reading Google's release manifest…";
    case "downloading": return "Downloading Google's release…";
    case "extracting": return "Unpacking the release…";
    case "validating": return "Checking the new version…";
    case "activating": return "Activating the new version…";
    default: return "Starting…";
  }
}

/** Why an install or update failed, as a sentence. Sentence case: this is helper text. */
export function antigravityInstallFailureSentence(failure: AntigravityInstallFailure | undefined): string {
  switch (failure) {
    case "platform_not_supported":
      return "Google doesn't publish an Antigravity release for this machine's system.";
    case "installer_not_recognized":
      return "Google's installer or release manifest changed in a way Wollipog doesn't recognize, so nothing was downloaded. Install Antigravity from the terminal instead.";
    case "redirect_refused":
      return "A download was redirected away from Google's servers, so Wollipog stopped.";
    case "download_failed":
      return "The download from Google didn't finish. Check the machine's network connection, then try again.";
    case "timed_out":
      return "The download or the new version's checks took too long. Try again.";
    case "checksum_mismatch":
      return "The downloaded file didn't match the checksum Google published, so Wollipog discarded it.";
    case "archive_invalid":
      return "Google's release archive wasn't in the expected form, so Wollipog discarded it.";
    case "validation_failed":
      return "The new version didn't pass Wollipog's checks: its version, its ACP help and an ACP handshake.";
    case "access_check_failed":
      return "The new version didn't pass Wollipog's check with this machine's sign-in, so Wollipog didn't keep it.";
    case "rollback_failed":
      return "The new version didn't pass Wollipog's check, and Wollipog couldn't restore the version before it yet. It tries again at the next check.";
    case "activation_failed":
    default:
      return "Wollipog couldn't write the new version to the runner's data folder.";
  }
}

/** One sentence for a failed check. Sentence case: this is helper text. */
export function antigravityCheckFailureSentence(setup: AntigravitySetupView): string {
  switch (setup.failure) {
    case "version_check_failed":
      return "Antigravity was found, but its version check didn't run successfully as the runner's user. Reinstall it or repair its installation, then check again.";
    case "handshake_failed":
      return "Antigravity was found, but its ACP server didn't start. Update Antigravity to a release with ACP support, then check again.";
    case "timed_out":
      return "Antigravity didn't answer in time. Check the machine's network connection and that Antigravity can reach Google, then check again.";
    case "session_check_failed":
    default:
      return "Antigravity started, but Wollipog couldn't open a session with this machine's sign-in or read the account's models. Sign in again, or check that the account can use Antigravity.";
  }
}

/** The ending of the last sign-in, when it failed, timed out or was cancelled. */
export function antigravitySignInEnding(setup: AntigravitySetupView | undefined): { title: string; sentence: string; tone: "danger" | "neutral" } | null {
  const signIn = setup?.signIn;
  if (!signIn) return null;
  if (signIn.status === "timed_out") {
    return { title: "Sign-In Expired", tone: "neutral", sentence: "The sign-in wasn't completed in time, so its link and code no longer work." };
  }
  if (signIn.status === "cancelled") {
    return { title: "Sign-In Canceled", tone: "neutral", sentence: "The sign-in was canceled before it finished." };
  }
  if (signIn.status !== "failed") return null;
  switch (signIn.failure) {
    case "link_unavailable":
      return { title: "Sign-In Didn't Start", tone: "danger", sentence: "Antigravity didn't show a Google sign-in link. Update Antigravity, or sign in from the machine's terminal." };
    case "not_verified":
      return { title: "Sign-In Not Confirmed", tone: "danger", sentence: "The sign-in finished, but Wollipog couldn't confirm access with it. Nothing was marked ready." };
    case "input_closed":
      return { title: "Sign-In Failed", tone: "danger", sentence: "Antigravity stopped accepting the authorization code." };
    case "not_completed":
    default:
      return { title: "Sign-In Failed", tone: "danger", sentence: "Google didn't accept the sign-in. The code may be wrong or expired." };
  }
}
