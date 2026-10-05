import React, { useState } from "react";
import type { ProviderLoginView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { accountLabelText } from "../personal-identifiers.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";

function statusLabel(status: ProviderLoginView["status"]): string {
  if (status === "starting") return "Starting";
  if (status === "awaiting_code") return "Authorization Code Required";
  if (status === "waiting_for_provider") return "Waiting for Provider";
  if (status === "succeeded") return "Signed In";
  if (status === "cancelled") return "Canceled";
  if (status === "timed_out") return "Timed Out";
  return "Sign-In Failed";
}

/**
 * A provider sign-in the runner is running. `embedded` is the sign-in Request Card's body (#2198):
 * the card's facts name the account and its sentence the status, so this drops its heading (and its
 * Cancel: the card's Cancel Sign-In is its only button), and Submit Code is not a second primary.
 */
export function ProviderLoginCard({ runnerId, login, revealScope = "", embedded = false }: {
  runnerId: string;
  login: ProviderLoginView;
  revealScope?: string;
  embedded?: boolean;
}) {
  const privacy = useAccountEmailPrivacy();
  const api = useApi();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = login.status === "starting" || login.status === "awaiting_code" ||
    login.status === "waiting_for_provider";

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.submitProviderLoginCode(runnerId, login.operationId, code);
      setCode("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.dismissProviderLoginNotice(runnerId, login.operationId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.cancelProviderLogin(runnerId, login.operationId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className="provider-login-card"
      data-provider-login-status={login.status}
      data-embedded={embedded || undefined}
      aria-label={`${accountLabelText(login.label, undefined, privacy.hide)} Provider Sign-In`}
    >
      {/* Embedded, the sign-in card's facts already name the account and its sentence the status. */}
      {!embedded && <div className="provider-login-head">
        <div>
          <strong><AccountIdentifier identity={JSON.stringify([runnerId, login.accountId, login.operationId, revealScope])} value={login.label} label="Account Email" /></strong>
          <span>{login.provider === "claude" ? "Claude" : "Codex"} · {statusLabel(login.status)}</span>
        </div>
        {!login.sessionId && (login.status === "failed" || login.status === "timed_out") && (
          <button type="button" className="btn ghost" disabled={busy}
            onClick={() => void dismiss()}>Dismiss</button>
        )}
        {active && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void cancel()}>Cancel</button>}
      </div>}
      {login.verificationUrl && (
        <p>
          <a className="link" href={login.verificationUrl} target="_blank" rel="noreferrer">Open Provider Sign-In</a>
        </p>
      )}
      {login.userCode && (
        <div className="provider-login-device-code">
          <span>Device Code</span>
          <code>{login.userCode}</code>
        </div>
      )}
      {login.expectsCode && (
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label>
            <span>Authorization Code</span>
            <input
              type="password"
              autoComplete="off"
              value={code}
              maxLength={4_096}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button type="submit" className={embedded ? "btn sm" : "btn primary sm"} disabled={busy || !code.trim()}>
            {busy ? "Submitting…" : "Submit Code"}
          </button>
        </form>
      )}
      {login.error && <p className="form-error" role="alert">{login.error}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </article>
  );
}
