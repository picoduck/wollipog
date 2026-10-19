/** CI only: run the native protocol suite against the explicit source product.
 * Windows raw tsx deliberately has no admitted image; prepare a separate source test product
 * with the exact offline inputs used by build-binary, rather than weakening runtime admission.
 * No production process imports this script or reads its build-workspace inputs. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { helperDigest, validateHelperTuple } from "../../../scripts/lease-helper-distribution.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tests = ["provider-home-lease", "provider-home-lease-portable", "provider-home-lease-io",
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
const result = spawnSync(process.execPath, ["--import", "tsx", "--test",
  ...tests.map(name => join(product, "apps/runner/src", `${name}.test.ts`))],
{ cwd: repo, stdio: "inherit", timeout: 15 * 60_000 });
if (result.error) throw result.error;
assert.equal(result.signal, null, "native suite must finish with an actual exit receipt");
assert.equal(result.status, 0, "all native lease protocol cases must pass");
