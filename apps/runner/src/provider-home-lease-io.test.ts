import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const registryModule = new URL("./provider-home-lease.ts", import.meta.url).href;

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
  writeFileSync(script, `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';
const actual=cp.spawnSync;let refused=0;
cp.spawnSync=(command,args,options)=>{if(String(command).startsWith(${JSON.stringify(temporary)})&&String(command).endsWith('/lease-io')){refused++;return{error:Object.assign(new Error('noexec simulation'),{code:'EACCES'}),status:null,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};}return actual(command,args,options);};syncBuiltinESMExports();
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
  writeFileSync(script, `import assert from'node:assert/strict';import cp from'node:child_process';import{syncBuiltinESMExports}from'node:module';
const actual=cp.spawnSync;cp.spawnSync=(command,args,options)=>String(command).endsWith('/lease-io')?{error:Object.assign(new Error('noexec simulation'),{code:'EACCES'}),status:null,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:actual(command,args,options);syncBuiltinESMExports();
const{ProviderHomeLeaseRegistry}=await import(${JSON.stringify(registryModule)});const r=new ProviderHomeLeaseRegistry('a'.repeat(64),{helperDataDir:${JSON.stringify(data)}});
assert.throws(()=>r.acquireHome(${JSON.stringify(home)}),e=>{assert.match(e.message,/helper unavailable/);assert.doesNotMatch(e.message,/quarantine/);return true;});`);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TMPDIR: temporary }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(home), false, "helper probe failure precedes HOME creation or journal publication");
  assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith("wollipog-provider-home-lease-io-")), []); assert.deepEqual(readdirSync(data), []);
});
