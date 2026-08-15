import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { DESKTOP_EXCLUDED_ASSETS, isDesktopBuild, stripManifestLink } from "./src/desktop-bundle.js";

/**
 * §23.6 — the desktop bundle ships neither a service worker nor a web-app manifest.
 *
 * Both are copied out of `public/` into every build, and both are meaningless inside a Tauri
 * webview. Registration was already guarded on the `tauri.localhost` host in `pwa.ts`; this removes
 * the files themselves, and the `<link rel="manifest">` that would otherwise 404 on every launch.
 */
function excludePwaAssetsFromDesktop(): Plugin {
  // Taken from the RESOLVED config, not hardcoded to `dist`. A hardcoded path silently does nothing
  // whenever the output directory is anything else — including the directory the test that guards
  // this builds into, which is how the miss was found.
  let outDir = "";
  return {
    name: "wollipog-desktop-bundle",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root ?? dirname(fileURLToPath(import.meta.url)), config.build.outDir);
    },
    async closeBundle() {
      if (!isDesktopBuild(process.env)) return;
      for (const asset of DESKTOP_EXCLUDED_ASSETS) await rm(join(outDir, asset), { force: true });
      const indexPath = join(outDir, "index.html");
      await writeFile(indexPath, stripManifestLink(await readFile(indexPath, "utf8")));
    },
  };
}

// The control plane runs separately (default http://127.0.0.1:4317). The web app
// talks to it directly over CORS + websocket; override via VITE_CONTROL_PLANE_*.
export default defineConfig(({ mode }) => ({
  plugins: [react(), excludePwaAssetsFromDesktop()],
  build: mode === "same-origin-dev" ? { emptyOutDir: false } : undefined,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
}));
