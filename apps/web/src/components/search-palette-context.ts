import { createContext, useContext } from "react";

/**
 * Opens the search palette from inside a view at every width: the Session page's Search Sessions
 * when its session is not found (#2202). The shell provides it; a surface rendered without the
 * shell (a harness page or a unit test) has none and leaves the action out.
 */
export const SearchPaletteContext = createContext<(() => void) | undefined>(undefined);

export function useOpenSearchPalette(): (() => void) | undefined {
  return useContext(SearchPaletteContext);
}
