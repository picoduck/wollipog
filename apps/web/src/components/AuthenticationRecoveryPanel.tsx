import React, { useEffect, useState } from "react";
import {
  runnerSupportsProtocol,
  type PendingApproval,
  type ProviderAuthenticationAccountOption,
  type ProviderAuthenticationCurrentIdentity,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";

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

function providerName(driver: SessionView["driver"]): string {
  return driver === "claude-code" ? "Claude Code" : "Codex";
}

const AVAILABILITY_LABEL: Record<ProviderAuthenticationAccountOption["availability"], string> = {
  current: "Current",
  available: "Signed In",
  sign_in_required: "Sign-In Required",
  status_unknown: "Status Unknown",
};

/**
 * Account context for an Authentication Required card: the identity the provider reports right
 * now, the session's configured account label (never presented as verified), and the other
 * compatible accounts on the same Machine. The provider-reported email lives only in this
 * component's memory for the open card and is dropped whenever the card or account changes.
 */
export function AuthenticationRecoveryPanel({
  session,
  approval,
  runner,
  runnerOnline,
}: {
  session: SessionView;
  approval: PendingApproval;
  runner: RunnerView | undefined;
  runnerOnline: boolean;
}) {
  const api = useApi();
  const supported = runnerSupportsProtocol(runner?.protocolVersion, "providerAuthenticationAccountRecovery");
  const provider = providerName(session.driver);
  const signingIn = runner?.providerLogins?.some((login) =>
    login.sessionId === session.id && login.status !== "succeeded" && login.status !== "cancelled") === true;
  // Everything fetched belongs to this exact card and configured account. A change to either
  // discards the old answer before it can be shown against the new state.
  const cardKey = `${approval.requestId}\u0000${session.providerAccountId ?? ""}`;
  const accountInventoryKey = (runner?.providerAccounts ?? [])
    .map((account) => `${account.id}:${account.authStatus}`)
    .join("|");
  const [refreshes, setRefreshes] = useState(0);
  const [identity, setIdentity] = useState<Loadable<ProviderAuthenticationCurrentIdentity> | null>(null);
  const [accounts, setAccounts] = useState<Loadable<ProviderAuthenticationAccountOption[]> | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [startingSignIn, setStartingSignIn] = useState<string | null>(null);
  const active = supported && runnerOnline && !signingIn;

  useEffect(() => {
    // A refused selection's explanation outlives the refresh it triggers; the next action clears it.
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

  if (!supported) {
    return (
      <div className="auth-recovery" role="group" aria-label="Account Recovery">
        <p className="auth-recovery-note">
          This Machine&apos;s runner cannot show which account {provider} reports or switch accounts from this card.
          Update and restart the runner, or use this card&apos;s other actions.
        </p>
      </div>
    );
  }

  const currentIdentity = identity?.key === cardKey ? identity : null;
  const accountList = accounts?.key === cardKey ? accounts : null;
  const alternatives = accountList?.state === "loaded"
    ? accountList.value.filter((account) => account.availability !== "current")
    : [];
  const canSwitch = !!session.providerAccountId;
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
      setSelectionError((cause as Error).message);
      const code = cause instanceof ApiError ? cause.code : undefined;
      if (code === "account_changed" || code === "recovery_changed" || code === "sign_in_required" ||
          code === "status_unknown") {
        setRefreshes((value) => value + 1);
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
      setSelectionError((cause as Error).message);
    } finally {
      setStartingSignIn(null);
    }
  };

  return (
    <div className="auth-recovery" role="group" aria-label="Account Recovery">
      <dl className="auth-recovery-identity">
        <div>
          <dt>Provider-Reported Account</dt>
          <dd>
            <ProviderIdentity
              provider={provider}
              runnerOnline={runnerOnline}
              signingIn={signingIn}
              identity={currentIdentity}
              onCheckAgain={() => setRefreshes((value) => value + 1)}
            />
          </dd>
        </div>
        <div>
          <dt>Configured Account</dt>
          <dd>
            <span>{session.providerAccountLabel ?? "Machine Default Sign-In"}</span>
            <span className="auth-recovery-hint">
              {session.providerAccountLabel
                ? "A label chosen on this Machine. The provider has not verified it."
                : "This session uses the provider's default sign-in on this Machine."}
            </span>
          </dd>
        </div>
      </dl>
      <section className="auth-recovery-accounts" aria-label="Choose Another Account">
        <h4>Choose Another Account</h4>
        {!canSwitch ? (
          <p className="auth-recovery-note">
            This session is not bound to an account added to this Machine, so it can recover only with its current sign-in.
          </p>
        ) : !active ? (
          <p className="auth-recovery-note">
            {!runnerOnline
              ? "The runner is offline. Accounts will load when it reconnects."
              : "Finish or cancel the sign-in above before choosing another account."}
          </p>
        ) : !accountList || accountList.state === "loading" ? (
          <p className="auth-recovery-note">Loading accounts…</p>
        ) : accountList.state === "failed" ? (
          <p className="auth-recovery-note" role="alert">Accounts could not be loaded: {accountList.error}</p>
        ) : alternatives.length === 0 ? (
          <p className="auth-recovery-note">
            No other {provider} accounts are added to this Machine. A Machine owner or organization admin can add one
            from the Machine&apos;s Accounts section.
          </p>
        ) : (
          <ul className="auth-recovery-account-list">
            {alternatives.map((account) => (
              <li key={account.id} className="auth-recovery-account" data-availability={account.availability}>
                <div className="auth-recovery-account-head">
                  <span className="auth-recovery-account-label">{account.label}</span>
                  <span className={`atag ${account.availability === "sign_in_required" ? "broken" : "discovered"}`}>
                    {AVAILABILITY_LABEL[account.availability]}
                  </span>
                </div>
                <p className="auth-recovery-hint">{accountGuidance(account, canStartSignIn)}</p>
                <div className="auth-recovery-account-actions">
                  {account.availability === "sign_in_required" && canStartSignIn && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!!selecting || !!startingSignIn}
                      onClick={() => void signIn(account.id)}
                    >
                      {startingSignIn === account.id ? "Starting…" : "Sign In"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn sm${account.availability === "available" ? " primary" : ""}`}
                    disabled={!!selecting || !!startingSignIn}
                    aria-label={`${account.availability === "available" ? "Use" : "Check and Use"} ${account.label}`}
                    onClick={() => void select(account)}
                  >
                    {selecting === account.id
                      ? "Checking…"
                      : account.availability === "available" ? "Use Account" : "Check and Use"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {accountLogins.map((login) => (
          <ProviderLoginCard key={login.operationId} runnerId={session.runnerId} login={login} />
        ))}
        {selectionError && <div className="form-error" role="alert">{selectionError}</div>}
      </section>
    </div>
  );
}

function accountGuidance(account: ProviderAuthenticationAccountOption, canStartSignIn: boolean): string {
  if (account.availability === "available") {
    return "Wollipog rechecks this account's sign-in, then resumes the session with it.";
  }
  if (account.availability === "sign_in_required") {
    return canStartSignIn
      ? "This account is signed out. Sign in, then use it. Check and Use rechecks it first."
      : "This account is signed out. Ask a Machine owner or organization admin to sign in to it, then use it.";
  }
  return "Wollipog could not confirm this account's sign-in. Check and Use rechecks it before resuming.";
}

function ProviderIdentity({
  provider,
  runnerOnline,
  signingIn,
  identity,
  onCheckAgain,
}: {
  provider: string;
  runnerOnline: boolean;
  signingIn: boolean;
  identity: Loadable<ProviderAuthenticationCurrentIdentity> | null;
  onCheckAgain: () => void;
}) {
  const checkAgain = (
    <button type="button" className="btn ghost sm" onClick={onCheckAgain}>Check Again</button>
  );
  if (!runnerOnline) return <span className="auth-recovery-hint">The runner is offline.</span>;
  if (signingIn) return <span className="auth-recovery-hint">Available after the sign-in above finishes.</span>;
  if (!identity || identity.state === "loading") {
    return <span className="auth-recovery-hint">Checking with {provider}…</span>;
  }
  if (identity.state === "failed") {
    return (
      <span className="auth-recovery-email">
        <span className="auth-recovery-hint" role="alert">The current account could not be checked: {identity.error}</span>
        {checkAgain}
      </span>
    );
  }
  const value = identity.value;
  const checkedAt = new Date(value.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const checked = (
    <>
      <span className="auth-recovery-hint">Checked at {checkedAt}.</span>
      {checkAgain}
    </>
  );
  const message = value.status === "unauthenticated"
    ? `${provider} reports that no account is signed in.`
    : value.status === "unknown"
    ? `${provider} could not confirm which account is signed in.`
    : !value.emailSupported
    ? `${provider} does not report an account email, so its identity cannot be displayed.`
    : !value.email
    ? `${provider} did not supply an account email, so its identity cannot be displayed.`
    : null;
  return (
    <span className="auth-recovery-email">
      {message ?? <PendingMaskedIdentifier value={value.email!} label="Provider-Reported Email" />}
      {checked}
    </span>
  );
}

/**
 * TEMPORARY SEAM — replaced by the shared default-masked identifier from #1648 before this branch
 * is proposed. It exists only so the recovery flow can be exercised meanwhile; do not reuse it.
 */
function PendingMaskedIdentifier({ value, label }: { value: string; label: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="auth-recovery-masked">
      <span aria-label={revealed ? undefined : `${label} Hidden`}>{revealed ? value : "••••••••"}</span>
      <button
        type="button"
        className="btn ghost sm"
        aria-label={`${revealed ? "Hide" : "Reveal"} ${label}`}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? "Hide" : "Reveal"}
      </button>
    </span>
  );
}
