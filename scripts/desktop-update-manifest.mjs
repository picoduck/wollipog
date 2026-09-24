import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The desktop updater's release side (#1646).
 *
 * `tauri-action` can write `latest.json` itself, but it does so by read-modify-writing one release
 * asset from each of the six parallel matrix legs, so concurrent legs drop each other's platforms.
 * The final verification job builds it here instead, once, after every leg has uploaded — and only
 * after checking every package against the update public key, because the bundler treats a
 * signature from the wrong key as a warning.
 */

export const UPDATE_MANIFEST_NAME = "latest.json";
const PRODUCT = "Wollipog";

/**
 * Every updater package a release publishes, and the manifest keys that select it.
 *
 * The app looks up `<os>-<arch>-<installer>` first, from the bundle type the bundler patched into
 * its binary, and falls back to `<os>-<arch>`. The fallback points at the package each platform's
 * one-line installer uses, so a build with no recorded bundle type still learns a release exists.
 * `.deb` and `.rpm` are listed because they are signed and published, but the app never installs
 * them in place; it points those users at the release page.
 */
export function desktopUpdaterArtifacts(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`invalid desktop version: ${version}`);
  }
  return [
    { asset: `${PRODUCT}_aarch64.app.tar.gz`, keys: ["darwin-aarch64", "darwin-aarch64-app"] },
    { asset: `${PRODUCT}_x64.app.tar.gz`, keys: ["darwin-x86_64", "darwin-x86_64-app"] },
    { asset: `${PRODUCT}_${version}_x64-setup.exe`, keys: ["windows-x86_64", "windows-x86_64-nsis"] },
    { asset: `${PRODUCT}_${version}_x64_en-US.msi`, keys: ["windows-x86_64-msi"] },
    { asset: `${PRODUCT}_${version}_arm64-setup.exe`, keys: ["windows-aarch64", "windows-aarch64-nsis"] },
    { asset: `${PRODUCT}_${version}_arm64_en-US.msi`, keys: ["windows-aarch64-msi"] },
    { asset: `${PRODUCT}_${version}_amd64.AppImage`, keys: ["linux-x86_64", "linux-x86_64-appimage"] },
    { asset: `${PRODUCT}_${version}_amd64.deb`, keys: ["linux-x86_64-deb"] },
    { asset: `${PRODUCT}-${version}-1.x86_64.rpm`, keys: ["linux-x86_64-rpm"] },
    { asset: `${PRODUCT}_${version}_aarch64.AppImage`, keys: ["linux-aarch64", "linux-aarch64-appimage"] },
    { asset: `${PRODUCT}_${version}_arm64.deb`, keys: ["linux-aarch64-deb"] },
    { asset: `${PRODUCT}-${version}-1.aarch64.rpm`, keys: ["linux-aarch64-rpm"] },
  ];
}

/** The release assets the updater adds: each package's `.sig` and the manifest. */
export function updaterReleaseAssetNames(version) {
  return [
    ...desktopUpdaterArtifacts(version).map(({ asset }) => `${asset}.sig`),
    UPDATE_MANIFEST_NAME,
  ].sort();
}

/** Minisign's two-line text boxes arrive base64-encoded once more in Tauri's config and `.sig` files. */
function decodeBox(value, label) {
  const text = Buffer.from(String(value).trim(), "base64").toString("utf8");
  const lines = text.split(/\r?\n/u);
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment: ")) {
    throw new Error(`${label} is not a base64-encoded minisign ${label}`);
  }
  return lines;
}

function strictBase64(value, length, label) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value) {
    throw new Error(`${label} is malformed`);
  }
  return bytes;
}

/** Parse the value of `plugins.updater.pubkey`. */
export function parseUpdaterPublicKey(value) {
  const [, keyLine] = decodeBox(value, "public key");
  const bytes = strictBase64(keyLine.trim(), 42, "public key");
  if (bytes.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("public key is not an Ed25519 minisign key");
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes.subarray(10)]);
  return {
    keyId: bytes.subarray(2, 10),
    keyIdHex: Buffer.from(bytes.subarray(2, 10)).reverse().toString("hex").toUpperCase(),
    key: createPublicKey({ key: der, format: "der", type: "spki" }),
  };
}

/** Parse a `.sig` file as Tauri writes it. */
export function parseUpdaterSignature(value) {
  const lines = decodeBox(value, "signature");
  if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("signature has no trusted comment");
  }
  const signature = strictBase64(lines[1].trim(), 74, "signature");
  const algorithm = signature.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error(`unsupported signature algorithm ${algorithm}`);
  const trustedComment = lines[2].slice("trusted comment: ".length);
  const fields = new Map();
  for (const field of trustedComment.split("\t")) {
    const colon = field.indexOf(":");
    if (colon > 0) fields.set(field.slice(0, colon), field.slice(colon + 1));
  }
  return {
    prehashed: algorithm === "ED",
    keyId: signature.subarray(2, 10),
    signature: signature.subarray(10),
    trustedComment,
    globalSignature: strictBase64(lines[3].trim(), 64, "global signature"),
    fields,
  };
}

async function blake2b512File(path) {
  const hash = createHash("blake2b512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest();
}

/**
 * Verify one package exactly as the app will, and then some.
 *
 * The app checks the key, the signature, the global signature over the trusted comment, and that
 * the signed version equals the announced one. The release also requires the signed file name to
 * be the published asset name, so a package cannot be published under another package's name.
 */
export async function verifyUpdaterPackage({ path, signatureText, publicKey, asset, version }) {
  const parsed = parseUpdaterSignature(signatureText);
  if (!parsed.keyId.equals(publicKey.keyId)) {
    throw new Error(`${asset} is signed by key ${Buffer.from(parsed.keyId).reverse().toString("hex").toUpperCase()}, not the update key ${publicKey.keyIdHex}`);
  }
  const message = parsed.prehashed ? await blake2b512File(path) : readFileSync(path);
  if (!verify(null, message, publicKey.key, parsed.signature)) {
    throw new Error(`${asset} does not match its update signature`);
  }
  const global = Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, "utf8")]);
  if (!verify(null, global, publicKey.key, parsed.globalSignature)) {
    throw new Error(`${asset} has an invalid trusted-comment signature`);
  }
  if (parsed.fields.get("file") !== asset) {
    throw new Error(`${asset} was signed as ${parsed.fields.get("file") ?? "an unnamed file"}`);
  }
  if (parsed.fields.get("version") !== version) {
    throw new Error(`${asset} was signed for version ${parsed.fields.get("version") ?? "(none)"}, not ${version}`);
  }
}

export function releaseAssetUrl(repo, tag, asset) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

export function buildUpdateManifest({ version, repo, tag, pubDate, signatures }) {
  const platforms = {};
  for (const { asset, keys } of desktopUpdaterArtifacts(version)) {
    const signature = signatures.get(asset);
    if (typeof signature !== "string" || signature.trim() === "") throw new Error(`missing signature for ${asset}`);
    for (const key of keys) {
      platforms[key] = { signature: signature.trim(), url: releaseAssetUrl(repo, tag, asset) };
    }
  }
  return {
    version,
    notes: `https://github.com/${repo}/releases/tag/${tag}`,
    pub_date: pubDate,
    platforms: Object.fromEntries(Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Verify every downloaded package and signature, then return the manifest text. */
export async function verifiedUpdateManifest({ assetsDir, publicKeyValue, version, repo, tag, pubDate }) {
  const publicKey = parseUpdaterPublicKey(publicKeyValue);
  const signatures = new Map();
  for (const { asset } of desktopUpdaterArtifacts(version)) {
    const path = join(assetsDir, asset);
    const signaturePath = `${path}.sig`;
    for (const required of [path, signaturePath]) {
      let size = 0;
      try {
        size = statSync(required).size;
      } catch {
        throw new Error(`release is missing ${required.slice(assetsDir.length + 1)}`);
      }
      if (size === 0) throw new Error(`release asset is empty: ${required.slice(assetsDir.length + 1)}`);
    }
    const signatureText = readFileSync(signaturePath, "utf8");
    await verifyUpdaterPackage({ path, signatureText, publicKey, asset, version });
    signatures.set(asset, signatureText);
  }
  return `${JSON.stringify(buildUpdateManifest({ version, repo, tag, pubDate, signatures }), null, 2)}\n`;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

async function main(args) {
  const command = args[0];
  if (command === "check-public-key") {
    // Read from the environment so the value never appears on a command line.
    const { keyIdHex } = parseUpdaterPublicKey(process.env.TAURI_UPDATER_PUBLIC_KEY ?? "");
    console.log(`update public key ${keyIdHex}`);
    return;
  }
  if (command === "build") {
    const output = option(args, "--output");
    const version = option(args, "--version");
    const text = await verifiedUpdateManifest({
      assetsDir: option(args, "--assets-dir"),
      publicKeyValue: process.env.TAURI_UPDATER_PUBLIC_KEY ?? "",
      version,
      repo: option(args, "--repo"),
      tag: option(args, "--tag"),
      pubDate: new Date().toISOString(),
    });
    writeFileSync(output, text);
    console.log(`verified ${desktopUpdaterArtifacts(version).length} update packages against the update key and wrote ${UPDATE_MANIFEST_NAME}`);
    return;
  }
  throw new Error("usage: desktop-update-manifest.mjs <check-public-key|build> [options]");
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
