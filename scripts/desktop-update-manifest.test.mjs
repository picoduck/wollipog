import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildUpdateManifest,
  desktopUpdaterArtifacts,
  parseUpdaterPublicKey,
  UPDATE_MANIFEST_NAME,
  updaterReleaseAssetNames,
  verifiedUpdateManifest,
} from "./desktop-update-manifest.mjs";

const VERSION = "0.28.0";
const REPO = "picoduck/wollipog";
const TAG = "v0.28.0";

/**
 * A minisign key pair, encoded the way `tauri signer generate` and the bundler encode them, so the
 * verifier is tested against the real format rather than against its own parser's idea of it.
 */
function updateKey(keyId = Buffer.from("0102030405060708", "hex")) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const text = `untrusted comment: minisign public key: ${Buffer.from(keyId).reverse().toString("hex").toUpperCase()}\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
  return { publicKeyValue: Buffer.from(text).toString("base64"), privateKey, keyId };
}

function signPackage(bytes, { privateKey, keyId }, trustedComment, { prehashed = true } = {}) {
  const message = prehashed ? createHash("blake2b512").update(bytes).digest() : bytes;
  const signature = sign(null, message, privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), privateKey);
  const text = [
    "untrusted comment: signature from tauri secret key",
    Buffer.concat([Buffer.from(prehashed ? "ED" : "Ed"), keyId, signature]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    global.toString("base64"),
    "",
  ].join("\n");
  return Buffer.from(text).toString("base64");
}

function trusted(asset, version = VERSION) {
  return `timestamp:1790000000\tfile:${asset}\tversion:${version}`;
}

function fixture(key, { override } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-update-manifest-"));
  for (const { asset, signedAs } of desktopUpdaterArtifacts(VERSION)) {
    const bytes = Buffer.from(`update package ${asset}`);
    writeFileSync(join(root, asset), bytes);
    const signature = override?.(asset, bytes) ?? signPackage(bytes, key, trusted(signedAs));
    writeFileSync(join(root, `${asset}.sig`), signature);
  }
  return root;
}

async function manifestFor(root, publicKeyValue) {
  return verifiedUpdateManifest({
    assetsDir: root,
    publicKeyValue,
    version: VERSION,
    repo: REPO,
    tag: TAG,
    pubDate: "2026-09-23T00:00:00.000Z",
  });
}

test("every platform the updater looks up resolves to one signed package of this release", async () => {
  const key = updateKey();
  const root = fixture(key);
  try {
    const manifest = JSON.parse(await manifestFor(root, key.publicKeyValue));
    assert.equal(manifest.version, VERSION);
    const keys = Object.keys(manifest.platforms);
    // `<os>-<arch>` for the six native targets, plus the installer-qualified keys the app prefers.
    for (const os of ["darwin", "windows", "linux"]) {
      for (const arch of ["x86_64", "aarch64"]) assert.ok(keys.includes(`${os}-${arch}`), `${os}-${arch}`);
    }
    for (const key of ["darwin-aarch64-app", "windows-x86_64-msi", "windows-aarch64-nsis", "linux-x86_64-appimage", "linux-aarch64-deb", "linux-x86_64-rpm"]) {
      assert.ok(keys.includes(key), key);
    }
    assert.equal(keys.length, 18);
    assert.equal(
      manifest.platforms["windows-x86_64-nsis"].url,
      "https://github.com/picoduck/wollipog/releases/download/v0.28.0/Wollipog_0.28.0_x64-setup.exe",
    );
    // The one-line installers' formats are the fallbacks.
    assert.equal(manifest.platforms["linux-x86_64"].url, manifest.platforms["linux-x86_64-appimage"].url);
    assert.equal(manifest.platforms["windows-aarch64"].url, manifest.platforms["windows-aarch64-nsis"].url);
    for (const { signature, url } of Object.values(manifest.platforms)) {
      const asset = decodeURIComponent(url.split("/").pop());
      assert.equal(signature, readFileSync(join(root, `${asset}.sig`), "utf8"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the release adds exactly one signature per package and the manifest", () => {
  const names = updaterReleaseAssetNames(VERSION);
  assert.equal(names.length, 13);
  assert.ok(names.includes(UPDATE_MANIFEST_NAME));
  assert.ok(names.includes("Wollipog_aarch64.app.tar.gz.sig"));
  assert.ok(names.includes("Wollipog-0.28.0-1.aarch64.rpm.sig"));
  assert.throws(() => desktopUpdaterArtifacts("v0.28.0"), /invalid desktop version/u);
});

test("a package signed by another key, or not matching its signature, fails the release", async () => {
  const key = updateKey();
  const other = updateKey(Buffer.from("1112131415161718", "hex"));
  const target = "Wollipog_0.28.0_amd64.AppImage";

  let root = fixture(key, { override: (asset, bytes) => (asset === target ? signPackage(bytes, other, trusted(asset)) : undefined) });
  try {
    await assert.rejects(manifestFor(root, key.publicKeyValue), /Wollipog_0\.28\.0_amd64\.AppImage is signed by key 1817161514131211/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Same key id, different private key: exactly what a mismatched secret produces.
  const impostor = { ...updateKey(), keyId: key.keyId };
  root = fixture(key, { override: (asset, bytes) => (asset === target ? signPackage(bytes, impostor, trusted(asset)) : undefined) });
  try {
    await assert.rejects(manifestFor(root, key.publicKeyValue), /does not match its update signature/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  root = fixture(key);
  try {
    writeFileSync(join(root, target), "tampered after signing");
    await assert.rejects(manifestFor(root, key.publicKeyValue), /does not match its update signature/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the signed file name and version must be this release's", async () => {
  const key = updateKey();
  const target = "Wollipog_0.28.0_x64_en-US.msi";
  const cases = [
    [trusted("Wollipog_0.28.0_arm64_en-US.msi"), /was signed as Wollipog_0\.28\.0_arm64_en-US\.msi/u],
    [trusted(target, "0.27.0"), /signed for version 0\.27\.0, not 0\.28\.0/u],
    // A CLI older than 2.11.5 records no version; the app would refuse it with requireSignedVersion.
    [`timestamp:1790000000\tfile:${target}`, /signed for version \(none\)/u],
  ];
  for (const [comment, expected] of cases) {
    const root = fixture(key, { override: (asset, bytes) => (asset === target ? signPackage(bytes, key, comment) : undefined) });
    try {
      await assert.rejects(manifestFor(root, key.publicKeyValue), expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the macOS archives are checked against the name the bundler signed, not the uploaded name", async () => {
  // tauri-action uploads `Wollipog.app.tar.gz` as `Wollipog_<arch>.app.tar.gz`; the signature was
  // made before that rename. Requiring the uploaded name failed every real release.
  const mac = desktopUpdaterArtifacts(VERSION).filter(({ keys }) => keys[0].startsWith("darwin-"));
  assert.deepEqual(mac.map(({ signedAs }) => signedAs), ["Wollipog.app.tar.gz", "Wollipog.app.tar.gz"]);
  assert.ok(desktopUpdaterArtifacts(VERSION).filter(({ keys }) => !keys[0].startsWith("darwin-")).every(({ asset, signedAs }) => asset === signedAs));

  const key = updateKey();
  const target = "Wollipog_aarch64.app.tar.gz";
  const root = fixture(key, { override: (asset, bytes) => (asset === target ? signPackage(bytes, key, trusted(target)) : undefined) });
  try {
    await assert.rejects(manifestFor(root, key.publicKeyValue), /Wollipog_aarch64\.app\.tar\.gz was signed as Wollipog_aarch64\.app\.tar\.gz/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trusted comment edited after signing is rejected", async () => {
  const key = updateKey();
  const target = "Wollipog_x64.app.tar.gz";
  const root = fixture(key, {
    override: (asset, bytes) => {
      if (asset !== target) return undefined;
      const lines = Buffer.from(signPackage(bytes, key, trusted("Wollipog.app.tar.gz", "0.27.0")), "base64").toString("utf8").split("\n");
      lines[2] = `trusted comment: ${trusted("Wollipog.app.tar.gz")}`;
      return Buffer.from(lines.join("\n")).toString("base64");
    },
  });
  try {
    await assert.rejects(manifestFor(root, key.publicKeyValue), /invalid trusted-comment signature/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy (non-prehashed) signatures verify too", async () => {
  const key = updateKey();
  const signedAs = new Map(desktopUpdaterArtifacts(VERSION).map((entry) => [entry.asset, entry.signedAs]));
  const root = fixture(key, { override: (asset, bytes) => signPackage(bytes, key, trusted(signedAs.get(asset)), { prehashed: false }) });
  try {
    assert.equal(JSON.parse(await manifestFor(root, key.publicKeyValue)).version, VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing or empty package or signature fails before any manifest exists", async () => {
  const key = updateKey();
  for (const name of ["Wollipog_0.28.0_arm64-setup.exe", "Wollipog_0.28.0_arm64-setup.exe.sig"]) {
    const root = fixture(key);
    try {
      rmSync(join(root, name));
      await assert.rejects(manifestFor(root, key.publicKeyValue), new RegExp(`release is missing ${name.replaceAll(".", "\\.")}`, "u"));
      writeFileSync(join(root, name), "");
      await assert.rejects(manifestFor(root, key.publicKeyValue), /release asset is empty/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.throws(
    () => buildUpdateManifest({ version: VERSION, repo: REPO, tag: TAG, pubDate: "x", signatures: new Map() }),
    /missing signature for Wollipog_aarch64\.app\.tar\.gz/u,
  );
});

test("the public key check accepts a Tauri key and rejects anything else", () => {
  const key = updateKey();
  assert.equal(parseUpdaterPublicKey(key.publicKeyValue).keyIdHex, "0807060504030201");
  assert.throws(() => parseUpdaterPublicKey(""), /not a base64-encoded minisign public key/u);
  assert.throws(() => parseUpdaterPublicKey(Buffer.from("untrusted comment: x\nAAAA\n").toString("base64")), /public key is malformed/u);

  const script = fileURLToPath(new URL("./desktop-update-manifest.mjs", import.meta.url));
  const ok = spawnSync(process.execPath, [script, "check-public-key"], {
    env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: key.publicKeyValue },
    encoding: "utf8",
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /update public key 0807060504030201/u);
  const bad = spawnSync(process.execPath, [script, "check-public-key"], {
    env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: "not a key" },
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
});

test("the build command writes the verified manifest", () => {
  const key = updateKey();
  const root = fixture(key);
  try {
    const output = join(root, UPDATE_MANIFEST_NAME);
    const script = fileURLToPath(new URL("./desktop-update-manifest.mjs", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [script, "build", "--assets-dir", root, "--version", VERSION, "--repo", REPO, "--tag", TAG, "--output", output],
      { env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: key.publicKeyValue }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified 12 update packages/u);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).platforms["darwin-x86_64"].url.endsWith("/Wollipog_x64.app.tar.gz"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
