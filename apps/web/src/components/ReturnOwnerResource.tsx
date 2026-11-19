import React, { useEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Notice } from "./Notice.js";

/**
 * This calls a human-only route; it does not answer or transfer a pending occurrence.
 *
 * `row` is Campaign Status's section inside a resource's row. `footnote` is one line inside a
 * request card, between its body and its footer (#4713): the decision the card asks for reads
 * first, and returning the resource stays a quiet secondary action with an in-place confirmation.
 */
export function ReturnOwnerResource({ sessionId, occurrenceId, resourceLabel, onChanged, presentation, ownershipReason }: {
  sessionId: string; occurrenceId: string; resourceLabel: string; onChanged?: () => void;
  presentation: "row" | "footnote"; ownershipReason: string;
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
  const returnedText = `${resourceLabel} returned to the Orchestrator for future requests. Pending requests remain yours.`;
  if (presentation === "footnote") {
    if (returned) return <p className="owner-resource-footnote" role="status">{returnedText}</p>;
    return <OwnerResourceFootnote resourceLabel={resourceLabel} ownershipReason={ownershipReason} confirming={confirming}
      busy={busy} error={error} onConfirm={() => setConfirming(true)} onCancel={() => { setConfirming(false); setError(null); }}
      onReturn={() => void save()} />;
  }
  if (returned) return <p role="status">{returnedText}</p>;
  return <section className="owner-resource-return-inline" aria-label={`Your Resource Ownership: ${resourceLabel}`}>
    <h4>Your Action</h4>
    <p><strong>{resourceLabel}</strong></p>
    <p>{ownershipReason} You can let the Orchestrator handle future requests within the campaign's current boundary.</p>
    {confirming && <p>Return {resourceLabel} to the Orchestrator for future requests? Pending requests remain yours.</p>}
    {error && <Notice tone="danger">{error}</Notice>}
    <div className="owner-resource-return-actions">
    <BusyButton type="button" className="btn sm" busy={busy} progress="Returning the resource…"
      onClick={() => confirming ? void save() : setConfirming(true)}>Return to the Orchestrator</BusyButton>
    {confirming && <button type="button" className="btn sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>}
    </div>
  </section>;
}

function OwnerResourceFootnote({ resourceLabel, ownershipReason, confirming, busy, error, onConfirm, onCancel, onReturn }: {
  resourceLabel: string; ownershipReason: string; confirming: boolean; busy: boolean; error: string | null;
  onConfirm: () => void; onCancel: () => void; onReturn: () => void;
}) {
  const startRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The control pressed is replaced by the other state's, so focus moves with it rather than to the page.
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    (confirming ? cancelRef : startRef).current?.focus();
  }, [confirming]);
  return <div className="owner-resource-footnote" role="group" aria-label={`Resource Ownership: ${resourceLabel}`}>
    {confirming ? <>
      <p>Send future requests for {resourceLabel} to the Orchestrator? This request stays yours.</p>
      {error && <Notice tone="danger" compact role="alert">{error}</Notice>}
      <div className="owner-resource-footnote-actions">
        <button type="button" ref={cancelRef} className="btn sm" disabled={busy}
          onClick={() => { moved.current = true; onCancel(); }}>Cancel</button>
        <BusyButton type="button" className="btn sm" busy={busy} progress="Returning the resource…" onClick={onReturn}>Return</BusyButton>
      </div>
    </> : <p>
      {ownershipReason}{" "}
      <button type="button" ref={startRef} className="link"
        onClick={() => { moved.current = true; onConfirm(); }}>Return to the Orchestrator</button>
    </p>}
  </div>;
}
