import { useEffect, useState } from "react";
import { formatDictationElapsed } from "../dictation.js";

/**
 * What the composer bar's left group becomes while the mic is listening (#2193): a red dot,
 * "Listening…", how long it has been, how to stop for the gesture in use, and the words the
 * recognizer has heard but not yet settled. Settled phrases go into the message instead.
 *
 * The strip is a status region, so it is announced once when it appears and again when the stop
 * hint changes; the timer and the unsettled words change too often to announce, so they are
 * excluded from it. The timer ticks here, not in SessionDetail, so a second passing re-renders
 * only the strip.
 */
export function DictationStrip({ startedAt, held, interim }: {
  startedAt: number;
  held: boolean;
  interim: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    // Tick on each whole second since the start, so the display never skips or lingers.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const elapsed = Date.now() - startedAt;
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, 1000 - (elapsed % 1000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [startedAt]);
  return (
    <div className="dictation-strip" role="status">
      <span className="dictation-dot" aria-hidden="true" />
      <span className="dictation-label">Listening…</span>
      <span className="dictation-timer" role="timer" aria-live="off">{formatDictationElapsed(now - startedAt)}</span>
      {interim && <span className="dictation-interim" aria-live="off"><bdi>{interim}</bdi></span>}
      <span className="dictation-hint">{held ? "Release to stop" : "Tap the mic to stop"}</span>
    </div>
  );
}
