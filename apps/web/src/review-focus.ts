import { useCallback, useRef, useState } from "react";
import type { DiffFileFocus } from "./components/GitDiffViewer.js";

/**
 * The file a transcript edit's Open in Review asked the Review tab to show (#2187). Request numbers
 * only ever increase, even across a cleared request: the Review panel tells a fresh request from the
 * one it last met by its number, so a reused number would be judged against the previous request's
 * diff read and dropped before its own read lands.
 */
export function useDiffFileFocus(): {
  focus: DiffFileFocus | null;
  request: (path: string) => void;
  clear: () => void;
} {
  const [focus, setFocus] = useState<DiffFileFocus | null>(null);
  const sequence = useRef(0);
  const request = useCallback((path: string) => {
    sequence.current += 1;
    setFocus({ path, request: sequence.current });
  }, []);
  const clear = useCallback(() => setFocus(null), []);
  return { focus, request, clear };
}
