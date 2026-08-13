import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function recordsFromSlurpedPages(value, label) {
  if (!Array.isArray(value))
    throw new Error(`${label} metadata must be a JSON array`);
  const pages = value.every(Array.isArray) ? value : [value];
  const records = pages.flat();
  if (
    records.some(
      (record) =>
        !record || typeof record !== "object" || Array.isArray(record),
    )
  ) {
    throw new Error(`${label} metadata contains a non-object record`);
  }
  return records;
}

export function resolveDraftReleaseId(value, releaseTag) {
  if (typeof releaseTag !== "string" || releaseTag.length === 0) {
    throw new Error("release tag is required");
  }
  const matches = recordsFromSlurpedPages(value, "release").filter(
    (release) => release.tag_name === releaseTag && release.draft === true,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one draft release for ${releaseTag}, found ${matches.length}`,
    );
  }
  const id = matches[0].id;
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error(`draft release ${releaseTag} has an invalid id`);
  return String(id);
}

export function resolveAssetDigest(value, assetName) {
  if (typeof assetName !== "string" || assetName.length === 0) {
    throw new Error("asset name is required");
  }
  const matches = recordsFromSlurpedPages(value, "asset").filter(
    (asset) => asset.name === assetName,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${assetName} asset, found ${matches.length}`,
    );
  }
  if (typeof matches[0].digest !== "string")
    throw new Error(`${assetName} has no REST digest`);
  return matches[0].digest;
}

function parseStdin() {
  const input = readFileSync(0, "utf8");
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("GitHub REST metadata was not valid JSON");
  }
}

function main() {
  const [command, value] = process.argv.slice(2);
  const metadata = parseStdin();
  if (command === "draft-release-id")
    return resolveDraftReleaseId(metadata, value);
  if (command === "asset-digest") return resolveAssetDigest(metadata, value);
  throw new Error(
    "usage: release-asset-metadata.mjs <draft-release-id|asset-digest> <value>",
  );
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
  try {
    process.stdout.write(main());
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
