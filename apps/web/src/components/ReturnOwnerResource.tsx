import React, { useState } from "react";
import { useApi } from "../api-context.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Notice } from "./Notice.js";

/** This calls a human-only route; it does not answer or transfer a pending occurrence. */
export function ReturnOwnerResource({ sessionId, occurrenceId, onChanged }: {
  sessionId: string; occurrenceId: string; onChanged?: () => void;
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
  if (returned) return <p role="status">Returned to the Orchestrator for future requests. Pending requests remain yours.</p>;
  return <div>
    {confirming && <p>Future requests for this resource will follow the campaign's current boundary. Pending requests remain yours.</p>}
    {error && <Notice tone="danger">{error}</Notice>}
    <BusyButton type="button" className="btn sm" busy={busy} progress="Returning the resource…"
      onClick={() => confirming ? void save() : setConfirming(true)}>Return to the Orchestrator</BusyButton>
    {confirming && <button type="button" className="btn sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>}
  </div>;
}
