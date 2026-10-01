import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LeaseHelperArtifact, leaseHelperParent } from "./provider-home-lease-staging.js";

const registryModule = new URL("./provider-home-lease.ts", import.meta.url).href;
const ioModule = new URL("./provider-home-lease-io.ts", import.meta.url).href;
const boundedModule = new URL("../../../packages/test-support/src/bounded-child-process.ts", import.meta.url).href;

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

test("rejected temporary execution falls back to existing in-profile runner data", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-profile-fallback-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile"), temporary = join(home, "tmp"), data = join(home, ".agent-manager");
  mkdirSync(temporary, { recursive: true }); mkdirSync(data);
  const script = join(root, "fallback.mts");
  writeFileSync(script, `import{refuseLeaseIoProbeForTest}from${JSON.stringify(ioModule)};import{ProviderHomeLeaseRegistry}from${JSON.stringify(registryModule)};let rejected=0;refuseLeaseIoProbeForTest(p=>{if(p.startsWith(${JSON.stringify(temporary)})){rejected++;return true;}return false;});const r=new ProviderHomeLeaseRegistry('a'.repeat(64),{helperDataDir:${JSON.stringify(data)}});r.acquireHome(${JSON.stringify(home)});if(!r.releaseHome(${JSON.stringify(home)})||rejected!==1)throw Error('fallback failed');`);
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
    const result = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${evidence}") do @echo %~sI`], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const short = result.stdout.trim();
    assert.throws(() => leaseHelperParent(join(short, "nested"), home), /lease evidence/);
    const shortHomeResult = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${home}") do @echo %~sI`], { encoding: "utf8", timeout: 10_000 });
    assert.equal(shortHomeResult.status, 0, shortHomeResult.stderr);
    const shortHome = shortHomeResult.stdout.trim();
    assert.throws(() => leaseHelperParent(nested, shortHome), shortHome !== home ? /physical lease evidence alias/ : /lease evidence/);
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

test("fixed lease helper probes an executable runner-data fallback and cleans exact normal-exit copies", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-lease-staging-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, "tmp"), data = join(root, "runner-data"), home = join(root, "home");
  mkdirSync(temporary); mkdirSync(data);
  const script = join(root, "probe.mts");
  writeFileSync(script, `const{refuseLeaseIoProbeForTest}=await import(${JSON.stringify(ioModule)});let refused=0;
refuseLeaseIoProbeForTest(path=>{if(path.startsWith(${JSON.stringify(temporary)})){refused++;return true;}return false;});
const{ProviderHomeLeaseRegistry}=await import(${JSON.stringify(registryModule)});
const r=new ProviderHomeLeaseRegistry('a'.repeat(64),{helperDataDir:${JSON.stringify(data)}});r.acquireHome(${JSON.stringify(home)});if(!r.releaseHome(${JSON.stringify(home)}))throw Error('release failed');if(refused!==1)throw Error('temporary execution probe was not rejected exactly once');console.log('fallback acquired and released');`);
  for (let pass = 0; pass < 5; pass++) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TMPDIR: temporary }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fallback acquired and released/);
    assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), [], "failed probe copy removed; unrelated tsx cache untouched");
    assert.deepEqual(readdirSync(data), [], "normal exit removes only the exact staged copy");
  }
  t.diagnostic("5 exited lifetimes: 0 private helper cache entries under both staging roots");
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
