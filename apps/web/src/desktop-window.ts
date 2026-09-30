import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMacPlatform } from "./shortcuts.js";
import type { ResolvedTheme, ThemePreference } from "./theme.js";

/**
 * #1979 — the desktop window's own chrome: its title bar, its theme and its title.
 *
 * On macOS the window has no separate title bar (`titleBarStyle: "Overlay"` in tauri.conf.json).
 * The traffic lights sit in the rail's top-left, so the rail keeps a 40px strip clear for them, and
 * that strip, the page header and the detail bar are where the window is dragged from. Windows and
 * Linux keep their native decorations, which follow the app's theme instead. Every build, browser
 * included, titles the document after the page.
 */

/** The app's name after every page title: "Agent Skills – Wollipog". */
export const APP_NAME = "Wollipog";

export interface DesktopWindow {
  isTauri(): boolean;
  /** `navigator.platform`, which is how the rest of the app tells macOS apart (shortcuts.ts). */
  platform(): string;
  /** Null follows the operating system. */
  setTheme(theme: ResolvedTheme | null): Promise<void>;
  /** The window's theme: the one set, or with none set the operating system's (null if unknown). */
  theme(): Promise<ResolvedTheme | null>;
  setTitle(title: string): Promise<void>;
}

/** The real window. Injected so the hooks are testable without a Tauri webview. */
const nativeWindow: DesktopWindow = {
  isTauri,
  platform: () => typeof navigator === "undefined" ? "" : navigator.platform,
  setTheme: (theme) => getCurrentWindow().setTheme(theme),
  theme: () => getCurrentWindow().theme(),
  setTitle: (title) => getCurrentWindow().setTitle(title),
};

/** True in the macOS desktop app, whose web content runs under the traffic lights. */
export function hasOverlayTitleBar(desktop: DesktopWindow = nativeWindow): boolean {
  return desktop.isTauri() && isMacPlatform(desktop.platform());
}

/**
 * Mark the document before the first paint, so the rail never renders under the traffic lights
 * and then jumps. The platform cannot change while the app runs, so this is done once.
 */
export function installDesktopWindowChrome(root: HTMLElement = document.documentElement, desktop: DesktopWindow = nativeWindow): void {
  // styles.css keys the rail's strip on this class.
  root.classList.toggle("macos-title-bar", hasOverlayTitleBar(desktop));
}

/**
 * The attribute that makes a bar's background drag the window, spread onto the bar's root.
 *
 * "deep" lets any part of the bar that is not a control start the drag: Tauri's handler skips
 * buttons, links, inputs, labels, focusable elements (`tabindex` other than -1) and the interactive
 * ARIA roles, so they stay clickable. Only the macOS app gets it: elsewhere the native title bar is
 * still there to drag, and a browser ignores the attribute anyway.
 */
export function windowDragRegion(desktop: DesktopWindow = nativeWindow): { "data-tauri-drag-region"?: "deep" } {
  return hasOverlayTitleBar(desktop) ? { "data-tauri-drag-region": "deep" } : {};
}

/**
 * The theme to ask the native window for. A System preference asks for none, which follows the
 * operating system: naming the theme the system resolved to would pin it, because the window's
 * appearance is also what the webview reports as `prefers-color-scheme` on macOS and Windows, so
 * the app would stop noticing when the system changes.
 */
export function nativeWindowTheme(preference: ThemePreference, resolved: ResolvedTheme): ResolvedTheme | null {
  return preference === "system" ? null : resolved;
}

/**
 * Ask the native window for `theme`, where null follows the operating system.
 *
 * On Linux, null alone does not: tao seeds GTK's dark preference from the desktop portal when the
 * window opens, but clearing the theme sets that preference to light, so a dark desktop's window
 * would turn light. Once nothing is set, though, the window's theme is the portal's, so it is read
 * back and named. The portal still moves GTK's preference when the desktop changes theme.
 */
export async function applyNativeWindowTheme(theme: ResolvedTheme | null, desktop: DesktopWindow = nativeWindow, current: () => boolean = () => true): Promise<void> {
  await desktop.setTheme(theme);
  if (theme !== null || !/linux/i.test(desktop.platform())) return;
  const system = await desktop.theme();
  if (system && current()) await desktop.setTheme(system);
}

/**
 * Keep the native window's theme, and so its title bar on Windows and Linux, on the app's.
 *
 * A window that cannot follow is left as it is: a Linux window manager that draws its own title bar
 * ignores the request, and an older shell refuses the command. Neither is worth telling the user
 * about, since the page itself has already changed.
 */
export function useNativeWindowTheme(preference: ThemePreference, resolved: ResolvedTheme, desktop: DesktopWindow = nativeWindow): void {
  const theme = nativeWindowTheme(preference, resolved);
  useEffect(() => {
    if (!desktop.isTauri()) return;
    // A later choice supersedes this one: its Linux read-back must not name a stale system theme.
    let current = true;
    applyNativeWindowTheme(theme, desktop, () => current).catch(() => {});
    return () => { current = false; };
  }, [desktop, theme]);
}

/** "Agent Skills – Wollipog", or the app's name alone while there is no page. */
export function windowTitle(page?: string | null): string {
  const name = page?.trim();
  return name ? `${name} – ${APP_NAME}` : APP_NAME;
}

/**
 * Title the document, and the desktop window with it, after the page: the taskbar, the window
 * switcher and a browser's tabs then tell two windows or pages apart.
 */
export function useWindowTitle(page: string | null | undefined, desktop: DesktopWindow = nativeWindow): void {
  const title = windowTitle(page);
  useEffect(() => {
    document.title = title;
    // A webview's document title does not reach its native window on its own.
    if (desktop.isTauri()) desktop.setTitle(title).catch(() => {});
  }, [desktop, title]);
}
