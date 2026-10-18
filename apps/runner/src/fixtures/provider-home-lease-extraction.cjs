// Isolated source/SEA fixture. Patch real Node boundaries before loading production modules;
// no substitute loader, digest comparison, registry, or native helper is implemented here.
const assert = require("node:assert/strict");
const fs = require("node:fs"), cp = require("node:child_process");
const crypto = require("node:crypto"), sea = require("node:sea");
const { join, basename, dirname } = require("node:path");
const [mode, root] = process.argv.slice(-2);
const home = join(root, "home"), temporary = join(root, "tmp"), data = join(root, "data");
const originalWrite = fs.writeFileSync, originalSpawn = cp.spawnSync, originalMkdtemp = fs.mkdtempSync;
const originalHash = crypto.createHash, faults = [], captures = [], executions = [], events = [];
const embedded = sea.isSea() ? Buffer.from(sea.getAsset("wollipog/provider-home-lease-io")) : undefined;
crypto.createHash = function (...args) {
  const hash = originalHash(...args), update = hash.update, digest = hash.digest;
  let trustedInput = false;
  hash.update = function (bytes, ...rest) {
    trustedInput ||= !!embedded && Buffer.from(bytes).equals(embedded);
    return update.call(this, bytes, ...rest);
  };
  hash.digest = function (...args) {
    if (trustedInput) events.push("trusted-digest");
    return digest.apply(this, args);
  };
  return hash;
};
fs.mkdtempSync = function (prefix, ...args) {
  if (sea.isSea() && basename(prefix).startsWith("wollipog-provider-home-lease-io-")) {
    assert.ok(events.includes("trusted-digest"), "trusted asset digest must precede staging creation");
  }
  return originalMkdtemp(prefix, ...args);
};
function helperPath(path) { return typeof path === "string" && basename(path) === "lease-io"; }
function corrupt(path, bytes, options) {
  if (mode === "partial" || mode === "partial-throw") {
    const partial = Buffer.from(bytes).subarray(0, Math.floor(bytes.length / 2));
    originalWrite(path, partial, options); faults.push([path, Buffer.from(partial)]);
    if (mode === "partial-throw") throw Error("injected interrupted write");
  } else {
    // Mutate the very buffer passed by extraction. Hashing it after the write is too late.
    const changed = mode === "fallback" ? Buffer.from(bytes) : bytes;
    changed[changed.length - 1] = embedded[embedded.length - 1] ^ 1;
    originalWrite(path, changed, options); faults.push([path, Buffer.from(changed)]);
  }
}
fs.writeFileSync = function (path, bytes, options) {
  if (helperPath(path) && ["corrupt", "partial", "partial-throw", "fallback"].includes(mode)
      && (mode !== "fallback" || dirname(dirname(path)) === temporary)) return corrupt(path, bytes, options);
  return originalWrite(path, bytes, options);
};
cp.spawnSync = function (command, args, options) {
  if (helperPath(command)) executions.push({ command, probe: args[0] === "--probe" });
  if (mode === "compiler-partial" && (command === "/usr/bin/cc" || command === "/usr/bin/clang")) {
    const path = args[args.indexOf("-o") + 1], bytes = Buffer.from("incomplete compiler evidence");
    originalWrite(path, bytes, { flag: "wx", mode: 0o700 }); faults.push([path, bytes]);
    return { status: 1, stderr: "injected compilation failure" };
  }
  return originalSpawn(command, args, options);
};
require("node:module").syncBuiltinESMExports();
const { ProviderHomeLeaseRegistry } = require("../provider-home-lease.ts");
const { LeaseHelperArtifact } = require("../provider-home-lease-staging.ts");
const capture = LeaseHelperArtifact.prototype.capture;
LeaseHelperArtifact.prototype.capture = function (...args) {
  if (mode === "substitute") {
    const old = this.root + ".original"; fs.renameSync(this.path, old);
    const replacement = Buffer.concat([embedded, Buffer.from("substituted tail")]);
    originalWrite(this.path, replacement, { flag: "wx", mode: 0o700 });
    faults.push([old, Buffer.from(embedded)], [this.path, replacement]);
  }
  const proof = capture.apply(this, args); captures.push(proof); return proof;
};
const registry = new ProviderHomeLeaseRegistry("a".repeat(64), { helperDataDir: data });
const success = mode === "success" || mode === "fallback";
if (success) {
  assert.equal(registry.acquireHome(home), true);
  assert.equal(registry.releaseHome(home), true);
} else {
  assert.throws(() => registry.acquireHome(home), /helper unavailable/);
  assert.equal(captures.length, 0, "failed extraction cannot publish artifact proof");
  assert.deepEqual(executions, [], "failed extraction cannot probe or execute");
  assert.equal(fs.existsSync(join(home, ".agent-manager", "provider-home-leases-v1")), false);
  assert.equal(fs.existsSync(join(data, "provider-home-leases-v1")), false);
  assert.equal(faults.length, mode === "substitute" ? 4 : 2, "both staging parents exercised");
}
for (const [path, bytes] of faults) assert.deepEqual(fs.readFileSync(path), bytes, "exact unproven evidence retained");
assert.equal(fs.readFileSync(join(home, "credential-sentinel"), "utf8"), "synthetic unchanged");
if (success) {
  assert.equal(captures.length, 1); assert.equal(executions.filter(x => x.probe).length, 1);
  assert.ok(executions.some(x => !x.probe), "real lease transaction executed");
  if (mode === "fallback") {
    assert.equal(faults.length, 1);
    assert.ok(executions.every(x => dirname(dirname(x.command)) === data));
  }
}
console.log(JSON.stringify({ sea: sea.isSea(), mode, captures: captures.length, executions: executions.length, faults: faults.length }));
