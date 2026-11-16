import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leaseHelperParent } from "./provider-home-lease-staging.js";

test("production Add Account keeps the runner-data helper fallback when temporary execution is refused", { skip: process.platform !== "linux" && process.platform !== "darwin" }, t => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-create-fallback-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const data = join(fixture, "data"), temporary = join(fixture, "temporary"), home = join(fixture, "home");
  for (const path of [data, temporary, home]) mkdirSync(path, { mode: 0o700 });
  // The fixed resolver must retain its ancestry checks. A namespace that refuses both roots
  // cannot certify successful staging; do not bypass that guard to make this test pass.
  try { leaseHelperParent(data); } catch { t.skip("isolated namespace refuses runner-data staging ancestry too; needs normal-host CI"); return; }
  const script = join(fixture, "fallback.mts");
  writeFileSync(script, `
import assert from 'node:assert/strict';
import { existsSync,readdirSync } from 'node:fs';
import { refuseLeaseIoProbeForTest } from ${JSON.stringify(new URL("./provider-home-lease-io.ts", import.meta.url).href)};
import { ProviderLoginSupervisor } from ${JSON.stringify(new URL("./provider-login.ts", import.meta.url).href)};
import { managedProviderProfileRoot } from ${JSON.stringify(new URL("./provider-profile-home.ts", import.meta.url).href)};
let rejected=0,markerReached=false;
refuseLeaseIoProbeForTest(path=>{if(path.startsWith(${JSON.stringify(temporary)})){rejected++;return true;}return false;});
const root=managedProviderProfileRoot(${JSON.stringify(home)});
const supervisor=new ProviderLoginSupervisor({
 dataDir:${JSON.stringify(data)},configPath:${JSON.stringify(join(fixture, "unused-config.json"))},accounts:[],
 agents:()=>[{id:'claude',name:'Claude',command:'claude',args:[],env:{},driver:'claude-code',context:{kind:'native'}}],
 resolveEnv:()=>({}),acquireLease:()=>{throw Error('must not reach lease/sign-in');},releaseLease:()=>true,
 onUpdate:()=>{},onAccountAdded:()=>{},spawn:()=>{throw Error('must not spawn a provider');},
 profiles:{root,create:async directory=>{markerReached=true;assert.ok(existsSync(directory));throw Error('fixture marker boundary');},settle:async()=>{}}
});
await assert.rejects(supervisor.startAccount({provider:'claude',label:'Fixture',profileGrantId:'2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3'}),/fixture marker boundary/);
assert.equal(rejected,1);assert.equal(markerReached,true);assert.equal(readdirSync(root).length,1);
`);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary }, encoding: "utf8", timeout: 30_000, maxBuffer: 65536,
  });
  assert.equal(result.status, 0, result.stderr);
  const artifacts = (directory: string) => readdirSync(directory).filter(name => name.startsWith("wollipog-provider-home-lease-io-"));
  assert.deepEqual(artifacts(temporary), [], "rejected helper artifacts are retired without touching unrelated tsx cache state");
  assert.deepEqual(artifacts(data), [], "fallback helper artifacts are retired at process exit");
});
