import React, { useEffect, useState, type ReactNode } from "react";
import {
  runnerSupportsProtocol,
  type PendingApproval,
  type ProviderAuthenticationCurrentIdentity,
  type ProviderLoginView,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";
import { RelativeTime } from "./RelativeTime.js";
import { BusyButton } from "./ui/BusyButton.js";

type Loadable<T> =
  | { key: string; state: "loading" }
  | { key: string; state: "loaded"; value: T }
  | { key: string; state: "failed"; error: string };

/** Only a runner-owned recovery card can act on an account. The retained-messages follow-up and
 * the dismiss-only card for contexts the runner cannot probe offer neither Recheck nor Cancel. */
export function authenticationRecoveryPanelApplies(session: SessionView, approval: PendingApproval): boolean {
  return approval.kind === "authentication" && !approval.requestId.endsWith(":retained-messages") &&
    approval.options.some((option) => option.optionId === "auth:revalidate" || option.optionId === "auth:cancel") &&
    (session.driver === "claude-code" || session.driver === "codex" || session.driver === "codex-app-server");
}

/** The session can recover with another account added to its Machine: it is bound to one, and the
 * runner can list and switch them. The card's Choose Another Account… appears only then; #1743
 * widens it to sessions on the Machine's default sign-in without changing the dialog. */
export function authenticationAccountChoiceApplies(
  session: SessionView,
  approval: PendingApproval,
  runner: RunnerView | undefined,
): boolean {
  return authenticationRecoveryPanelApplies(session, approval) && !!session.providerAccountId &&
    !approval.options.some((option) => option.optionId === "auth:cancel") &&
    runnerSupportsProtocol(runner?.protocolVersion, "providerAuthenticationAccountRecovery");
}

export function signInProviderName(driver: SessionView["driver"]): string {
  return driver === "claude-code" ? "Claude Code" : "Codex";
}

/** The sign-in card's own words (§17): labels are Title Case, the rest are sentences. */
export const SIGN_IN_COPY = {
  group: "Account Recovery",
  thisSessionUses: "This Session Uses",
  signedInNow: "Signed In Now",
  lastChecked: "Last Checked",
  checkAgain: "Check Again",
  machineDefault: "Machine Default Sign-In",
  chooseAnotherAccount: "Choose Another Account…",
  startSignIn: "Start Sign-In",
  signInMethods: "Sign-In Methods",
  rechecking: "Checking the sign-in again…",
  labelHelp: "A name chosen on this machine; the provider has not confirmed it.",
  defaultHelp: "The provider's own sign-in on this machine.",
} as const;

/** What the card's one primary will do, in the state the runner put the session in. */
export type SignInSituation = "different_account" | "signed_out" | "read_only";

export function signInSituation(approval: PendingApproval): SignInSituation | null {
  const ids = new Set(approval.options.map((option) => option.optionId));
  if (ids.has("auth:cancel")) return null;
  if (ids.has("auth:accept-current")) return "different_account";
  if (ids.has("auth:login")) return "signed_out";
  return ids.has("auth:revalidate") ? "read_only" : null;
}

/** What the facts can say about the account signed in now: shown (an email), still being checked,
 * unknown to an older runner, or unknown for now (offline, a failed or inconclusive check, no email). */
export type SignedInAccountView = "seen" | "checking" | "older_runner" | "unseen";

/**
 * The one sentence under the facts: the situation, and what the primary does about it. It never
 * claims more than Signed In Now shows: a mismatch the facts cannot show is stated as unknown. While
 * a sign-in runs it carries the sign-in's status, which the embedded sign-in does not repeat.
 */
export function signInSentence({ situation, provider, signingIn, loginStatus, account = "seen" }: {
  situation: SignInSituation | null;
  provider: string;
  signingIn: boolean;
  loginStatus?: ProviderLoginView["status"];
  account?: SignedInAccountView;
}): string | null {
  if (signingIn) {
    switch (loginStatus) {
      case "awaiting_code":
        return `Sign in to ${provider} with Open Provider Sign-In, then paste the authorization code here.`;
      case "waiting_for_provider":
        return `Finish signing in to ${provider} on the provider's page. This card updates when it's done.`;
      case "failed":
        return `The sign-in to ${provider} failed. Cancel it, then try again.`;
      case "timed_out":
        return `The sign-in to ${provider} timed out. Cancel it, then try again.`;
      default:
        return `A sign-in to ${provider} is starting. Follow it here, or cancel it.`;
    }
  }
  switch (situation) {
    case "different_account":
      if (account === "older_runner") {
        return `This machine's runner can't tell which account ${provider} uses. Use Current Account continues this ` +
          `session with whatever account ${provider} is signed in to.`;
      }
      if (account === "checking") {
        return `Checking which account ${provider} uses. Use Current Account continues this session with ` +
          `whatever account ${provider} is signed in to.`;
      }
      if (account === "unseen") {
        return `Wollipog couldn't check which account ${provider} uses. Use Current Account continues this session ` +
          `with whatever account ${provider} is signed in to.`;
      }
      return `${provider} is signed in to a different account than this session uses. Use Current Account continues ` +
        "this session with it.";
    case "signed_out":
      return `${provider} is signed out. Start Sign-In signs in on this machine, and the session continues.`;
    case "read_only":
      return `Wollipog can't start a sign-in here. Sign in to ${provider} on the machine as the request details ` +
        "describe, then choose Recheck Authentication.";
    default:
      return null;
  }
}

/**
 * The Request Card's sign-in body (#2198, docs/design-system.md §5.4): the facts of the sign-in and
 * one sentence saying what the card's primary will do. The provider-reported email lives only in
 * this component's memory for the open card and is dropped whenever the card or account changes.
 *
 * Check Again on the Last Checked fact runs the runner's recheck (`onRecheck`); it is absent when
 * Recheck Authentication is the card's primary. While a sign-in runs only the session's account is
 * a fact, and the runner's sign-in renders below it. The Machine's other accounts are not on the
 * card: Choose Another Account… opens them in a dialog (ChooseAccountDialog, #2208).
 */
export function AuthenticationRecoveryPanel({
  session,
  approval,
  runner,
  runnerOnline,
  recheck,
  refreshKey = 0,
}: {
  session: SessionView;
  approval: PendingApproval;
  runner: RunnerView | undefined;
  runnerOnline: boolean;
  /** The Last Checked fact's Check Again, when Recheck Authentication is not the card's primary. */
  recheck?: { run: () => Promise<void>; busy: boolean; disabled: boolean; describedBy?: string };
  /** Changes when something else may have changed the signed-in account (a refused account choice),
   * so the identity is read again. */
  refreshKey?: number;
}) {
  const api = useApi();
  const supported = runnerSupportsProtocol(runner?.protocolVersion, "providerAuthenticationAccountRecovery");
  const provider = signInProviderName(session.driver);
  const providerLogin = runner?.providerLogins?.find((login) =>
    login.sessionId === session.id && login.status !== "succeeded" && login.status !== "cancelled");
  const signingIn = !!providerLogin || approval.options.some((option) => option.optionId === "auth:cancel");
  // Everything fetched belongs to this exact card and configured account. A change to either
  // discards the old answer before it can be shown against the new state.
  const cardKey = `${approval.requestId}\u0000${session.providerAccountId ?? ""}`;
  const [refreshes, setRefreshes] = useState(0);
  const [identity, setIdentity] = useState<Loadable<ProviderAuthenticationCurrentIdentity> | null>(null);
  const active = supported && runnerOnline && !signingIn;

  useEffect(() => {
    setIdentity(null);
    if (!active) return;
    let cancelled = false;
    setIdentity({ key: cardKey, state: "loading" });
    api.authenticationCurrentIdentity(session.id, approval.requestId).then(
      (result) => { if (!cancelled) setIdentity({ key: cardKey, state: "loaded", value: result.identity }); },
      (cause) => { if (!cancelled) setIdentity({ key: cardKey, state: "failed", error: (cause as Error).message }); },
    );
    return () => { cancelled = true; };
  }, [api, active, approval.requestId, cardKey, refreshes, refreshKey, session.id]);

  const currentIdentity = identity?.key === cardKey ? identity : null;
  const checkAgain = recheck && (
    <BusyButton
      className="btn sm ghost"
      busy={recheck.busy}
      progress={SIGN_IN_COPY.rechecking}
      disabled={recheck.disabled}
      aria-describedby={recheck.describedBy}
      data-session-request-control="option:auth:revalidate"
      onClick={() => {
        // The recheck answers the card; reading the identity again shows what it found.
        void recheck.run().finally(() => setRefreshes((value) => value + 1));
      }}
    >
      {SIGN_IN_COPY.checkAgain}
    </BusyButton>
  );
  const sentence = signInSentence({
    situation: signInSituation(approval),
    provider,
    signingIn,
    loginStatus: providerLogin?.status,
    account: signedInAccountView(supported, runnerOnline, currentIdentity),
  });

  return (
    <div className="sign-in-body" role="group" aria-label={SIGN_IN_COPY.group}>
      <dl className="facts sign-in-facts">
        <div>
          <dt>{SIGN_IN_COPY.thisSessionUses}</dt>
          <dd>
            {session.providerAccountLabel
              ? <AccountIdentifier identity={`${session.id}:${cardKey}`} value={session.providerAccountLabel}
                label="Session Account Email" revealTooltip={false} />
              : <span>{SIGN_IN_COPY.machineDefault}</span>}
            <span className="facts-help">
              {session.providerAccountLabel ? SIGN_IN_COPY.labelHelp : SIGN_IN_COPY.defaultHelp}
            </span>
          </dd>
        </div>
        {!signingIn && (
          <>
            <div>
              <dt>{SIGN_IN_COPY.signedInNow}</dt>
              <dd>
                <SignedInNow
                  provider={provider}
                  supported={supported}
                  runnerOnline={runnerOnline}
                  identity={currentIdentity}
                />
              </dd>
            </div>
            <div>
              <dt>{SIGN_IN_COPY.lastChecked}</dt>
              <dd>
                <span>{lastChecked(supported, runnerOnline, currentIdentity)}</span>
                {checkAgain}
              </dd>
            </div>
          </>
        )}
      </dl>
      {sentence && <p className="sign-in-sentence">{sentence}</p>}
      {providerLogin && <ProviderLoginCard runnerId={session.runnerId} login={providerLogin} embedded />}
    </div>
  );
}

/** "seen" only when Signed In Now shows an email, so the sentence never claims more than the facts. */
function signedInAccountView(
  supported: boolean,
  runnerOnline: boolean,
  identity: Loadable<ProviderAuthenticationCurrentIdentity> | null,
): SignedInAccountView {
  if (!supported) return "older_runner";
  if (!runnerOnline) return "unseen";
  if (!identity || identity.state === "loading") return "checking";
  if (identity.state === "failed") return "unseen";
  const value = identity.value;
  return value.status === "authenticated" && value.emailSupported && value.email ? "seen" : "unseen";
}

function lastChecked(
  supported: boolean,
  runnerOnline: boolean,
  identity: Loadable<ProviderAuthenticationCurrentIdentity> | null,
): ReactNode {
  if (!supported || !runnerOnline || identity?.state === "failed") return "Not checked";
  if (!identity || identity.state === "loading") return "Checking…";
  return <RelativeTime at={identity.value.observedAt} />;
}

function SignedInNow({
  provider,
  supported,
  runnerOnline,
  identity,
}: {
  provider: string;
  supported: boolean;
  runnerOnline: boolean;
  identity: Loadable<ProviderAuthenticationCurrentIdentity> | null;
}): ReactNode {
  if (!supported) {
    return (
      <span className="facts-help">
        This machine&apos;s runner can&apos;t report the signed-in account. Update and restart the runner to see it.
      </span>
    );
  }
  if (!runnerOnline) return <span className="facts-help">Unknown while the runner is offline.</span>;
  if (!identity || identity.state === "loading") return <span className="facts-help">Checking with {provider}…</span>;
  if (identity.state === "failed") {
    return <span className="facts-help" role="alert">{provider} couldn&apos;t be checked: {identity.error}</span>;
  }
  const value = identity.value;
  if (value.status === "unauthenticated") return <span>No account</span>;
  if (value.status === "unknown") return <span className="facts-help">{provider} couldn&apos;t confirm the account.</span>;
  if (!value.emailSupported || !value.email) {
    return (
      <span className="facts-help">
        {value.emailSupported ? `${provider} didn't supply an account email.` : `${provider} doesn't report an account email.`}
      </span>
    );
  }
  return (
    <AccountIdentifier
      identity={identity.key}
      value={value.email}
      label="Email"
      sensitive
      kind="email"
      revealTooltip={false}
    />
  );
}
