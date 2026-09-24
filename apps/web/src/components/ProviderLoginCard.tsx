import React, { useState } from "react";
import type { ProviderLoginView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { accountLabelText } from "../personal-identifiers.js";
import { PersonalIdentifier } from "./PersonalIdentifier.js";

function statusLabel(status: ProviderLoginView["status"]): string {
  if (status === "starting") return "Starting";
  if (status === "awaiting_code") return "Authorization Code Required";
  if (status === "waiting_for_provider") return "Waiting for Provider";
  if (status === "succeeded") return "Signed In";
  if (status === "cancelled") return "Cancelled";
  if (status === "timed_out") return "Timed Out";
  return "Sign-In Failed";
}

export function ProviderLoginCard({ runnerId, login }: { runnerId: string; login: ProviderLoginView }) {
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
      aria-label={`${accountLabelText(login.label)} Provider Sign-In`}
    >
      <div className="provider-login-head">
        <div>
          <strong><PersonalIdentifier value={login.label} label="Account Email" /></strong>
          <span>{login.provider === "claude" ? "Claude" : "Codex"} · {statusLabel(login.status)}</span>
        </div>
        {active && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void cancel()}>Cancel</button>}
      </div>
      {login.verificationUrl && (
        <p>
          <a href={login.verificationUrl} target="_blank" rel="noreferrer">Open Provider Sign-In</a>
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
          <button type="submit" className="btn primary sm" disabled={busy || !code.trim()}>
            {busy ? "Submitting…" : "Submit Code"}
          </button>
        </form>
      )}
      {login.error && <p className="form-error" role="alert">{login.error}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </article>
  );
}
