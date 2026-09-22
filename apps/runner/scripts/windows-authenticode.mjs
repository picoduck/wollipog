/**
 * Windows Authenticode signing through Azure Artifact Signing, for release CI.
 *
 * Signing is opt-in: it runs only when WOLLIPOG_WINDOWS_SIGNING=1, which the release workflow sets
 * after it has downloaded the pinned Artifact Signing client and signed in to Azure. Local and CI
 * builds without that variable produce unsigned binaries exactly as before.
 *
 * Two callers share this module:
 * - build-binary.mjs and build-sidecar.mjs sign each Node SEA right after injection and before any
 *   byte-identical copy (legacy runner alias, headless control plane, Tauri sidecar) is made. Tauri
 *   skips sidecars that already verify as signed, so every copy of a binary keeps the same bytes.
 * - Tauri's bundle.windows.signCommand runs this file as a CLI (`node windows-authenticode.mjs %1`)
 *   for the app executable, the MSI, the NSIS installer, and the NSIS uninstaller.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WINDOWS_SIGNING_FLAG = "WOLLIPOG_WINDOWS_SIGNING";
export const ARTIFACT_SIGNING_TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";
const SIGN_ATTEMPTS = 3;

const REQUIRED_SETTINGS = {
  signtool: "WOLLIPOG_SIGNTOOL",
  dlib: "WOLLIPOG_ARTIFACT_SIGNING_DLIB",
  metadata: "WOLLIPOG_ARTIFACT_SIGNING_METADATA",
};

/**
 * The signing settings, or null when signing is not enabled. An enabled flag with a missing
 * setting is a broken release configuration, so it throws rather than silently skipping.
 */
export function windowsSigningConfig(env = process.env) {
  if (env[WINDOWS_SIGNING_FLAG] !== "1") return null;
  const config = {};
  for (const [key, name] of Object.entries(REQUIRED_SETTINGS)) {
    const value = env[name];
    if (!value) throw new Error(`${WINDOWS_SIGNING_FLAG}=1 but ${name} is not set`);
    config[key] = value;
  }
  return config;
}

/** signtool arguments for an RFC 3161 timestamped SHA-256 signature through the Artifact Signing dlib. */
export function signtoolSignArgs(file, config) {
  return [
    "sign",
    "/v",
    "/fd",
    "SHA256",
    "/tr",
    ARTIFACT_SIGNING_TIMESTAMP_URL,
    "/td",
    "SHA256",
    "/dlib",
    config.dlib,
    "/dmdf",
    config.metadata,
    file,
  ];
}

/**
 * Remove the signature a copied node.exe carries before SEA injection. Injection invalidates it,
 * and Node's SEA guidance removes it first so the later signature is applied to a clean image.
 * Best effort: an already-unsigned file makes signtool fail, which is harmless here.
 */
export function removeWindowsSignature(file, { env = process.env, run = execFileSync } = {}) {
  const config = windowsSigningConfig(env);
  if (!config) return false;
  try {
    run(config.signtool, ["remove", "/s", file], { stdio: "inherit" });
  } catch {
    /* unsigned input */
  }
  return true;
}

/**
 * Sign one file and verify the result against the Windows trust policy. Returns false when
 * signing is not enabled. The signing service is remote, so a failed attempt is retried before
 * the error is surfaced; verification is not retried.
 */
export function signWindowsBinary(file, { env = process.env, run = execFileSync, attempts = SIGN_ATTEMPTS } = {}) {
  const config = windowsSigningConfig(env);
  if (!config) return false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      run(config.signtool, signtoolSignArgs(file, config), { stdio: "inherit" });
      break;
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.warn(`Authenticode signing attempt ${attempt} of ${attempts} failed for ${file}; retrying`);
    }
  }
  run(config.signtool, ["verify", "/pa", "/v", file], { stdio: "inherit" });
  return true;
}

/** CLI for Tauri's signCommand. Signing must be enabled: the command is only configured when it is. */
export function runWindowsSigningCli(args, { env = process.env, run = execFileSync } = {}) {
  if (args.length !== 1 || !args[0]) throw new Error("usage: windows-authenticode.mjs <file>");
  if (!signWindowsBinary(args[0], { env, run })) {
    throw new Error(`${WINDOWS_SIGNING_FLAG} is not 1; refusing to report ${args[0]} as signed`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runWindowsSigningCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
