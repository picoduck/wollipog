import { CampaignSection } from "./CampaignSections.js";
import { useId, useState } from "react";
import type { CampaignPauseView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatRecordedTimestamp } from "../format.js";
import { BusyButton } from "./ui/BusyButton.js";

/** Suspension is an owner action; the server checks ownership independently of this control. */
export function CampaignPause({ campaignId, pause, canEdit, onChanged }: {
  campaignId: string; pause?: CampaignPauseView; canEdit: boolean; onChanged: () => void;
}) {
  const api = useApi();
  const untilId = useId();
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = !!pause && pause.resumedAt === undefined;
  const change = async () => {
    if (busy) return;
    const resumeAt = until ? new Date(until).getTime() : null;
    if (!paused && resumeAt !== null && (!Number.isSafeInteger(resumeAt) || resumeAt <= Date.now())) {
      setError("Choose a future resume time, or leave it empty to resume manually."); return;
    }
    setBusy(true); setError(null);
    try {
      await api.setCampaignPause(campaignId, { action: paused ? "resume" : "pause", ...(!paused ? { resumeAt } : {}) });
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change campaign pause."); }
    finally { setBusy(false); }
  };
  return <CampaignSection title="Campaign Pause" count={1} attention={paused ? String(pause.pausedAt) : ""} className="campaign-detail-section">
    {pause && <dl className="facts">
      <div><dt>Paused</dt><dd>{formatRecordedTimestamp(pause.pausedAt)?.label} by {pause.pausedBy}</dd></div>
      {paused && <div><dt>Resumes At</dt><dd>{pause.resumeAt === null ? "When the owner resumes"
        : new Date(pause.resumeAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd></div>}
      {paused && <div><dt>In Flight</dt><dd>{pause.inFlightSessionIds.length > 0 ? <>
        <p>{pause.inFlightSessionIds.length === 1 ? "1 session still has work in flight." : `${pause.inFlightSessionIds.length} sessions still have work in flight.`}</p>
        <ul className="campaign-detail-list">{pause.inFlightSessionIds.map(sessionId => <li key={sessionId}>
          {pause.inFlightWork?.find(work => work.sessionId === sessionId)?.description ?? `Session ${sessionId} is still in flight.`}
        </li>)}</ul>
      </> : "None. Paused children are preserved for resume."}</dd></div>}
      {pause.resumedAt !== undefined && <div><dt>Resumed</dt><dd>{formatRecordedTimestamp(pause.resumedAt)?.label} by {pause.resumedBy}</dd></div>}
    </dl>}
    {paused && <p>Campaign continuations and new children are held. Pending requests and decisions stay unchanged.</p>}
    {pause?.resumeRequestedBy && paused && <p role="status">Resume is waiting for stopped providers to settle and pass existing admission checks.</p>}
    {canEdit && <>
      {!paused && <div className="field"><label htmlFor={untilId}>Resume At (Optional)</label>
        <input id={untilId} type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} />
        <p>Leave empty to wait for your Resume action. The time uses your device’s timezone.</p>
      </div>}
      <BusyButton className="btn sm" busy={busy} progress="Saving…" disabled={!!pause?.resumeRequestedBy && paused} onClick={() => void change()}>
        {paused ? "Resume Campaign" : "Pause Campaign"}
      </BusyButton>
    </>}
    {error && <p role="alert">{error}</p>}
  </CampaignSection>;
}
