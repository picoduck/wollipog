import {
  ANTIGRAVITY_SIGN_IN_ACTIVE_STATUSES,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type AntigravitySetupView,
  type RunnerView,
} from "@wollipog/protocol";

/** What the Google Antigravity row and its setup dialog show for one machine (#4780). */
export type AntigravitySetupPhase =
  | "checking"
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
  const verifying = setup.signIn?.status === "verifying";
  const phase: AntigravitySetupPhase = antigravitySignInRunning(setup) || verifying ? "signing_in" : setup.status;
  return { phase, setup, blocked };
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
