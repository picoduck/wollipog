import React, { useState } from "react";
import { runnerSupportsProtocol, type ProviderAccountDefinition, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ChevronRightIcon, PlusIcon } from "./Icons.js";
import { Modal } from "./common.js";
import { PersonalIdentifier } from "./PersonalIdentifier.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";
import { Select } from "./ui/ChoiceControls.js";

export function ProviderAccountsSection({ runner, online }: { runner: RunnerView; online: boolean }) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [label, setLabel] = useState("");
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = runnerSupportsProtocol(runner.protocolVersion, "providerLogin");
  const removalSupported = runnerSupportsProtocol(runner.protocolVersion, "providerAccountRemoval");
  const canManage = runner.canManage === true;
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
      title: "Remove Account?",
      message: "Wollipog stops offering this account on the Machine and deletes the credentials it stored " +
        "for it. If a session on this Machine still uses the account, its credentials are kept so that " +
        "session can continue. The account itself is not affected.",
      details: (
        <span className="provider-account-remove-target">
          <PersonalIdentifier value={account.label} label="Account Email" />
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

  if (!supported && !(runner.providerAccounts?.length)) return null;
  return (
    <>
      <details className="runner-agents" open={logins.length > 0 || undefined}>
        <summary>
          <span className="runner-agents-label">Accounts</span>
          <span className="group-count">{runner.providerAccounts?.length ?? 0}</span>
          <ChevronRightIcon className="runner-disclosure-chevron" />
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
                  <PersonalIdentifier className="agent-name" value={account.label} label="Account Email" />
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
                </div>
              </div>
            ))}
          </div>
          {logins.map((login) => <ProviderLoginCard key={login.operationId} runnerId={runner.runnerId} login={login} />)}
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
                A name such as Work or Personal stays visible. An email address is hidden until revealed.
              </small>
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
          </form>
        </Modal>
      )}
    </>
  );
}
