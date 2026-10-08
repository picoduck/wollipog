import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The edges a scroll container can still scroll past, as `data-clip-start` / `data-clip-end`. */
export function markClipEdges(element: HTMLElement): void {
  const scrolls = element.scrollHeight > element.clientHeight + 1 &&
    element.ownerDocument.defaultView?.getComputedStyle(element).overflowY !== "visible";
  element.toggleAttribute("data-clip-start", scrolls && element.scrollTop > 1);
  element.toggleAttribute("data-clip-end", scrolls && element.scrollTop + element.clientHeight < element.scrollHeight - 1);
}

interface Attached {
  element: HTMLElement;
  observer: ResizeObserver | null;
  update: () => void;
}

/**
 * Every Request Card's one "more below" signal (#2715, §13.2): while the element scrolls, each edge
 * it can still scroll past is marked `data-clip-start` or `data-clip-end`, which the stylesheet draws
 * as a `--border` hairline, as a tab row's clipped edges are marked. The marks follow the scroll
 * position and the size of the element and of everything in it, including what grows on its own (a
 * notice's Show Details). After each render the element's current children are observed and the marks
 * re-read, so a new notice, a layout switch, or a different element behind `ref` is seen too.
 */
export function useClipEdges(ref: RefObject<HTMLElement | null>): void {
  const attached = useRef<Attached | null>(null);
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    let current = attached.current;
    if (current && current.element !== element) {
      detach(current);
      current = attached.current = null;
    }
    if (element && !current) {
      const update = () => markClipEdges(element);
      element.addEventListener("scroll", update, { passive: true });
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
      current = attached.current = { element, observer, update };
    }
    if (!current) return;
    current.observer?.observe(current.element);
    // Observing an element twice is a no-op; children that left are released on disconnect.
    for (const child of current.element.children) current.observer?.observe(child);
    current.update();
  });
  useEffect(() => () => {
    if (attached.current) detach(attached.current);
    attached.current = null;
  }, []);
}

function detach({ element, observer, update }: Attached): void {
  element.removeEventListener("scroll", update);
  observer?.disconnect();
  element.removeAttribute("data-clip-start");
  element.removeAttribute("data-clip-end");
}
