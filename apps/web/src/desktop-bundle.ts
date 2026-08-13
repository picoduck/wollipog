/**
 * What the DESKTOP bundle must not contain, and why — §23.6.
 *
 * A service worker and a web-app manifest are meaningless inside a Tauri webview, and push-to-wake,
 * whose whole value is working while the app is closed, is incoherent for a desktop process the
 * user just quit. Registration is already guarded on the `tauri.localhost` host in `pwa.ts`; this is
 * the other half — the files themselves, which Vite copies out of `public/` into every build.
 *
 * Exported as data rather than inlined into the Vite config so the build rule and the test that
 * checks a real bundle read the same list, instead of two lists that agree until one is edited.
 */
export const DESKTOP_EXCLUDED_ASSETS = ["sw.js", "manifest.webmanifest"] as const;

/** The env var that selects the desktop build. Set by the desktop `beforeBuildCommand`. */
export const DESKTOP_BUILD_ENV = "WOLLIPOG_DESKTOP_BUILD";

export function isDesktopBuild(env: Record<string, string | undefined>): boolean {
  return env[DESKTOP_BUILD_ENV] === "1";
}

/**
 * Strip the manifest link from `index.html`.
 *
 * Deleting the file without this leaves a `<link rel="manifest">` pointing at nothing, which is a
 * 404 on every launch — a smaller problem than the one being fixed, and an entirely avoidable one.
 */
export function stripManifestLink(html: string): string {
  return html.replace(/[ \t]*<link\b[^>]*\brel="manifest"[^>]*>\s*\n?/g, "");
}
