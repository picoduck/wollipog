import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import {
  DENSITY_STORAGE_KEY,
  SCHEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyDensityToDocument,
  applySchemeToDocument,
  applyThemeToDocument,
  parseColorScheme,
  parseDensity,
  parseThemePreference,
  resolveTheme,
  type ColorScheme,
  type Density,
  type ResolvedTheme,
  type ThemePreference,
} from "../theme.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Light/dark and the palette are separate axes: every scheme has both. */
  scheme: ColorScheme;
  setScheme: (scheme: ColorScheme) => void;
  /**
   * A palette to RENDER without choosing it, for the picker's live preview, and null for none.
   *
   * It lives here rather than in the picker because this provider is the only writer of
   * `data-scheme`. A second `applySchemeToDocument` caller elsewhere would be two owners of one
   * attribute, and the loser is whichever effect happens to run second.
   */
  previewScheme: ColorScheme | null;
  setPreviewScheme: (scheme: ColorScheme | null) => void;
  /** And density is a third: it is about spacing, not colour. */
  density: Density;
  setDensity: (density: Density) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function storedPreference(): ThemePreference {
  return parseThemePreference(loadBrowserStorageValue(THEME_STORAGE_KEY));
}

function storedScheme(): ColorScheme {
  return parseColorScheme(loadBrowserStorageValue(SCHEME_STORAGE_KEY));
}

function storedDensity(): Density {
  return parseDensity(loadBrowserStorageValue(DENSITY_STORAGE_KEY));
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const [scheme, setScheme] = useState<ColorScheme>(storedScheme);
  const [previewScheme, setPreviewScheme] = useState<ColorScheme | null>(null);
  const [density, setDensity] = useState<Density>(storedDensity);
  const resolved = resolveTheme(preference, systemDark);

  // The head bootstrap already applies the first palette before CSS paints. Keep the DOM,
  // browser chrome, and persisted preference in sync before subsequent React paints.
  useLayoutEffect(() => {
    applyThemeToDocument(document, resolved);
    saveBrowserStorageValue(THEME_STORAGE_KEY, preference);
  }, [preference, resolved]);

  // What the document RENDERS: the preview while one is being browsed, the committed scheme
  // otherwise. Applying the preview here rather than persisting it is the whole distinction — a
  // preview that reached storage would make dragging down a list of palettes a series of decisions.
  useLayoutEffect(() => {
    applySchemeToDocument(document, previewScheme ?? scheme);
    // The browser chrome is a function of the palette, and the palette has two axes: re-apply it
    // whenever EITHER moves, or switching scheme leaves the address bar on the previous one.
    applyThemeToDocument(document, resolved);
  }, [previewScheme, scheme, resolved]);

  // Persistence follows the COMMITTED scheme alone, and is separate for that reason: folded into
  // the effect above it would fire on every highlight move, writing the committed value repeatedly
  // and inviting the next edit to write the previewed one.
  useLayoutEffect(() => {
    saveBrowserStorageValue(SCHEME_STORAGE_KEY, scheme);
  }, [scheme]);

  useLayoutEffect(() => {
    applyDensityToDocument(document, density);
    saveBrowserStorageValue(DENSITY_STORAGE_KEY, density);
  }, [density]);

  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const changed = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    }
    // Older WebKit exposes only the deprecated listener pair.
    media.addListener(changed);
    return () => media.removeListener(changed);
  }, []);

  const value = useMemo(() => ({
    preference, resolved, setPreference, scheme, setScheme, previewScheme, setPreviewScheme, density, setDensity,
  }), [preference, resolved, scheme, previewScheme, density]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
