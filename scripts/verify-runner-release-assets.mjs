import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  headlessArtifactNames,
  runnerArtifactNames,
  RUNNER_TARGET_TRIPLES,
} from "../apps/runner/scripts/runner-artifacts.mjs";
import {
  desktopUpdaterArtifacts,
  UPDATE_MANIFEST_NAME,
  updaterReleaseAssetNames,
} from "./desktop-update-manifest.mjs";

export const EXPECTED_DESKTOP_RELEASE_ASSET_COUNT = 14;
/** Desktop bundles + 12 runner names + 6 headless control planes + the web bundle + SHA256SUMS. */
export const EXPECTED_RELEASE_ASSET_COUNT =
  EXPECTED_DESKTOP_RELEASE_ASSET_COUNT + RUNNER_TARGET_TRIPLES.length * 2 + headlessArtifactNames().length + 1;
/** A release signed for in-place updates adds one `.sig` per update package plus `latest.json`. */
export const EXPECTED_UPDATER_ASSET_COUNT = updaterReleaseAssetNames("0.0.0").length;
export const EXPECTED_SIGNED_RELEASE_ASSET_COUNT = EXPECTED_RELEASE_ASSET_COUNT + EXPECTED_UPDATER_ASSET_COUNT;

export function expectedRunnerAssetNames() {
  return RUNNER_TARGET_TRIPLES.flatMap((triple) => Object.values(runnerArtifactNames(triple))).sort();
}

/** Every asset the checksum manifest covers: runner pairs plus the headless assets. */
export function expectedManifestAssetNames() {
  return [...expectedRunnerAssetNames(), ...headlessArtifactNames()].sort();
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assertExactNames(actual, expected, label) {
  const normalized = [...actual].sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate names`);
  }
  const missing = expected.filter((name) => !normalized.includes(name));
  const extra = normalized.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    throw new Error(`${label} mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`);
  }
}

/** Verify the downloaded release bytes (runner pairs and headless assets) before publishing their
 * checksum manifest. */
export async function verifyLocalRunnerAssets(assetsDir) {
  const expected = expectedManifestAssetNames();
  const actual = readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assertExactNames(actual, expected, "downloaded release assets");

  const digests = new Map();
  for (const name of expected) {
    const path = join(assetsDir, name);
    if (statSync(path).size === 0) throw new Error(`release asset is empty: ${name}`);
    digests.set(name, await sha256File(path));
  }
  for (const triple of RUNNER_TARGET_TRIPLES) {
    const { canonical, legacy } = runnerArtifactNames(triple);
    if (digests.get(canonical) !== digests.get(legacy)) {
      throw new Error(`runner aliases differ for ${triple}`);
    }
  }
  return digests;
}

export function checksumManifest(digests) {
  const expected = expectedManifestAssetNames();
  assertExactNames([...digests.keys()], expected, "checksum entries");
  return `${expected.map((name) => `${digests.get(name)}  ${name}`).join("\n")}\n`;
}

export function parseChecksumManifest(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    if (entries.has(match[2])) throw new Error(`duplicate SHA256SUMS entry: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  assertExactNames([...entries.keys()], expectedManifestAssetNames(), "SHA256SUMS");
  return entries;
}

function assetsFromPaginatedList(value) {
  if (!Array.isArray(value) || !value.every(Array.isArray)) {
    throw new Error("release asset metadata must be a paginated JSON array");
  }
  const assets = value.flat();
  if (assets.some((asset) => !asset || typeof asset !== "object" || Array.isArray(asset))) {
    throw new Error("release asset metadata contains a non-object record");
  }
  return assets;
}

function verifiedPublisherDigest(asset, name) {
  if (!Number.isSafeInteger(asset?.size) || asset.size <= 0) {
    throw new Error(`release asset has invalid size: ${name}`);
  }
  const match = /^sha256:([a-f0-9]{64})$/u.exec(String(asset?.digest ?? ""));
  if (!match) throw new Error(`release asset has no valid SHA-256 digest: ${name}`);
  return match[1];
}

/** Final hosted gate: consume GitHub's exact paginated asset endpoint, prove the complete inventory,
 * and bind every runner alias plus the uploaded manifest to its publisher-recorded digest.
 *
 * `updater`, when the release was signed for in-place updates, is the verified `latest.json` text
 * and the desktop version it announces. Every update package, its `.sig`, and the manifest must then
 * be present, and the hosted manifest must be the exact bytes the verification job produced. */
export function verifyHostedRelease(assetPages, manifestText, expectedTotal = EXPECTED_RELEASE_ASSET_COUNT, updater = null) {
  const assets = assetsFromPaginatedList(assetPages);
  if (assets.length !== expectedTotal) {
    throw new Error(`release has ${assets.length} assets; expected exactly ${expectedTotal}`);
  }
  const names = assets.map((asset) => String(asset?.name ?? ""));
  if (new Set(names).size !== names.length) throw new Error("release contains duplicate asset names");
  const expectedManifest = expectedManifestAssetNames();
  for (const name of [...expectedManifest, "SHA256SUMS"]) {
    if (!names.includes(name)) throw new Error(`release is missing ${name}`);
  }

  const manifest = parseChecksumManifest(manifestText);
  const manifestAsset = assets.find((candidate) => candidate.name === "SHA256SUMS");
  const hostedManifestDigest = verifiedPublisherDigest(manifestAsset, "SHA256SUMS");
  const localManifestDigest = createHash("sha256").update(manifestText).digest("hex");
  if (hostedManifestDigest !== localManifestDigest) {
    throw new Error("SHA256SUMS publisher digest does not match the local manifest");
  }
  const remoteDigests = new Map();
  for (const name of expectedManifest) {
    const remoteDigest = verifiedPublisherDigest(
      assets.find((candidate) => candidate.name === name),
      name,
    );
    if (manifest.get(name) !== remoteDigest) throw new Error(`release digest does not match SHA256SUMS: ${name}`);
    remoteDigests.set(name, remoteDigest);
  }
  for (const triple of RUNNER_TARGET_TRIPLES) {
    const { canonical, legacy } = runnerArtifactNames(triple);
    if (remoteDigests.get(canonical) !== remoteDigests.get(legacy)) {
      throw new Error(`hosted runner alias digests differ for ${triple}`);
    }
  }
  if (updater) verifyHostedUpdater(assets, names, updater);
}

function verifyHostedUpdater(assets, names, { manifestText, version }) {
  const required = [
    ...desktopUpdaterArtifacts(version).map(({ asset }) => asset),
    ...updaterReleaseAssetNames(version),
  ];
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`release is missing ${name}`);
    verifiedPublisherDigest(assets.find((candidate) => candidate.name === name), name);
  }
  const hosted = verifiedPublisherDigest(
    assets.find((candidate) => candidate.name === UPDATE_MANIFEST_NAME),
    UPDATE_MANIFEST_NAME,
  );
  if (hosted !== createHash("sha256").update(manifestText).digest("hex")) {
    throw new Error(`${UPDATE_MANIFEST_NAME} publisher digest does not match the verified update manifest`);
  }
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error(`${UPDATE_MANIFEST_NAME} is not valid JSON`);
  }
  if (parsed?.version !== version) {
    throw new Error(`${UPDATE_MANIFEST_NAME} announces ${parsed?.version}, not ${version}`);
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

async function main(args) {
  const command = args[0];
  if (command === "local") {
    const assetsDir = option(args, "--assets-dir");
    const manifestPath = option(args, "--manifest");
    const digests = await verifyLocalRunnerAssets(assetsDir);
    writeFileSync(manifestPath, checksumManifest(digests));
    console.log(`verified ${digests.size} local release assets and wrote ${basename(manifestPath)}`);
    return;
  }
  if (command === "release") {
    const assetsPath = option(args, "--assets-json");
    const manifestPath = option(args, "--manifest");
    const updater = args.includes("--update-manifest")
      ? {
          manifestText: readFileSync(option(args, "--update-manifest"), "utf8"),
          version: option(args, "--desktop-version"),
        }
      : null;
    const expectedTotal = updater ? EXPECTED_SIGNED_RELEASE_ASSET_COUNT : EXPECTED_RELEASE_ASSET_COUNT;
    verifyHostedRelease(
      JSON.parse(readFileSync(assetsPath, "utf8")),
      readFileSync(manifestPath, "utf8"),
      expectedTotal,
      updater,
    );
    console.log(
      `verified exact ${expectedTotal}-asset release inventory, six runner digest pairs, and the headless assets${updater ? `, and the ${EXPECTED_UPDATER_ASSET_COUNT} update assets` : ""}`,
    );
    return;
  }
  throw new Error("usage: verify-runner-release-assets.mjs <local|release> [options]");
}

function isDirectEntry(argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
