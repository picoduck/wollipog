import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { helperDigest, type HelperTuple } from "../../../scripts/lease-helper-distribution.mjs";
import { decodeBuiltManagedImage, LEASE_HELPER_SOURCE_SHA256 } from "./provider-home-lease-assets.js";

test("independent source pins match the current native implementations", () => {
  for (const [kind, extension] of [["posix", "c"], ["windows", "cs"]] as const) {
    const bytes = readFileSync(new URL(`../native/provider-home-lease-io.${extension}`, import.meta.url));
    assert.equal(helperDigest(bytes), LEASE_HELPER_SOURCE_SHA256[kind]);
  }
});

function expected(bytes: Buffer): HelperTuple {
  return { schema: "WPLI1", target: "x86_64-pc-windows-msvc", protocol: "WPLL4",
    sourceSha256: LEASE_HELPER_SOURCE_SHA256.windows, imageSha256: helperDigest(bytes),
    imageBytes: bytes.length, abi: "framework4-il64" };
}

test("fixed managed program bytes admit the exact closed input up to 64KiB", () => {
  for (const bytes of [Buffer.from([1]), Buffer.alloc(65536, 7)]) {
    assert.deepEqual(decodeBuiltManagedImage(bytes.toString("base64"), expected(bytes)), bytes);
  }
});

test("managed decode refuses excess length, noncanonical encodings and self-selected contracts", () => {
  const bytes = Buffer.from([1]), tuple = expected(bytes);
  for (const value of [undefined, {}, "", "AQ", "AQ==\n", "A===", "AR==", "Ag==", "AAAA", Buffer.alloc(65539).toString("base64")]) {
    assert.throws(() => decodeBuiltManagedImage(value, tuple), /managed|build input/u);
  }
  const maximum = expected(Buffer.alloc(65536));
  assert.throws(() => decodeBuiltManagedImage(Buffer.alloc(65537).toString("base64"), maximum), /before-decode/u);
  for (const invalid of [{ ...tuple, sourceSha256: "a".repeat(64) }, { ...tuple, abi: "posix64" },
    { ...tuple, target: "x86_64-unknown-linux-gnu" }, { ...tuple, arbitrary: "adopt" }]) {
    assert.throws(() => decodeBuiltManagedImage("AQ==", invalid as HelperTuple), /managed|closed|helper/u);
  }
});

test("Windows raw source and helper admission refuse before mutable metadata lookup or any growth", { timeout: 20000 }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-windows-no-adoption-")));
  const files = ["wollipog-lease-helper-source-0.json", "lease-io.dll", "credential-canary"];
  for (const file of files) writeFileSync(join(root, file), `owned negative-test canary ${file}`);
  const before = files.map(file => readFileSync(join(root, file)));
  let closed = false;
  t.after(() => { if (closed) rmSync(root, { recursive: true }); else t.diagnostic(`Retain fixture; child closure unavailable: ${root}`); });
  const assets = new URL("./provider-home-lease-assets.ts", import.meta.url).href;
  const io = new URL("./provider-home-lease-windows-io.ts", import.meta.url).href;
  const shared = new URL("../../../scripts/lease-helper-distribution.mjs", import.meta.url).href;
  // On POSIX this verifies only the explicit Windows refusal policy, not native Windows ABI.
  // The same test uses the real platform on Windows; real loaded CLR proof is separate.
  const script = `import assert from 'node:assert/strict';
if(process.platform!=='win32')Object.defineProperty(process,'platform',{value:'win32'});
const a=await import(${JSON.stringify(assets)}),w=await import(${JSON.stringify(io)}),s=await import(${JSON.stringify(shared)});
const root=${JSON.stringify(root)},tuple=${JSON.stringify(expected(Buffer.from([1])))};
assert.throws(()=>a.expectedLeaseHelper(),/offline source runner bundle/);
assert.throws(()=>w.windowsLeaseIoCommand(),/offline source runner bundle/);
assert.throws(()=>s.readSourceHelperTuple(root,tuple.target,tuple.sourceSha256),/never adopted/);
assert.throws(()=>s.publishSourceHelperTuple(root,tuple),/no source-record/);
assert.throws(()=>s.pinHelperParent(root),/no file installation/);
assert.throws(()=>s.findInstalledHelper(root,tuple),/no file installation/);
await assert.rejects(s.installLeaseHelper(root,tuple,[Buffer.from([1])]),/no file installation/);
process.stdout.write('refused before selection and growth\\n');`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, WOLLIPOG_LEASE_HELPER_ROOT: root }, timeout: 10000, maxBuffer: 65536, encoding: "utf8",
  });
  assert.equal(result.error, undefined); closed = true;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "refused before selection and growth\n");
  assert.deepEqual(readdirSync(root).sort(), [...files].sort());
  files.forEach((file, i) => assert.deepEqual(readFileSync(join(root, file)), before[i]));
});
