import { ArrowDownIcon, QuestionIcon } from "../Icons.js";

export const ASK_MARKER_COPY = {
  question: "Question",
  jumpToQuestion: "Jump to Question",
} as const;

/**
 * A pending question's place in the transcript (docs/design-system.md §13.2; #2205): one neutral
 * row, "Question · <title>", while the question itself waits on the request dock above the
 * composer, the only amber surface. Jump to Question brings the docked card up and focuses it; Show
 * Where Asked on the card comes back here and marks this row selected until the reader scrolls.
 * Once answered, the same row is the answered question row (`QuestionHistoryRow`).
 */
export function AskMarker({ title, selected = false, onJump }: {
  title: string;
  /** Show Where Asked brought the reader here. */
  selected?: boolean;
  /** Absent where nothing can answer the question from this transcript. */
  onJump?: () => void;
}) {
  return (
    <div className="ask-marker" data-selected={selected ? "" : undefined}>
      <QuestionIcon size={16} className="ask-marker-icon" />
      <span className="ask-marker-text">
        <span className="ask-marker-kind">{ASK_MARKER_COPY.question}</span>
        <span className="ask-marker-title">{title}</span>
      </span>
      {onJump && (
        // Icon-only below 760px, under the same name (§15.1).
        <button type="button" className="btn sm ghost ask-marker-jump" aria-label={ASK_MARKER_COPY.jumpToQuestion} onClick={onJump}>
          <ArrowDownIcon size={14} />
          <span className="ask-marker-jump-label">{ASK_MARKER_COPY.jumpToQuestion}</span>
        </button>
      )}
    </div>
  );
}
