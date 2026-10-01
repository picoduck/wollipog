import React from "react";

/** Transcript-shaped skeleton rows (§12.3): one user message and two agent replies. `label` names what
 * is loading, in Title Case; the live line repeats it as a sentence. */
export function TranscriptSkeleton({ label = "Loading Session Activity" }: { label?: string }) {
  return (
    <div className="transcript-skeleton" role="status" aria-label={label}>
      <span className="sr-only">{label}…</span>
      <div className="transcript-skeleton-row user" aria-hidden="true"><span /><span /></div>
      <div className="transcript-skeleton-row agent" aria-hidden="true"><span /><span /><span /></div>
      <div className="transcript-skeleton-row agent short" aria-hidden="true"><span /><span /></div>
    </div>
  );
}
