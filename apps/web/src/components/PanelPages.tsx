import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Pages inside a side panel tool (docs/design-system.md §4.9; #2856). A tool's detail (a worker, a
 * job) opens as a page in the panel's own frame instead of below its list: the header's Back to
 * <Tool> and the page's title take the switcher's place, Escape pops it, and Back returns focus to
 * the row that opened it with the list scrolled where it was. Switching tools or closing the panel
 * clears the stack, so reopening a tool shows its list.
 *
 * A tool reads `usePanelPages()`, renders its list while `current` is null (hidden rather than
 * unmounted, so its rows and their state survive) and the page for `current` otherwise, with the
 * page's title in `PanelPageTitle`. A row that pushes a page carries `data-panel-page-key` with the
 * page's key, which is where focus returns when the control that opened the page is gone.
 */
export interface PanelPagesController {
  /** The key of the page on top, or null while the tool shows its list. */
  current: string | null;
  /**
   * Open a page over the list or the current page, keyed by its item's id. Focus moves to the
   * page's title. `root` replaces the whole stack, for an entry point outside the panel (the
   * transcript's Open), so Back goes straight to the list.
   */
  push: (key: string, options?: { root?: boolean }) => void;
  /** Close the page on top, returning to what opened it. */
  pop: () => void;
  /** Close every page without moving focus, for a tool that moves focus itself (an attention link). */
  clear: () => void;
}

export const PanelPagesContext = createContext<PanelPagesController | null>(null);

/**
 * The element the current page's title portals into: the header's title, which takes focus on push.
 * Only RightPanel provides it (and tests).
 */
export const PanelPageTitleSlotContext = createContext<HTMLElement | null>(null);

/**
 * The panel's page stack. Outside the side panel (a fixture rendering a tool alone) the tool keeps a
 * stack of its own, with no header to show a title or Back.
 */
export function usePanelPages(): PanelPagesController {
  const panel = useContext(PanelPagesContext);
  const [stack, setStack] = useState<readonly string[]>([]);
  const local = useMemo<PanelPagesController>(() => ({
    current: stack.at(-1) ?? null,
    push: (key, options) => setStack((current) =>
      options?.root ? [key] : current.at(-1) === key ? current : [...current, key]),
    pop: () => setStack((current) => current.slice(0, -1)),
    clear: () => setStack([]),
  }), [stack]);
  return panel ?? local;
}

/** The pushed page's title, shown in the panel header at `--type-title` in the switcher's place. */
export function PanelPageTitle({ children }: { children: ReactNode }) {
  const slot = useContext(PanelPageTitleSlotContext);
  return slot ? createPortal(children, slot) : null;
}
