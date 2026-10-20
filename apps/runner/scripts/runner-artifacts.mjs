import { chmodSync, closeSync, constants, copyFileSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, statSync, writeSync } from "node:fs";
import { helperAssociationName, helperDigest, helperReleaseAssetName, readHelperFile, validateHelperTuple } from "../../../scripts/lease-helper-distribution.mjs";

export const RUNNER_TARGET_TRIPLES = Object.freeze([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "aarch64-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
]);

const RUNNER_TARGET_HOSTS = Object.freeze({
  "aarch64-apple-darwin": Object.freeze({ platform: "darwin", arch: "arm64" }),
  "x86_64-apple-darwin": Object.freeze({ platform: "darwin", arch: "x64" }),
  "aarch64-unknown-linux-gnu": Object.freeze({ platform: "linux", arch: "arm64" }),
  "x86_64-unknown-linux-gnu": Object.freeze({ platform: "linux", arch: "x64" }),
  "aarch64-pc-windows-msvc": Object.freeze({ platform: "win32", arch: "arm64" }),
  "x86_64-pc-windows-msvc": Object.freeze({ platform: "win32", arch: "x64" }),
});

/** Release names are derived from the target, not the build host, so tests and final verification
 * use exactly the same Windows suffix rule as the native matrix producer. */
export function runnerArtifactNames(triple) {
  if (!RUNNER_TARGET_TRIPLES.includes(triple)) {
    throw new Error(`unsupported runner target triple: ${triple}`);
  }
  const executable = triple.endsWith("-pc-windows-msvc") ? ".exe" : "";
  return {
    canonical: `wollipog-runner-${triple}${executable}`,
    legacy: `agent-manager-runner-${triple}${executable}`,
  };
}

/** Headless release assets: one control-plane executable per target plus one platform-neutral
 * web bundle. Names are derived from the target like the runner names, so installers, the
 * release gate, and `wollipog service upgrade` agree byte for byte. */
export const WEB_BUNDLE_ASSET_NAME = "wollipog-web.tar.gz";

export function controlPlaneArtifactName(triple) {
  runnerArtifactNames(triple);
  const executable = triple.endsWith("-pc-windows-msvc") ? ".exe" : "";
  return `wollipog-control-plane-${triple}${executable}`;
}

/** Every checksum-manifest asset besides the runner pairs, sorted. */
export function headlessArtifactNames() {
  return [...RUNNER_TARGET_TRIPLES.map((triple) => controlPlaneArtifactName(triple)), WEB_BUNDLE_ASSET_NAME].sort();
}
/** Four POSIX companions and six closed runner/helper association records. */
export function leaseHelperArtifactNames() {
  return RUNNER_TARGET_TRIPLES.flatMap(target => [helperAssociationName(target),
    ...(target.endsWith("-pc-windows-msvc") ? [] : [helperReleaseAssetName(target)])]).sort();
}

export function runnerPlatformOfTarget(triple) {
  runnerArtifactNames(triple);
  return RUNNER_TARGET_HOSTS[triple].platform;
}

/** A Node SEA embeds its build host's runtime, so every supported target has one exact native
 * platform/architecture pair. This is deliberately the same closed set as the release matrix. */
export function assertRunnerTargetHost(triple, hostPlatform, hostArch) {
  runnerArtifactNames(triple);
  const expected = RUNNER_TARGET_HOSTS[triple];
  if (hostPlatform !== expected.platform || hostArch !== expected.arch) {
    throw new Error(
      `runner target ${triple} requires a ${expected.platform}/${expected.arch} host; ` +
        `received ${hostPlatform}/${hostArch}`,
    );
  }
}

/** Publish the compatibility alias only after the canonical SEA has been injected and signed.
 * copyFile preserves the exact bytes; copying the mode explicitly keeps the POSIX alias runnable. */
export function publishLegacyRunnerAlias(canonicalPath, legacyPath) {
  copyFileSync(canonicalPath, legacyPath);
  chmodSync(legacyPath, statSync(canonicalPath).mode);
}

/** Offline output publication: identical read-only companions are reused; unknown output is
 * retained. This is not a runtime compiler quota or installation-position admission. */
export function publishLeaseHelperCompanion(destination, input, expected) {
  const tuple = validateHelperTuple(expected);
  if (tuple.abi !== "posix64" || !(input instanceof Uint8Array) || input.length !== tuple.imageBytes ||
      helperDigest(input) !== tuple.imageSha256) throw new Error("invalid bounded offline companion");
  const verify = () => {
    const image = readHelperFile(destination, tuple.imageBytes);
    if (image.bytes.length !== tuple.imageBytes || helperDigest(image.bytes) !== tuple.imageSha256 || !(image.stat.mode & 0o100n)) {
      throw new Error("existing offline companion differs; preserve it");
    }
  };
  try { lstatSync(destination); verify(); return { reused: true }; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Reserve exclusively before the single already-admitted byte buffer can reach disk.
  const fd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const created = fstatSync(fd, { bigint: true });
    if (writeSync(fd, input) !== input.length) throw new Error("partial offline companion; preserve it");
    const named = lstatSync(destination, { bigint: true });
    if (named.dev !== created.dev || named.ino !== created.ino || named.nlink !== 1n || named.isSymbolicLink()) throw new Error("offline companion substituted; preserve it");
    fsyncSync(fd); fchmodSync(fd, 0o555);
  } finally { closeSync(fd); }
  verify(); return { reused: false };
}
