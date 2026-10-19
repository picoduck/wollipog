import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** New growth only, per unchanged protected physical installation parent. No retirement. */
export const LEASE_HELPER_LIMITS = Object.freeze({
  positions: 8, imageBytes: 2097152, windowsImageBytes: 65536, contractBytes: 16384,
  sourceRecords: 2, entries: 34, logicalBytes: 16941056, diagnosticBytes: 512,
  ancestry: 256, compileMs: 30000, probeMs: 10000, producerMs: 30000,
});
export const LEASE_HELPER_TARGETS = Object.freeze({
  "linux/x64": "x86_64-unknown-linux-gnu", "linux/arm64": "aarch64-unknown-linux-gnu",
  "darwin/x64": "x86_64-apple-darwin", "darwin/arm64": "aarch64-apple-darwin",
  "win32/x64": "x86_64-pc-windows-msvc", "win32/arm64": "aarch64-pc-windows-msvc",
});
export const helperPositionName = (index) => {
  if (!Number.isInteger(index) || index < 0 || index >= LEASE_HELPER_LIMITS.positions) throw new Error("invalid helper position");
  return `wollipog-lease-helper-${String(index).padStart(2, "0")}`;
};
export const helperSourceRecordName = (index) => {
  if (index !== 0 && index !== 1) throw new Error("invalid helper source record");
  return `wollipog-lease-helper-source-${index}.json`;
};
export const helperImageName = (tuple) => tuple.target.endsWith("-pc-windows-msvc") ? "lease-io.dll" : "lease-io";
export const helperReleaseAssetName = (target) => {
  if (!Object.values(LEASE_HELPER_TARGETS).includes(target) || target.endsWith("-pc-windows-msvc")) throw new Error("no external helper asset for target");
  return `wollipog-provider-home-lease-io-${target}`;
};
export const helperAssociationName = (target) => {
  if (!Object.values(LEASE_HELPER_TARGETS).includes(target)) throw new Error("unsupported helper target");
  return `wollipog-runner-lease-contract-${target}.json`;
};
export const helperDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tupleKeys = ["schema", "target", "protocol", "sourceSha256", "imageSha256", "imageBytes", "abi"];
const hash = /^[a-f0-9]{64}$/u;
function keys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== expected.length ||
      !expected.every(key => Object.hasOwn(value, key))) throw new Error("invalid closed helper contract");
}
export function validateHelperTuple(value) {
  keys(value, tupleKeys);
  const windows = typeof value.target === "string" && value.target.endsWith("-pc-windows-msvc");
  if (value.schema !== "WPLI1" || value.protocol !== "WPLL4" || !Object.values(LEASE_HELPER_TARGETS).includes(value.target) ||
      typeof value.sourceSha256 !== "string" || !hash.test(value.sourceSha256) || typeof value.imageSha256 !== "string" || !hash.test(value.imageSha256) ||
      !Number.isSafeInteger(value.imageBytes) || value.imageBytes < 1 || value.imageBytes > (windows ? LEASE_HELPER_LIMITS.windowsImageBytes : LEASE_HELPER_LIMITS.imageBytes) ||
      value.abi !== (windows ? "framework4-il64" : "posix64")) throw new Error("invalid helper image/ABI contract");
  return Object.freeze(Object.fromEntries(tupleKeys.map(key => [key, value[key]])));
}
export function helperContractBytes(tuple) { return Buffer.from(`${JSON.stringify(validateHelperTuple(tuple))}\n`); }
/** Canonical encoding also refuses duplicate keys and alternate encodings, never truncates. */
export function parseHelperTuple(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > LEASE_HELPER_LIMITS.contractBytes) throw new Error("helper contract byte limit");
  const text = Buffer.from(bytes).toString("utf8"), tuple = validateHelperTuple(JSON.parse(text));
  if (!Buffer.from(text).equals(Buffer.from(bytes)) || !helperContractBytes(tuple).equals(Buffer.from(bytes))) throw new Error("noncanonical helper contract");
  return tuple;
}
export function sameHelperTuple(a, b) { return helperContractBytes(a).equals(helperContractBytes(b)); }
const associationKeys = ["schema", "helper", "canonical", "legacy", "runnerSha256", "storage", "installerMode"];
export function validateHelperAssociation(value) {
  keys(value, associationKeys);
  const helper = validateHelperTuple(value.helper), extension = helper.target.endsWith("-pc-windows-msvc") ? ".exe" : "";
  if (value.schema !== "WPLR1" || value.canonical !== `wollipog-runner-${helper.target}${extension}` ||
      value.legacy !== `agent-manager-runner-${helper.target}${extension}` || !hash.test(value.runnerSha256) ||
      value.storage !== (extension ? "embedded" : "external") || value.installerMode !== "--lease-helper-install") throw new Error("invalid runner/helper association");
  return Object.freeze(Object.fromEntries(associationKeys.map(key => [key, key === "helper" ? helper : value[key]])));
}
export function helperAssociationBytes(value) { return Buffer.from(`${JSON.stringify(validateHelperAssociation(value))}\n`); }
export function parseHelperAssociation(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > LEASE_HELPER_LIMITS.contractBytes) throw new Error("runner/helper association byte limit");
  const association = validateHelperAssociation(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (!helperAssociationBytes(association).equals(Buffer.from(bytes))) throw new Error("noncanonical runner/helper association");
  return association;
}
/** One fixed producer lifetime. A late iterator completion cannot resume a failed disk write. */
export async function* boundedHelperChunks(input, maximum, deadline = performance.now() + LEASE_HELPER_LIMITS.producerMs) {
  const iterator = input[Symbol.asyncIterator]?.() ?? input[Symbol.iterator]?.();
  if (!iterator) throw new Error("invalid helper producer");
  let bytes = 0, chunks = 0, finished = false;
  try {
    for (;;) {
      const left = deadline - performance.now(); if (left <= 0) throw new Error("helper producer deadline exceeded; preserve partial evidence");
      let timer;
      const next = await Promise.race([Promise.resolve(iterator.next()), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("helper producer deadline exceeded; preserve partial evidence")), left); })]).finally(() => clearTimeout(timer));
      if (next.done) { finished = true; break; }
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || chunk.length < 1 || chunk.length > 65536 || ++chunks > 32768 || bytes + chunk.length > maximum) throw new Error("helper producer before-write byte/work limit exceeded");
      bytes += chunk.length; yield chunk;
    }
  } finally {
    if (!finished) {
      input.destroy?.();
      // Never wait beyond the producer deadline for a foreign iterator's return hook.
      try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* no disk writer remains */ }
    }
  }
}
export async function collectHelperBytes(input, maximum, deadline) {
  const parts = []; let size = 0;
  for await (const chunk of boundedHelperChunks(input, maximum, deadline)) { parts.push(Buffer.from(chunk)); size += chunk.length; }
  return Buffer.concat(parts, size);
}
export function readSourceHelperTuple(parentPath, target, sourceSha256) {
  if (process.platform === "win32") throw new Error("Windows lease helpers require fixed built code; source helper records are never adopted");
  const parent = pinHelperParent(parentPath);
  for (let i = 0; i < LEASE_HELPER_LIMITS.sourceRecords; i++) {
    const path = join(parent.physical, helperSourceRecordName(i));
    try { lstatSync(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const tuple = parseHelperTuple(readHelperFile(path, LEASE_HELPER_LIMITS.contractBytes, parent.check).bytes);
    if (tuple.target === target && tuple.sourceSha256 === sourceSha256) return tuple;
  }
  throw new Error("matching offline source helper contract unavailable; explicitly prepare source assets before starting the runner");
}
export function publishSourceHelperTuple(parentPath, expected) {
  if (process.platform === "win32") throw new Error("Windows lease helpers have no source-record installation producer");
  const tuple = validateHelperTuple(expected), parent = pinHelperParent(parentPath), bytes = helperContractBytes(tuple);
  if (bytes.length > LEASE_HELPER_LIMITS.contractBytes) throw new Error("source helper contract before-write limit");
  for (let i = 0; i < LEASE_HELPER_LIMITS.sourceRecords; i++) {
    const path = join(parent.physical, helperSourceRecordName(i)); parent.check();
    try {
      const old = parseHelperTuple(readHelperFile(path, LEASE_HELPER_LIMITS.contractBytes, parent.check).bytes);
      if (sameHelperTuple(old, tuple)) return path;
      continue;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    let fd;
    try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { if (error.code === "EEXIST") throw new Error("source helper contract concurrently reserved; preserve evidence and inspect the completed publication"); throw error; }
    try {
      parent.check(); const created = fstatSync(fd, { bigint: true });
      if (writeSync(fd, bytes) !== bytes.length) throw new Error("partial source contract; preserve evidence");
      const named = lstatSync(path, { bigint: true });
      if (!identity(created, named) || named.nlink !== 1n || named.isSymbolicLink()) throw new Error("source contract substituted");
      fsyncSync(fd); fchmodSync(fd, 0o444); parent.check(); return path;
    } finally { closeSync(fd); }
  }
  throw new Error("offline source helper contract budget exhausted (2 occupied records); preserve evidence and request operator inspection");
}
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const changed = (a, b) => !identity(a, b) || a.size !== b.size || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs || a.nlink !== b.nlink;
const inside = (root, path) => { const r = relative(root, path); return !r || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
function owner(stat) { return !process.getuid || stat.uid === 0n || stat.uid === BigInt(process.getuid()); }
function directory(stat) { if (!stat.isDirectory() || stat.isSymbolicLink() || !owner(stat)) throw new Error("unproved helper directory owner/identity"); }
function protect(chain) {
  if (!process.getuid) throw new Error("POSIX helper owner proof unavailable");
  let exposed = true;
  for (const { stat } of [...chain].reverse()) {
    directory(stat);
    if (exposed && (stat.mode & 0o022n) && !(stat.mode & 0o1000n)) throw new Error("helper ancestor permits foreign renames");
    if (stat.uid === BigInt(process.getuid()) && !(stat.mode & 0o077n)) exposed = false;
  }
}
/** Existing, protected parent only. This establishes read/new-exclusive-create authority, never deletion authority. */
export function pinHelperParent(parent, providerHome) {
  if (process.platform === "win32") throw new Error("Windows lease helpers have no file installation or helper parent");
  if (typeof parent !== "string" || !isAbsolute(parent)) throw new Error("helper installation parent must be absolute");
  const named = lstatSync(parent, { bigint: true }); directory(named);
  const physical = realpathSync(parent), chain = [];
  for (let path = physical;; path = dirname(path)) {
    const stat = lstatSync(path, { bigint: true }); directory(stat); chain.push({ path, stat });
    if (chain.length > LEASE_HELPER_LIMITS.ancestry) throw new Error("helper ancestry budget exhausted");
    if (path === dirname(path)) break;
  }
  if (!identity(named, chain[0].stat)) throw new Error("helper parent substituted");
  protect(chain);
  if (providerHome) {
    const canonical = resolve(providerHome, ".agent-manager", "provider-home-leases-v1");
    if (inside(canonical, resolve(parent)) || inside(canonical, physical)) throw new Error("canonical HOME evidence cannot contain helpers");
    try { const root = lstatSync(canonical, { bigint: true }); if (chain.some(x => identity(x.stat, root))) throw new Error("canonical HOME evidence alias"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const check = () => {
    const fresh = chain.map(x => { const stat = lstatSync(x.path, { bigint: true }); directory(stat); if (!identity(x.stat, stat)) throw new Error("helper ancestry substituted"); return { stat }; });
    const current = lstatSync(parent, { bigint: true }); directory(current);
    if (!identity(current, named)) throw new Error("helper named parent substituted");
    protect(fresh);
  };
  return { physical, check };
}
function inspectPosition(parent, root) {
  parent.check(); const stat = lstatSync(root, { bigint: true }); directory(stat);
  if (process.getuid && (stat.mode & 0o222n)) throw new Error("incomplete helper position");
  const dir = opendirSync(root, { bufferSize: 4 }); const names = [];
  try {
    for (let entry; (entry = dir.readSync());) {
      if (names.length >= 4 || Buffer.byteLength(entry.name) > 255) throw new Error("helper position inventory unavailable");
      names.push(entry.name);
    }
  } finally { dir.closeSync(); }
  if (names.length !== 2 || !names.includes("contract.json") || !(names.includes("lease-io") || names.includes("lease-io.dll"))) throw new Error("unknown/incomplete helper position");
  const check = () => { parent.check(); const now = lstatSync(root, { bigint: true }); directory(now); if (!identity(now, stat) || (process.getuid && (now.mode & 0o222n))) throw new Error("helper position changed"); };
  return check;
}
/** All eight names are charged atomically by exclusive mkdir, never by a separate allowance. */
export function helperAdmissionInventory(parentPath) {
  const parent = pinHelperParent(parentPath);
  for (let i = 0; i < LEASE_HELPER_LIMITS.positions; i++) {
    parent.check(); const root = join(parent.physical, helperPositionName(i)); let stat;
    try { stat = lstatSync(root, { bigint: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    // A foreign/file/link position is occupied, never traversed or adopted. Preexisting bytes are unknown.
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owner(stat)) continue;
    const dir = opendirSync(root, { bufferSize: 4 }); let count = 0;
    try { for (let item; (item = dir.readSync());) if (++count > 4 || Buffer.byteLength(item.name) > 255) throw new Error("helper admission inventory unavailable; preserve every occupied position"); }
    finally { dir.closeSync(); }
    parent.check(); if (!identity(stat, lstatSync(root, { bigint: true }))) throw new Error("helper admission inventory substituted");
  }
  parent.check(); return parent;
}
export function readHelperFile(path, maximum, check = () => {}, readOnly = true) {
  check(); const named = lstatSync(path, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || !owner(named) || named.size < 1n || named.size > BigInt(maximum) ||
      (readOnly && (named.mode & 0o222n))) throw new Error("unproved helper file/size/owner");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true }); if (changed(named, before)) throw new Error("helper file substituted while opening");
    const bytes = Buffer.alloc(Number(before.size) + 1); let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
    const after = fstatSync(fd, { bigint: true }), finalName = lstatSync(path, { bigint: true });
    if (used !== Number(before.size) || changed(before, after) || changed(before, finalName) || finalName.isSymbolicLink()) throw new Error("helper changed during bounded read");
    check(); return { bytes: bytes.subarray(0, used), stat: before };
  } finally { closeSync(fd); }
}
export function findInstalledHelper(parentPath, expected, providerHome) {
  const tuple = validateHelperTuple(expected), parent = pinHelperParent(parentPath, providerHome);
  for (let i = 0; i < LEASE_HELPER_LIMITS.positions; i++) {
    const root = join(parent.physical, helperPositionName(i));
    try { lstatSync(root); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    try {
      const check = inspectPosition(parent, root);
      const record = readHelperFile(join(root, "contract.json"), LEASE_HELPER_LIMITS.contractBytes, check);
      if (!sameHelperTuple(parseHelperTuple(record.bytes), tuple)) continue;
      const path = join(root, helperImageName(tuple)), image = readHelperFile(path, tuple.imageBytes, check);
      if (image.bytes.length !== tuple.imageBytes || helperDigest(image.bytes) !== tuple.imageSha256 ||
          (process.platform !== "win32" && !(image.stat.mode & 0o100n))) throw new Error("helper image does not match independent contract");
      return { root, path, bytes: image.bytes, tuple, verify() {
        check(); const current = readHelperFile(path, tuple.imageBytes, check);
        if (!identity(current.stat, image.stat) || current.bytes.length !== tuple.imageBytes || helperDigest(current.bytes) !== tuple.imageSha256) throw new Error("installed helper identity changed");
        const metadata = readHelperFile(join(root, "contract.json"), LEASE_HELPER_LIMITS.contractBytes, check);
        if (!identity(metadata.stat, record.stat) || !sameHelperTuple(parseHelperTuple(metadata.bytes), tuple)) throw new Error("installed helper contract changed");
        return current.bytes;
      } };
    } catch { parent.check(); /* Occupied unproven position is preserved. It confers no write/delete authority. */ }
  }
  throw new Error("matching installed lease helper unavailable; install the matching companion/offline source assets; preserve occupied positions");
}
/** Every successful/partial write belongs to one of eight exclusively reserved fixed positions. */
export async function installLeaseHelper(parentPath, expected, input, { beforeWrite = undefined, onPhase = undefined, deadline = performance.now() + LEASE_HELPER_LIMITS.producerMs } = {}) {
  if (process.platform === "win32") throw new Error("Windows lease helpers have no file installation producer");
  const started = performance.now();
  if (!Number.isFinite(deadline) || deadline <= started || deadline > started + LEASE_HELPER_LIMITS.producerMs) throw new Error("helper producer deadline exceeded or invalid");
  const tuple = validateHelperTuple(expected), parent = pinHelperParent(parentPath);
  try { return findInstalledHelper(parent.physical, tuple); } catch { parent.check(); }
  helperAdmissionInventory(parent.physical);
  let root;
  for (let i = 0; i < LEASE_HELPER_LIMITS.positions; i++) {
    parent.check(); const candidate = join(parent.physical, helperPositionName(i));
    try { mkdirSync(candidate, { mode: 0o700 }); root = candidate; break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!root) throw new Error("lease helper installation budget exhausted (8 occupied positions); preserve evidence and request operator inspection");
  const created = lstatSync(root, { bigint: true }); directory(created);
  onPhase?.("reserved");
  const check = () => { parent.check(); const now = lstatSync(root, { bigint: true }); directory(now); if (!identity(now, created)) throw new Error("new helper position substituted"); };
  const path = join(root, helperImageName(tuple)); check();
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  const file = fstatSync(fd, { bigint: true }); const hash = createHash("sha256"); let offset = 0, chunks = 0;
  try {
    for await (const chunk of boundedHelperChunks(input, tuple.imageBytes, deadline)) {
      if (!(chunk instanceof Uint8Array) || chunk.length === 0 || ++chunks > 32768) throw new Error("helper producer chunk/work budget exceeded");
      if (offset + chunk.length > tuple.imageBytes || offset + chunk.length > LEASE_HELPER_LIMITS.imageBytes) throw new Error("helper producer exceeds before-write byte budget");
      beforeWrite?.(offset, chunk.length); check();
      if (performance.now() >= deadline) throw new Error("helper producer deadline exceeded before write; preserve position");
      const name = lstatSync(path, { bigint: true }); const current = fstatSync(fd, { bigint: true });
      if (!identity(name, file) || !identity(current, file) || name.isSymbolicLink() || current.nlink !== 1n || current.size !== BigInt(offset)) throw new Error("new helper output identity changed");
      const wrote = writeSync(fd, chunk); if (wrote !== chunk.length) throw new Error("incomplete helper producer write; preserve position");
      offset += wrote; hash.update(chunk);
    }
    if (offset !== tuple.imageBytes || hash.digest("hex") !== tuple.imageSha256) throw new Error("incomplete/mismatched helper image; preserve position");
    check();
    const final = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (!identity(final, file) || !identity(named, file) || final.nlink !== 1n || final.size !== BigInt(offset) || named.isSymbolicLink()) throw new Error("helper output identity changed before completion");
    fsyncSync(fd); fchmodSync(fd, process.platform === "win32" ? 0o444 : 0o555);
  } finally { closeSync(fd); }
  onPhase?.("image-closed");
  check();
  const metadata = helperContractBytes(tuple); if (metadata.length > LEASE_HELPER_LIMITS.contractBytes) throw new Error("helper contract before-write budget");
  if (performance.now() >= deadline) throw new Error("helper producer deadline exceeded before contract; preserve position");
  const contract = join(root, "contract.json"), record = openSync(contract, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const recorded = fstatSync(record, { bigint: true }); check();
    if (writeSync(record, metadata) !== metadata.length) throw new Error("partial helper contract; preserve position");
    const named = lstatSync(contract, { bigint: true });
    if (!identity(recorded, named) || named.isSymbolicLink() || named.nlink !== 1n) throw new Error("helper contract substituted");
    fsyncSync(record); fchmodSync(record, 0o444);
  }
  finally { closeSync(record); }
  onPhase?.("contract-closed");
  check();
  if (process.platform !== "win32") {
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { check(); if (!identity(fstatSync(directory, { bigint: true }), created)) throw new Error("helper completion root substituted"); fchmodSync(directory, 0o555); }
    finally { closeSync(directory); }
  }
  const installed = findInstalledHelper(parent.physical, tuple);
  onPhase?.("completed"); return installed;
}
