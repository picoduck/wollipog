import React, { useState } from "react";
import { runnerSupportsProtocol, type ProviderAccountDefinition, type RunnerView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useFeedback } from "./FeedbackProvider.js";
import { activeSessionConflict } from "./active-session-conflict.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChevronRightIcon, PlusIcon } from "./Icons.js";
import { Modal } from "./common.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";
import { Select } from "./ui/ChoiceControls.js";

/** Coded adoption refusals whose runner message is technical, in words the person can act on. */
const ADOPTION_REFUSALS: Readonly<Record<string, string>> = {
  PROFILE_EXISTS: "This account's HOME already has a profile record that cannot accept this control plane. " +
    "It may be unreadable, belong to the other provider, or already list the maximum number of control planes.",
  HOME_IN_USE: "Another runner or control plane is using this account's HOME. Try again when it is no longer in use.",
  UNSUPPORTED_HOME: "This account's HOME cannot hold a provider profile. Windows Machines and WSL account homes are not supported.",
  PROVIDER_PROFILE_GRANT_REVOKED: "Access was revoked while the account was being adopted. Adopt it again to grant access.",
};

const ADOPTION_FAILED_DEFAULT = "The provider profile could not be adopted.";

/** The sentence-case message for a failed Adopt as Profile or Revoke Access request. */
export function providerProfileErrorMessage(cause: unknown, action: "adopt" | "revoke"): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error ? cause.message : String(cause);
  if (action === "adopt" && cause.status === 504) {
    return "The Machine did not confirm the adoption in time. It completes when the Machine reports the account again.";
  }
  if (action === "adopt" && cause.status === 409 && cause.message === "runner is offline") {
    return "The Machine is offline. Adopting an account needs the Machine to be online.";
  }
  if (cause.status === 409 && cause.code && ADOPTION_REFUSALS[cause.code]) return ADOPTION_REFUSALS[cause.code]!;
  if (cause.status === 409 && cause.code === "PROVIDER_PROFILE_ADOPTION_FAILED") {
    // No code: the runner kept this authorization pending, so a retry reuses it.
    const detail = cause.message && cause.message !== ADOPTION_FAILED_DEFAULT ? ` ${cause.message}` : "";
    return `The Machine could not adopt this account. Adopt it again to retry.${detail}`;
  }
  // The capability refusal ("This machine needs a newer runner…") and the other refusals are
  // already sentence-case copy from the control plane.
  return cause.message;
}

export function ProviderAccountsSection({ runner, online, canManageProfiles = false }: {
  runner: RunnerView;
  online: boolean;
  /** The viewer is an organization Owner or Admin. Profile routes are not member-scoped, so a member
   * with manage rights on this Machine does not get the profile actions. */
  canManageProfiles?: boolean;
}) {
  const privacy = useAccountEmailPrivacy();
  const [revealEpoch, setRevealEpoch] = useState(0);
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [label, setLabel] = useState("");
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [busyProfileAction, setBusyProfileAction] = useState<"adopt" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = runnerSupportsProtocol(runner.protocolVersion, "providerLogin");
  const removalSupported = runnerSupportsProtocol(runner.protocolVersion, "providerAccountRemoval");
  const canManage = runner.canManage === true;
  const profileActions = canManageProfiles && runnerSupportsProtocol(runner.protocolVersion, "providerProfiles");
  const logins = (runner.providerLogins ?? []).filter((login) =>
    login.status !== "succeeded" && login.status !== "cancelled");

  const startNew = async () => {
    setBusyAccountId("new");
    setError(null);
    try {
      await api.startProviderLogin(runner.runnerId, { provider, label: label.trim() });
      setAdding(false);
      setLabel("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyAccountId(null);
    }
  };

  const signIn = async (accountId: string) => {
    setBusyAccountId(accountId);
    setError(null);
    try {
      await api.startProviderLogin(runner.runnerId, { accountId });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyAccountId(null);
    }
  };

  const remove = async (account: ProviderAccountDefinition) => {
    const approved = await confirm({
      title: "Remove Account",
      message: "Wollipog stops offering this account on the machine and deletes the credentials it stored for it. " +
        "A session that still uses the account keeps its credentials, and the account itself is not affected.",
      details: (
        <span className="provider-account-remove-target">
          <AccountIdentifier identity={`${runner.runnerId}:${account.id}`} value={account.label} label="Account Email" />
          <span className="atag">{account.provider === "claude" ? "Claude" : "Codex"}</span>
        </span>
      ),
      confirmLabel: "Remove Account",
      tone: "danger",
    });
    if (!approved) return;
    setBusyAccountId(account.id);
    setError(null);
    try {
      const result = await api.removeProviderAccount(runner.runnerId, account.id);
      showToast(result.credentialsRetained
        ? "Account removed. Its credentials were kept because a session on this Machine still uses them."
        : "Account removed.", { tone: "success" });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyAccountId(null);
    }
  };

  const accountTarget = (account: ProviderAccountDefinition) => (
    <span className="provider-account-remove-target">
      <AccountIdentifier identity={`${runner.runnerId}:${account.id}`} value={account.label} label="Account Email" />
      <span className="atag">{account.provider === "claude" ? "Claude" : "Codex"}</span>
    </span>
  );

  const runProfileAction = async (account: ProviderAccountDefinition, action: "adopt" | "revoke", run: () => Promise<void>) => {
    setBusyAccountId(account.id);
    setBusyProfileAction(action);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(providerProfileErrorMessage(cause, action));
    } finally {
      setBusyAccountId(null);
      setBusyProfileAction(null);
    }
  };

  const adopt = async (account: ProviderAccountDefinition) => {
    const approved = await confirm({
      title: "Adopt as Profile",
      message: "After adoption, only control planes granted this profile can use this account's HOME, so other control planes " +
        "that share this Machine's account lose access to it. Existing sessions keep working as before; new sessions record the profile.",
      details: accountTarget(account),
      confirmLabel: "Adopt as Profile",
    });
    if (!approved) return;
    await runProfileAction(account, "adopt", async () => {
      await api.adoptProviderProfile(runner.runnerId, account.id);
      showToast("Account adopted as a profile.", { tone: "success" });
    });
  };

  const revoke = async (account: ProviderAccountDefinition) => {
    const approved = await confirm({
      title: "Revoke Access",
      message: "This control plane stops using this account's profile, and sessions that use it cannot restart until access is granted again. " +
        "Other control planes' access is not affected.",
      details: accountTarget(account),
      confirmLabel: "Revoke Access",
      tone: "danger",
    });
    if (!approved) return;
    await runProfileAction(account, "revoke", async () => {
      try {
        await api.revokeProviderProfileAccess(runner.runnerId, account.id, false);
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 409 || cause.code !== "PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS") throw cause;
        setBusyAccountId(null);
        setBusyProfileAction(null);
        const conflict = activeSessionConflict(cause);
        const sessions = conflict.count == null ? "Active sessions use"
          : conflict.count === 1 ? "1 active session uses" : `${conflict.count} active sessions use`;
        const force = await confirm({
          title: "Revoke Access from Active Sessions",
          message: `${sessions} this account's profile. Revoking access stops them from restarting until access is granted again.`,
          detailRows: conflict.detailRows,
          detailRowsOverflow: conflict.detailRowsOverflow,
          confirmLabel: "Revoke Access",
          tone: "danger",
        });
        if (!force) return;
        setBusyAccountId(account.id);
        setBusyProfileAction("revoke");
        await api.revokeProviderProfileAccess(runner.runnerId, account.id, true);
      }
      showToast("Access revoked.", { tone: "success" });
    });
  };

  if (!supported && !(runner.providerAccounts?.length)) return null;
  return (
    <>
      <details className="runner-agents disclosure" open={logins.length > 0 || undefined}
        onToggle={() => setRevealEpoch((value) => value + 1)}>
        <summary onClick={() => setRevealEpoch((value) => value + 1)}>
          <ChevronRightIcon className="disclosure-chevron" />
          <span className="runner-agents-label">Accounts</span>
          <span className="group-count">{runner.providerAccounts?.length ?? 0}</span>
        </summary>
        <div className="runner-agents-body">
          <div className="provider-accounts-actions">
            <p>Sign in to Claude or Codex on this Machine without opening a shell.</p>
            {supported && canManage && (
              <button className="btn sm" type="button" disabled={!online} onClick={() => { setError(null); setAdding(true); }}>
                <PlusIcon size={14} /> Add Account
              </button>
            )}
          </div>
          <div className="agent-list">
            {(runner.providerAccounts ?? []).map((account) => (
              <div className="agent-row" key={account.id}>
                <div className="agent-row-head">
                  <AccountIdentifier identity={`${runner.runnerId}:${account.id}:${revealEpoch}`} className="agent-name" value={account.label} label="Account Email" />
                  {supported && canManage && account.authStatus !== "authenticated" && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!online || busyAccountId !== null}
                      onClick={() => void signIn(account.id)}
                    >
                      {busyAccountId === account.id ? "Starting…" : "Sign In"}
                    </button>
                  )}
                  {removalSupported && canManage && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={!online || busyAccountId !== null}
                      onClick={() => void remove(account)}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="agent-row-meta">
                  <span className="atag">{account.provider === "claude" ? "Claude" : "Codex"}</span>
                  <span className={`atag ${account.authStatus === "unauthenticated" ? "broken" : "discovered"}`}>
                    {account.authStatus === "authenticated" ? "Logged In" :
                      account.authStatus === "unauthenticated" ? "Login Required" : "Login Unknown"}
                  </span>
                  {account.profile?.access === "granted" && <span className="atag ctx">Profile</span>}
                  {account.profile?.access === "pending" && <span className="atag">Grant Pending</span>}
                  {account.profile?.access === "not_granted" && <span className="atag broken">Not Granted</span>}
                </div>
                {/* Their own line: with Sign In and Remove the head row has no room left for the name. */}
                {profileActions && (
                  <div className="agent-row-meta">
                    {account.profile?.access !== "granted" && (
                      <BusyButton
                        className="btn sm"
                        busy={busyAccountId === account.id && busyProfileAction === "adopt"}
                        progress="Authorizing…"
                        disabled={!online || (busyAccountId !== null && !(busyAccountId === account.id && busyProfileAction === "adopt"))}
                        onClick={() => void adopt(account)}
                      >
                        Adopt as Profile
                      </BusyButton>
                    )}
                    {(account.profile?.access === "granted" || account.profile?.access === "pending") && (
                      <BusyButton
                        className="btn sm ghost"
                        busy={busyAccountId === account.id && busyProfileAction === "revoke"}
                        progress="Revoking…"
                        disabled={busyAccountId !== null && !(busyAccountId === account.id && busyProfileAction === "revoke")}
                        onClick={() => void revoke(account)}
                      >
                        Revoke Access
                      </BusyButton>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {logins.map((login) => <ProviderLoginCard key={login.operationId} runnerId={runner.runnerId} login={login} revealScope={String(revealEpoch)} />)}
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      </details>
      {adding && (
        <Modal
          title="Add Account"
          onClose={() => { if (!busyAccountId) { setAdding(false); setError(null); } }}
          footer={(
            <>
              <button type="button" className="btn" disabled={!!busyAccountId} onClick={() => setAdding(false)}>Cancel</button>
              <button
                type="submit"
                form="provider-account-form"
                className="btn primary"
                disabled={!!busyAccountId || !label.trim()}
              >
                {busyAccountId ? "Starting…" : "Start Sign-In"}
              </button>
            </>
          )}
        >
          <form id="provider-account-form" className="provider-account-form" onSubmit={(event) => { event.preventDefault(); void startNew(); }}>
            <label>
              <span>Provider</span>
              <Select
                label="Provider"
                value={provider}
                options={[
                  { value: "claude", label: "Claude" },
                  { value: "codex", label: "Codex" },
                ]}
                onChange={setProvider}
              />
            </label>
            <label>
              <span>Account Label</span>
              <input
                autoFocus
                maxLength={100}
                value={label}
                aria-describedby="provider-account-label-hint"
                onChange={(event) => setLabel(event.target.value)}
              />
              <small id="provider-account-label-hint" className="muted">
                {privacy.hide
                  ? "A name such as Work or Personal stays visible. An email address is hidden until revealed."
                  : "A name such as Work or Personal stays visible. Email addresses follow Hide Account Emails in Settings."}
              </small>
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
          </form>
        </Modal>
      )}
    </>
  );
}
