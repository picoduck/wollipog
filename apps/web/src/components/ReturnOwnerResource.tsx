import React, { useState } from "react";
import { useApi } from "../api-context.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Notice } from "./Notice.js";

/** This calls a human-only route; it does not answer or transfer a pending occurrence. */
export function ReturnOwnerResource({ sessionId, occurrenceId, resourceLabel, onChanged, inRow, ownershipReason }: {
  sessionId: string; occurrenceId: string; resourceLabel: string; onChanged?: () => void;
  inRow?: boolean; ownershipReason?: string;
}) {
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [returned, setReturned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await api.returnOwnerResource(sessionId, occurrenceId);
      setReturned(true); onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : "The resource could not be returned."); }
    finally { setBusy(false); }
  };
  if (returned) return <p role="status">{resourceLabel} returned to the Orchestrator for future requests. Pending requests remain yours.</p>;
  return <section className={inRow ? "owner-resource-return-inline" : "owner-resource-return"} aria-label={`Your Resource Ownership: ${resourceLabel}`}>
    <h4>{inRow ? "Your Action" : "Your Resource Ownership"}</h4>
    <p><strong>{resourceLabel}</strong></p>
    <p>{ownershipReason ?? "You kept this resource."} You can let the Orchestrator handle future requests within the campaign's current boundary.</p>
    {confirming && <p>Return {resourceLabel} to the Orchestrator for future requests? Pending requests remain yours.</p>}
    {error && <Notice tone="danger">{error}</Notice>}
    <div className="owner-resource-return-actions">
    <BusyButton type="button" className="btn sm" busy={busy} progress="Returning the resource…"
      onClick={() => confirming ? void save() : setConfirming(true)}>Return to the Orchestrator</BusyButton>
    {confirming && <button type="button" className="btn sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>}
    </div>
  </section>;
}
