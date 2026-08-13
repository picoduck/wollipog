import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runnerArtifactNames, RUNNER_TARGET_TRIPLES } from "../apps/runner/scripts/runner-artifacts.mjs";
import {
  checksumManifest,
  EXPECTED_RELEASE_ASSET_COUNT,
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
  }
  return root;
}

test("local runner verification emits a complete deterministic SHA256SUMS manifest", async () => {
  const root = await fixture();
  try {
    const digests = await verifyLocalRunnerAssets(root);
    const manifest = checksumManifest(digests);
    assert.equal(manifest.trimEnd().split("\n").length, 12);
    assert.deepEqual(manifest.trimEnd().split("\n").map((line) => line.slice(66)), expectedRunnerAssetNames());
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted verification enforces the exact release count, manifest, and six remote digest pairs", async () => {
  const root = await fixture();
  try {
    const digests = await verifyLocalRunnerAssets(root);
    const manifest = checksumManifest(digests);
    const runners = expectedRunnerAssetNames().map((name) => ({
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
    assert.equal(EXPECTED_RELEASE_ASSET_COUNT, 14 + RUNNER_TARGET_TRIPLES.length * 2 + 1);
    assert.equal(EXPECTED_RELEASE_ASSET_COUNT, 27);
    assert.equal(assets.length, EXPECTED_RELEASE_ASSET_COUNT);
    assert.doesNotThrow(() => verifyHostedRelease(assetPages, manifest));

    assert.throws(
      () => verifyHostedRelease([assets.slice(0, -1)], manifest),
      /expected exactly 27/,
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
    assert.match(cliResult.stdout, /verified exact 27-asset release inventory/u);
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
