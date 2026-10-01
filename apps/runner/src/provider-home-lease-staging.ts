import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, opendirSync, openSync, readSync, realpathSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const inside = (root: string, path: string) => {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};

function safeDirectory(identity: BigIntStats): void {
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("unsafe helper staging ancestry");
}

function protectedAncestry(chain: Array<{ identity: BigIntStats }>): void {
  if (!process.getuid) return;
  const uid = BigInt(process.getuid());
  let exposed = true;
  for (const { identity } of [...chain].reverse()) {
    if ((identity.uid !== 0n && identity.uid !== uid) ||
        (exposed && (identity.mode & 0o022n) && !(identity.mode & 0o1000n))) throw new Error("helper parent permits unprotected foreign renames");
    // A current-user private ancestor prevents other users reaching descendants even when
    // their directory modes are permissive. Its exposed ancestors must still be protected.
    if (identity.uid === uid && !(identity.mode & 0o077n)) exposed = false;
  }
}

function ancestors(path: string): Array<{ path: string; identity: BigIntStats }> {
  const result = [];
  for (let current = path;; current = dirname(current)) {
    const identity = lstatSync(current, { bigint: true });
    safeDirectory(identity);
    result.push({ path: current, identity });
    if (result.length > 256) throw new Error("helper staging ancestry limit exceeded");
    if (dirname(current) === current) { protectedAncestry(result); return result; }
  }
}

/** Resolve an existing bootstrap parent; canonical lease evidence is never a staging area. */
export function leaseHelperParent(path: string, providerHome?: string): string {
  if (!isAbsolute(path)) throw new Error("helper staging parent must be absolute");
  const named = lstatSync(path, { bigint: true });
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error("unsafe helper staging parent");
  const canonical = realpathSync(path), chain = ancestors(canonical);
  if (!same(named, chain[0]!.identity)) throw new Error("helper staging parent changed");
  if (providerHome) {
    const leaseRoot = resolve(providerHome, ".agent-manager", "provider-home-leases-v1");
    if (inside(leaseRoot, resolve(path)) || inside(leaseRoot, canonical)) throw new Error("lease evidence cannot hold bootstrap artifacts");
    try {
      const protectedRoot = lstatSync(leaseRoot, { bigint: true });
      if (!protectedRoot.isDirectory() || protectedRoot.isSymbolicLink()) throw new Error("unsafe canonical lease root");
      if (chain.some(entry => same(entry.identity, protectedRoot))) throw new Error("physical lease evidence alias cannot hold bootstrap artifacts");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return canonical;
}

/** Only fixed privately created files can be reused or cleaned; changes preserve evidence. */
export class LeaseHelperArtifact {
  readonly root: string;
  readonly path: string;
  private readonly parentChain: ReturnType<typeof ancestors>;
  private readonly rootIdentity: BigIntStats;
  private fileIdentity?: BigIntStats;
  private hash?: string;

  constructor(parent: string, private readonly name: "lease-io" | "lease-io.dll") {
    this.parentChain = ancestors(parent);
    this.root = mkdtempSync(join(parent, "wollipog-provider-home-lease-io-"));
    this.rootIdentity = lstatSync(this.root, { bigint: true });
    this.path = join(this.root, name);
    this.checkRoot();
  }

  private checkRoot(): void {
    const currentChain = [];
    for (const entry of this.parentChain) {
      const current = lstatSync(entry.path, { bigint: true });
      safeDirectory(current);
      if (!current.isDirectory() || current.isSymbolicLink() || !same(current, entry.identity)) throw new Error("helper parent ancestry changed");
      currentChain.push({ identity: current });
    }
    protectedAncestry(currentChain);
    const current = lstatSync(this.root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !same(current, this.rootIdentity) ||
        (process.getuid && (current.uid !== BigInt(process.getuid()) || (current.mode & 0o077n)))) throw new Error("private helper root changed");
    this.entries();
  }

  private entries(): number {
    const directory = opendirSync(this.root, { bufferSize: 2 });
    try {
      const first = directory.readSync();
      if ((first && first.name !== this.name) || directory.readSync()) throw new Error("unknown helper staging evidence");
      return first ? 1 : 0;
    } finally { directory.closeSync(); }
  }

  private bytes(): { bytes: Buffer; identity: BigIntStats } {
    this.checkRoot();
    const named = lstatSync(this.path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size < 1n || named.size > BigInt(MAX_HELPER_BYTES) ||
        (process.getuid && named.uid !== BigInt(process.getuid())) || (this.fileIdentity && !same(named, this.fileIdentity))) throw new Error("unsafe fixed helper file");
    const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!same(named, before) || before.size !== named.size || !before.isFile() || before.nlink !== 1n) throw new Error("helper file changed while opening");
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let used = 0;
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, null);
        if (!count) break;
        used += count;
      }
      const after = fstatSync(fd, { bigint: true }), finalName = lstatSync(this.path, { bigint: true });
      if (used !== Number(before.size) || !same(after, before) || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs || after.nlink !== 1n || !same(finalName, before) || finalName.isSymbolicLink() ||
          finalName.mtimeNs !== before.mtimeNs || finalName.ctimeNs !== before.ctimeNs) throw new Error("fixed helper changed during read");
      this.checkRoot();
      return { bytes: bytes.subarray(0, used), identity: after };
    } finally { closeSync(fd); }
  }

  capture(): { sha256: string; dev: bigint; ino: bigint } {
    const file = this.bytes();
    this.fileIdentity = file.identity;
    this.hash = digest(file.bytes);
    return { sha256: this.hash, dev: file.identity.dev, ino: file.identity.ino };
  }

  verify(): Uint8Array {
    if (!this.fileIdentity || !this.hash) throw new Error("unproven helper artifact");
    const file = this.bytes();
    if (digest(file.bytes) !== this.hash) throw new Error("immutable helper bytes changed");
    return file.bytes;
  }

  cleanup = (): void => {
    try {
      this.checkRoot();
      if (this.entries()) {
        this.verify();
        this.checkRoot();
        const current = lstatSync(this.path, { bigint: true });
        if (!this.fileIdentity || !same(current, this.fileIdentity) || current.nlink !== 1n || current.isSymbolicLink()) return;
        unlinkSync(this.path);
      }
      this.checkRoot();
      rmdirSync(this.root);
    } catch { /* Changed or unproven evidence is retained, including incomplete compiler output. */ }
  };
}
