/** CI only: run the native protocol suite against the explicit source product.
 * Windows raw tsx deliberately has no admitted image; prepare a separate source test product
 * with the exact offline inputs used by build-binary, rather than weakening runtime admission.
 * No production process imports this script or reads its build-workspace inputs. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync, writeSync, copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { helperDigest, validateHelperTuple } from "../../../scripts/lease-helper-distribution.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tests = ["provider-home-lease", "provider-home-lease-handoffs", "provider-home-lease-portable", "provider-home-lease-io",
  "provider-home-lease-async", "provider-home-lease-worker-protocol", "provider-home-lease-heartbeat",
  "provider-home-lease-clock", "provider-home-lease-deadline", "provider-home-lease-worker-deadline"];
let product = repo;
if (process.platform === "win32") {
  const record = join(repo, "apps/runner/.bin-build/lease-helper-test-inputs.json");
  const stat = lstatSync(record);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 128 * 1024);
  const input = JSON.parse(readFileSync(record, "utf8"));
  const tuple = validateHelperTuple(input.tuple);
  assert.equal(tuple.target, `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`);
  assert.equal(tuple.abi, "framework4-il64");
  assert.equal(typeof input.managedImage, "string");
  assert.ok(input.managedImage.length <= 87384);
  const image = Buffer.from(input.managedImage, "base64");
  assert.equal(image.toString("base64"), input.managedImage);
  assert.equal(image.length, tuple.imageBytes);
  assert.equal(helperDigest(image), tuple.imageSha256);
  assert.equal(helperDigest(readFileSync(join(repo, "apps/runner/native/provider-home-lease-io.cs"))), tuple.sourceSha256);

  // Keep relative fixture/module paths intact. node_modules resolves from the enclosing
  // checkout; neither dependencies nor executable inputs are downloaded by this preparation.
  product = join(repo, "apps/runner/.bin-build/lease-test-source");
  const names = execFileSync("git", ["-C", repo, "ls-files", "-z"], { maxBuffer: 2 * 1024 * 1024 }).toString().split("\0").filter(Boolean);
  assert.ok(names.length <= 8192);
  let bytes = 0;
  for (const name of names) {
    const source = join(repo, name), target = join(product, name), rel = relative(product, target);
    assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
    const file = lstatSync(source);
    assert.ok(file.isFile() && !file.isSymbolicLink(), name);
    bytes += file.size;
    assert.ok(bytes <= 128 * 1024 * 1024, "offline test product source byte cap");
  }
  mkdirSync(product); // A second invocation cannot resume or overwrite an old test product.
  for (const name of names) {
    const target = join(product, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repo, name), target);
  }
  const path = join(product, "apps/runner/src/provider-home-lease-assets.ts");
  let source = readFileSync(path, "utf8");
  for (const [declaration, value] of [
    ["declare const __WOLLIPOG_LEASE_HELPER_TUPLE__: HelperTuple | undefined;", `const __WOLLIPOG_LEASE_HELPER_TUPLE__: HelperTuple | undefined = ${JSON.stringify(tuple)};`],
    ["declare const __WOLLIPOG_LEASE_MANAGED_IMAGE_BASE64__: string | undefined;", `const __WOLLIPOG_LEASE_MANAGED_IMAGE_BASE64__: string | undefined = ${JSON.stringify(input.managedImage)};`],
  ]) {
    assert.equal(source.split(declaration).length, 2, "exact build-input declaration");
    source = source.replace(declaration, value);
  }
  writeFileSync(path, source);
  console.log(JSON.stringify({ product: "offline-native-test-source", sourceBytes: bytes,
    sourceEntries: names.length, imageSha256: tuple.imageSha256, imageBytes: tuple.imageBytes }));
}

// Fixed-size CI diagnostic only. Failure here cannot change the native suite verdict.
let phasePath, phaseIdentity;
if (process.platform === "win32") {
  let fd;
  try {
    assert.equal(realpathSync(product), product, "physical offline test product");
    phasePath = join(product, ".native-main-phase-v1.bin");
    fd = openSync(phasePath, "wx+", 0o600);
    const frame = Buffer.alloc(512);
    frame.write("WPNPH1", 0, "ascii"); frame[14] = 66;
    createHash("sha256").update(frame.subarray(0, 224)).digest().copy(frame, 224);
    assert.equal(writeSync(fd, frame, 0, 512, 0), 512);
    const opened = fstatSync(fd), named = lstatSync(phasePath);
    assert.ok(opened.isFile() && !named.isSymbolicLink() && opened.nlink === 1 && opened.size === 512);
    assert.ok(opened.dev === named.dev && opened.ino === named.ino);
    phaseIdentity = { dev: opened.dev, ino: opened.ino };
  } catch { phaseIdentity = undefined; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
function reportNativePhase() {
  if (process.platform !== "win32") return;
  let summary = { nativePhaseReceipt: "UNKNOWN" }, fd;
  try {
    if (!phaseIdentity || !phasePath) throw new Error("no telemetry identity");
    const named = lstatSync(phasePath);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 ||
        named.dev !== phaseIdentity.dev || named.ino !== phaseIdentity.ino || named.size !== 512) throw new Error("telemetry identity");
    fd = openSync(phasePath, "r");
    const opened = fstatSync(fd), bytes = Buffer.alloc(512);
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 ||
        opened.size !== 512 || readSync(fd, bytes, 0, 512, 0) !== 512) throw new Error("short telemetry");
    const frames = [bytes.subarray(0, 256), bytes.subarray(256, 512)].filter((frame, slot) => {
      const seq = frame.readUInt32LE(8), id = frame.readUInt16LE(12), stage = frame[14];
      const active = frame.readBigUInt64LE(16) | (frame.readBigUInt64LE(24) << 64n);
      if (!frame.subarray(0, 8).equals(Buffer.from("WPNPH1\0\0", "ascii")) ||
          !createHash("sha256").update(frame.subarray(0, 224)).digest().equals(frame.subarray(224)) ||
          seq > 255 || seq % 2 !== slot || id > 59 || (frame[15] & ~7) || active >= (1n << 59n) ||
          ![66, 77, 83, 69, 73, 70, 88].includes(stage) ||
          frame.readInt16LE(56) < -1 || frame.readInt16LE(56) > 255 ||
          frame[58] > 3 || frame[59] > 3 || frame.subarray(92, 224).some(n => n !== 0)) return false;
      if (stage === 66) {
        const prepared = Buffer.alloc(224); prepared.write("WPNPH1", 0, "ascii"); prepared[14] = 66;
        return frame.subarray(0, 224).equals(prepared);
      }
      if (stage === 77 && (seq !== 1 || id !== 0 || active !== 0n)) return false;
      if (stage === 70 && id !== 0) return false;
      if (stage === 73) {
        const n = BigInt(frame.readUInt32LE(40));
        if (n === 0n || (n & (n - 1n)) !== 0n) return false;
      }
      if (stage === 88 && !(frame[15] & 6)) return false;
      return seq > 0 && ((stage !== 83 && stage !== 69) || id > 0);
    }).sort((a, b) => b.readUInt32LE(8) - a.readUInt32LE(8));
    if (!frames.length || (frames.length === 2 && frames[0].readUInt32LE(8) - frames[1].readUInt32LE(8) !== 1)) throw new Error("ambiguous telemetry");
    summary = { nativePhaseReceipt: "last-valid-snapshot", frameHex: frames[0].toString("hex") };
  } catch {}
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  try {
    const line = JSON.stringify(summary) + "\n";
    if (Buffer.byteLength(line) <= 2048) writeSync(2, line);
  } catch {}
}

let result;
try {
result = spawnSync(process.execPath, ["--import", "tsx", "--test",
  ...tests.map(name => join(product, "apps/runner/src", `${name}.test.ts`))],
{ cwd: repo, stdio: "inherit", timeout: 15 * 60_000,
  env: { ...process.env, WOLLIPOG_NATIVE_TEST_PHASE_RECEIPT: phaseIdentity ? phasePath : undefined } });
} finally { reportNativePhase(); }
if (result.error) throw result.error;
assert.equal(result.signal, null, "native suite must finish with an actual exit receipt");
assert.equal(result.status, 0, "all native lease protocol cases must pass");
