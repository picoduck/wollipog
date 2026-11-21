// Synthetic, credential-free stand-ins for Google's Antigravity CLI release chain, used by the
// managed-install tests (Refs #4780): the installer script (only the lines Wollipog reads), the
// per-platform manifest, a gzipped tar built here byte by byte (so tests can make it unsafe), and a
// fake HTTPS origin set behind an injected fetch. Nothing here is captured from Google, and no
// network is used.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { AntigravityFetch } from "../../antigravity-install.js";

/** A manifest service address of the shape Google's installer names (HTTPS on run.app). */
export const FIXTURE_MANIFEST_BASE = "https://fixture-updater-000000000000.us-central1.run.app";
export const FIXTURE_INSTALLER_URL = "https://antigravity.google/cli/install.sh";

/** The installer script's layout as Wollipog reads it. The real script also detects the platform,
 * downloads and verifies the archive and runs `agy install`; Wollipog never runs it. */
export function fakeInstallerScript(options: { base?: string; extraBase?: string; manifestLine?: string; extractLine?: string } = {}): string {
  const base = options.base ?? FIXTURE_MANIFEST_BASE;
  return [
    "#!/bin/bash",
    "# Synthetic stand-in for Google's Antigravity CLI installer: only the lines Wollipog reads.",
    "set -euo pipefail",
    `DOWNLOAD_BASE_URL="${base}"`,
    ...(options.extraBase ? [`DOWNLOAD_BASE_URL="${options.extraBase}"`] : []),
    'TARGET_DIR="$HOME/.local/bin"',
    options.manifestLine ?? 'MANIFEST_URL="$DOWNLOAD_BASE_URL/manifests/$platform.json"',
    'STAGING_DIR="$HOME/.cache/antigravity/staging"',
    `    if ! ${options.extractLine ?? 'tar -xzf "$staging_payload" -C "$STAGING_DIR" antigravity'} 2>/dev/null; then`,
    '        echo "Extraction Error: Failed to extract binary from archive." >&2',
    "        exit 1",
    "    fi",
    "",
  ].join("\n");
}

export interface FakeTarEntry {
  name: string;
  /** Tar type flag: "0" regular (default), "5" folder, "1" hard link, "2" symlink, "3" device, "x" pax, "L" GNU long name. */
  type?: string;
  content?: Buffer | string;
  linkname?: string;
  prefix?: string;
  /** Declared size, when it should differ from the content (a truncated member). */
  declaredSize?: number;
}

function field(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value.slice(0, length), offset, length, "utf8");
}

function octalField(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, "0")}\0`;
}

function tarHeader(entry: FakeTarEntry, size: number): Buffer {
  const block = Buffer.alloc(512, 0);
  field(block, 0, 100, entry.name);
  field(block, 100, 8, octalField(0o755, 7));
  field(block, 108, 8, octalField(0, 7));
  field(block, 116, 8, octalField(0, 7));
  field(block, 124, 12, octalField(entry.declaredSize ?? size, 11));
  field(block, 136, 12, octalField(1_795_000_000, 11));
  field(block, 148, 8, "        ");
  field(block, 156, 1, entry.type ?? "0");
  field(block, 157, 100, entry.linkname ?? "");
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  field(block, 345, 155, entry.prefix ?? "");
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** A tar archive of `entries`, gzipped. `end: false` leaves out the end-of-archive blocks. */
export function fakeTarGz(entries: FakeTarEntry[], options: { end?: boolean; truncateTo?: number } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    parts.push(tarHeader(entry, content.length));
    parts.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    parts.push(Buffer.alloc(padding, 0));
  }
  if (options.end !== false) parts.push(Buffer.alloc(1024, 0));
  let tar = Buffer.concat(parts);
  if (options.truncateTo !== undefined) tar = tar.subarray(0, options.truncateTo);
  return gzipSync(tar);
}

/** A pax extended header naming `path` for the member that follows. */
export function paxPathEntry(path: string): FakeTarEntry {
  const body = ` path=${path}\n`;
  let length = body.length;
  length += String(length + String(length).length).length;
  return { name: "PaxHeaders/antigravity", type: "x", content: `${length}${body}` };
}

/** The `antigravity` binary of a fake release: a shell wrapper running the fake CLI with this
 * release's own version and behaviors. */
export function fakeAgyWrapper(options: { fixture: string; version: string; mode?: string; label?: string }): string {
  const env = [
    `FAKE_AGY_VERSION=${options.version}`,
    `FAKE_AGY_LABEL=${options.label ?? `managed-${options.version}`}`,
    ...(options.mode !== undefined ? [`FAKE_AGY_MODE=${options.mode}`] : []),
  ].join(" ");
  return `#!/bin/sh\n${env} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(options.fixture)} "$@"\n`;
}

export function sha512(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("hex");
}

export interface FakeRoute {
  status?: number;
  body?: Buffer | string;
  headers?: Record<string, string>;
  /** Never answers until the request is aborted. */
  hang?: boolean;
}

/** Fake HTTPS origins behind the injected fetch. Unknown addresses answer 404. */
export class FakeReleaseServer {
  readonly requests: string[] = [];
  private readonly routes = new Map<string, FakeRoute>();

  set(url: string, route: FakeRoute): void {
    this.routes.set(url, route);
  }

  readonly fetch: AntigravityFetch = async (input, init) => {
    this.requests.push(input.href);
    if (init.redirect !== "manual") throw new Error("the fixture expects redirect: manual");
    const route = this.routes.get(input.href);
    if (!route) return new Response("not found", { status: 404 });
    if (route.hang) {
      return new Promise<Response>((_, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    const body = route.body === undefined ? null : new Uint8Array(Buffer.from(route.body));
    return new Response(body, { status: route.status ?? 200, headers: route.headers ?? {} });
  };

  /** Publish a release for `platform`: the installer, its manifest and the archive. */
  publish(options: {
    platform: string;
    version: string;
    archive: Buffer;
    /** The manifest's SHA-512, when it should not match the archive. */
    manifestSha512?: string;
    archiveUrl?: string;
    installer?: string;
  }): { archiveUrl: string; manifestUrl: string } {
    const archiveUrl = options.archiveUrl ??
      `https://storage.googleapis.com/antigravity-public/antigravity-cli/${options.version}-fixture/cli_${options.platform}.tar.gz`;
    const manifestUrl = `${FIXTURE_MANIFEST_BASE}/manifests/${options.platform}.json`;
    this.set(FIXTURE_INSTALLER_URL, { body: options.installer ?? fakeInstallerScript() });
    this.set(manifestUrl, { body: JSON.stringify({
      version: options.version, url: archiveUrl, sha512: options.manifestSha512 ?? sha512(options.archive),
    }, null, 2) });
    this.set(archiveUrl, { body: options.archive, headers: { "content-length": String(options.archive.length) } });
    return { archiveUrl, manifestUrl };
  }
}
