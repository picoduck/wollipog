import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildUpdateManifest, desktopUpdaterArtifacts } from "./desktop-update-manifest.mjs";
import { checksumManifest, expectedManifestAssetNames } from "./verify-runner-release-assets.mjs";
import { verifyPublishedAssets } from "./release.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const version = "0.35.0", repository = "example/project";

function fixture() {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const mergeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("0102030405060708", "hex");
  const publicKeyValue = Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from("Ed"), keyId, Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")]).toString("base64")}\n`).toString("base64");
  const files = new Map(), signatures = new Map();
  for (const name of expectedManifestAssetNames()) files.set(name, Buffer.from(name.replace(/^agent-manager-/, "wollipog-")));
  for (const { asset, signedAs } of desktopUpdaterArtifacts(version)) {
    const bytes = Buffer.from(`tiny package ${asset}`);
    const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
    const comment = `timestamp:1790000000\tfile:${signedAs}\tversion:${version}`;
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const text = Buffer.from(["untrusted comment: test signature", Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
      `trusted comment: ${comment}`, global.toString("base64"), ""].join("\n")).toString("base64");
    signatures.set(asset, text); files.set(asset, bytes); files.set(asset + ".sig", Buffer.from(text));
  }
  for (const arch of ["aarch64", "x64"]) files.set(`Wollipog_${version}_${arch}.dmg`, Buffer.from("disk image"));
  files.set("SHA256SUMS", Buffer.from(checksumManifest(new Map(expectedManifestAssetNames().map((name) => [name, sha256(files.get(name))])))));
  files.set("latest.json", Buffer.from(JSON.stringify(buildUpdateManifest({ version, repo: repository, tag: `v${version}`, signatures, pubDate: "2026-10-20T12:00:00Z" }))));
  const assets = [...files].map(([name, bytes], i) => ({ id: i + 1, name, size: bytes.length, digest: `sha256:${sha256(bytes)}` }));
  const directory = mkdtempSync(join(tmpdir(), "release-verify-test-"));
  let downloads = 0;
  const io = {
    cwd, cacheDirectory: directory,
    pages: () => assets,
    api: () => ({ value: publicKeyValue }),
    execute(program, args, options = {}) {
      if (program === "gh") {
        downloads++;
        const id = Number(args[1].split("/").at(-1));
        assert.match(args[1], /^repos\/example\/project\/releases\/assets\/\d+$/);
        return files.get(assets.find((asset) => asset.id === id).name);
      }
      return execFileSync(program, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options });
    },
  };
  return { state: { repository, version, tag: `v${version}`, mergeSha }, release: { id: 200 }, io, files, assets,
    downloads: () => downloads, directory, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("publication verification uses real merged helpers, signatures, publisher hashes, and cache rehashing", () => {
  const f = fixture();
  try {
    const recheck = verifyPublishedAssets(f.state, f.release, f.io); recheck();
    assert.ok(f.downloads() > 0);
    const before = f.downloads();
    verifyPublishedAssets(f.state, f.release, f.io)();
    assert.equal(f.downloads(), before);
    const latest = f.assets.find((asset) => asset.name === "latest.json");
    writeFileSync(join(f.directory, latest.digest.slice(7)), "corrupt cache");
    verifyPublishedAssets(f.state, f.release, f.io)();
    assert.equal(f.downloads(), before + 1);
    latest.digest = "sha256:" + "0".repeat(64);
    assert.throws(recheck, /Hosted assets changed/);
  } finally { f.close(); }
});

test("changed bytes cannot pass even when the download request itself succeeds", () => {
  const f = fixture();
  try {
    const name = desktopUpdaterArtifacts(version)[0].asset;
    f.files.set(name, Buffer.from("tampered package"));
    assert.throws(() => verifyPublishedAssets(f.state, f.release, f.io), /differs from publisher metadata/);
  } finally { f.close(); }
});

test("a dangling cache symlink cannot redirect a downloaded asset write", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const target = join(f.directory, "must-not-be-created");
    const latest = f.assets.find((asset) => asset.name === "latest.json");
    symlinkSync(target, join(f.directory, latest.digest.slice(7)));
    assert.throws(() => verifyPublishedAssets(f.state, f.release, f.io), /symlink/);
    assert.equal(existsSync(target), false);
  } finally { f.close(); }
});

test("publisher-consistent altered packages still fail cryptographic verification", () => {
  const f = fixture();
  try {
    const name = desktopUpdaterArtifacts(version)[0].asset;
    const bytes = Buffer.from("publisher recorded different bytes");
    f.files.set(name, bytes);
    Object.assign(f.assets.find((asset) => asset.name === name), { size: bytes.length, digest: `sha256:${sha256(bytes)}` });
    assert.throws(() => verifyPublishedAssets(f.state, f.release, f.io));
  } finally { f.close(); }
});
