import { useEffect, useRef, useState } from "react";
import type { SessionProviderAccountOption, SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { Modal } from "./common.js";
import { ChoiceCards } from "./ui/ChoiceControls.js";

function usageSummary(account: SessionProviderAccountOption): string {
  if (account.buckets.length === 0) return "Usage available";
  return account.buckets.map((bucket) => {
    const remaining = bucket.remainingPercent ??
      (bucket.usedPercent === undefined ? undefined : Math.max(0, 100 - bucket.usedPercent));
    return remaining === undefined ? bucket.label : `${bucket.label}: ${Math.round(remaining)}% remaining`;
  }).join(" · ");
}

export function SwitchAccountDialog({
  session,
  onClose,
  onSwitched,
  returnFocusRef,
}: {
  session: Pick<SessionView, "id" | "providerAccountLabel">;
  onClose: () => void;
  onSwitched: (scheduled: boolean) => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const [accounts, setAccounts] = useState<SessionProviderAccountOption[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void api.sessionProviderAccounts(session.id).then((response) => {
      if (cancelled) return;
      setAccounts(response.accounts);
      setSelectedId(response.accounts[0]?.id ?? "");
    }).catch((cause) => {
      if (!cancelled) setError((cause as Error).message);
    });
    return () => { cancelled = true; };
  }, [api, session.id]);

  const close = () => {
    if (!submittingRef.current) onClose();
  };

  const submit = async () => {
    if (submittingRef.current || !selectedId) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.switchSessionProviderAccount(session.id, selectedId);
      onClose();
      onSwitched(result.scheduled);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Switch Account"
      onClose={close}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={(
        <>
          <button className="btn ghost" type="button" onClick={close} disabled={submitting}>Cancel</button>
          <button
            className="btn primary"
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !selectedId}
          >
            {submitting ? "Switching…" : "Switch Account"}
          </button>
        </>
      )}
    >
      <p>
        Continue this provider conversation using another subscription account on this Machine.
        {session.providerAccountLabel ? ` The current account is ${session.providerAccountLabel}.` : ""}
      </p>
      {accounts === null && !error && <p role="status">Loading accounts…</p>}
      {accounts?.length === 0 && (
        <p role="status">No other signed-in accounts currently have subscription usage headroom.</p>
      )}
      {accounts && accounts.length > 0 && (
        <div className="switch-account-picker">
          <span className="field-label">Account</span>
          <ChoiceCards<string>
            label="Account"
            value={selectedId || null}
            onChange={setSelectedId}
            options={accounts.map((account) => ({
              value: account.id,
              title: account.label,
              description: `${usageSummary(account)}${account.freshness === "stale" ? " · Last Known" : ""}`,
              disabled: submitting,
            }))}
          />
        </div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <p className="muted">
        A running turn finishes on the current account. Wollipog then resumes the same conversation
        before sending queued work to the selected account.
      </p>
    </Modal>
  );
}
