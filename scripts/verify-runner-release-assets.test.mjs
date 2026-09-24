import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { controlPlaneArtifactName, headlessArtifactNames, runnerArtifactNames, RUNNER_TARGET_TRIPLES, WEB_BUNDLE_ASSET_NAME } from "../apps/runner/scripts/runner-artifacts.mjs";
import { desktopUpdaterArtifacts, updaterReleaseAssetNames } from "./desktop-update-manifest.mjs";
import {
  checksumManifest,
  EXPECTED_RELEASE_ASSET_COUNT,
  EXPECTED_SIGNED_RELEASE_ASSET_COUNT,
  EXPECTED_UPDATER_ASSET_COUNT,
  expectedManifestAssetNames,
  expectedRunnerAssetNames,
  verifyHostedRelease,
  verifyLocalRunnerAssets,
} from "./verify-runner-release-assets.mjs";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-runner-release-"));
  for (const triple of RUNNER_TARGET_TRIPLES) {
    const bytes = Buffer.from(`native runner for ${triple}`);
    const { canonical, legacy } = runnerArtifactNames(triple);
    writeFileSync(join(root, canonical), bytes);
    writeFileSync(join(root, legacy), bytes);
    writeFileSync(join(root, controlPlaneArtifactName(triple)), Buffer.from(`native control plane for ${triple}`));
  }
  writeFileSync(join(root, WEB_BUNDLE_ASSET_NAME), Buffer.from("web bundle"));
  return root;
}

test("local runner verification emits a complete deterministic SHA256SUMS manifest", async () => {
  const root = await fixture();
  try {
    const digests = await verifyLocalRunnerAssets(root);
    const manifest = checksumManifest(digests);
    assert.equal(manifest.trimEnd().split("\n").length, 19);
    assert.deepEqual(manifest.trimEnd().split("\n").map((line) => line.slice(66)), expectedManifestAssetNames());
    assert.deepEqual(headlessArtifactNames(), [...RUNNER_TARGET_TRIPLES.map((triple) => controlPlaneArtifactName(triple)), WEB_BUNDLE_ASSET_NAME].sort());
    assert.equal(controlPlaneArtifactName("x86_64-pc-windows-msvc"), "wollipog-control-plane-x86_64-pc-windows-msvc.exe");
    assert.equal(controlPlaneArtifactName("x86_64-unknown-linux-gnu"), "wollipog-control-plane-x86_64-unknown-linux-gnu");
    for (const name of expectedRunnerAssetNames()) assert.ok(expectedManifestAssetNames().includes(name));
    for (const triple of RUNNER_TARGET_TRIPLES) {
      const { canonical, legacy } = runnerArtifactNames(triple);
      assert.equal(digests.get(canonical), digests.get(legacy));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local runner verification rejects extra, missing, and divergent aliases", async () => {
  const root = await fixture();
  try {
    writeFileSync(join(root, "unexpected"), "extra");
    await assert.rejects(verifyLocalRunnerAssets(root), /extra=\[unexpected\]/);
    rmSync(join(root, "unexpected"));
    const { legacy } = runnerArtifactNames(RUNNER_TARGET_TRIPLES[0]);
    rmSync(join(root, legacy));
    await assert.rejects(verifyLocalRunnerAssets(root), /missing=\[agent-manager-runner-aarch64-apple-darwin\]/);
    writeFileSync(join(root, legacy), "different");
    await assert.rejects(verifyLocalRunnerAssets(root), /runner aliases differ/);
    writeFileSync(join(root, legacy), `native runner for ${RUNNER_TARGET_TRIPLES[0]}`);
    rmSync(join(root, WEB_BUNDLE_ASSET_NAME));
    await assert.rejects(verifyLocalRunnerAssets(root), /missing=\[wollipog-web\.tar\.gz\]/);
    writeFileSync(join(root, WEB_BUNDLE_ASSET_NAME), "");
    await assert.rejects(verifyLocalRunnerAssets(root), /release asset is empty: wollipog-web\.tar\.gz/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted verification enforces the exact release count, manifest, and six remote digest pairs", async () => {
  const root = await fixture();
  try {
    const digests = await verifyLocalRunnerAssets(root);
    const manifest = checksumManifest(digests);
    const runners = expectedManifestAssetNames().map((name) => ({
      name,
      size: 100,
      digest: `sha256:${digests.get(name)}`,
    }));
    const assets = [
      ...runners,
      {
        name: "SHA256SUMS",
        size: Buffer.byteLength(manifest),
        digest: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
      },
      ...Array.from({ length: 14 }, (_, index) => ({
        name: `desktop-${index}`,
        size: 100,
        digest: `sha256:${String(index).padStart(64, "0")}`,
      })),
    ];
    const assetPages = [assets.slice(0, 13), assets.slice(13)];
    assert.equal(EXPECTED_RELEASE_ASSET_COUNT, 14 + RUNNER_TARGET_TRIPLES.length * 2 + RUNNER_TARGET_TRIPLES.length + 1 + 1);
    assert.equal(EXPECTED_RELEASE_ASSET_COUNT, 34);
    assert.equal(assets.length, EXPECTED_RELEASE_ASSET_COUNT);
    assert.doesNotThrow(() => verifyHostedRelease(assetPages, manifest));

    assert.throws(
      () => verifyHostedRelease([assets.slice(0, -1)], manifest),
      /expected exactly 34/,
    );
    const badManifestDigest = structuredClone(assetPages);
    badManifestDigest.flat().find((asset) => asset.name === "SHA256SUMS").digest = `sha256:${"f".repeat(64)}`;
    assert.throws(
      () => verifyHostedRelease(badManifestDigest, manifest),
      /SHA256SUMS publisher digest does not match/u,
    );
    const emptyManifest = structuredClone(assetPages);
    emptyManifest.flat().find((asset) => asset.name === "SHA256SUMS").size = 0;
    assert.throws(() => verifyHostedRelease(emptyManifest, manifest), /invalid size: SHA256SUMS/u);

    const divergentAssets = structuredClone(assetPages);
    const legacy = divergentAssets.flat().find((asset) => asset.name === "agent-manager-runner-aarch64-apple-darwin");
    legacy.digest = `sha256:${"f".repeat(64)}`;
    assert.throws(() => verifyHostedRelease(divergentAssets, manifest), /does not match SHA256SUMS/);

    const mismatchedManifest = manifest.replace(
      new RegExp(`^[a-f0-9]{64}  ${legacy.name}$`, "mu"),
      `${"f".repeat(64)}  ${legacy.name}`,
    );
    const mismatchedManifestAssets = structuredClone(divergentAssets);
    const checksumAsset = mismatchedManifestAssets.flat().find((asset) => asset.name === "SHA256SUMS");
    checksumAsset.size = Buffer.byteLength(mismatchedManifest);
    checksumAsset.digest = `sha256:${createHash("sha256").update(mismatchedManifest).digest("hex")}`;
    assert.throws(
      () => verifyHostedRelease(mismatchedManifestAssets, mismatchedManifest),
      /hosted runner alias digests differ/,
    );

    const assetsPath = join(root, "hosted-assets.json");
    const manifestPath = join(root, "SHA256SUMS");
    writeFileSync(assetsPath, JSON.stringify(assetPages));
    writeFileSync(manifestPath, manifest);
    const cli = fileURLToPath(new URL("./verify-runner-release-assets.mjs", import.meta.url));
    const cliResult = spawnSync(process.execPath, [
      cli,
      "release",
      "--assets-json",
      assetsPath,
      "--manifest",
      manifestPath,
    ], { encoding: "utf8" });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.match(cliResult.stdout, /verified exact 34-asset release inventory/u);
    const missingControlPlane = structuredClone(assetPages);
    const cpAsset = missingControlPlane.flat().find((asset) => asset.name === controlPlaneArtifactName("x86_64-unknown-linux-gnu"));
    cpAsset.digest = `sha256:${"e".repeat(64)}`;
    assert.throws(() => verifyHostedRelease(missingControlPlane, manifest), /does not match SHA256SUMS: wollipog-control-plane-x86_64-unknown-linux-gnu/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a release signed for updates must carry every package, signature, and the exact update manifest", async () => {
  const root = await fixture();
  try {
    const version = "0.28.0";
    const digests = await verifyLocalRunnerAssets(root);
    const manifest = checksumManifest(digests);
    const updateManifest = `${JSON.stringify({ version, platforms: {} })}\n`;
    const hosted = (name, bytes = name) => ({
      name,
      size: Buffer.byteLength(bytes),
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
    // The 14 desktop bundles are the 12 update packages plus the two disk images.
    const desktop = [
      ...desktopUpdaterArtifacts(version).map(({ asset }) => hosted(asset)),
      hosted(`Wollipog_${version}_aarch64.dmg`),
      hosted(`Wollipog_${version}_x64.dmg`),
    ];
    const assets = [
      ...expectedManifestAssetNames().map((name) => ({ name, size: 100, digest: `sha256:${digests.get(name)}` })),
      hosted("SHA256SUMS", manifest),
      ...desktop,
      ...updaterReleaseAssetNames(version).filter((name) => name !== "latest.json").map((name) => hosted(name)),
      hosted("latest.json", updateManifest),
    ];
    assert.equal(EXPECTED_UPDATER_ASSET_COUNT, 13);
    assert.equal(EXPECTED_SIGNED_RELEASE_ASSET_COUNT, 47);
    assert.equal(assets.length, EXPECTED_SIGNED_RELEASE_ASSET_COUNT);
    const updater = { manifestText: updateManifest, version };
    const pages = [assets.slice(0, 20), assets.slice(20)];
    assert.doesNotThrow(() => verifyHostedRelease(pages, manifest, EXPECTED_SIGNED_RELEASE_ASSET_COUNT, updater));

    // An unsigned inventory of the same size is not a signed release.
    const swapped = structuredClone(pages);
    swapped.flat().find((asset) => asset.name === "Wollipog_0.28.0_amd64.deb.sig").name = "unexpected.sig";
    assert.throws(
      () => verifyHostedRelease(swapped, manifest, EXPECTED_SIGNED_RELEASE_ASSET_COUNT, updater),
      /release is missing Wollipog_0\.28\.0_amd64\.deb\.sig/u,
    );
    const missingPackage = structuredClone(pages);
    missingPackage.flat().find((asset) => asset.name === "Wollipog_x64.app.tar.gz").name = "Wollipog_x64.app.zip";
    assert.throws(
      () => verifyHostedRelease(missingPackage, manifest, EXPECTED_SIGNED_RELEASE_ASSET_COUNT, updater),
      /release is missing Wollipog_x64\.app\.tar\.gz/u,
    );
    const replacedManifest = structuredClone(pages);
    replacedManifest.flat().find((asset) => asset.name === "latest.json").digest = `sha256:${"a".repeat(64)}`;
    assert.throws(
      () => verifyHostedRelease(replacedManifest, manifest, EXPECTED_SIGNED_RELEASE_ASSET_COUNT, updater),
      /latest\.json publisher digest does not match the verified update manifest/u,
    );
    assert.throws(
      () => verifyHostedRelease(pages, manifest, EXPECTED_SIGNED_RELEASE_ASSET_COUNT, { ...updater, version: "0.28.1" }),
      /release is missing/u,
    );
    // A signed release checked as an unsigned one fails on its count, never silently passes.
    assert.throws(() => verifyHostedRelease(pages, manifest), /expected exactly 34/u);

    const assetsPath = join(root, "hosted-assets.json");
    const manifestPath = join(root, "SHA256SUMS");
    const updatePath = join(root, "latest.json");
    writeFileSync(assetsPath, JSON.stringify(pages));
    writeFileSync(manifestPath, manifest);
    writeFileSync(updatePath, updateManifest);
    const cli = fileURLToPath(new URL("./verify-runner-release-assets.mjs", import.meta.url));
    const cliResult = spawnSync(process.execPath, [
      cli, "release", "--assets-json", assetsPath, "--manifest", manifestPath,
      "--update-manifest", updatePath, "--desktop-version", version,
    ], { encoding: "utf8" });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.match(cliResult.stdout, /verified exact 47-asset release inventory.*and the 13 update assets/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the release verifier fails closed when invoked through a symlinked repository root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-release-verifier-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const linkedRoot = join(root, "repository-link");
  symlinkSync(repositoryRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const linkedCli = join(linkedRoot, "scripts", "verify-runner-release-assets.mjs");
  const result = spawnSync(process.execPath, [linkedCli, "local"], { encoding: "utf8" });
  assert.equal(result.status, 1, "a skipped direct entry would incorrectly exit zero");
  assert.match(result.stderr, /missing --assets-dir/u);
});
