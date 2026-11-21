/**
 * The phone card's status line (#4791): one 20px line that never wraps, so every card stays three
 * lines. When the badges, the activity strip and the branch do not fit, they give way in a fixed
 * order, recorded as `data-fit` on the line for the stylesheet to act on:
 *
 * 1. `branch`: the branch ellipsizes on its own (it shrinks first), and leaves the line once it would
 *    be cut below {@link STATUS_LINE_BRANCH_MIN_PX}, where it says nothing useful. A pull request
 *    that needs the person (#604) stays, whole, after its branch has gone.
 * 2. `strip`: the activity strip hides.
 * 3. `badge`: the secondary badge folds into the "+N" count; the lifecycle badge always stays.
 *
 * Measured rather than styled: CSS cannot fold a badge into a count, and a wrapping line moves the
 * branch whole instead of shortening it, which is how the fourth line used to appear.
 */
export type StatusLineDrop = "branch" | "strip" | "badge";

/** Below this a cut branch shows a glyph and a letter or two, so it leaves the line instead. */
export const STATUS_LINE_BRANCH_MIN_PX = 72;

function overflows(line: HTMLElement): boolean {
  return line.scrollWidth > line.clientWidth + 0.5;
}

function truncated(element: HTMLElement | null): boolean {
  return element !== null && element.scrollWidth > element.clientWidth + 0.5;
}

/** Re-fit one status line from scratch: show everything, then drop in order until it fits. */
export function fitStatusLine(line: HTMLElement): StatusLineDrop[] {
  const drops: StatusLineDrop[] = [];
  const apply = () => {
    if (drops.length > 0) line.dataset.fit = drops.join(" ");
    else delete line.dataset.fit;
  };
  apply();
  const git = line.querySelector<HTMLElement>(":scope > .inbox-row-git");
  if (git) {
    const cut = truncated(git.querySelector<HTMLElement>(".inbox-row-branch-name"))
      || truncated(git.querySelector<HTMLElement>(".inbox-row-base"));
    // `git` clipping its own contents means the branch is already at its few-character minimum.
    if (overflows(line) || truncated(git) || (cut && git.getBoundingClientRect().width < STATUS_LINE_BRANCH_MIN_PX)) {
      drops.push("branch");
      apply();
    }
  }
  if (overflows(line) && line.querySelector(":scope > .inbox-row-activity")) {
    drops.push("strip");
    apply();
  }
  if (overflows(line) && line.querySelector(".row-status-collapsed")) {
    drops.push("badge");
    apply();
  }
  return drops;
}

/**
 * One observer for every mounted phone card, not one per card: a card's status line changes width
 * only when the list or the window does, and then every mounted card re-fits in one callback. Lines
 * also re-fit once web fonts finish loading, since a wider face can push a line over.
 */
let observer: ResizeObserver | null = null;
const observed = new Set<HTMLElement>();
let fontsHooked = false;

export function observeStatusLine(line: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) fitStatusLine(entry.target as HTMLElement);
  });
  if (!fontsHooked && typeof document !== "undefined" && document.fonts?.addEventListener) {
    fontsHooked = true;
    document.fonts.addEventListener("loadingdone", () => { for (const each of observed) fitStatusLine(each); });
  }
  observed.add(line);
  observer.observe(line);
  return () => {
    observed.delete(line);
    observer?.unobserve(line);
  };
}
