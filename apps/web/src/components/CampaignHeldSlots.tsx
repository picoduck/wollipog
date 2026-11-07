import React, { useId, useState, type ReactNode } from "react";
import { CAMPAIGN_SLOT_RELEASE_REASON_MAX, type CampaignBudgetView, type CampaignHeldSlot, type CampaignHeldSlotReason,
  type CampaignSlotRelease } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { timeAgo } from "../campaign-status.js";
import { formatRecordedTimestamp } from "../format.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * Campaign Status's Held Slots section (#4331). A worker that ended still holds its concurrency slot
 * until its runner proves the provider gone. Some slots no automatic proof can ever free: an older
 * runner served the worker, or its runner's retirement fence carries no process evidence. Only the
 * campaign's owner can release one, after checking the machine; the release records who, when and
 * why, and stops nothing. The server refuses every agent, an Orchestrator under Full Control included.
 */

export const HELD_SLOT_REASONS: Record<CampaignHeldSlotReason, string> = {
  older_runner: "Its runner is too old to prove that the provider is gone.",
  fence_without_evidence: "Its runner left no process evidence that could prove the provider is gone.",
  unsupported_location: "Its provider ran where the runner can't check it, such as WSL, a container or a cloud machine.",
};

const STATUS_LABELS: Record<CampaignHeldSlot["status"], string> = { completed: "Completed", failed: "Failed", stopped: "Stopped" };

function slotName(slot: { title: string | null; sessionId: string }): string {
  return slot.title ?? slot.sessionId;
}

function ReleaseForm({ campaignId, slot, onDone, onCancel }: {
  campaignId: string;
  slot: CampaignHeldSlot;
  onDone: (release: CampaignSlotRelease) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = slotName(slot);
  const release = async () => {
    if (busy) return;
    const text = reason.trim();
    if (!text) { setError("Say how you checked that the worker's provider is gone."); return; }
    setBusy(true); setError(null);
    try {
      onDone(await api.releaseCampaignSlot(campaignId, { sessionId: slot.sessionId, generation: slot.generation, reason: text }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not release the slot.");
    } finally {
      setBusy(false);
    }
  };
  return <fieldset className="field">
    <legend>Release Slot: {name}</legend>
    <p>Release it only after you've checked that the worker's provider is gone, for example by rebooting its machine or
      removing its container. Releasing stops nothing: a provider that is still running keeps running outside the campaign's
      concurrency allowance. The worker's reservation settles at its final recorded usage.</p>
    <label className="field">
      <span>How You Checked</span>
      <input type="text" value={reason} maxLength={CAMPAIGN_SLOT_RELEASE_REASON_MAX} disabled={busy}
        placeholder="Rebooted the host" onChange={(event) => setReason(event.target.value)} />
    </label>
    {error && <Notice tone="danger" role="alert" title="Couldn't Release the Slot">{error}</Notice>}
    <div>
      <BusyButton className="btn sm primary" busy={busy} progress="Releasing slot…" onClick={() => void release()}
        aria-label={`Release Slot: ${name}`}>Release Slot</BusyButton>{" "}
      <button className="btn ghost sm" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </fieldset>;
}

function ReleaseRecord({ release, now }: { release: CampaignSlotRelease; now: number }) {
  const stamp = formatRecordedTimestamp(release.releasedAt);
  const settled = `$${release.settlement.costUsd.toFixed(2)}, ${release.settlement.toolCalls} tool call${release.settlement.toolCalls === 1 ? "" : "s"}`;
  return <dl className="facts">
    <div>
      <dt>{slotName(release)}</dt>
      <dd>
        Released by {release.releasedByName ?? release.releasedByUserId}{" "}
        <time dateTime={stamp?.dateTime} title={stamp?.title}>{timeAgo(release.releasedAt, now)}</time>
        <span className="campaign-status-meta">“{release.reason}”</span>
        <span className="campaign-status-meta">
          {HELD_SLOT_REASONS[release.heldReason]} Settled at {settled}, from {release.settlement.source === "checkpoint"
            ? "the runner's final usage" : "the usage Wollipog recorded"}.
        </span>
      </dd>
    </div>
  </dl>;
}

export function CampaignHeldSlots({ campaignId, budget, canAct, now, onOpenSession }: {
  campaignId: string;
  budget: Pick<CampaignBudgetView, "heldSlots" | "slotReleases">;
  /** Only the campaign's own view offers the release; the server checks that the person owns it. */
  canAct: boolean;
  now: number;
  onOpenSession: (sessionId: string) => ReactNode;
}) {
  const headingId = useId();
  const releasesId = useId();
  const [releasing, setReleasing] = useState<string | null>(null);
  const [released, setReleased] = useState<CampaignSlotRelease | null>(null);
  const held = budget.heldSlots ?? [];
  const releases = budget.slotReleases ?? [];
  if (held.length === 0 && releases.length === 0 && !released) return null;
  return (
    <section className="campaign-status-handoffs" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">Held Slots</h3>
      {held.length > 0 && <p className="section-note">
        {held.length === 1 ? "This ended worker still holds" : "These ended workers still hold"} a concurrency slot that no automatic
        proof can free. Only you can release {held.length === 1 ? "it" : "one"}, after checking that its provider is gone.
      </p>}
      {released && <Notice tone="success" role="status" title="Slot Released">
        {slotName(released)}'s slot is free, and its reservation settled.
      </Notice>}
      {held.length > 0 && <ul className="campaign-detail-list">
        {held.map((slot) => (
          <li key={`${slot.sessionId}:${slot.generation}`}>
            <dl className="facts">
              <div>
                <dt>{slotName(slot)}</dt>
                <dd>
                  {STATUS_LABELS[slot.status]}. {HELD_SLOT_REASONS[slot.reason]}
                  <span className="campaign-status-meta">{onOpenSession(slot.sessionId)}</span>
                </dd>
              </div>
            </dl>
            {canAct && (releasing === slot.sessionId
              ? <ReleaseForm campaignId={campaignId} slot={slot} onCancel={() => setReleasing(null)}
                  onDone={(release) => { setReleasing(null); setReleased(release); }} />
              : <div><button className="btn sm" type="button" onClick={() => { setReleased(null); setReleasing(slot.sessionId); }}
                  aria-label={`Release Slot: ${slotName(slot)}`}>Release Slot</button></div>)}
          </li>
        ))}
      </ul>}
      {releases.length > 0 && <section aria-labelledby={releasesId}>
        <h4 id={releasesId} className="section-title">Released Slots</h4>
        <ul className="campaign-detail-list">
          {releases.map((release) => <li key={`${release.sessionId}:${release.generation}`}>
            <ReleaseRecord release={release} now={now} />
          </li>)}
        </ul>
      </section>}
    </section>
  );
}
