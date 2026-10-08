/**
 * Static serving of the built web app, with the HTTP caching and compression policy (#2767).
 *
 * Two `@fastify/static` registrations, so the policy follows the directory rather than a guess
 * about each file:
 *
 *  - `/assets/` holds only Vite's content-hashed output. A changed file gets a new name, so these
 *    are cached immutably, and the web build writes `.br` / `.gz` sidecars next to them that are
 *    served to clients that accept the encoding (`preCompressed`). A missing sidecar falls back to
 *    the original file, and every response there carries `Vary: Accept-Encoding`.
 *  - Everything else (`sw.js`, the manifest, icons, licenses) keeps a stable name across builds,
 *    so it is revalidated on every use and never served from a sidecar: a sidecar left beside a
 *    stable name could outlive the file it was made from.
 *
 * The entry document is not served from here at all (see `index.ts`); it is sent with
 * `APP_SHELL_CACHE_CONTROL`.
 */

import { basename, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { appShellSecurityHeaders, isIndexHtmlPath } from "./web-dist.js";

/** Content-hashed assets never change under one name. */
export const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Stable-named files: cacheable, but revalidated (ETag / Last-Modified) before every use. */
export const REVALIDATED_CACHE_CONTROL = "public, max-age=0";
/** The entry document and the service worker script must reach the browser fresh. */
export const APP_SHELL_CACHE_CONTROL = "no-cache";

/**
 * Headers for every app-shell response. The shell names the current hashed assets, so a browser
 * holding an old copy would keep loading the previous build; `no-cache` makes it revalidate
 * (here: refetch, since the marked shell carries no validator) on every navigation.
 */
export function appShellHeaders(html: string): Record<string, string> {
  return { ...appShellSecurityHeaders(html), "Cache-Control": APP_SHELL_CACHE_CONTROL };
}

/**
 * Does a file in `assets/` carry Vite's content hash (`<name>-<8 hash chars>.<ext>`)? A sidecar
 * (`.br` / `.gz`) is classified by the file it was compressed from. Anything without the hash
 * marker is revalidated rather than trusted to be immutable.
 */
export function isContentHashedAssetName(fileName: string): boolean {
  return /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(fileName.replace(/\.(?:br|gz)$/, ""));
}

function setAssetHeaders(reply: FastifyReply, filePath: string): void {
  reply.header("cache-control", isContentHashedAssetName(basename(filePath))
    ? HASHED_ASSET_CACHE_CONTROL
    : REVALIDATED_CACHE_CONTROL);
}

function setRootHeaders(reply: FastifyReply, filePath: string): void {
  // Browsers already bypass the HTTP cache when checking a worker for updates, but an explicit
  // header keeps every intermediary from holding on to an old one.
  if (basename(filePath) === "sw.js") reply.header("cache-control", APP_SHELL_CACHE_CONTROL);
}

/**
 * Serve `webDist`. Every sensitive route is an explicit `/api/...` (or `/ui`, `/runner`) route,
 * and Fastify prefers explicit routes over these wildcards, so they can only ever serve files
 * under `webDist` (traversal-guarded by `@fastify/static`).
 *
 * `allowedPath` refuses every routable spelling of the entry document (`/INDEX.HTML`,
 * `/./index.html`, `/index.html/` …). An explicit `/index.html` route only beats the wildcard for
 * that exact string; the rest would otherwise be served raw off disk — unmarked — and a phone
 * opening one would point its API calls at itself. Refused paths fall through to the notFound
 * handler, which renders the marked shell. Fastify rejects an authority-form-looking
 * `//index.html` before routing, which is also safe because no entry-document bytes are served.
 */
export function registerWebAppStatic(app: FastifyInstance, webDist: string): void {
  app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    index: false,
    allowedPath: (pathname) => !isIndexHtmlPath(pathname),
    setHeaders: setRootHeaders,
  });
  app.register(fastifyStatic, {
    root: join(webDist, "assets"),
    prefix: "/assets/",
    index: false,
    decorateReply: false,
    preCompressed: true,
    setHeaders: setAssetHeaders,
  });
}
