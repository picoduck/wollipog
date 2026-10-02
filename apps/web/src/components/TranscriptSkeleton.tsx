import React, { useEffect, useState } from "react";

/** How long the skeleton shows on its own before it says what it is waiting for (§12.3). */
export const TRANSCRIPT_SKELETON_SENTENCE_DELAY_MS = 3000;

/** The sentence a long transcript load adds, with the snapshot's event count when it has one. */
export function transcriptLoadingSentence(eventCount: number | null | undefined): string {
  if (eventCount == null || !Number.isFinite(eventCount) || eventCount <= 0) return "Loading the conversation…";
  const count = Math.floor(eventCount);
  return `Loading a long conversation (${count.toLocaleString("en-US")} ${count === 1 ? "event" : "events"})…`;
}

/** Transcript-shaped skeleton (§12.3): two turns, each a right-aligned message bubble, a work bar
 * and three prose lines. `label` names what is loading, in Title Case; the live line repeats it as
 * a sentence. With `sentence`, the skeleton adds that sentence after 3 seconds, so a load that is
 * taking a while says so instead of shimmering indefinitely. */
export function TranscriptSkeleton({
  label = "Loading Session Activity",
  sentence,
}: {
  label?: string;
  sentence?: string;
}) {
  const [slow, setSlow] = useState(false);
  // Keyed on whether there is a sentence, not on its words: a count that arrives mid-load must not
  // restart the 3 seconds.
  const hasSentence = sentence !== undefined;
  useEffect(() => {
    if (!hasSentence) return;
    const timer = setTimeout(() => setSlow(true), TRANSCRIPT_SKELETON_SENTENCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasSentence]);
  return (
    <div className="transcript-skeleton" role="status" aria-label={label}>
      <span className="sr-only">{label}…</span>
      {[0, 1].map((turn) => (
        <div className="transcript-skeleton-turn" aria-hidden="true" key={turn}>
          <span className="transcript-skeleton-bubble" />
          <span className="transcript-skeleton-work" />
          <span className="transcript-skeleton-prose"><span /><span /><span /></span>
        </div>
      ))}
      {slow && sentence !== undefined && <p className="transcript-skeleton-sentence">{sentence}</p>}
    </div>
  );
}
