import React, { useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ChevronRightIcon, PlusIcon } from "./Icons.js";
import { Modal } from "./common.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";
import { Select } from "./ui/ChoiceControls.js";

export function ProviderAccountsSection({ runner, online }: { runner: RunnerView; online: boolean }) {
  const api = useApi();
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [label, setLabel] = useState("");
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = runnerSupportsProtocol(runner.protocolVersion, "providerLogin");
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
                  <span className="agent-name">{account.label}</span>
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
              <input autoFocus maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
          </form>
        </Modal>
      )}
    </>
  );
}
