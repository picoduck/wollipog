import { createHash, randomUUID, webcrypto } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const SHA256_KEY = /^[a-f0-9]{64}$/;

export class ArtifactBlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactBlobIntegrityError";
  }
}

export interface ArtifactBlobStore {
  put(key: string, bytes: Buffer): void;
  /** `put` for callers on the event loop: hashing, writes, flushes and the publishing link run on
   * the thread pool. `beforePublish` runs once the content is flushed and before it can appear at
   * its content path, so a caller can first make its pending-write record durable. The blob is
   * durable, verified and published when the promise resolves. */
  putDurable(key: string, bytes: Buffer, beforePublish?: () => Promise<void>): Promise<void>;
  read(key: string, expectedSize: number): Buffer;
  delete(key: string): boolean;
  readonly rootPath: string | null;
}

export function artifactBlobSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 on the thread pool, so a multi-megabyte digest does not block the event loop. */
export async function artifactBlobSha256Async(bytes: Buffer): Promise<string> {
  // Node buffers here are never backed by a SharedArrayBuffer.
  return Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).toString("hex");
}

export function assertArtifactBlobKey(key: string): void {
  if (!SHA256_KEY.test(key)) throw new ArtifactBlobIntegrityError("artifact blob key is invalid");
}

export function defaultArtifactBlobRoot(databasePath: string): string {
  if (databasePath === ":memory:") throw new Error("in-memory databases do not have a default blob root");
  const absolute = resolve(databasePath);
  return join(dirname(absolute), `${basename(absolute)}.artifacts`);
}

export function artifactBlobFilePath(root: string, key: string): string {
  assertArtifactBlobKey(key);
  return join(resolve(root), "sha256", key.slice(0, 2), key);
}

function verifyBytes(key: string, bytes: Buffer, expectedSize: number): void {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || bytes.byteLength !== expectedSize) {
    throw new ArtifactBlobIntegrityError("artifact blob size does not match metadata");
  }
  if (artifactBlobSha256(bytes) !== key) {
    throw new ArtifactBlobIntegrityError("artifact blob digest does not match its content key");
  }
}

async function verifyBytesAsync(key: string, bytes: Buffer, expectedSize: number): Promise<void> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || bytes.byteLength !== expectedSize) {
    throw new ArtifactBlobIntegrityError("artifact blob size does not match metadata");
  }
  if (await artifactBlobSha256Async(bytes) !== key) {
    throw new ArtifactBlobIntegrityError("artifact blob digest does not match its content key");
  }
}

export class MemoryArtifactBlobStore implements ArtifactBlobStore {
  readonly rootPath = null;
  private readonly blobs = new Map<string, Buffer>();

  put(key: string, bytes: Buffer): void {
    assertArtifactBlobKey(key);
    verifyBytes(key, bytes, bytes.byteLength);
    const existing = this.blobs.get(key);
    if (existing) {
      verifyBytes(key, existing, bytes.byteLength);
      if (!existing.equals(bytes)) throw new ArtifactBlobIntegrityError("artifact blob key collision");
      return;
    }
    this.blobs.set(key, Buffer.from(bytes));
  }

  async putDurable(key: string, bytes: Buffer, beforePublish?: () => Promise<void>): Promise<void> {
    assertArtifactBlobKey(key);
    await verifyBytesAsync(key, bytes, bytes.byteLength);
    await beforePublish?.();
    this.put(key, bytes);
  }

  read(key: string, expectedSize: number): Buffer {
    assertArtifactBlobKey(key);
    const bytes = this.blobs.get(key);
    if (!bytes) throw new ArtifactBlobIntegrityError("artifact blob is missing");
    verifyBytes(key, bytes, expectedSize);
    return Buffer.from(bytes);
  }

  delete(key: string): boolean {
    assertArtifactBlobKey(key);
    return this.blobs.delete(key);
  }
}

export class FileArtifactBlobStore implements ArtifactBlobStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
    const contentRoot = join(this.rootPath, "sha256");
    mkdirSync(contentRoot, { recursive: true, mode: 0o700 });
    this.assertDirectory(this.rootPath);
    this.assertDirectory(contentRoot);
    try { chmodSync(this.rootPath, 0o700); } catch { /* Windows and read-only filesystems may ignore POSIX modes. */ }
    try { chmodSync(contentRoot, 0o700); } catch { /* Best effort on Windows. */ }
  }

  private assertDirectory(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ArtifactBlobIntegrityError("artifact blob directory is not a real directory");
    }
  }

  private path(key: string): string {
    return artifactBlobFilePath(this.rootPath, key);
  }

  private flushDirectory(path: string): void {
    let handle: number | null = null;
    try {
      handle = openSync(path, "r");
      fsyncSync(handle);
    } catch {
      // Windows and some filesystems do not permit opening directories. The file itself was
      // flushed before publication; directory flush is an additional durability barrier where
      // the host supports it.
    } finally {
      if (handle !== null) {
        try { closeSync(handle); } catch { /* Directory flush is best effort. */ }
      }
    }
  }

  put(key: string, bytes: Buffer): void {
    assertArtifactBlobKey(key);
    verifyBytes(key, bytes, bytes.byteLength);
    const finalPath = this.path(key);
    const parent = dirname(finalPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    this.assertDirectory(parent);
    try { chmodSync(parent, 0o700); } catch { /* Best effort on Windows. */ }

    if (existsSync(finalPath)) {
      const existing = this.read(key, bytes.byteLength);
      if (!existing.equals(bytes)) throw new ArtifactBlobIntegrityError("artifact blob key collision");
      try { chmodSync(finalPath, 0o600); } catch { /* Best effort on Windows. */ }
      // A concurrent putDurable may have linked this path without flushing its directory yet.
      this.flushDirectory(parent);
      return;
    }

    const temporaryPath = join(parent, `.${key}.${randomUUID()}.tmp`);
    let handle: number | null = null;
    try {
      handle = openSync(temporaryPath, "wx", 0o600);
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(handle, bytes, offset);
      fsyncSync(handle);
      closeSync(handle);
      handle = null;
      try {
        // A same-directory hard link is an atomic no-replace publication. Unlike POSIX rename,
        // it cannot silently overwrite a path created between the existence check and publish.
        linkSync(temporaryPath, finalPath);
        unlinkSync(temporaryPath);
        this.flushDirectory(parent);
      } catch (error) {
        if (!existsSync(finalPath)) throw error;
        const existing = this.read(key, bytes.byteLength);
        if (!existing.equals(bytes)) throw new ArtifactBlobIntegrityError("artifact blob key collision");
        unlinkSync(temporaryPath);
        this.flushDirectory(parent);
      }
      try { chmodSync(finalPath, 0o600); } catch { /* Best effort on Windows. */ }
      this.read(key, bytes.byteLength);
    } catch (error) {
      if (handle !== null) closeSync(handle);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }

  private async assertDirectoryAsync(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ArtifactBlobIntegrityError("artifact blob directory is not a real directory");
    }
  }

  private async flushDirectoryAsync(path: string): Promise<void> {
    let handle: FileHandle | null = null;
    try {
      handle = await open(path, "r");
      await handle.sync();
    } catch {
      // Best effort for the same reasons as flushDirectory.
    } finally {
      try { await handle?.close(); } catch { /* Directory flush is best effort. */ }
    }
  }

  /** Verify an already-published blob and flush it and its directory: another writer may have
   * linked it without completing its own directory flush. */
  private async adoptExisting(key: string, finalPath: string, expectedSize: number): Promise<void> {
    const stat = await lstat(finalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ArtifactBlobIntegrityError("artifact blob is not a regular file");
    }
    if (stat.size !== expectedSize) throw new ArtifactBlobIntegrityError("artifact blob size does not match metadata");
    // The digest equals the key, which is the digest of the caller's bytes: same content.
    await verifyBytesAsync(key, await readFile(finalPath), expectedSize);
    try { await chmod(finalPath, 0o600); } catch { /* Best effort on Windows. */ }
    const handle = await open(finalPath, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await this.flushDirectoryAsync(dirname(finalPath));
  }

  async putDurable(key: string, bytes: Buffer, beforePublish?: () => Promise<void>): Promise<void> {
    assertArtifactBlobKey(key);
    await verifyBytesAsync(key, bytes, bytes.byteLength);
    const finalPath = this.path(key);
    const parent = dirname(finalPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await this.assertDirectoryAsync(parent);
    try { await chmod(parent, 0o700); } catch { /* Best effort on Windows. */ }

    const published = async () => {
      try {
        await lstat(finalPath);
        return true;
      } catch {
        return false;
      }
    };
    if (await published()) {
      await this.adoptExisting(key, finalPath, bytes.byteLength);
      return;
    }

    const temporaryPath = join(parent, `.${key}.${randomUUID()}.tmp`);
    let handle: FileHandle | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await beforePublish?.();
      try {
        // The same no-replace publication as put.
        await link(temporaryPath, finalPath);
      } catch (error) {
        if (!(await published())) throw error;
        await unlink(temporaryPath);
        await this.adoptExisting(key, finalPath, bytes.byteLength);
        return;
      }
      await unlink(temporaryPath);
      await this.flushDirectoryAsync(parent);
      try { await chmod(finalPath, 0o600); } catch { /* Best effort on Windows. */ }
      const stat = await lstat(finalPath);
      if (!stat.isFile() || stat.size !== bytes.byteLength) {
        throw new ArtifactBlobIntegrityError("artifact blob size does not match metadata");
      }
    } catch (error) {
      if (handle !== null) {
        try { await handle.close(); } catch { /* Already failing. */ }
      }
      try { await unlink(temporaryPath); } catch { /* Already published or never created. */ }
      throw error;
    }
  }

  read(key: string, expectedSize: number): Buffer {
    assertArtifactBlobKey(key);
    const path = this.path(key);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new ArtifactBlobIntegrityError("artifact blob is missing");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ArtifactBlobIntegrityError("artifact blob is not a regular file");
    }
    if (stat.size !== expectedSize) throw new ArtifactBlobIntegrityError("artifact blob size does not match metadata");
    const bytes = readFileSync(path);
    verifyBytes(key, bytes, expectedSize);
    return bytes;
  }

  delete(key: string): boolean {
    assertArtifactBlobKey(key);
    const path = this.path(key);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ArtifactBlobIntegrityError("artifact blob is not a regular file");
      }
      unlinkSync(path);
      return true;
    } catch (error) {
      if (!existsSync(path)) return false;
      throw error;
    }
  }
}
