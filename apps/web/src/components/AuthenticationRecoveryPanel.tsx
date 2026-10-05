import React, { useEffect, useState, type ReactNode } from "react";
import {
  runnerSupportsProtocol,
  type PendingApproval,
  type ProviderAuthenticationAccountOption,
  type ProviderAuthenticationCurrentIdentity,
  type ProviderLoginView,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { relativeTime } from "../format.js";
import { maskedAccountTitles } from "../personal-identifiers.js";
import type { StatusTone } from "../status-meta.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";
import { StatusBadge } from "./StatusBadge.js";
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
 * runner can list and switch them. The card's Choose Another Account… appears only then. */
export function authenticationAccountChoiceApplies(
  session: SessionView,
  approval: PendingApproval,
  runner: RunnerView | undefined,
): boolean {
  return authenticationRecoveryPanelApplies(session, approval) && !!session.providerAccountId &&
    !approval.options.some((option) => option.optionId === "auth:cancel") &&
    runnerSupportsProtocol(runner?.protocolVersion, "providerAuthenticationAccountRecovery");
}

function providerName(driver: SessionView["driver"]): string {
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
  otherAccounts: "Other Accounts",
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

/** What the facts can say about the account signed in now: shown, unknown to an older runner, or
 * unknown for now (offline, a failed or inconclusive check). */
export type SignedInAccountView = "seen" | "older_runner" | "unseen";

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

const AVAILABILITY: Record<ProviderAuthenticationAccountOption["availability"], { label: string; tone: StatusTone }> = {
  current: { label: "Current", tone: "neutral" },
  available: { label: "Signed In", tone: "success" },
  sign_in_required: { label: "Sign-In Required", tone: "warning" },
  status_unknown: { label: "Status Unknown", tone: "neutral" },
};

/**
 * The Request Card's sign-in body (#2198, docs/design-system.md §5.4): the facts of the sign-in and
 * one sentence saying what the card's primary will do. The provider-reported email lives only in
 * this component's memory for the open card and is dropped whenever the card or account changes.
 *
 * Check Again on the Last Checked fact runs the runner's recheck (`onRecheck`); it is absent when
 * Recheck Authentication is the card's primary. While a sign-in runs only the session's account is
 * a fact, and the runner's sign-in renders below it.
 *
 * `choosingAccount` shows the other accounts on the session's Machine, opened by the card's Choose
 * Another Account…; #2208 replaces that list with its dialog.
 */
export function AuthenticationRecoveryPanel({
  session,
  approval,
  runner,
  runnerOnline,
  recheck,
  choosingAccount = false,
  accountsId,
}: {
  session: SessionView;
  approval: PendingApproval;
  runner: RunnerView | undefined;
  runnerOnline: boolean;
  /** The Last Checked fact's Check Again, when Recheck Authentication is not the card's primary. */
  recheck?: { run: () => Promise<void>; busy: boolean; disabled: boolean; describedBy?: string };
  choosingAccount?: boolean;
  /** The id Choose Another Account… controls. */
  accountsId?: string;
}) {
  const api = useApi();
  const supported = runnerSupportsProtocol(runner?.protocolVersion, "providerAuthenticationAccountRecovery");
  const provider = providerName(session.driver);
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
  }, [api, active, approval.requestId, cardKey, refreshes, session.id]);

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
    account: !supported ? "older_runner"
      : !runnerOnline || currentIdentity?.state === "failed" ||
        (currentIdentity?.state === "loaded" && currentIdentity.value.status !== "authenticated") ? "unseen"
      : "seen",
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
      {choosingAccount && (
        <AccountChoice
          id={accountsId}
          session={session}
          approval={approval}
          runner={runner}
          provider={provider}
          active={active}
          runnerOnline={runnerOnline}
          cardKey={cardKey}
          onRefused={() => setRefreshes((value) => value + 1)}
        />
      )}
    </div>
  );
}

function lastChecked(
  supported: boolean,
  runnerOnline: boolean,
  identity: Loadable<ProviderAuthenticationCurrentIdentity> | null,
): string {
  if (!supported || !runnerOnline || identity?.state === "failed") return "Not checked";
  if (!identity || identity.state === "loading") return "Checking…";
  return relativeTime(identity.value.observedAt);
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

/**
 * The other accounts on the session's Machine, until #2208's Choose Another Account dialog replaces
 * this list. None is a primary: the card's footer holds its one.
 */
function AccountChoice({
  id,
  session,
  approval,
  runner,
  provider,
  active,
  runnerOnline,
  cardKey,
  onRefused,
}: {
  id?: string;
  session: SessionView;
  approval: PendingApproval;
  runner: RunnerView | undefined;
  provider: string;
  active: boolean;
  runnerOnline: boolean;
  cardKey: string;
  onRefused: () => void;
}) {
  const privacy = useAccountEmailPrivacy();
  const api = useApi();
  const accountInventoryKey = (runner?.providerAccounts ?? [])
    .map((account) => `${account.id}:${account.authStatus}`)
    .join("|");
  const [refreshes, setRefreshes] = useState(0);
  const [accounts, setAccounts] = useState<Loadable<ProviderAuthenticationAccountOption[]> | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  // A refusal belongs to the account that was chosen. It renders in that row, beside the control
  // the person just used, so it cannot land below the fold of a scrolling card.
  const [selectionError, setSelectionError] = useState<{ accountId: string; message: string } | null>(null);
  const [startingSignIn, setStartingSignIn] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setAccounts(null);
      return;
    }
    let cancelled = false;
    setAccounts((current) => current?.key === cardKey && current.state === "loaded"
      ? current
      : { key: cardKey, state: "loading" });
    api.authenticationAccounts(session.id).then(
      (result) => { if (!cancelled) setAccounts({ key: cardKey, state: "loaded", value: result.accounts }); },
      (cause) => { if (!cancelled) setAccounts({ key: cardKey, state: "failed", error: (cause as Error).message }); },
    );
    return () => { cancelled = true; };
  }, [api, active, accountInventoryKey, cardKey, refreshes, session.id]);

  const accountList = accounts?.key === cardKey ? accounts : null;
  const alternatives = accountList?.state === "loaded"
    ? accountList.value.filter((account) => account.availability !== "current")
    : [];
  // Button names cannot carry a reveal control, so an email-shaped label is named by a distinct
  // hidden ordinal instead of its value.
  const labels = alternatives.map((account) => account.label);
  const accountTitles = privacy.hide ? maskedAccountTitles(labels) : labels;
  const canStartSignIn = runner?.canManage === true && runnerSupportsProtocol(runner.protocolVersion, "providerLogin");
  const accountLogins = (runner?.providerLogins ?? []).filter((login) =>
    !login.sessionId && login.status !== "succeeded" && login.status !== "cancelled" &&
    alternatives.some((account) => account.id === login.accountId));

  const select = async (account: ProviderAuthenticationAccountOption) => {
    if (!session.providerAccountId) return;
    setSelecting(account.id);
    setSelectionError(null);
    try {
      await api.selectAuthenticationAccount(session.id, {
        requestId: approval.requestId,
        providerAccountId: account.id,
        expectedProviderAccountId: session.providerAccountId,
      });
    } catch (cause) {
      setSelectionError({ accountId: account.id, message: (cause as Error).message });
      const code = cause instanceof ApiError ? cause.code : undefined;
      if (code === "account_changed" || code === "recovery_changed" || code === "sign_in_required" ||
          code === "status_unknown") {
        setRefreshes((value) => value + 1);
        onRefused();
      }
    } finally {
      setSelecting(null);
    }
  };

  const signIn = async (accountId: string) => {
    setStartingSignIn(accountId);
    setSelectionError(null);
    try {
      await api.startProviderLogin(session.runnerId, { accountId });
    } catch (cause) {
      setSelectionError({ accountId, message: (cause as Error).message });
    } finally {
      setStartingSignIn(null);
    }
  };

  return (
    <section id={id} className="auth-recovery-accounts" aria-label={SIGN_IN_COPY.otherAccounts} ref={revealNode}>
      <h4>{SIGN_IN_COPY.otherAccounts}</h4>
      {!active ? (
        <p className="facts-help">
          {!runnerOnline
            ? "The runner is offline. Accounts will load when it reconnects."
            : "Finish or cancel the sign-in above before choosing another account."}
        </p>
      ) : !accountList || accountList.state === "loading" ? (
        <p className="facts-help">Loading accounts…</p>
      ) : accountList.state === "failed" ? (
        <p className="facts-help" role="alert">Accounts could not be loaded: {accountList.error}</p>
      ) : alternatives.length === 0 ? (
        <p className="facts-help">
          No other {provider} accounts are added to this machine. A machine owner or organization admin can add one
          from the machine&apos;s Accounts section.
        </p>
      ) : (
        <ul className="auth-recovery-account-list">
          {alternatives.map((account, index) => (
            <li key={account.id} className="auth-recovery-account" data-availability={account.availability}>
              <div className="auth-recovery-account-head">
                <AccountIdentifier
                  identity={`${session.id}:${cardKey}:${account.id}`}
                  className="auth-recovery-account-label"
                  value={account.label}
                  label="Account Email"
                  lead="Account"
                  revealTooltip={false}
                />
                <StatusBadge tone={AVAILABILITY[account.availability].tone} label={AVAILABILITY[account.availability].label} />
              </div>
              <p className="facts-help">{accountGuidance(account, canStartSignIn)}</p>
              <div className="auth-recovery-account-actions">
                {account.availability === "sign_in_required" && canStartSignIn && (
                  <BusyButton
                    className="btn sm"
                    busy={startingSignIn === account.id}
                    progress="Starting the sign-in…"
                    disabled={(!!selecting || !!startingSignIn) && startingSignIn !== account.id}
                    onClick={() => void signIn(account.id)}
                  >
                    Sign In
                  </BusyButton>
                )}
                <BusyButton
                  className="btn sm"
                  busy={selecting === account.id}
                  progress="Checking the account…"
                  disabled={(!!selecting || !!startingSignIn) && selecting !== account.id}
                  aria-label={`${account.availability === "available" ? "Use" : "Check and Use"} ${accountTitles[index]}`}
                  onClick={() => void select(account)}
                >
                  {account.availability === "available" ? "Use Account" : "Check and Use"}
                </BusyButton>
              </div>
              {selectionError?.accountId === account.id && (
                <div className="form-error auth-recovery-account-error" role="alert" ref={revealNode}>
                  {selectionError.message}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {accountLogins.map((login) => (
        <ProviderLoginCard key={login.operationId} runnerId={session.runnerId} login={login} />
      ))}
      {selectionError && !alternatives.some((account) => account.id === selectionError.accountId) && (
        <div className="form-error" role="alert" ref={revealNode}>{selectionError.message}</div>
      )}
    </section>
  );
}

/** Bring a newly shown list or refusal into view inside the card's scrolling body. */
function revealNode(node: HTMLElement | null): void {
  node?.scrollIntoView?.({ block: "nearest" });
}

function accountGuidance(account: ProviderAuthenticationAccountOption, canStartSignIn: boolean): string {
  if (account.availability === "available") {
    return "Wollipog rechecks this account's sign-in, then resumes the session with it.";
  }
  if (account.availability === "sign_in_required") {
    return canStartSignIn
      ? "This account is signed out. Sign in, then use it. Check and Use rechecks it first."
      : "This account is signed out. Ask a machine owner or organization admin to sign in to it, then use it.";
  }
  return "Wollipog could not confirm this account's sign-in. Check and Use rechecks it before resuming.";
}
