import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { helperContractBytes, helperDigest, helperPositionName, findInstalledHelper } from "../../../scripts/lease-helper-distribution.mjs";
import { stageDesktopLeaseHelperResource, verifyDesktopLeaseHelperResource } from "./lease-helper-resources.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "desktop-resource-layout-"));
  t.after(() => {
    const writable = path => {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) writable(join(path, entry.name));
      }
    };
    writable(root); rmSync(root, { recursive: true, force: true });
  });
  const image = Buffer.from("synthetic layout input; never executed");
  const tuple = { schema: "WPLI1", protocol: "WPLL4", target: "x86_64-unknown-linux-gnu",
    sourceSha256: "a".repeat(64), imageSha256: helperDigest(image), imageBytes: image.length, abi: "posix64" };
  return { root, image, tuple, output: resolve(root, "resource") };
}
test("offline resource output has the exact immutable runtime-readable layout and complete reuse", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const first = stageDesktopLeaseHelperResource(f.output, f.tuple, f.image);
  assert.deepEqual(readdirSync(f.output), [helperPositionName(0)]);
  const position = join(f.output, helperPositionName(0));
  assert.deepEqual(readdirSync(position).sort(), ["contract.json", "lease-io"]);
  assert.deepEqual(readFileSync(join(position, "contract.json")), helperContractBytes(f.tuple));
  assert.deepEqual(readFileSync(first.path), f.image);
  assert.equal(stageDesktopLeaseHelperResource(f.output, f.tuple, f.image).path, first.path);
  // This private fixture ALSO passes the independent unchanged runtime admission.
  // Synthetic bytes establish layout only; real native execution is separate CI evidence.
  assert.deepEqual(findInstalledHelper(f.output, f.tuple).verify(), f.image);
});
test("corrupt, partial and unknown existing offline resources are retained without overwrite", { skip: process.platform === "win32" }, t => {
  for (const kind of ["partial", "unknown", "corrupt"]) {
    const f = fixture(t);
    if (kind === "partial") {
      mkdirSync(f.output);
      writeFileSync(join(f.output, "partial-evidence"), "retain");
    } else {
      const result = stageDesktopLeaseHelperResource(f.output, f.tuple, f.image);
      if (kind === "unknown") writeFileSync(join(f.output, "unknown"), "retain");
      else { chmodSync(result.path, 0o600); writeFileSync(result.path, "corrupt retained bytes"); chmodSync(result.path, 0o555); }
    }
    const before = readdirSync(f.output).sort();
    const imagePath = join(f.output, helperPositionName(0), "lease-io");
    const bytes = existsSync(imagePath) ? readFileSync(imagePath) : undefined;
    assert.throws(() => stageDesktopLeaseHelperResource(f.output, f.tuple, f.image), /offline resource/);
    assert.deepEqual(readdirSync(f.output).sort(), before);
    if (bytes) assert.deepEqual(readFileSync(imagePath), bytes);
  }
});
test("invalid image or non-POSIX tuple refuses before allocating the offline layout", t => {
  const f = fixture(t);
  assert.throws(() => stageDesktopLeaseHelperResource(f.output, f.tuple, Buffer.from("different")), /invalid bounded/);
  assert.equal(existsSync(f.output), false);
  const windows = { ...f.tuple, target: "x86_64-pc-windows-msvc", abi: "framework4-il64" };
  assert.throws(() => stageDesktopLeaseHelperResource(f.output, windows, f.image), /POSIX/);
  assert.equal(existsSync(f.output), false);
  assert.throws(() => verifyDesktopLeaseHelperResource("relative", f.tuple), /absolute/);
});
