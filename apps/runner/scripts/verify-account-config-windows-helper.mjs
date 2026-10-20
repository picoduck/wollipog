/** Finite actual source/SEA native verification. No provider, runtime compiler, retry or fixture deletion. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"../../.."), DIR=join(ROOT,"apps/runner/.bin-build");
const sha=b=>createHash("sha256").update(b).digest("hex");
assert.equal(process.platform,"win32");
const source=process.argv.includes("--source"),packaged=process.argv.includes("--packaged");assert.notEqual(source,packaged);
const id=JSON.parse(readFileSync(join(DIR,"provider-account-config-windows-v1.identity.json"),"utf8"));
assert.equal(id.architecture,process.arch);
assert.equal(id.sourceSha256,sha(readFileSync(join(ROOT,"apps/runner/native/provider-account-config-windows.cs"))));
for(const [name,pin] of [["provider-account-config-windows-v1.dll",id.dll],[id.engine.name,id.engine]]){
 const raw=readFileSync(join(DIR,name));assert.equal(raw.length,pin.sizeBytes);assert.equal(sha(raw),pin.sha256);
}
const report=join(DIR,source?"account-config-source-verification.json":"account-config-packaged-verification.json");
assert.equal(existsSync(report),false,"verification allowance already recorded; no replay");
function run(file,args,options={}){
 const result=spawnSync(file,args,{cwd:ROOT,shell:false,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024,...options});
 const outputs={};for(const [name,bytes] of [["stdout",result.stdout??Buffer.alloc(0)],["stderr",result.stderr??Buffer.alloc(0)]]){
  assert.ok(bytes.length<=8*1024*1024);const path=report+"."+name;writeFileSync(path,bytes,{flag:"wx",mode:0o600});outputs[name]={path,sizeBytes:bytes.length,sha256:sha(bytes)};
 }
 const receipt={file,args,actualOSExit:result.status,signal:result.signal,error:result.error?.message,outputs,architecture:process.arch,sourceSha256:id.sourceSha256,engineSha256:id.engine.sha256,dllSha256:id.dll.sha256};
 const raw=Buffer.from(JSON.stringify(receipt));assert.ok(raw.length<=16384);writeFileSync(report,raw,{flag:"wx",mode:0o600});
 process.stdout.write(result.stdout??"");process.stderr.write(result.stderr??"");
 assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.signal,null);return result;
}
if(source){
 const fixture=JSON.parse(readFileSync(join(DIR,"provider-account-config-windows-fixture.identity.json"),"utf8"));
 assert.equal(fixture.sourceSha256,id.sourceSha256);
 for(const [name,pin] of [["provider-account-config-windows-fixture.dll",fixture.fixtureDll],[fixture.fixtureEngine.name,fixture.fixtureEngine]])assert.equal(sha(readFileSync(join(DIR,name))),pin.sha256);
 const files=["provider-account-config-windows-protocol.test.ts","provider-account-config-windows.test.ts","provider-account-config-windows.integration.test.ts","provider-login.test.ts"];
 const compiled=await build({stdin:{contents:files.map(f=>`import ${JSON.stringify("./apps/runner/src/"+f)};`).join("\n"),resolveDir:ROOT,sourcefile:"account-config-native-verification.ts"},bundle:true,platform:"node",format:"cjs",target:"node24",write:false,
  define:{"import.meta.url":"undefined",__WACW_ENGINE_SHA__:JSON.stringify(id.engine.sha256),__WACW_FIXTURE_ENGINE_SHA__:JSON.stringify(fixture.fixtureEngine.sha256)},legalComments:"none"});
 assert.equal(compiled.outputFiles.length,1);const bytes=Buffer.from(compiled.outputFiles[0].contents);assert.ok(bytes.length<=16*1024*1024);
 const entry=join(DIR,"account-config-native-test.cjs");writeFileSync(entry,bytes,{flag:"wx",mode:0o600});
 const positiveNames=["a new sign-in to a different account is recorded when the existing identities differ","removing an account forgets it while truthfully reporting its credential HOME retained"];
 const pattern="^(WACW1 |Windows publication trust scope |an unbuilt source adapter |native Windows account-config |"+positiveNames.join("$|")+"$)";
 const result=run(process.execPath,["--test","--test-reporter=tap","--test-timeout=90000","--test-name-pattern="+pattern,entry]);
 const text=result.stdout.toString();for(const name of positiveNames)assert.ok(text.includes("- "+name),"actual selected supervisor case missing");
 // Four codec/static cases, seven actual native cases, two existing supervisor cases.
 assert.match(text,/# pass 13(?:\r?\n|$)/u);assert.match(text,/# fail 0(?:\r?\n|$)/u);assert.match(text,/# cancelled 0(?:\r?\n|$)/u);
 for(const name of positiveNames)assert.doesNotMatch(text,new RegExp(name+".*# SKIP","u"));
}else{
 const dist=join(ROOT,"apps/runner/dist-bin"),names=readdirSync(dist).filter(x=>/^wollipog-runner-.*\.exe$/u.test(x));assert.equal(names.length,1);
 const binary=join(dist,names[0]);const root=mkdtempSync(join(tmpdir(),"wollipog-account-config-packaged-")),preload=join(root,"verify-fixed-engine.cjs");
 // Test-only setup stays outside the SEA; production embeds only its production DLL.
 const fixture=JSON.parse(readFileSync(join(DIR,"provider-account-config-windows-fixture.identity.json"),"utf8"));
 assert.equal(fixture.sourceSha256,id.sourceSha256);
 assert.equal(sha(readFileSync(join(DIR,"provider-account-config-windows-fixture.dll"))),fixture.fixtureDll.sha256);
 const fixtureEngine=join(DIR,fixture.fixtureEngine.name);
 assert.equal(sha(readFileSync(fixtureEngine)),fixture.fixtureEngine.sha256);
 createRequire(import.meta.url)(fixtureEngine).createSyntheticFixture(join(root,"runner.json"),"private");
 const code=`const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),vm=require('node:vm'),path=require('node:path'),sea=require('node:sea');
assert.equal(sea.isSea(),true);const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const engine=Buffer.from(sea.getAsset('wollipog/account-config-windows-engine-wacw1')),dll=Buffer.from(sea.getAsset('wollipog/account-config-windows-ntfs-v1'));
assert.equal(sha(engine),${JSON.stringify(id.engine.sha256)});assert.equal(sha(dll),${JSON.stringify(id.dll.sha256)});
assert.equal(sha(Buffer.from(sea.getAsset('wollipog/account-config-windows-ntfs-v1.identity'))),${JSON.stringify(sha(readFileSync(join(DIR,"provider-account-config-windows-v1.identity.json"))))});
const target={exports:{}};vm.runInThisContext('(function(exports,require,module,__filename,__dirname){'+engine.toString()+'\n})')(target.exports,n=>{assert.ok(n.startsWith('node:'));return require(n)},target,__filename,__dirname);
const config=path.join(${JSON.stringify(root)},'runner.json');assert.equal(fs.existsSync(config),true);
const first=target.exports.capture(config);assert.equal(first.revision,0);const next=Buffer.from(JSON.stringify({providerAccounts:[],untouched:true,after:true}));
target.exports.publish({path:config,stamp:first.stamp,parentBirth:first.parentBirth,beforeAccounts:sha('[]'),afterAccounts:sha('[]'),next});
assert.equal(target.exports.capture(config).revision,1);assert.equal(JSON.parse(fs.readFileSync(config)).after,true);
assert.ok(fs.existsSync(path.join(${JSON.stringify(root)},'.runner.json.account-publications-win-v1.anchor')));
assert.equal(fs.existsSync(path.join(${JSON.stringify(root)},'.runner.json.account-publications-win-v1.guard')),false);
console.log(JSON.stringify({packagedNativePublication:true,engineSha256:sha(engine),dllSha256:sha(dll),architecture:process.arch}));process.exit(0);`;
 assert.ok(Buffer.byteLength(code)<=16384);writeFileSync(preload,code,{flag:"wx",mode:0o600});
 // Only this isolated verifier process gets a preload, following the existing worker verifier.
 run(binary,[],{env:{...process.env,NODE_OPTIONS:"--require "+JSON.stringify(preload)}});
}
