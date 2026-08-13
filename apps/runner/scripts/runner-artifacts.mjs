import { chmodSync, copyFileSync, statSync } from "node:fs";

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
