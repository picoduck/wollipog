import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** The summary's initial width is reported in layout, and subsequent widths come from its body
 * observer. Keep DOM ownership in refs cleared by React on detach: a DOM-valued render state can
 * survive in an old action callback's shared closure context after the session has unmounted. */
export function useBodyWidth(reportWidth: ((width: number) => void) | undefined) {
  const body = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [attachment, setAttachment] = useState(0);
  const setBody = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    body.current = element;
    if (element) setAttachment(value => value + 1);
  }, []);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !reportWidth) return;
    const report = (width: number) => {
      if (width > 0) reportWidth(width);
    };
    report(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(entries => {
      const entry = entries.at(-1);
      if (entry) report(entry.contentRect.width);
    });
    observer.current = resize;
    resize.observe(element);
    return () => {
      resize.disconnect();
      if (observer.current === resize) observer.current = null;
    };
  }, [attachment, reportWidth]);
  return setBody;
}
