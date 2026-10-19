// Isolated source/SEA consumer fixture. All installation inputs are prepared by the parent
// before this process starts. Instrument real Node boundaries; never substitute the registry,
// digest/identity verifier, or native helper. Runtime helper writes/compilation must not occur.
const assert = require("node:assert/strict");
const fs = require("node:fs"), cp = require("node:child_process");
const crypto = require("node:crypto"), sea = require("node:sea");
const { join, basename, relative, isAbsolute, sep } = require("node:path");
const [mode, root] = process.argv.slice(-2);
const home = join(root, "home"), temporary = join(root, "tmp"), data = join(root, "data");
const installed = process.env.WOLLIPOG_LEASE_HELPER_ROOT;
assert.ok(installed && isAbsolute(installed));
const originalSpawn = cp.spawnSync, executions = [], writes = [], captures = [];
let compilations = 0;
function snapshot(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name), stat = fs.lstatSync(path);
    return [{ path, mode: stat.mode, links: stat.nlink,
      value: stat.isSymbolicLink() ? fs.readlinkSync(path) : stat.isFile()
        ? crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex") : "directory" },
      ...(stat.isDirectory() && !stat.isSymbolicLink() ? snapshot(path) : [])];
  });
}
const before = [snapshot(installed), snapshot(temporary), snapshot(data)];
function noHelperWrite(path) {
  if (typeof path !== "string") return;
  const rel = relative(installed, path);
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) ||
      basename(path).startsWith("wollipog-provider-home-lease-io-")) {
    writes.push(path); throw new Error("runtime helper production forbidden");
  }
}
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync"]) {
  const original = fs[name];
  fs[name] = function(path, ...args) { noHelperWrite(path); return original.call(this, path, ...args); };
}
const originalOpen = fs.openSync;
fs.openSync = function(path, flags, ...args) {
  if (typeof flags === "string" ? /[wa+]/u.test(flags) : flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) noHelperWrite(path);
  return originalOpen.call(this, path, flags, ...args);
};
cp.spawnSync = function(command, args, options) {
  if (["cc", "clang", "csc", "csc.exe"].includes(basename(command))) {
    compilations++; throw new Error("runtime compilation forbidden");
  }
  if (basename(command) === "lease-io") executions.push({ command, probe: args[0] === "--probe" });
  return originalSpawn(command, args, options);
};
require("node:module").syncBuiltinESMExports();
const { ProviderHomeLeaseRegistry } = require("../provider-home-lease.ts");
const { LeaseHelperArtifact } = require("../provider-home-lease-staging.ts");
const capture = LeaseHelperArtifact.prototype.capture;
LeaseHelperArtifact.prototype.capture = function(...args) { captures.push(this.path); return capture.apply(this,args); };
const registry = new ProviderHomeLeaseRegistry("a".repeat(64), { helperDataDir: data });
if (mode === "success") {
  assert.equal(registry.acquireHome(home), true);
  assert.equal(registry.releaseHome(home), true);
  assert.equal(executions.filter(item => item.probe).length, 1);
  assert.ok(executions.some(item => !item.probe), "real native transaction completed");
} else {
  assert.throws(() => registry.acquireHome(home), /helper unavailable/u);
  assert.deepEqual(executions, [], "unproved installed inputs must never execute");
  assert.equal(fs.existsSync(join(home, ".agent-manager/provider-home-leases-v1")), false);
  assert.equal(fs.existsSync(join(data, "provider-home-leases-v1")), false);
}
assert.equal(compilations, 0); assert.deepEqual(writes, []); assert.deepEqual(captures, []);
assert.deepEqual([snapshot(installed), snapshot(temporary), snapshot(data)], before,
  "complete, partial, linked and legacy evidence must remain byte-for-byte unchanged");
assert.equal(fs.readFileSync(join(home, "credential-sentinel"), "utf8"), "synthetic unchanged");
console.log(JSON.stringify({ sea: sea.isSea(), mode, captures: captures.length,
  executions: executions.length, runtimeWrites: writes.length, compilations }));
