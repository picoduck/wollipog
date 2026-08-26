/**
 * Locating the built web app so the control plane can SERVE it (same-origin).
 *
 * Why same-origin matters: a phone reaches the control plane at `http://<host>:<port>`. If the
 * dashboard is served from that same origin, its REST + `/ui` calls need no CORS and a single
 * `http://<host>:<port>/#pair=<token>` link both loads the app and pairs the device. When the
 * bundle is absent (a source checkout that never ran `pnpm --filter @wollipog/web build`), the API
 * still works — only the browser-served UI is unavailable.
 *
 * The Tauri desktop shell does NOT use this: it loads its own `frontendDist` from
 * `tauri.localhost` and talks to the sidecar's API over 127.0.0.1.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCompatibleEnv, type LegacyEnvironmentWarning } from "./env-compat.js";

export interface WebDistEnvironment {
  [name: string]: string | undefined;
  WOLLIPOG_WEB_DIST?: string;
  MAM_WEB_DIST?: string;
}

/**
 * Is this process a PACKAGED control plane (the Node SEA sidecar) rather than a plain `node` /
 * `tsx` run of the source? Under `node`, `process.execPath` is the Node binary in a shared bin
 * directory — a `web/` folder beside it is nothing to do with us, and serving it would hand a
 * stale (or planted) page same-origin trust: it can try to read the browser's stored local-startup
 * or paired-device credential and then drive the authenticated REST API.
 */
export function isPackagedExec(execPath: string): boolean {
  // Split on BOTH separators, not node:path.basename — basename is host-OS-specific (POSIX
  // basename leaves a `\` path intact), and a robust classification of the executable name must
  // not depend on which OS is inspecting the path.
  const exe = (execPath.split(/[\\/]/).pop() ?? "").toLowerCase();
  return exe !== "node" && exe !== "node.exe";
}

/** Cache the app shell only for immutable packaged assets, never a watched source build. */
export function shouldCacheWebIndex(execPath: string, lifecycleEvent?: string): boolean {
  return isPackagedExec(execPath) || lifecycleEvent !== "dev";
}

/**
 * Candidate directories for the built web app, most-specific first. Pure (no fs) so the
 * ordering is unit-testable:
 *  1. `$WOLLIPOG_WEB_DIST`    — explicit override (packaging, tests, unusual layouts)
 *  2. `<execDir>/web`         — next to a packaged single-executable control plane ONLY
 *  3. `<cwd>/apps/web/dist`   — repo root (`pnpm dev` from the monorepo root)
 *  4. `<cwd>/../web/dist`     — cwd is apps/control-plane (its own `pnpm dev`)
 */
export function webDistCandidates(
  env: WebDistEnvironment,
  cwd: string,
  execPath: string,
  warn?: LegacyEnvironmentWarning,
): string[] {
  const out: string[] = [];
  const override = readCompatibleEnv(env, "WOLLIPOG_WEB_DIST", "MAM_WEB_DIST", warn);
  if (override) out.push(override);
  if (isPackagedExec(execPath)) out.push(join(dirname(execPath), "web"));
  out.push(join(cwd, "apps", "web", "dist"));
  out.push(join(cwd, "..", "web", "dist"));
  return out;
}

/**
 * Does `dir` look like a BUILT bundle rather than a source root? `@fastify/static` publishes the
 * whole rooted directory, so `WOLLIPOG_WEB_DIST=apps/web` (an easy slip — the var says "web dist")
 * would expose `src/`, `package.json`, and configs. A built Vite bundle never contains either.
 */
export function looksLikeBuiltBundle(dir: string, exists: (p: string) => boolean): boolean {
  if (!exists(join(dir, "index.html"))) return false;
  return !exists(join(dir, "package.json")) && !exists(join(dir, "src"));
}

/** First candidate that holds a built bundle, or null when none is present. */
export function resolveWebDist(
  env: WebDistEnvironment = process.env,
  cwd: string = process.cwd(),
  execPath: string = process.execPath,
  exists: (p: string) => boolean = existsSync,
  warn: LegacyEnvironmentWarning = (message) => console.warn(`[control-plane] ${message}`),
): string | null {
  for (const dir of webDistCandidates(env, cwd, execPath, warn)) {
    if (looksLikeBuiltBundle(dir, exists)) return dir;
  }
  return null;
}

/**
 * Mark the served index.html as CP-hosted. New web bundles read `window.__WOLLIPOG_SAME_ORIGIN__`
 * while bundles built before TODO-001 read the legacy marker. Emit both during the compatibility
 * window so a source checkout cannot strand a previously built, gitignored `apps/web/dist` bundle.
 * Either makes the app point its API/WS at `location.origin` instead of the 127.0.0.1:4317 default — which would be
 * the PHONE itself when the page is opened remotely. Injected at serve time rather than baked
 * into the bundle so the SAME build still works under Vite dev and inside the Tauri shell.
 */
/** Paths the app shell must never stand in for: the API and the two WebSocket channels. */
const RESERVED_PREFIXES = ["/api", "/hooks", "/ui", "/runner"];

/** Percent-decode a pathname; malformed escapes stay as-is rather than throwing. */
export function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Canonical form of a request pathname for policy decisions: percent-decoded, backslashes
 * folded to `/`, duplicate slashes collapsed, `.` and `..` segments resolved, trailing slash
 * dropped. Every path-shape check below runs on this, so no alternate spelling of a path can
 * be classified differently from its canonical form — `//index.html`, `/./index.html`,
 * `/index.html/`, `/ui/`, and `/%75i/` all normalize to the thing they actually address.
 */
export function normalizeRequestPath(pathname: string): string {
  const decoded = safeDecodePath(pathname).replace(/\\/g, "/");
  const parts: string[] = [];
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/**
 * Is this a request for the app's entry document (in any spelling/case)? Such requests must be
 * answered by the marker-injecting handler, never served raw off disk: an unmarked shell makes
 * the web app fall back to `http://127.0.0.1:4317`, which on a phone is the phone itself.
 * `@fastify/static` is configured to refuse these paths so they fall through to the shell route.
 */
export function isIndexHtmlPath(pathname: string): boolean {
  return /^\/index\.html$/i.test(normalizeRequestPath(pathname));
}

/**
 * Should a route miss render the client-side app shell?
 *
 * Only GET/HEAD requests, on the CANONICAL path, that are neither reserved nor file-shaped:
 *  - A missing `/assets/index-abc.js` must 404 honestly rather than return HTML, which the
 *    browser would try to parse as JavaScript — turning a deploy slip into a baffling error.
 *  - Reserved paths are matched as PREFIXES. `/ui/` (trailing slash) misses the exact `/ui`
 *    socket route, so an exact-match check let `GET /ui/?token=<device token>` render the shell:
 *    the page never adopts or scrubs the token, stranding a reusable credential in history and
 *    referrers, and skipping the redacting 404 path.
 *  - Any spelling of the entry document IS a shell navigation, so it gets the marker.
 */
export function isSpaNavigation(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const p = normalizeRequestPath(pathname);
  for (const reserved of RESERVED_PREFIXES) {
    if (p === reserved || p.startsWith(`${reserved}/`)) return false;
  }
  if (isIndexHtmlPath(p)) return true;
  // Resource ids are opaque bounded strings and may legitimately end in `.txt`, `.json`, etc.
  // An exact marker-plus-one-segment detail route is navigation, even when the opaque id decodes
  // to an asset-looking name. Nested asset-looking misses still 404 instead of returning HTML.
  // The browser route codec uses a `~` marker plus alphabet-only UTF-16LE base64url, so normalization
  // cannot expose a slash or dot segment from inside the opaque id.
  if (/^\/(?:sessions|runs|pods)\/~[A-Za-z0-9_-]+\/?$/.test(p)) return true;
  return !/\.[a-zA-Z0-9]+$/.test(p);
}

export function injectSameOriginMarker(html: string): string {
  const assignments = [
    html.includes("__WOLLIPOG_SAME_ORIGIN__") ? "" : "window.__WOLLIPOG_SAME_ORIGIN__=1;",
    html.includes("__MAM_SAME_ORIGIN__") ? "" : "window.__MAM_SAME_ORIGIN__=1;",
  ].join("");
  if (!assignments) return html; // idempotent once both compatibility markers are present
  const tag = `<script>${assignments}</script>`;
  const i = html.indexOf("</head>");
  return i === -1 ? tag + html : html.slice(0, i) + tag + html.slice(i);
}

/** Security headers for the browser app shell, including hashes for its intentional inline scripts. */
export function appShellSecurityHeaders(html: string): Record<string, string> {
  const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\ssrc\s*=/i.test(match[0].slice(0, match[0].indexOf(">") + 1)))
    .map((match) => `'sha256-${createHash("sha256").update(match[1] ?? "").digest("base64")}'`);
  const scriptSrc = ["'self'", ...new Set(hashes)].join(" ");
  return {
    "Content-Security-Policy": `script-src ${scriptSrc}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff",
  };
}

/** Read the current marked shell, retaining the last complete copy across watched-build races. */
export function readWebIndexHtml(
  webDist: string,
  lastGood: string | null,
  read: (path: string, encoding: "utf8") => string = readFileSync,
): string | null {
  try {
    return injectSameOriginMarker(read(join(webDist, "index.html"), "utf8"));
  } catch {
    return lastGood;
  }
}
