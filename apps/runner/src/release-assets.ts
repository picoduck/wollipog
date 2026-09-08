/**
 * GitHub release resolution and verified downloads for `wollipog service upgrade`.
 *
 * Asset names mirror apps/runner/scripts/runner-artifacts.mjs (the release producer); a test pins
 * the two in sync. Every downloaded byte is verified against GitHub's publisher digest and, when
 * present, the release's SHA256SUMS entry before it is used.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const RELEASE_REPOSITORY = "picoduck/wollipog";
export const WEB_BUNDLE_ASSET_NAME = "wollipog-web.tar.gz";
export const CHECKSUM_MANIFEST_NAME = "SHA256SUMS";

const TARGET_TRIPLES: Record<string, string> = {
  "darwin/arm64": "aarch64-apple-darwin",
  "darwin/x64": "x86_64-apple-darwin",
  "linux/arm64": "aarch64-unknown-linux-gnu",
  "linux/x64": "x86_64-unknown-linux-gnu",
  "win32/arm64": "aarch64-pc-windows-msvc",
  "win32/x64": "x86_64-pc-windows-msvc",
};

/** The release target triple for this host, or null when no native release exists for it. */
export function hostTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  return TARGET_TRIPLES[`${platform}/${arch}`] ?? null;
}

function executableSuffix(triple: string): string {
  return triple.endsWith("-pc-windows-msvc") ? ".exe" : "";
}

export function runnerAssetName(triple: string): string {
  return `wollipog-runner-${triple}${executableSuffix(triple)}`;
}

export function controlPlaneAssetName(triple: string): string {
  return `wollipog-control-plane-${triple}${executableSuffix(triple)}`;
}

export interface ReleaseAsset {
  name: string;
  /** GitHub publisher digest (`sha256:<hex>`), or null when the API did not record one. */
  digest: string | null;
  url: string;
  size: number;
}

export interface ResolvedRelease {
  tag: string;
  /** `tag` without a leading `v`. */
  version: string;
  assets: ReleaseAsset[];
}

export type JsonFetch = (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Resolve the latest published release, or an exact tag. Drafts are never returned by these endpoints. */
export async function resolveRelease(
  fetchJson: JsonFetch,
  options: { repository?: string; tag?: string | null; token?: string | null } = {},
): Promise<ResolvedRelease> {
  const repository = options.repository ?? RELEASE_REPOSITORY;
  if (options.tag !== undefined && options.tag !== null && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.tag)) {
    throw new Error(`release tag must look like v1.2.3, got ${options.tag}`);
  }
  const url = options.tag
    ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(options.tag)}`
    : `https://api.github.com/repos/${repository}/releases/latest`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "wollipog-cli" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetchJson(url, headers);
  if (!response.ok) {
    throw new Error(response.status === 404
      ? `no ${options.tag ? `release ${options.tag}` : "published release"} found for ${repository} (a private repository needs GH_TOKEN with Contents: read)`
      : `GitHub release lookup failed: HTTP ${response.status}`);
  }
  let body: { tag_name?: unknown; assets?: unknown };
  try {
    body = JSON.parse(await response.text()) as typeof body;
  } catch {
    throw new Error("GitHub release metadata was not valid JSON");
  }
  if (typeof body.tag_name !== "string" || !/^v\d+\.\d+\.\d+/u.test(body.tag_name)) {
    throw new Error("GitHub release metadata has no usable tag name");
  }
  if (!Array.isArray(body.assets)) throw new Error("GitHub release metadata has no asset list");
  const assets: ReleaseAsset[] = [];
  for (const raw of body.assets as Array<Record<string, unknown>>) {
    if (!raw || typeof raw.name !== "string" || typeof raw.browser_download_url !== "string") continue;
    const digest = typeof raw.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(raw.digest) ? raw.digest : null;
    const size = typeof raw.size === "number" && Number.isSafeInteger(raw.size) ? raw.size : 0;
    assets.push({ name: raw.name, digest, url: raw.browser_download_url, size });
  }
  return { tag: body.tag_name, version: body.tag_name.replace(/^v/u, ""), assets };
}

export function findAsset(release: ResolvedRelease, name: string): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`release ${release.tag} has no asset named ${name}`);
  return asset;
}

/** Parse `SHA256SUMS` (`<hex>  <name>` lines). Duplicate or malformed lines fail closed. */
export function parseChecksumManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line);
    if (!match) throw new Error(`invalid ${CHECKSUM_MANIFEST_NAME} line: ${line}`);
    if (entries.has(match[2]!)) throw new Error(`duplicate ${CHECKSUM_MANIFEST_NAME} entry: ${match[2]}`);
    entries.set(match[2]!, match[1]!);
  }
  return entries;
}

export type Downloader = (url: string, destination: string, headers: Record<string, string>) => Promise<void>;

/** Stream a URL to a new file; the caller verifies the bytes before promoting them. */
export const downloadToFile: Downloader = async (url, destination, headers) => {
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as import("stream/web").ReadableStream), createWriteStream(destination, { mode: 0o600 }));
};

export async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    /* createReadStream closes the handle when it ends */
  }
}

/**
 * Download one asset and prove its bytes: the publisher digest is mandatory (an asset without one
 * is refused), and when a manifest is supplied its entry must agree as well. Returns the hex digest.
 */
export async function downloadVerifiedAsset(
  download: Downloader,
  asset: ReleaseAsset,
  destination: string,
  options: { manifest?: Map<string, string> | null; token?: string | null; hash?: (path: string) => Promise<string> } = {},
): Promise<string> {
  const publisher = asset.digest ? asset.digest.slice("sha256:".length) : null;
  if (!publisher) throw new Error(`${asset.name} has no valid GitHub SHA-256 digest; refusing an unverified download`);
  const manifestDigest = options.manifest ? options.manifest.get(asset.name) ?? null : null;
  if (options.manifest && !manifestDigest) throw new Error(`${CHECKSUM_MANIFEST_NAME} has no entry for ${asset.name}`);
  if (manifestDigest && manifestDigest !== publisher) throw new Error(`${asset.name}: ${CHECKSUM_MANIFEST_NAME} and the GitHub digest disagree`);
  const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "wollipog-cli" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  await download(asset.url, destination, headers);
  const actual = await (options.hash ?? sha256File)(destination);
  if (actual !== publisher) throw new Error(`${asset.name} failed SHA-256 verification (expected ${publisher}, got ${actual})`);
  return actual;
}
