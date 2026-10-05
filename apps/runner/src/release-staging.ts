/**
 * One fail-closed generic updater attempt. A previous process's metadata is never cleanup
 * authority: an interrupted attempt blocks admission until operator-authorized remediation.
 * This Linux/private-directory profile is not a hostile same-UID capability boundary, an
 * extracted-archive limit, or a practical disk quota. Keep it separate from native lease caches.
 */
import { randomUUID } from "node:crypto";
import {
  constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  opendirSync, readSync, realpathSync, rmdirSync, statfsSync, unlinkSync, writeSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { ReleaseAsset } from "./release-assets.js";

/** Complete injectable identity/syscall seam; production never uses a synthetic host UID. */
export const stagingFilesystem = {
  platform: process.platform,
  euid: (): number | undefined => process.geteuid?.(),
  lstat: (path: string): BigIntStats => lstatSync(path, { bigint: true }),
  fstat: (fd: number): BigIntStats => fstatSync(fd, { bigint: true }),
  realpath: realpathSync,
  type: (path: string): bigint => statfsSync(path, { bigint: true }).type,
  open: openSync, close: closeSync, sync: fsyncSync, mkdir: mkdirSync,
  directory: opendirSync, link: linkSync, unlink: unlinkSync, rmdir: rmdirSync,
  write: writeSync, read: readSync,
};
export type StagingFilesystem = typeof stagingFilesystem;
type Receipt = { path: string; fd: number; stat: BigIntStats; names: Set<string> };
const LOCAL_TYPES = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n]);
const OWNER = "owner.json";
const SLOT = "download-attempt-v1";

export function validateSelectedAssets(assets: ReleaseAsset[]): void {
  if (assets.length === 0 || assets.length > 4) throw new Error("release staging needs one to four selected assets");
  const names = new Set<string>();
  let total = 0;
  for (const asset of assets) {
    if (!/^(?:SHA256SUMS|wollipog-web\.tar\.gz|wollipog-(?:runner|control-plane)-(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-gnu|pc-windows-msvc)(?:\.exe)?)$/u.test(asset.name) || names.has(asset.name)) {
      throw new Error("release staging has an unknown or duplicate selected asset name");
    }
    if (!asset.digest || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)) throw new Error(`${asset.name} has no valid GitHub SHA-256 digest; refusing an unverified download`);
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !Number.isSafeInteger(total += asset.size)) {
      throw new Error("release staging requires positive safe declared asset sizes and a safe total");
    }
    names.add(asset.name);
  }
}

function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
}
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

export class ReleaseStaging {
  readonly path: string;
  private readonly nonce = randomUUID();
  private readonly chain: Array<{ path: string; stat: BigIntStats }> = [];
  private readonly directories: Receipt[] = [];
  private readonly files: Receipt[] = [];
  private readonly selected: Map<string, { size: number; digest: string | null }>;
  private readonly startedAssets = new Set<string>();
  private parentCreated = false;
  private parent: Receipt | undefined;
  private reservation: Receipt | undefined;
  private web: BigIntStats | undefined;
  private initialized = false;
  private ownerRecord: Buffer | undefined;
  private uncertain = false;
  private closed = false;
  private readonly uid: bigint;

  private constructor(
    private readonly dataDir: string,
    private readonly context: { mode: "user" | "system"; serviceUid: number | null },
    assets: ReleaseAsset[],
    private readonly fs: StagingFilesystem,
  ) {
    const uid = fs.euid();
    if (fs.platform !== "linux" || !Number.isSafeInteger(uid) || uid! < 0 || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
      throw new Error("release staging requires the supported Linux filesystem identity profile");
    }
    this.uid = BigInt(uid!);
    validateSelectedAssets(assets);
    this.selected = new Map(assets.map((asset) => [asset.name, { size: asset.size, digest: asset.digest }]));
    this.path = join(dataDir, "upgrades", SLOT);
  }

  static create(dataDir: string, context: { mode: "user" | "system"; serviceUid: number | null }, tag: string, assets: ReleaseAsset[], fs: StagingFilesystem = stagingFilesystem): ReleaseStaging {
    const attempt = new ReleaseStaging(dataDir, context, assets, fs);
    try {
      attempt.initialize(tag, assets);
      return attempt;
    } catch (error) {
      const cleanup = attempt.finish();
      throw new Error(`${(error as Error).message}${cleanup ? `; ${cleanup}` : ""}`, { cause: error });
    }
  }

  private pin(path: string, directory: boolean, fd?: number): Receipt {
    const handle = fd ?? this.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
    try {
      const stat = this.fs.fstat(handle);
      const named = this.fs.lstat(path);
      if (!same(stat, named) || stat.ino <= 0n || stat.dev < 0n || stat.uid !== this.uid ||
          (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n) ||
          (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) {
        throw new Error(`release staging identity or private permissions unavailable: ${path}`);
      }
      const receipt = { path, fd: handle, stat, names: new Set([path]) };
      if (directory) this.directories.push(receipt); else this.files.push(receipt);
      return receipt;
    } catch (error) {
      this.fs.close(handle);
      throw error;
    }
  }

  private initialize(tag: string, assets: ReleaseAsset[]): void {
    if (!isAbsolute(this.dataDir) || this.fs.realpath(this.dataDir) !== resolve(this.dataDir)) throw new Error("release staging requires an existing canonical absolute data directory without symlinks");
    if (this.context.mode === "system" && (this.uid !== 0n || !Number.isSafeInteger(this.context.serviceUid) || this.context.serviceUid! < 0)) throw new Error("system release staging requires root and the installed service UID");
    const trusted = new Set([0n, this.uid, ...(this.context.mode === "system" ? [BigInt(this.context.serviceUid!)] : [])]);
    const paths: string[] = [];
    for (let path = resolve(this.dataDir);; path = dirname(path)) {
      paths.unshift(path);
      if (path === parse(path).root) break;
    }
    for (const [index, path] of paths.entries()) {
      const stat = this.fs.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino <= 0n || stat.dev < 0n) throw new Error(`release staging refuses a symlink or unavailable directory identity: ${path}`);
      if (index === paths.length - 1) {
        const owners = this.context.mode === "system" ? new Set([0n, BigInt(this.context.serviceUid!)]) : new Set([this.uid]);
        if (!owners.has(stat.uid) || (stat.mode & 0o7777n) !== 0o700n) throw new Error("release staging data directory must have its expected owner and private 0700 permissions");
      } else if (!trusted.has(stat.uid) || (stat.mode & 0o6000n) !== 0n ||
          ((stat.mode & 0o022n) !== 0n && ((stat.mode & 0o1000n) === 0n || !trusted.has(this.fs.lstat(paths[index + 1]!).uid)))) {
        throw new Error(`release staging refuses unsafe ancestor ownership or writable permissions: ${path}`);
      }
      this.chain.push({ path, stat });
    }
    if (!LOCAL_TYPES.has(this.fs.type(this.dataDir))) throw new Error("release staging refuses an unsupported filesystem");
    // The dataDir may belong to the system service account; pin it without pretending root owns it.
    const dataFd = this.fs.open(this.dataDir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    let dataStat: BigIntStats;
    try { dataStat = this.fs.fstat(dataFd); }
    catch (error) { this.fs.close(dataFd); throw error; }
    if (!same(dataStat, this.chain[this.chain.length - 1]!.stat)) { this.fs.close(dataFd); throw new Error("release staging data directory was substituted"); }
    this.directories.push({ path: this.dataDir, fd: dataFd, stat: dataStat, names: new Set() });
    this.assertChain();
    const parent = dirname(this.path);
    try { this.fs.mkdir(parent, { mode: 0o700 }); this.parentCreated = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.parent = this.pin(parent, true);
    if (!LOCAL_TYPES.has(this.fs.type(parent))) throw new Error("release staging parent filesystem is unsupported");
    if (this.parentCreated) this.fs.sync(dataFd);
    this.inventory(parent, new Set());
    this.assertChain();
    this.fs.mkdir(this.path, { mode: 0o700 });
    this.reservation = this.pin(this.path, true);
    if (!LOCAL_TYPES.has(this.fs.type(this.path))) throw new Error("release staging attempt filesystem is unsupported");
    this.fs.sync(this.parent.fd);
    this.inventory(parent, new Set([SLOT]));
    const marker = this.createFile(OWNER);
    const record = Buffer.from(JSON.stringify({ schema: 1, nonce: this.nonce, tag,
      root: this.identity(dataStat), parent: this.identity(this.parent.stat), attempt: this.identity(this.reservation.stat),
      assets: assets.map(({ name, size, digest }) => ({ name, size, digest })),
    }) + "\n");
    let offset = 0;
    while (offset < record.length) {
      const count = this.fs.write(marker.fd, record, offset, record.length - offset);
      if (count <= 0) throw new Error("release staging owner record write made no progress");
      offset += count;
    }
    this.fs.sync(marker.fd);
    const actual = Buffer.alloc(record.length);
    if (this.fs.read(marker.fd, actual, 0, actual.length, 0) !== record.length || !actual.equals(record) || this.fs.fstat(marker.fd).size !== BigInt(record.length)) throw new Error("release staging owner record is incomplete");
    this.assertFile(marker);
    this.fs.sync(this.reservation.fd);
    this.ownerRecord = record;
    this.initialized = true;
  }

  private identity(stat: BigIntStats): Record<string, string> { return { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), mode: String(stat.mode) }; }

  private inventory(path: string, allowed: Set<string>): void {
    const seen = new Set<string>();
    const dir = this.fs.directory(path);
    try {
      for (let i = 0; i <= allowed.size; i++) {
        const entry = dir.readSync();
        if (!entry) {
          if (seen.size !== allowed.size) throw new Error("release staging inventory is incomplete");
          return;
        }
        if (!allowed.has(entry.name) || seen.has(entry.name)) throw new Error("release staging is occupied or has unknown entries; inspect staging and obtain operator-authorized remediation before retrying");
        seen.add(entry.name);
      }
      throw new Error("release staging inventory exceeded its known entry bound");
    } finally { dir.closeSync(); }
  }

  assertChain(): void {
    if (this.closed || this.uncertain) throw new Error("release staging identity is unavailable or uncertain");
    for (const { path, stat } of this.chain) if (!same(stat, this.fs.lstat(path))) throw new Error("release staging ancestor was substituted");
    for (const receipt of this.directories) if (!same(receipt.stat, this.fs.fstat(receipt.fd)) || !same(receipt.stat, this.fs.lstat(receipt.path))) throw new Error("release staging directory was substituted");
    const marker = this.files.find((file) => file.path === join(this.path, OWNER));
    if (this.initialized && marker?.names.size) {
      this.assertFile(marker);
      const expected = this.ownerRecord!;
      if (this.fs.fstat(marker.fd).size !== BigInt(expected.length)) throw new Error("release staging immutable owner record changed");
      const bytes = Buffer.alloc(expected.length);
      if (this.fs.read(marker.fd, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.equals(expected)) throw new Error("release staging immutable owner record changed");
    }
  }

  private createFile(name: string): Receipt {
    this.assertChain();
    const path = join(this.path, name);
    const fd = this.fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { return this.pin(path, false, fd); }
    catch (error) { this.uncertain = true; throw error; }
  }

  createPartial(asset: Pick<ReleaseAsset, "name" | "size" | "digest">, destination: string): { fd: number; path: string; size: number } {
    const selected = this.selected.get(asset.name);
    if (!this.initialized || !selected || asset.size !== selected.size || asset.digest !== selected.digest || destination !== join(this.path, asset.name)) throw new Error("release download destination or metadata is outside the initialized owned attempt");
    if (this.startedAssets.has(asset.name)) throw new Error("release asset was already admitted in this attempt");
    this.assertChain();
    this.startedAssets.add(asset.name);
    const receipt = this.createFile(`${asset.name}.${this.nonce}.partial`);
    return { fd: receipt.fd, path: receipt.path, size: selected.size };
  }

  private assertFile(receipt: Receipt): void {
    const stat = this.fs.fstat(receipt.fd);
    if (!same(receipt.stat, stat) || !stat.isFile() || stat.nlink !== BigInt(receipt.names.size)) throw new Error("release staging file identity or link count changed");
    for (const name of receipt.names) if (!same(stat, this.fs.lstat(name))) throw new Error("release staging file was substituted");
  }

  publish(partial: string, destination: string): void {
    this.assertChain();
    const receipt = this.files.find((file) => file.path === partial)!;
    this.assertFile(receipt);
    this.fs.sync(receipt.fd);
    this.fs.link(partial, destination);
    receipt.names.add(destination);
    this.assertFile(receipt);
    this.assertChain();
    this.fs.unlink(partial);
    receipt.names.delete(partial);
    this.assertFile(receipt);
    try { this.fs.sync(this.reservation!.fd); }
    catch (error) { this.uncertain = true; throw error; }
  }

  verifyPartial(partial: string, size: number): void {
    this.assertChain();
    const receipt = this.files.find((file) => file.path === partial);
    if (!receipt) throw new Error("release download has no current file receipt");
    this.assertFile(receipt);
    if (this.fs.fstat(receipt.fd).size !== BigInt(size)) throw new Error("release download file length changed");
  }

  private knownNames(): Set<string> {
    return new Set([...this.files.flatMap((file) => [...file.names].map((name) => name.slice(this.path.length + 1))), ...(this.web ? ["web"] : [])]);
  }

  captureWeb(): void {
    this.assertChain();
    const stat = this.fs.lstat(join(this.path, "web"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid) throw new Error("release staging web root identity is unavailable");
    this.web = stat;
    this.inventory(this.path, this.knownNames());
  }

  beforeMove(source: string): void {
    this.assertChain();
    this.inventory(this.path, this.knownNames());
    if (source === join(this.path, "web")) {
      if (!this.web || !same(this.web, this.fs.lstat(source))) throw new Error("release staging web root was substituted");
    } else {
      const receipt = this.files.find((file) => file.names.has(source));
      if (!receipt) throw new Error("release staging move has no current ownership receipt");
      this.assertFile(receipt);
    }
  }

  executable(path: string, chmod: () => void): void {
    this.beforeMove(path);
    const receipt = this.files.find((file) => file.names.has(path))!;
    chmod();
    const stat = this.fs.fstat(receipt.fd);
    if (stat.dev !== receipt.stat.dev || stat.ino !== receipt.stat.ino || stat.uid !== receipt.stat.uid ||
        (stat.mode & 0o7777n) !== 0o755n || !same(stat, this.fs.lstat(path))) throw new Error("release staging executable permission change has uncertain identity");
    receipt.stat = stat;
  }

  moved(source: string): void {
    // Call only after the existing host move succeeds; missing names without a receipt refuse.
    if (source === join(this.path, "web")) this.web = undefined;
    else {
      const receipt = this.files.find((file) => file.names.has(source))!;
      receipt.names.delete(source);
    }
  }

  /** Returns a bounded diagnostic. Unknown evidence is never recursively removed. */
  finish(): string | null {
    if (this.closed) return null;
    let problem: string | null = null;
    try {
      this.assertChain();
      if (this.parentCreated && !this.parent) throw new Error("created upgrades parent has no trustworthy receipt");
      if (this.reservation) {
        this.inventory(this.path, this.knownNames());
        if (this.web) throw new Error("extracted web staging retained; operator-authorized remediation is required before retrying");
        for (const file of this.files) if (file.names.size) this.assertFile(file);
        for (const file of [...this.files].sort((a, b) => Number(a.path.endsWith(`/${OWNER}`)) - Number(b.path.endsWith(`/${OWNER}`)))) {
          this.assertChain();
          if (file.names.size) this.assertFile(file);
          for (const name of [...file.names]) {
            this.assertChain(); this.assertFile(file);
            this.fs.unlink(name); file.names.delete(name);
          }
        }
        this.assertChain();
        this.fs.rmdir(this.path);
        this.directories.splice(this.directories.indexOf(this.reservation), 1);
        this.fs.close(this.reservation.fd);
        this.reservation = undefined;
        this.fs.sync(this.parent!.fd);
      } else {
        // A created but unreceipted reservation must not be mistaken for an empty parent.
        if (this.parent) this.inventory(this.parent.path, new Set());
      }
      if (this.parentCreated && this.parent) {
        this.assertChain();
        this.inventory(this.parent.path, new Set());
        this.fs.rmdir(this.parent.path);
        this.directories.splice(this.directories.indexOf(this.parent), 1);
        this.fs.close(this.parent.fd);
        this.parent = undefined;
        this.fs.sync(this.directories[0]!.fd);
      }
    } catch (error) {
      problem = `release staging retained or retirement uncertain: ${(error as Error).message.slice(0, 500)}`;
    } finally {
      for (const file of this.files) { try { this.fs.close(file.fd); } catch { problem ??= "release staging handle closure failed"; } }
      for (const directory of this.directories) { try { this.fs.close(directory.fd); } catch { problem ??= "release staging handle closure failed"; } }
      this.closed = true;
    }
    return problem;
  }
}
