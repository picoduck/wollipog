import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("native retirement flushes each changed directory once after verifying its entries", { skip: process.platform !== "linux" }, t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retirement-flush-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "flushes"), wrapper = join(root, "flush.c"), fixture = join(root, "fixture.cjs");
  // Observe real fsyncs in the real, statically linked helper; no production hook or clock change.
  writeFileSync(wrapper, `#define _POSIX_C_SOURCE 200809L
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
int __real_fsync(int fd);
int __real_unlinkat(int fd, const char *name, int flags);
static int observe(char event, int fd) {
  struct stat st;
  if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) {
    int out = open(${JSON.stringify(log)}, O_WRONLY|O_APPEND|O_CREAT, 0600);
    if (out < 0) return -1;
    char line[160]; int n = snprintf(line, sizeof(line), "%c %ld %llu:%llu\\n", event, (long)getpid(), (unsigned long long)st.st_dev, (unsigned long long)st.st_ino);
    if (write(out, line, (size_t)n) != n) { close(out); return -1; }
    close(out);
  }
  return 0;
}
int __wrap_fsync(int fd) {
  int result = __real_fsync(fd);
  return result == 0 ? observe('F', fd) : result;
}
int __wrap_unlinkat(int fd, const char *name, int flags) {
  int result = __real_unlinkat(fd, name, flags);
  return result == 0 ? observe('U', fd) : result;
}
`);
  const registry = fileURLToPath(new URL("./provider-home-lease.ts", import.meta.url));
  const bounded = fileURLToPath(new URL("../../../packages/test-support/src/bounded-child-process.ts", import.meta.url));
  writeFileSync(fixture, `const assert=require('node:assert/strict');
require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))});
const {interceptSpawnSyncForTest,spawnSync}=require(${JSON.stringify(bounded)});
const restore=interceptSpawnSyncForTest((command,args,options)=>command==='/usr/bin/cc'&&!args.includes(${JSON.stringify(wrapper)})?spawnSync(command,[...args,${JSON.stringify(wrapper)},'-Wl,--wrap=fsync','-Wl,--wrap=unlinkat'],options):undefined);
try {
const {ProviderHomeLeaseRegistry,providerHomeLeaseRefusalKind}=require(${JSON.stringify(registry)});
const fs=require('node:fs'),{join}=require('node:path'),{hostname}=require('node:os'),{createHash,randomUUID}=require('node:crypto');
const home=join(${JSON.stringify(root)},'home'),base=join(home,'.agent-manager/provider-home-leases-v1'),lock=join(base,'mutable-home.lock');
fs.mkdirSync(lock,{recursive:true,mode:0o700});
const owner='a'.repeat(64),hash=s=>createHash('sha256').update(s).digest('hex');
let record={version:2,state:'active',ownerHash:owner,leaseId:randomUUID(),previousLeaseId:null,previousRecordHash:null,recoveredEntriesHash:hash('[]'),pid:999999,hostname:hostname(),provider:'skills',createdAt:'2026-10-01',padding:'p'.repeat(3300)};
let raw=JSON.stringify(record)+'\\n',anchor=join(base,'mutable-home.recovery.json');
fs.writeFileSync(anchor,raw,{mode:0o600});fs.linkSync(anchor,join(lock,'checkpoint.json'));fs.linkSync(anchor,join(lock,'lease-'+record.leaseId+'.json'));
for(let i=0;i<128;i++){const name='next-'+record.leaseId+'.json';record={...record,recoveredEntriesHash:undefined,state:i%2===0?'released':'active',leaseId:randomUUID(),previousLeaseId:record.leaseId,previousRecordHash:hash(raw)};raw=JSON.stringify(record)+'\\n';fs.writeFileSync(join(base,name),raw,{mode:0o600});fs.linkSync(join(base,name),join(lock,name));}
const r=new ProviderHomeLeaseRegistry(owner);
assert.equal(r.acquireHome(home),true);assert.equal(r.releaseHome(home),true);
// Negative control: a foreign journal remains refused without changing its bytes.
const foreign=new ProviderHomeLeaseRegistry('b'.repeat(64));assert.equal(foreign.acquireHome(home),true);
const before=fs.readFileSync(anchor);assert.throws(()=>new ProviderHomeLeaseRegistry(owner,{isProcessAlive:()=>false}).acquireHome(home),e=>providerHomeLeaseRefusalKind(e)==='foreign_owner');assert.deepEqual(fs.readFileSync(anchor),before);assert.equal(foreign.releaseHome(home),true);
fs.writeFileSync(anchor,'invalid journal');assert.throws(()=>new ProviderHomeLeaseRegistry(owner).acquireHome(home),e=>providerHomeLeaseRefusalKind(e)==='unverifiable');assert.equal(fs.readFileSync(anchor,'utf8'),'invalid journal');
} finally { restore(); }
`);
  const result = spawnSync(process.execPath, [fixture], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const flushes = new Map<string, number>();
  const unflushed = new Set<string>();
  let unlinks = 0;
  for (const line of readFileSync(log, "utf8").trim().split("\n")) {
    const [event, pid, directory] = line.split(" ");
    assert.ok(pid && directory);
    const key = `${pid}/${directory}`;
    if (event === "U") { unflushed.add(key); unlinks++; }
    else { assert.equal(event, "F"); unflushed.delete(key); flushes.set(pid, (flushes.get(pid) ?? 0) + 1); }
  }
  assert.ok(unlinks >= 256, "the helper retired both aliases of the legacy transitions");
  assert.deepEqual([...unflushed], [], "every changed directory was flushed after its last unlink");
  const maximum = Math.max(...flushes.values());
  t.diagnostic(`Maximum directory flushes per native transaction: ${maximum}`);
  assert.ok(maximum <= 12, `retirement must not flush per alias: ${maximum} directory flushes`);
});

test("interrupted maximal padded retirement recovers within existing verification work bounds", { skip: process.platform !== "linux" }, t => {
  for (const tamper of ["none", "rewrite", "replace"]) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retirement-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "interrupted"), wrapper = join(root, "interrupt.c"), fixture = join(root, "fixture.cjs");
  // The first successful next-* unlink is the after-retire boundary: selection has
  // already been fsynced. Kill only this helper, once; spawnSync awaits its exit.
  writeFileSync(wrapper, `#define _POSIX_C_SOURCE 200809L
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
int __real_unlinkat(int fd, const char *name, int flags);
int __wrap_unlinkat(int fd, const char *name, int flags) {
  int result = __real_unlinkat(fd, name, flags);
  if (result == 0 && !strncmp(name, "next-", 5)) {
    int marker = open(${JSON.stringify(log)}, O_WRONLY|O_CREAT|O_EXCL, 0600);
    if (marker >= 0) { close(marker); kill(getpid(), SIGKILL); }
    const char *mode = getenv("WOLLIPOG_TEST_TAMPER");
    if (mode && strcmp(mode, "none")) {
      // Change the selected tip after its first cleanup ownership check. A second
      // retirement unlink after this point is always an error.
      int changed = open(${JSON.stringify(log + '.tamper')}, O_WRONLY|O_CREAT|O_EXCL, 0600);
      if (changed < 0) _exit(90);
      close(changed);
      const char *anchor = ${JSON.stringify(join(root, 'home/.agent-manager/provider-home-leases-v1/mutable-home.recovery.json'))};
      if (!strcmp(mode, "replace")) {
        const char *replacement = ${JSON.stringify(join(root, 'replacement'))};
        int out = open(replacement, O_WRONLY|O_CREAT|O_EXCL, 0600);
        int in = open(anchor, O_RDONLY); char buf[8192]; ssize_t n;
        if (out < 0 || in < 0) _exit(91);
        while ((n = read(in, buf, sizeof(buf))) > 0) if (write(out, buf, (size_t)n) != n) _exit(92);
        close(in); close(out);
        if (rename(replacement, anchor)) _exit(93);
      } else {
        int out = open(anchor, O_WRONLY);
        if (out < 0 || pwrite(out, "[", 1, 0) != 1) _exit(94);
        close(out);
      }
    }
  }
  return result;
}
`);
  const registry = fileURLToPath(new URL("./provider-home-lease.ts", import.meta.url));
  const bounded = fileURLToPath(new URL("../../../packages/test-support/src/bounded-child-process.ts", import.meta.url));
  writeFileSync(fixture, `const assert=require('node:assert/strict');
require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))});
const {interceptSpawnSyncForTest,spawnSync}=require(${JSON.stringify(bounded)});
const restore=interceptSpawnSyncForTest((command,args,options)=>command==='/usr/bin/cc'&&!args.includes(${JSON.stringify(wrapper)})?spawnSync(command,[...args,${JSON.stringify(wrapper)},'-Wl,--wrap=unlinkat'],options):undefined);
try {
const {observeLeaseIoWorkForTest,observeLeaseIoRunsForTest}=require(${JSON.stringify(fileURLToPath(new URL('./provider-home-lease-io.ts', import.meta.url)))});
const {LEASE_CHECKPOINT_LIMITS:limits}=require(${JSON.stringify(fileURLToPath(new URL('./provider-home-lease-checkpoint.ts', import.meta.url)))});
let maximumBytes=0,maximumRecords=0;const runs=[];observeLeaseIoWorkForTest(w=>{maximumBytes=Math.max(maximumBytes,w.bytes);maximumRecords=Math.max(maximumRecords,w.records);});observeLeaseIoRunsForTest(r=>runs.push(r));
const {ProviderHomeLeaseRegistry,providerHomeLeaseRefusalKind,observeLeaseVerificationWorkForTest}=require(${JSON.stringify(registry)});
const fs=require('node:fs'),{join}=require('node:path'),{hostname}=require('node:os'),{createHash,randomUUID}=require('node:crypto');
const home=join(${JSON.stringify(root)},'home'),base=join(home,'.agent-manager/provider-home-leases-v1'),lock=join(base,'mutable-home.lock');
fs.mkdirSync(lock,{recursive:true,mode:0o700});
const owner='a'.repeat(64),hash=s=>createHash('sha256').update(s).digest('hex');
let record={version:2,state:'active',ownerHash:owner,leaseId:randomUUID(),previousLeaseId:null,previousRecordHash:null,recoveredEntriesHash:hash('[]'),pid:999999,hostname:hostname(),provider:'skills',createdAt:'2026-10-01',padding:'p'.repeat(3300)};
let raw=JSON.stringify(record)+'\\n',anchor=join(base,'mutable-home.recovery.json');
fs.writeFileSync(anchor,raw,{mode:0o600});fs.linkSync(anchor,join(lock,'checkpoint.json'));fs.linkSync(anchor,join(lock,'lease-'+record.leaseId+'.json'));
for(let i=0;i<4090;i++){const name='next-'+record.leaseId+'.json';record={...record,recoveredEntriesHash:undefined,state:i%2===0?'released':'active',leaseId:randomUUID(),previousLeaseId:record.leaseId,previousRecordHash:hash(raw)};raw=JSON.stringify(record)+'\\n';fs.writeFileSync(join(base,name),raw,{mode:0o600});fs.linkSync(join(base,name),join(lock,name));}
const failures=[];const r=new ProviderHomeLeaseRegistry(owner,{onCheckpointFailureForTest:e=>failures.push(e)});
assert.throws(()=>r.acquireHome(home),/bounded catch-up/);
assert.ok(fs.existsSync(${JSON.stringify(log)}),'helper reached retirement after durable selection');
assert.equal(JSON.parse(fs.readFileSync(anchor)).version,4);
const selected=fs.readFileSync(anchor);
assert.equal(runs.filter(r=>r.signal==='SIGKILL').length,1,'spawnSync reaped the interrupted native helper');
assert.equal(failures.length,1,'only the deliberately killed helper failed');
maximumBytes=0;maximumRecords=0;
let attemptBytes=0,attemptRecords=0;
// This observer runs in finally, including after a cumulative budget refusal.
observeLeaseVerificationWorkForTest(w=>{attemptBytes=Math.max(attemptBytes,w.bytes);attemptRecords=Math.max(attemptRecords,w.records);});
const evidence=()=>[base,lock].flatMap(dir=>fs.readdirSync(dir).filter(name=>name!=='mutable-home.lock').sort().map(name=>[join(dir,name),hash(fs.readFileSync(join(dir,name)))]));
if(process.env.WOLLIPOG_TEST_TAMPER!=='none') {
  // Replacement preserves bytes, rewriting preserves size. Both must be detected
  // by the pin before a further retirement unlink (wrapper exit 90 otherwise).
  r.releaseHome(home);
  assert.equal(failures.length,2);
  assert.equal(failures[1].kind,'refusal');
  assert.equal(failures[1].message,'selected checkpoint changed','the anchor pin refuses before another retirement unlink');
  assert.equal(runs.some(r=>r.status===90),false,'no unlink after tip tampering');
  const before=evidence();
  if(process.env.WOLLIPOG_TEST_TAMPER==='rewrite') assert.throws(()=>new ProviderHomeLeaseRegistry(owner).acquireHome(home),e=>providerHomeLeaseRefusalKind(e)==='unverifiable');
  else assert.deepEqual(fs.readFileSync(anchor),selected,'replacement has the exact selected bytes');
  assert.deepEqual(evidence(),before);
} else {
assert.equal(r.releaseHome(home),true);
assert.equal(failures.length,1,'cleanup completes without another checkpoint failure');
const next=new ProviderHomeLeaseRegistry(owner);assert.equal(next.acquireHome(home),true);assert.equal(next.releaseHome(home),true);
assert.ok(fs.readdirSync(base).length+fs.readdirSync(lock).length<36,'recovery retires the maximal manifest');

const foreign=new ProviderHomeLeaseRegistry('b'.repeat(64));assert.equal(foreign.acquireHome(home),true);
const before=evidence();assert.throws(()=>new ProviderHomeLeaseRegistry(owner,{isProcessAlive:()=>false}).acquireHome(home),e=>providerHomeLeaseRefusalKind(e)==='foreign_owner');assert.deepEqual(evidence(),before);assert.equal(foreign.releaseHome(home),true);
fs.writeFileSync(anchor,'invalid journal');const malformed=evidence();assert.throws(()=>new ProviderHomeLeaseRegistry(owner).acquireHome(home),e=>providerHomeLeaseRefusalKind(e)==='unverifiable');assert.deepEqual(evidence(),malformed);
}
assert.ok(maximumBytes>0 && maximumBytes<=limits.verificationBytes,'recovery native transactions stay within the production verification byte budget');
assert.ok(maximumRecords>0 && maximumRecords<=limits.verificationRecords,'recovery native transactions stay within the production verification record budget');
assert.ok(attemptBytes>0 && attemptBytes<=limits.verificationBytes,'complete recovery attempts stay within the production verification byte budget');
assert.ok(attemptRecords>0 && attemptRecords<=limits.verificationRecords,'complete recovery attempts stay within the production verification record budget');
console.error('Maximum recovery native verification work: '+JSON.stringify({bytes:maximumBytes,records:maximumRecords}));
console.error('Maximum complete recovery attempt work: '+JSON.stringify({bytes:attemptBytes,records:attemptRecords}));
} finally { restore(); }
`);
  const result = spawnSync(process.execPath, [fixture], { env: { ...process.env, WOLLIPOG_TEST_TAMPER: tamper }, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 });
  t.diagnostic(result.stderr);
  assert.equal(result.status, 0, `${tamper}: ${result.stderr}`);
  }
});
