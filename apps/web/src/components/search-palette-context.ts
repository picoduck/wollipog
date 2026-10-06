import { createContext, useContext } from "react";

/**
 * Opens the search palette from inside a view at every width: the Session page's Search Sessions
 * when its session is not found (#2202), and Sessions' Search Transcripts with the query that
 * matched nothing (#2200). The shell provides it; a surface rendered without the shell (a harness
 * page or a unit test) has none and leaves the action out.
 */
export const SearchPaletteContext = createContext<((query?: string) => void) | undefined>(undefined);

export function useOpenSearchPalette(): ((query?: string) => void) | undefined {
  return useContext(SearchPaletteContext);
}
