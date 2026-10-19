import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LeaseHelperArtifact, leaseHelperParent } from "./provider-home-lease-staging.js";
import { helperDigest, helperPositionName, installLeaseHelper, LEASE_HELPER_TARGETS, publishSourceHelperTuple, type HelperTuple } from "../../../scripts/lease-helper-distribution.mjs";

const registryModule = new URL("./provider-home-lease.ts", import.meta.url).href;
const ioModule = new URL("./provider-home-lease-io.ts", import.meta.url).href;
const boundedModule = new URL("../../../packages/test-support/src/bounded-child-process.ts", import.meta.url).href;

test("trusted helper capture compares complete bounded bytes before establishing cleanup proof", (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-embedded-proof-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const trusted = Buffer.alloc(128 * 1024, 0x61);
  const expected = createHash("sha256").update(trusted).digest("hex");
  for (const change of ["valid", "tail", "partial", "empty", "oversized", "hardlink", ...(process.platform === "win32" ? [] : ["symlink"])]) {
    const artifact = new LeaseHelperArtifact(parent, "lease-io");
    const bytes = Buffer.from(trusted);
    if (change === "tail") bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    if (change === "symlink") {
      const target = join(parent, "foreign-target"); writeFileSync(target, trusted);
      symlinkSync(target, artifact.path);
    } else {
      writeFileSync(artifact.path, change === "partial" ? bytes.subarray(0, bytes.length / 2)
        : change === "empty" ? Buffer.alloc(0) : change === "oversized" ? Buffer.alloc(16 * 1024 * 1024 + 1) : bytes);
    }
    if (change === "hardlink") linkSync(artifact.path, join(parent, "foreign-link"));
    if (change === "valid") {
      assert.equal(artifact.capture(expected).sha256, expected);
      assert.deepEqual(artifact.verify(), trusted);
      artifact.cleanup(); assert.equal(existsSync(artifact.root), false);
    } else {
      assert.throws(() => artifact.capture(expected), /embedded asset|unsafe fixed helper/);
      assert.throws(() => artifact.verify(), /unproven helper artifact/);
      const before = readFileSync(artifact.path); artifact.cleanup();
      assert.deepEqual(readFileSync(artifact.path), before, change + ": unproven evidence retained");
    }
  }
});

test("source and actual POSIX SEA refuse corrupt, partial and substituted installed inputs without runtime production or fallback", {
  skip: process.platform !== "linux" && process.platform !== "darwin", timeout: 180_000,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-extraction-sea-")));
  let ownedChildrenClosed = true;
  t.after(() => {
    if (!ownedChildrenClosed) { t.diagnostic(`Retain synthetic fixture; owned child closure unproved: ${root}`); return; }
    const writableDirectories = (path: string): void => {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) writableDirectories(join(path, entry.name));
    };
    writableDirectories(root); rmSync(root, { recursive: true, force: true });
  });
  const require = createRequire(import.meta.url);
  const entry = fileURLToPath(new URL("./fixtures/provider-home-lease-extraction.cjs", import.meta.url));
  const bundle = join(root, "fixture-bundle.cjs"), binary = join(root, "fixture-sea");
  const helper = join(root, "native-helper"), blob = join(root, "fixture.blob"), config = join(root, "sea.json");
  const run = (command: string, args: string[]) => {
    ownedChildrenClosed = false;
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
    ownedChildrenClosed = !result.error && Number.isSafeInteger(result.status);
    assert.equal(result.status, 0, command + ": " + String(result.error ?? "") + "\n" + result.stderr + "\n" + result.stdout);
  };
  const compiler = process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc";
  run(compiler, ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", ...(process.platform === "linux" ? ["-static"] : []),
    fileURLToPath(new URL("../native/provider-home-lease-io.c", import.meta.url)), "-o", helper]);
  const image = readFileSync(helper);
  const tuple: HelperTuple = { schema: "WPLI1", target: LEASE_HELPER_TARGETS[`${process.platform}/${process.arch}`]!,
    protocol: "WPLL4", sourceSha256: helperDigest(readFileSync(new URL("../native/provider-home-lease-io.c", import.meta.url))),
    imageSha256: helperDigest(image), imageBytes: image.length, abi: "posix64" };
  const builder = join(root, "build.cjs");
  writeFileSync(builder, "require(" + JSON.stringify(require.resolve("esbuild")) + ").buildSync("
    + JSON.stringify({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs",
      target: "node24", define: { "import.meta.url": "undefined", __WOLLIPOG_LEASE_HELPER_TUPLE__: JSON.stringify(tuple) } }) + ");");
  run(process.execPath, [builder]);
  writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
  run(process.execPath, ["--experimental-sea-config", config]);
  copyFileSync(process.execPath, binary); chmodSync(binary, 0o700);
  if (process.platform === "darwin") {
    const unsigned = spawnSync("/usr/bin/codesign", ["--remove-signature", binary], { encoding: "utf8", timeout: 30_000 });
    assert.ok(unsigned.status === 0 || unsigned.stderr.includes("not signed at all"), unsigned.stderr);
  }
  const injector = join(root, "inject.cjs");
  writeFileSync(injector, "require(" + JSON.stringify(require.resolve("postject")) + ").inject("
    + JSON.stringify(binary) + ",'NODE_SEA_BLOB',require('node:fs').readFileSync(" + JSON.stringify(blob) + "),"
    + JSON.stringify({ sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}) })
    + ").catch(e=>{console.error(e);process.exitCode=1;});");
  run(process.execPath, [injector]);
  if (process.platform === "darwin") run("/usr/bin/codesign", ["--sign", "-", binary]);
  for (const sea of [false, true]) {
    for (const mode of ["success", "corrupt", "partial", "partial-throw", "substitute", "fallback", "compiler-partial"]) {
      const caseRoot = join(root, (sea ? "sea-" : "source-") + mode);
      const home = join(caseRoot, "home"), temporary = join(caseRoot, "tmp"), data = join(caseRoot, "data");
      for (const path of [home, temporary, data]) mkdirSync(path, { recursive: true, mode: 0o700 });
      const installedRoot = join(caseRoot, "installed"); mkdirSync(installedRoot, { mode: 0o700 });
      publishSourceHelperTuple(installedRoot, tuple);
      const chunks = function* () { for (let offset = 0; offset < image.length; offset += 65536) yield image.subarray(offset, offset + 65536); };
      if (mode === "compiler-partial") {
        const position = join(installedRoot, helperPositionName(0)); mkdirSync(position, { mode: 0o700 });
        writeFileSync(join(position, "lease-io"), image.subarray(0, 32), { mode: 0o600 });
      } else {
        const installed = await installLeaseHelper(installedRoot, tuple, chunks());
        if (mode === "partial-throw") {
          chmodSync(installed.root, 0o700); unlinkSync(join(installed.root, "contract.json")); chmodSync(installed.root, 0o555);
        } else if (mode === "substitute") {
          chmodSync(installed.root, 0o700); renameSync(installed.path, installed.path + ".original");
          symlinkSync(installed.path + ".original", installed.path); chmodSync(installed.root, 0o555);
        } else if (mode !== "success") {
          const altered = Buffer.from(image); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
          chmodSync(installed.path, 0o700);
          writeFileSync(installed.path, mode === "partial" ? altered.subarray(0, altered.length / 2) : altered);
          chmodSync(installed.path, 0o555);
        }
      }
      if (mode !== "success") for (const parent of [temporary, data]) {
        const legacy = join(parent, "wollipog-provider-home-lease-io-old-unknown"); mkdirSync(legacy);
        writeFileSync(join(legacy, "lease-io"), image, { mode: 0o700 });
      }
      writeFileSync(join(home, "credential-sentinel"), "synthetic unchanged");
      ownedChildrenClosed = false;
      const result = spawnSync(sea ? binary : process.execPath,
        [...(sea ? [] : ["--require", require.resolve("tsx/cjs"), entry]), mode, caseRoot], {
          // The source loader must not add its own cache while the evidence snapshot is frozen.
          env: { HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, PATH: "/usr/bin:/bin",
            TSX_DISABLE_CACHE: "1", WOLLIPOG_LEASE_HELPER_ROOT: installedRoot },
          encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024,
        });
      ownedChildrenClosed = !result.error && Number.isSafeInteger(result.status);
      assert.equal(result.status, 0, (sea ? "SEA " : "source ") + mode + ": " + String(result.error ?? "")
        + "\n" + result.stderr + "\n" + result.stdout);
      const receipt = JSON.parse(result.stdout.trim());
      assert.equal(receipt.sea, sea); assert.equal(receipt.mode, mode);
      if (mode === "success") {
        assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []);
        assert.deepEqual(readdirSync(data).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []);
      }
      t.diagnostic(result.stdout.trim());
    }
  }
});

test("default-equivalent profile temp and runner data can bootstrap without changing foreign lease evidence", { timeout: 180_000 }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-profile-bootstrap-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "long-user-profile"), temporary = join(home, "AppData", "Local", "Temp"), data = join(home, ".agent-manager");
  mkdirSync(temporary, { recursive: true }); mkdirSync(data);
  writeFileSync(join(home, "credential-sentinel"), "unchanged fixture");
  const script = join(root, "profile.mts");
  const contender = join(root, "foreign.mts");
  writeFileSync(contender, `import assert from'node:assert/strict';import{ProviderHomeLeaseRegistry}from${JSON.stringify(registryModule)};assert.throws(()=>new ProviderHomeLeaseRegistry('b'.repeat(64),{helperDataDir:${JSON.stringify(data)}}).acquireHome(${JSON.stringify(home)}),/already in use|another.*owner/);`);
  writeFileSync(script, `import assert from'node:assert/strict';import{spawnSync}from${JSON.stringify(boundedModule)};import{readFileSync,readdirSync}from'node:fs';import{join}from'node:path';import{ProviderHomeLeaseRegistry}from${JSON.stringify(registryModule)};
const home=${JSON.stringify(home)},data=${JSON.stringify(data)};const r=new ProviderHomeLeaseRegistry('a'.repeat(64),{helperDataDir:data});r.acquireHome(home);
const root=join(data,'provider-home-leases-v1');const evidence=()=>[root,join(root,'mutable-home.lock')].flatMap(dir=>readdirSync(dir).filter(n=>n!=='mutable-home.lock').map(n=>[join(dir,n),readFileSync(join(dir,n),'hex')]));const before=evidence();
const other=spawnSync(process.execPath,['--import','tsx',${JSON.stringify(contender)}],{encoding:'utf8',timeout:30000});assert.equal(other.status,0,other.stderr);assert.deepEqual(evidence(),before);assert.equal(r.releaseHome(home),true);assert.equal(readFileSync(join(home,'credential-sentinel'),'utf8'),'unchanged fixture');`);
  for (let pass = 0; pass < 9; pass++) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []);
    assert.deepEqual(readdirSync(data).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []);
  }
  assert.equal(JSON.parse(readFileSync(join(data, "provider-home-leases-v1", "mutable-home.recovery.json"), "utf8")).version, 4);
  t.diagnostic(`${process.platform}: 9 long-form in-profile lifetimes, selected v4, foreign lease and credential sentinel unchanged`);
});

test("direct immutable execution ignores temporary and runner-data staging locations", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-direct-helper-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), temporary = join(root, "tmp"), data = join(root, "data"), script = join(root, "direct.mts");
  mkdirSync(temporary); mkdirSync(data);
  writeFileSync(script, `import assert from'node:assert/strict';import{refuseLeaseIoProbeForTest}from${JSON.stringify(ioModule)};import{ProviderHomeLeaseRegistry}from${JSON.stringify(registryModule)};let probes=0;refuseLeaseIoProbeForTest(p=>{probes++;assert.ok(!p.startsWith(${JSON.stringify(temporary)})&&!p.startsWith(${JSON.stringify(data)}));return false});const r=new ProviderHomeLeaseRegistry('a'.repeat(64),{helperDataDir:${JSON.stringify(data)}});r.acquireHome(${JSON.stringify(home)});assert.equal(r.releaseHome(${JSON.stringify(home)}),true);assert.equal(probes,1);`);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TMPDIR: temporary }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []);
  assert.deepEqual(readdirSync(data).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []);
});

test("bootstrap excludes canonical evidence, descendants and physical path aliases before creation", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-staging-evidence-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, ".agent-manager"), evidence = join(data, "provider-home-leases-v1"), nested = join(evidence, "nested");
  mkdirSync(nested, { recursive: true }); writeFileSync(join(evidence, "foreign-evidence"), "retain");
  assert.throws(() => leaseHelperParent(evidence, home), /lease evidence/);
  assert.throws(() => leaseHelperParent(nested, home), /lease evidence/);
  const alias = join(home, "metadata-alias"); symlinkSync(data, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => leaseHelperParent(join(alias, "provider-home-leases-v1", "nested"), home), /lease evidence/);
  if (process.platform === "win32") {
    const result = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${evidence}") do @echo %~sI`], { encoding: "utf8", timeout: 10_000, windowsVerbatimArguments: true });
    assert.equal(result.status, 0, result.stderr);
    const short = result.stdout.trim();
    assert.throws(() => leaseHelperParent(join(short, "nested"), home), /lease evidence/);
    const shortHomeResult = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${home}") do @echo %~sI`], { encoding: "utf8", timeout: 10_000, windowsVerbatimArguments: true });
    assert.equal(shortHomeResult.status, 0, shortHomeResult.stderr);
    const shortHome = shortHomeResult.stdout.trim();
    assert.throws(() => leaseHelperParent(nested, shortHome), shortHome.toLowerCase() !== home.toLowerCase() ? /physical lease evidence alias/ : /lease evidence/);
    t.diagnostic(`Windows short-name evidence alias refused: ${short !== evidence}`);
  }
  assert.deepEqual(readdirSync(evidence).sort(), ["foreign-evidence", "nested"]);
  assert.equal(readFileSync(join(evidence, "foreign-evidence"), "utf8"), "retain");
});

test("private bootstrap reuse and cleanup retain changed, substituted, hardlinked or unknown evidence", (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-staging-proof-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const change of ["bytes", "inode", "hardlink", "unknown", "root"]) {
    const artifact = new LeaseHelperArtifact(parent, "lease-io");
    writeFileSync(artifact.path, "fixed trusted fixture bytes", { flag: "wx", mode: 0o700 }); artifact.capture();
    if (change === "bytes") writeFileSync(artifact.path, "changed evidence");
    if (change === "inode") { renameSync(artifact.path, join(parent, "old-inode")); writeFileSync(artifact.path, "fixed trusted fixture bytes"); }
    if (change === "hardlink") linkSync(artifact.path, join(parent, "foreign-hardlink"));
    if (change === "unknown") writeFileSync(join(artifact.root, "foreign-entry"), "retain");
    if (change === "root") { renameSync(artifact.root, join(parent, "old-root")); mkdirSync(artifact.root); writeFileSync(artifact.path, "fixed trusted fixture bytes"); }
    assert.throws(() => artifact.verify(), Error, change);
    const before = readFileSync(artifact.path); artifact.cleanup();
    assert.equal(existsSync(artifact.root), true, change); assert.deepEqual(readFileSync(artifact.path), before, change);
  }
  const valid = new LeaseHelperArtifact(parent, "lease-io");
  writeFileSync(valid.path, "fixed trusted fixture bytes", { flag: "wx", mode: 0o700 }); valid.capture();
  valid.cleanup(); assert.equal(existsSync(valid.root), false);
});

test("private ancestry protects permissive descendants and removal of that protection refuses reuse", { skip: process.platform === "win32" }, (t) => {
  // macOS's per-user tmpdir already has a private ancestor. Use the shared sticky
  // temp parent so this fixture can remove its only current-user private ancestor.
  const parent = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "wollipog-staging-private-ancestor-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const nested = join(parent, "permissive-temp"); mkdirSync(nested, { mode: 0o777 }); chmodSync(nested, 0o777);
  assert.equal(leaseHelperParent(nested), nested, "private current-user ancestor prevents foreign access");
  const artifact = new LeaseHelperArtifact(nested, "lease-io");
  writeFileSync(artifact.path, "fixed trusted fixture bytes", { flag: "wx", mode: 0o700 }); artifact.capture();
  chmodSync(parent, 0o777);
  assert.throws(() => leaseHelperParent(nested), /unprotected foreign renames/);
  assert.throws(() => artifact.verify(), /unprotected foreign renames/);
  artifact.cleanup(); assert.equal(existsSync(artifact.path), true, "uncertain ancestry preserves exact artifact");
});

test("normal runner exits remove only their exact fixed helper copies on every native platform", { timeout: 120_000 }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-lease-exit-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, "tmp"), home = join(root, "home"), script = join(root, "probe.mts");
  mkdirSync(temporary);
  writeFileSync(join(temporary, "unrelated-evidence"), "keep");
  writeFileSync(script, `import{ProviderHomeLeaseRegistry}from${JSON.stringify(registryModule)};const r=new ProviderHomeLeaseRegistry('a'.repeat(64));r.acquireHome(${JSON.stringify(home)});if(!r.releaseHome(${JSON.stringify(home)}))throw Error('release failed');`);
  for (let pass = 0; pass < 5; pass++) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []);
    assert.equal(existsSync(join(temporary, "unrelated-evidence")), true);
  }
  t.diagnostic(`${process.platform}: 5 normal exits leave 0 lease-helper copies and preserve unrelated evidence`);
});

test("failed direct probe preserves old crash artifacts and never allocates a fallback", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-direct-refusal-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, "tmp"), data = join(root, "data"), home = join(root, "home"), script = join(root, "refusal.mts");
  mkdirSync(temporary); mkdirSync(data);
  for (const parent of [temporary, data]) { const old = join(parent, "wollipog-provider-home-lease-io-old-unknown"); mkdirSync(old); writeFileSync(join(old, "unproven"), "retain unknown evidence"); }
  writeFileSync(script, `import assert from'node:assert/strict';import{refuseLeaseIoProbeForTest}from${JSON.stringify(ioModule)};import{ProviderHomeLeaseRegistry}from${JSON.stringify(registryModule)};let probes=0;refuseLeaseIoProbeForTest(()=>{probes++;return true});assert.throws(()=>new ProviderHomeLeaseRegistry('a'.repeat(64),{helperDataDir:${JSON.stringify(data)}}).acquireHome(${JSON.stringify(home)}),/helper unavailable/);assert.equal(probes,1);`);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TMPDIR: temporary }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(home), false);
  for (const parent of [temporary, data]) {
    assert.deepEqual(readdirSync(parent).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), ["wollipog-provider-home-lease-io-old-unknown"]);
    assert.equal(readFileSync(join(parent, "wollipog-provider-home-lease-io-old-unknown", "unproven"), "utf8"), "retain unknown evidence");
  }
});

test("unavailable helper refuses before publishing HOME evidence with a non-quarantine remedy", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-lease-unavailable-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, "tmp"), data = join(root, "runner-data"), home = join(root, "home");
  mkdirSync(temporary); mkdirSync(data);
  const script = join(root, "probe.mts");
  writeFileSync(script, `import assert from'node:assert/strict';const{refuseLeaseIoProbeForTest}=await import(${JSON.stringify(ioModule)});refuseLeaseIoProbeForTest(()=>true);
const{ProviderHomeLeaseRegistry}=await import(${JSON.stringify(registryModule)});const r=new ProviderHomeLeaseRegistry('a'.repeat(64),{helperDataDir:${JSON.stringify(data)}});
assert.throws(()=>r.acquireHome(${JSON.stringify(home)}),e=>{assert.match(e.message,/helper unavailable/);assert.doesNotMatch(e.message,/quarantine/);return true;});`);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TMPDIR: temporary }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(home), false, "helper probe failure precedes HOME creation or journal publication");
  assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []); assert.deepEqual(readdirSync(data), []);
});
