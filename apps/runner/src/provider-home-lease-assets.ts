import { dirname, isAbsolute, resolve } from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findInstalledHelper, helperDigest, LEASE_HELPER_LIMITS, LEASE_HELPER_TARGETS, pinHelperParent, readSourceHelperTuple, validateHelperTuple, type HelperTuple, type InstalledHelper } from "../../../scripts/lease-helper-distribution.mjs";

/** Trusted offline build input. Source records are part of the trusted source/toolchain distribution. */
declare const __WOLLIPOG_LEASE_HELPER_TUPLE__: HelperTuple | undefined;
declare const __WOLLIPOG_LEASE_MANAGED_IMAGE_BASE64__: string | undefined;
export const LEASE_HELPER_SOURCE_SHA256 = Object.freeze({
  posix: "28492e116000c648cd5ddc19f8db5ebe6d775c66f1fa57103235051e837af3d7",
  windows: "3c53da7bcf785778ce404e8cfb98e529d3f33009e93ced305daa10fae47282ca",
});
export const WINDOWS_LEASE_ASSET = "wollipog/provider-home-lease-io.dll";
let selectedRoot: string | undefined;
let selectedImage: InstalledHelper | undefined;
/** Private worker locator only; it cannot alter the independently expected tuple or budgets. */
export function setLeaseHelperRoot(root: string): void {
  if (!isAbsolute(root) || root.includes("\0") || Buffer.byteLength(root) > 32768 ||
      (selectedRoot !== undefined && selectedRoot !== root) || selectedImage) throw new Error("invalid or changed private helper locator");
  selectedRoot = root;
}
export function leaseHelperRoot(): string {
  if (selectedRoot) return resolve(selectedRoot);
  if (process.env.WOLLIPOG_LEASE_HELPER_ROOT) return resolve(process.env.WOLLIPOG_LEASE_HELPER_ROOT);
  if (isSea()) return dirname(process.execPath);
  return resolve(dirname(fileURLToPath(import.meta.url ?? pathToFileURL(__filename).href)), "../dist-bin");
}
export function expectedLeaseHelper(): HelperTuple {
  const target = LEASE_HELPER_TARGETS[`${process.platform}/${process.arch}`];
  if (!target) throw new Error("unsupported native lease helper target");
  const source = process.platform === "win32" ? LEASE_HELPER_SOURCE_SHA256.windows : LEASE_HELPER_SOURCE_SHA256.posix;
  if (process.platform === "win32" && typeof __WOLLIPOG_LEASE_HELPER_TUPLE__ === "undefined") {
    throw new Error("Windows source lease I/O requires the explicit offline source runner bundle; no mutable helper lookup or runtime fallback");
  }
  const tuple = typeof __WOLLIPOG_LEASE_HELPER_TUPLE__ !== "undefined"
    ? validateHelperTuple(__WOLLIPOG_LEASE_HELPER_TUPLE__)
    : readSourceHelperTuple(leaseHelperRoot(), target, source);
  if (tuple.target !== target || tuple.sourceSha256 !== source) throw new Error("stale or mismatched native lease helper build contract");
  return tuple;
}
export function installedLeaseHelper(providerHome?: string): InstalledHelper {
  pinHelperParent(leaseHelperRoot(), providerHome);
  if (!selectedImage) selectedImage = findInstalledHelper(leaseHelperRoot(), expectedLeaseHelper(), providerHome);
  selectedImage.verify();
  return selectedImage;
}
/** The argument is a build-time program literal, never metadata adopted from a helper path. */
export function decodeBuiltManagedImage(value: unknown, expected: HelperTuple): Buffer {
  const tuple = validateHelperTuple(expected);
  if (tuple.abi !== "framework4-il64" || !tuple.target.endsWith("-pc-windows-msvc") ||
      tuple.sourceSha256 !== LEASE_HELPER_SOURCE_SHA256.windows || typeof value !== "string" ||
      !value.length || value.length > 87384 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error("invalid fixed managed source build input");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const length = value.length / 4 * 3 - padding;
  if (length < 1 || length > LEASE_HELPER_LIMITS.windowsImageBytes || length !== tuple.imageBytes) {
    throw new Error("fixed managed source image before-decode byte limit");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value || helperDigest(bytes) !== tuple.imageSha256) {
    throw new Error("fixed managed source image does not match the independently embedded build contract");
  }
  return bytes;
}
export function windowsLeaseHelperImage(_providerHome?: string): { tuple: HelperTuple; bytes: Buffer } {
  const tuple = expectedLeaseHelper();
  if (process.platform !== "win32") throw new Error("Windows managed helper requires a native Windows host");
  if (!isSea()) {
    if (typeof __WOLLIPOG_LEASE_MANAGED_IMAGE_BASE64__ === "undefined") {
      throw new Error("Windows source lease I/O requires the explicit offline source runner bundle; no runtime fallback");
    }
    return { tuple, bytes: decodeBuiltManagedImage(__WOLLIPOG_LEASE_MANAGED_IMAGE_BASE64__, tuple) };
  }
  // The offline builder admits the embedded image before embedding. This is not a pre-allocation getAsset API.
  const bytes = Buffer.from(getAsset(WINDOWS_LEASE_ASSET));
  if (bytes.length !== tuple.imageBytes || bytes.length > LEASE_HELPER_LIMITS.windowsImageBytes || helperDigest(bytes) !== tuple.imageSha256) throw new Error("packaged managed helper bytes do not match the trusted build contract");
  return { tuple, bytes };
}
