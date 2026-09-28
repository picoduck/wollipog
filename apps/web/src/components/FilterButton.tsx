/**
 * The toolbar's phone "Filters" button (docs/design-system.md §4.7, §15.1): it opens the sheet that
 * holds a list's filters. While any filter is applied it takes the chosen-state edge and shows how
 * many, so a filtered list never looks like the whole list.
 */
export function FilterButton({
  applied,
  expanded,
  controls,
  onClick,
}: {
  /** How many filters are applied. */
  applied: number;
  expanded: boolean;
  controls?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`btn filter-btn${applied > 0 ? " is-set" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
    >
      Filters
      {applied > 0 && <span className="count" aria-hidden="true">{applied}</span>}
      {applied > 0 && <span className="sr-only">, {applied} applied</span>}
    </button>
  );
}
