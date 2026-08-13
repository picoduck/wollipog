import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runnerArtifactNames,
  RUNNER_TARGET_TRIPLES,
} from "../apps/runner/scripts/runner-artifacts.mjs";

export const EXPECTED_DESKTOP_RELEASE_ASSET_COUNT = 14;
export const EXPECTED_RELEASE_ASSET_COUNT =
  EXPECTED_DESKTOP_RELEASE_ASSET_COUNT + RUNNER_TARGET_TRIPLES.length * 2 + 1;

export function expectedRunnerAssetNames() {
  return RUNNER_TARGET_TRIPLES.flatMap((triple) => Object.values(runnerArtifactNames(triple))).sort();
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

/** Verify the downloaded release bytes before publishing their checksum manifest. */
export async function verifyLocalRunnerAssets(assetsDir) {
  const expected = expectedRunnerAssetNames();
  const actual = readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assertExactNames(actual, expected, "downloaded runner assets");

  const digests = new Map();
  for (const name of expected) {
    const path = join(assetsDir, name);
    if (statSync(path).size === 0) throw new Error(`runner asset is empty: ${name}`);
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
  const expected = expectedRunnerAssetNames();
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
  assertExactNames([...entries.keys()], expectedRunnerAssetNames(), "SHA256SUMS");
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
 * and bind every runner alias plus the uploaded manifest to its publisher-recorded digest. */
export function verifyHostedRelease(assetPages, manifestText, expectedTotal = EXPECTED_RELEASE_ASSET_COUNT) {
  const assets = assetsFromPaginatedList(assetPages);
  if (assets.length !== expectedTotal) {
    throw new Error(`release has ${assets.length} assets; expected exactly ${expectedTotal}`);
  }
  const names = assets.map((asset) => String(asset?.name ?? ""));
  if (new Set(names).size !== names.length) throw new Error("release contains duplicate asset names");
  const expectedRunners = expectedRunnerAssetNames();
  for (const name of [...expectedRunners, "SHA256SUMS"]) {
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
  for (const name of expectedRunners) {
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
    console.log(`verified 12 local runner assets and wrote ${basename(manifestPath)}`);
    return;
  }
  if (command === "release") {
    const assetsPath = option(args, "--assets-json");
    const manifestPath = option(args, "--manifest");
    const expectedTotal = EXPECTED_RELEASE_ASSET_COUNT;
    verifyHostedRelease(
      JSON.parse(readFileSync(assetsPath, "utf8")),
      readFileSync(manifestPath, "utf8"),
      expectedTotal,
    );
    console.log(`verified exact ${expectedTotal}-asset release inventory and six runner digest pairs`);
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
