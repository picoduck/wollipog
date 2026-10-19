import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstalledHelper, helperDigest, helperReleaseAssetName, installLeaseHelper, LEASE_HELPER_LIMITS, LEASE_HELPER_TARGETS, publishSourceHelperTuple, readHelperFile, readSourceHelperTuple } from "../../../scripts/lease-helper-distribution.mjs";

const runner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quote = value => `'${value.replaceAll("'", "''")}'`;
/** Explicit offline build step. Never called from a runner/worker startup or reconnect. */
export async function prepareLeaseHelperAssets({ target = LEASE_HELPER_TARGETS[`${process.platform}/${process.arch}`], outDir = process.env.WOLLIPOG_LEASE_HELPER_ROOT || join(runner, "dist-bin"), buildDir = join(runner, ".bin-build"), managedImageInput = process.env.WOLLIPOG_BUILD_LEASE_MANAGED_IMAGE } = {}) {
  if (target !== LEASE_HELPER_TARGETS[`${process.platform}/${process.arch}`]) throw new Error("lease helper preparation requires the exact native target");
  mkdirSync(outDir, { recursive: true }); mkdirSync(buildDir, { recursive: true });
  const windows = process.platform === "win32", source = join(runner, "native", windows ? "provider-home-lease-io.cs" : "provider-home-lease-io.c");
  const sourceSha256 = helperDigest(readFileSync(source));
  if (!windows) try {
    const tuple = readSourceHelperTuple(outDir, target, sourceSha256);
    const image = findInstalledHelper(outDir, tuple);
    return { tuple, image, source, offlineImage: image.path };
  } catch (error) {
    if (error.code && error.code !== "ENOENT") throw error;
    // Only absence of the trusted source record permits compilation. Unproven existing records are not overwritten.
    if (!String(error.message).includes("matching offline source helper contract unavailable") && error.code !== "ENOENT") throw error;
  }
  const offlineImage = managedImageInput ?? join(buildDir, windows ? "provider-home-lease-io.dll" : helperReleaseAssetName(target));
  if (!managedImageInput) {
    if (existsSync(offlineImage)) throw new Error("unproven offline compiler output already exists; preserve it and inspect the explicit build workspace");
    let result;
    if (windows) {
      const program = `$ErrorActionPreference='Stop';if($PSVersionTable.PSVersion.Major -ne 5){throw 'Windows PowerShell 5 required'};Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(source)})) -OutputAssembly ${quote(offlineImage)}`;
      result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program], { timeout: LEASE_HELPER_LIMITS.compileMs, maxBuffer: 65536, windowsHide: true });
    } else {
      result = spawnSync(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", ...(process.platform === "linux" ? ["-static"] : []), source, "-o", offlineImage], { timeout: LEASE_HELPER_LIMITS.compileMs, maxBuffer: 65536 });
    }
    if (result.error || result.status !== 0) throw new Error("offline native helper compilation failed; no runtime fallback", { cause: result.error ?? new Error(result.stderr.toString().slice(0, 2048)) });
    if (process.platform === "darwin") {
      const signed = spawnSync("/usr/bin/codesign", ["--sign", "-", offlineImage], { timeout: LEASE_HELPER_LIMITS.producerMs, maxBuffer: 65536 });
      if (signed.error || signed.status !== 0) throw new Error("offline helper signing failed; preserve build output and refuse runtime fallback");
    }
  } else if (!windows) throw new Error("a shared managed build input is Windows-only");
  const length = statSync(offlineImage).size, cap = windows ? LEASE_HELPER_LIMITS.windowsImageBytes : LEASE_HELPER_LIMITS.imageBytes;
  if (!Number.isSafeInteger(length) || length < 1 || length > cap) throw new Error("offline helper output is not admissible; final size check is not a compiler quota");
  // Explicit compiler/build input: immutable source/toolchain authority, never a runtime helper record.
  // This bounded read admits output after compilation; it does not bound the compiler's earlier writes.
  const bytes = readHelperFile(offlineImage, cap, undefined, false).bytes;
  const tuple = { schema: "WPLI1", target, protocol: "WPLL4", sourceSha256, imageSha256: helperDigest(bytes), imageBytes: bytes.length, abi: windows ? "framework4-il64" : "posix64" };
  if (windows) {
    const image = { path: offlineImage, bytes, tuple, verify() {
      const current = readHelperFile(offlineImage, cap, undefined, false).bytes;
      if (current.length !== tuple.imageBytes || helperDigest(current) !== tuple.imageSha256) throw new Error("offline managed build input changed");
      return current;
    } };
    return { tuple, image, source, offlineImage };
  }
  const image = await installLeaseHelper(outDir, tuple, createReadStream(offlineImage, { highWaterMark: 65536 }));
  publishSourceHelperTuple(outDir, tuple);
  return { tuple, image, source, offlineImage };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prepared = await prepareLeaseHelperAssets();
  console.log(JSON.stringify({ target: prepared.tuple.target, sourceSha256: prepared.tuple.sourceSha256, imageSha256: prepared.tuple.imageSha256, imageBytes: prepared.tuple.imageBytes, runtimeCacheEntries: 0 }));
}
