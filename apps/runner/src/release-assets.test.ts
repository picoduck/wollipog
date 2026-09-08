import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  RUNNER_TARGET_TRIPLES,
  controlPlaneArtifactName,
  runnerArtifactNames,
  WEB_BUNDLE_ASSET_NAME as PRODUCER_WEB_BUNDLE,
} from "../scripts/runner-artifacts.mjs";
import {
  WEB_BUNDLE_ASSET_NAME,
  controlPlaneAssetName,
  downloadVerifiedAsset,
  findAsset,
  hostTargetTriple,
  parseChecksumManifest,
  resolveRelease,
  runnerAssetName,
  type Downloader,
} from "./release-assets.js";

test("release asset names stay in sync with the release producer", () => {
  assert.equal(WEB_BUNDLE_ASSET_NAME, PRODUCER_WEB_BUNDLE);
  for (const triple of RUNNER_TARGET_TRIPLES as readonly string[]) {
    assert.equal(runnerAssetName(triple), runnerArtifactNames(triple).canonical);
    assert.equal(controlPlaneAssetName(triple), controlPlaneArtifactName(triple));
  }
  assert.equal(hostTargetTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(hostTargetTriple("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(hostTargetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(hostTargetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(hostTargetTriple("freebsd", "x64"), null);
  assert.equal(hostTargetTriple("linux", "ia32"), null);
});

test("resolveRelease reads latest or an exact tag and keeps only usable digests", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchJson = async (url: string, headers: Record<string, string>) => {
    seen.push({ url, headers });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        tag_name: "v1.2.3",
        assets: [
          { name: "wollipog-runner-x86_64-unknown-linux-gnu", digest: `sha256:${"a".repeat(64)}`, browser_download_url: "https://dl/r", size: 10 },
          { name: "odd", digest: "md5:nope", browser_download_url: "https://dl/o", size: 1 },
          { name: "broken" },
        ],
      }),
    };
  };
  const latest = await resolveRelease(fetchJson, { token: "tok" });
  assert.equal(latest.tag, "v1.2.3");
  assert.equal(latest.version, "1.2.3");
  assert.equal(seen[0]!.url, "https://api.github.com/repos/picoduck/wollipog/releases/latest");
  assert.equal(seen[0]!.headers.authorization, "Bearer tok");
  assert.deepEqual(latest.assets.map((asset) => [asset.name, asset.digest]), [
    ["wollipog-runner-x86_64-unknown-linux-gnu", `sha256:${"a".repeat(64)}`],
    ["odd", null],
  ]);
  await resolveRelease(fetchJson, { tag: "v1.2.3" });
  assert.equal(seen[1]!.url, "https://api.github.com/repos/picoduck/wollipog/releases/tags/v1.2.3");
  assert.equal(seen[1]!.headers.authorization, undefined);
  await assert.rejects(resolveRelease(fetchJson, { tag: "latest" }), /must look like v1\.2\.3/u);
  await assert.rejects(resolveRelease(async () => ({ ok: false, status: 404, text: async () => "" }), {}), /no published release found/u);
  await assert.rejects(resolveRelease(async () => ({ ok: true, status: 200, text: async () => "<html>" }), {}), /not valid JSON/u);
  await assert.rejects(resolveRelease(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: "nightly", assets: [] }) }), {}), /no usable tag name/u);
  assert.throws(() => findAsset(latest, "missing"), /has no asset named missing/u);
});

test("checksum manifests parse strictly and downloads are verified against publisher and manifest digests", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-release-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("verified bytes\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = parseChecksumManifest(`${digest}  wollipog-runner-x86_64-unknown-linux-gnu\n${"b".repeat(64)}  wollipog-web.tar.gz\n`);
  assert.equal(manifest.get("wollipog-runner-x86_64-unknown-linux-gnu"), digest);
  assert.throws(() => parseChecksumManifest("garbage\n"), /invalid SHA256SUMS line/u);
  assert.throws(() => parseChecksumManifest(`${digest}  a\n${digest}  a\n`), /duplicate SHA256SUMS entry/u);
  assert.throws(() => parseChecksumManifest(`${digest}  ../evil\n`), /invalid SHA256SUMS line/u);

  const download: Downloader = async (_url, destination) => { writeFileSync(destination, bytes); };
  const asset = { name: "wollipog-runner-x86_64-unknown-linux-gnu", digest: `sha256:${digest}`, url: "https://dl/r", size: bytes.length };
  const destination = join(root, "runner");
  assert.equal(await downloadVerifiedAsset(download, asset, destination, { manifest }), digest);
  assert.deepEqual(readFileSync(destination), bytes);

  await assert.rejects(downloadVerifiedAsset(download, { ...asset, digest: null }, join(root, "x")), /no valid GitHub SHA-256 digest/u);
  await assert.rejects(downloadVerifiedAsset(download, { ...asset, name: "wollipog-web.tar.gz" }, join(root, "y"), { manifest }), /SHA256SUMS and the GitHub digest disagree/u);
  await assert.rejects(downloadVerifiedAsset(download, { ...asset, name: "unlisted" }, join(root, "z"), { manifest }), /SHA256SUMS has no entry for unlisted/u);
  const tampered: Downloader = async (_url, destination) => { writeFileSync(destination, "tampered"); };
  await assert.rejects(downloadVerifiedAsset(tampered, asset, join(root, "t"), { manifest }), /failed SHA-256 verification/u);
  const headersSeen: Record<string, string>[] = [];
  const recording: Downloader = async (_url, destination, headers) => { headersSeen.push(headers); writeFileSync(destination, bytes); };
  await downloadVerifiedAsset(recording, asset, join(root, "h"), { token: "tok" });
  assert.equal(headersSeen[0]!.authorization, "Bearer tok");
  assert.equal(headersSeen[0]!.accept, "application/octet-stream");
});
