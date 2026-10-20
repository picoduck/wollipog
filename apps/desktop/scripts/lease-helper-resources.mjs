/** Offline Tauri packaging inputs only. This is not runtime installation admission.
 * Container checkout ancestors may belong to the host runner. Never weaken the runtime
 * ancestry proof to accommodate them: prepare helpers under a separate protected parent,
 * then assemble this fixed, bounded resource layout from the closed build association.
 * A packaged runtime still has to pass the unchanged physical-parent/tuple admission. */
import { chmodSync, lstatSync, mkdirSync, opendirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { helperContractBytes, helperDigest, helperPositionName, LEASE_HELPER_LIMITS,
  parseHelperTuple, readHelperFile, sameHelperTuple, validateHelperTuple } from "../../../scripts/lease-helper-distribution.mjs";
import { publishLeaseHelperCompanion } from "../../runner/scripts/runner-artifacts.mjs";

function directory(path, sealed = false) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== 0n && stat.uid !== BigInt(process.getuid())) ||
      (sealed && (stat.mode & 0o222n))) throw new Error("unproved offline resource directory; preserve it");
  return stat;
}
function names(path, expected) {
  const handle = opendirSync(path, { bufferSize: 4 }), seen = [];
  try {
    for (let item; (item = handle.readSync());) {
      if (seen.length >= expected.length || !expected.includes(item.name)) {
        throw new Error("unknown offline resource entry; preserve it");
      }
      seen.push(item.name);
    }
  } finally { handle.closeSync(); }
  if (seen.length !== expected.length) throw new Error("partial offline resource layout; preserve it");
}
function posixTuple(value) {
  const tuple = validateHelperTuple(value);
  if (tuple.abi !== "posix64") throw new Error("offline resource layout requires a POSIX helper");
  return tuple;
}
/** Bounded offline byte/layout verification; deliberately grants no runtime parent authority. */
export function verifyDesktopLeaseHelperResource(resourceRoot, expected) {
  if (!isAbsolute(resourceRoot)) throw new Error("absolute offline resource root required");
  const tuple = posixTuple(expected), root = directory(resourceRoot);
  names(resourceRoot, [helperPositionName(0)]);
  const position = join(resourceRoot, helperPositionName(0)), before = directory(position, true);
  names(position, ["contract.json", "lease-io"]);
  const contract = readHelperFile(join(position, "contract.json"), LEASE_HELPER_LIMITS.contractBytes).bytes;
  if (!sameHelperTuple(parseHelperTuple(contract), tuple)) throw new Error("offline resource contract changed; preserve it");
  const path = join(position, "lease-io"), image = readHelperFile(path, tuple.imageBytes);
  if (image.bytes.length !== tuple.imageBytes || helperDigest(image.bytes) !== tuple.imageSha256 ||
      !(image.stat.mode & 0o100n)) throw new Error("offline resource image changed; preserve it");
  const after = directory(position, true), finalRoot = directory(resourceRoot);
  if (before.dev !== after.dev || before.ino !== after.ino ||
      root.dev !== finalRoot.dev || root.ino !== finalRoot.ino) throw new Error("offline resource directory substituted; preserve it");
  return { path, tuple };
}
export function stageDesktopLeaseHelperResource(resourceRoot, expected, image) {
  if (!isAbsolute(resourceRoot)) throw new Error("absolute offline resource root required");
  const tuple = posixTuple(expected), contract = helperContractBytes(tuple);
  if (!(image instanceof Uint8Array) || image.length !== tuple.imageBytes ||
      helperDigest(image) !== tuple.imageSha256 || contract.length > LEASE_HELPER_LIMITS.contractBytes) {
    throw new Error("invalid bounded offline resource input");
  }
  if (lstatSync(resourceRoot, { throwIfNoEntry: false })) {
    return verifyDesktopLeaseHelperResource(resourceRoot, tuple); // Exact complete reuse only.
  }
  mkdirSync(resourceRoot, { mode: 0o700 }); // No parents, replacement, or resume of partial output.
  const position = join(resourceRoot, helperPositionName(0));
  mkdirSync(position, { mode: 0o700 });
  publishLeaseHelperCompanion(join(position, "lease-io"), image, tuple);
  writeFileSync(join(position, "contract.json"), contract, { flag: "wx", mode: 0o444 });
  chmodSync(position, 0o555);
  return verifyDesktopLeaseHelperResource(resourceRoot, tuple);
}
