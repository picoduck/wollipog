import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { linuxCgroupHelper } from "./linux-cgroup-helper.js";
import { currentCgroupDirectory, type LinuxCgroupBoundary, type LinuxCgroupIdentity } from "./linux-cgroup.js";
import { isLeaseContainmentEvidence } from "./provider-home-lease-containment.js";
import { linuxLeaseProcessProbe } from "./provider-home-lease-evidence.js";

type Process = { pid?: number; once(event: "close", callback: () => void): unknown };
export interface ProviderProcessOwner { prepare(): { spawned(child: Process, containment?: LinuxCgroupBoundary): void; aborted(): void } }
interface Ownership {
  version: 1 | 2; runnerId: string; generation: string; sessionId: string;
  bootId: string; uid: number; runnerPid: number; runnerStartTime: string;
  pid?: number; startTime?: string;
  containment?: Readonly<LinuxCgroupIdentity>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const START = /^[1-9][0-9]{0,19}$/u;
const MAX_RECORDS = 1024;

/** Private launch journal, never a browser projection or an agent operation. Missing records
 * grant no authority; the existing HOME lease proof continues to reject unknown survivors. */
export class ProviderProcessOwnership {
  private readonly generation = randomUUID();
  private readonly probe = linuxLeaseProcessProbe();
  private readonly uid = process.getuid?.();
  private recoveryStarted = false;

  constructor(private readonly directory: string, private readonly runnerId: string) {
    if (process.platform !== "linux") return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.checkDirectory();
  }

  private checkDirectory(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o777) !== 0o700) {
      throw new Error("provider ownership directory is not private");
    }
  }

  private read(file: string): string {
    this.checkDirectory();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== this.uid || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o777) !== 0o600) {
        throw new Error("provider ownership record is not private");
      }
      const bytes = Buffer.alloc(4097);
      const used = readSync(fd, bytes, 0, bytes.length, 0);
      const after = fstatSync(fd);
      if (used !== stat.size || used > 4096 || after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) {
        throw new Error("provider ownership record changed during read");
      }
      return bytes.subarray(0, used).toString("utf8");
    } finally { closeSync(fd); }
  }

  private files(): string[] {
    this.checkDirectory();
    const files: string[] = [];
    const directory = opendirSync(this.directory, { bufferSize: 32 });
    try {
      while (files.length <= MAX_RECORDS) {
        const next = directory.readSync();
        if (!next) break;
        files.push(next.name);
      }
      return files;
    } finally { directory.closeSync(); }
  }

  private publish(file: string, record: Ownership, initial: boolean): void {
    this.checkDirectory();
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > 4096) throw new Error("provider ownership record exceeds its private bound");
    const target = initial ? file : `${file}.pending`;
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    if (!initial) renameSync(target, file);
    const parent = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }

  private discard(file: string, expected: readonly string[]): boolean {
    try {
      if (!expected.includes(this.read(file))) return false;
      unlinkSync(file);
      return true;
    } catch { return false; } // Changed or unreadable evidence is retained.
  }

  owner(sessionId: string): ProviderProcessOwner | undefined {
    if (!this.probe || this.uid === undefined || !/^[\w.-]{1,200}$/u.test(sessionId)) return undefined;
    const probe = this.probe, uid = this.uid;
    return { prepare: () => {
      if (this.files().length >= MAX_RECORDS) throw new Error("provider ownership journal is full; preserve the evidence");
      const runnerStartTime = probe.startTime(process.pid);
      if (!runnerStartTime) throw new Error("provider owner kernel identity is unavailable");
      const record: Ownership = { version: 1, runnerId: this.runnerId, generation: this.generation,
        sessionId, bootId: probe.bootId(), uid, runnerPid: process.pid, runnerStartTime };
      const file = join(this.directory, `${randomUUID()}.json`);
      // An interrupted admission stays unproven. Never infer absence from an incomplete write.
      this.publish(file, record, true);
      const published = [JSON.stringify(record)];
      const cleanup = () => {
        this.discard(file, published);
        this.discard(`${file}.pending`, published);
      };
      return { spawned: (child, containment) => {
        // Even ENOENT (no pid) and a failed completion write get a close notification.
        if (containment) containment.onReleased(cleanup);
        else child.once("close", cleanup);
        // This synchronous snapshot is taken before the event loop can reap/recycle our child.
        try {
          const startTime = child.pid ? probe.startTime(child.pid) : null;
          // Preserve spawn's asynchronous ENOENT/error contract. The intent remains unproven.
          if (!child.pid || !startTime) return;
          // Version 2 is rejected by old readers rather than granting root-only retirement
          // authority over a tree whose evidence must outlive that root.
          const complete: Ownership = { ...record, pid: child.pid, startTime,
            ...(containment ? { version: 2, containment: containment.identity } : {}) };
          published.push(JSON.stringify(complete));
          this.publish(file, complete, false);
        } catch { /* Interrupted evidence is retained, never promoted into signal authority. */ }
      }, aborted: cleanup };
    } };
  }

  /** Called exactly once during trusted runner startup, before its connection admits commands.
   * No management route exposes this operation, including to a root's own credential. */
  async recover(): Promise<{ retired: number; retained: number; pruned: number; sessions: string[] }> {
    if (this.recoveryStarted) throw new Error("provider startup retirement already ran");
    this.recoveryStarted = true;
    const result = { retired: 0, retained: 0, pruned: 0, sessions: [] as string[] };
    if (!this.probe || this.uid === undefined) return result;
    this.checkDirectory();
    const files = this.files();
    const deadline = performance.now() + 30_000;
    for (const [index, name] of files.entries()) {
      if (performance.now() >= deadline) { result.retained += files.length - index; break; }
      // A complete private pending write has the same authority as its renamed publication.
      if (!/\.json(?:\.pending)?$/u.test(name) || !UUID.test(name.replace(/\.json(?:\.pending)?$/u, ""))) { result.retained++; continue; }
      const file = join(this.directory, name);
      let bytes: string, record: Ownership;
      try {
        bytes = this.read(file);
        record = JSON.parse(bytes) as Ownership;
        if (!this.valid(record) || record.runnerId !== this.runnerId || record.uid !== this.uid ||
            record.generation === this.generation || record.runnerPid === process.pid ||
            record.pid === process.pid) { result.retained++; continue; }
        if (record.bootId === this.probe.bootId() && this.probe.startTime(record.runnerPid) === record.runnerStartTime) {
          result.retained++; continue;
        }
      } catch { result.retained++; continue; }
      if (!record.pid || !record.startTime) {
        // No signal authority ever existed. Removing obsolete metadata does not remove the
        // independent HOME evidence: an unrecorded survivor still blocks its lease recovery.
        if (this.discard(file, [bytes])) { result.pruned++; continue; }
        result.retained++; continue;
      }
      // The helper opens a pidfd FIRST, then rechecks boot, UID, root start time and prior
      // runner liveness. It never signals a numeric PID. No record bytes enter argv or logs.
      const retired = await this.retire(record);
      if ((retired === "retired" || retired === "gone") && this.discard(file, [bytes])) {
        if (retired === "gone") result.pruned++;
        else { result.retired++; result.sessions.push(record.sessionId); }
        continue;
      }
      result.retained++;
    }
    result.sessions = [...new Set(result.sessions)];
    return result;
  }

  private valid(v: Ownership): boolean {
    return !!v && (v.version === 1 && v.containment === undefined || v.version === 2 &&
      v.pid !== undefined && v.startTime !== undefined &&
      isLeaseContainmentEvidence(v.containment) && v.containment.kind === "linux-cgroup-v2" &&
      !Object.hasOwn(v.containment, "unit") && v.containment.bootId === v.bootId) && typeof v.runnerId === "string" && typeof v.sessionId === "string" &&
      /^[\w.-]{1,200}$/u.test(v.sessionId) && typeof v.generation === "string" && UUID.test(v.generation) &&
      typeof v.bootId === "string" && UUID.test(v.bootId) && Number.isSafeInteger(v.uid) && v.uid >= 0 &&
      Number.isSafeInteger(v.runnerPid) && v.runnerPid > 1 && START.test(v.runnerStartTime) &&
      (v.pid === undefined || Number.isSafeInteger(v.pid) && v.pid > 1) &&
      (v.startTime === undefined || typeof v.startTime === "string" && START.test(v.startTime));
  }

  private async retire(record: Ownership): Promise<"retired" | "gone" | "unproven"> {
    let directoryFd: number | undefined;
    let directory: string | undefined;
    try {
      if (record.bootId !== this.probe!.bootId()) return "gone";
      if (record.containment) {
        // Resolve only the recorded hierarchy through this process's real mount table.
        // The native worker rechecks the inherited fd's filesystem/inode and every member.
        const mount = currentCgroupDirectory(readFileSync("/proc/self/mountinfo", "utf8"), readFileSync("/proc/self/cgroup", "utf8"));
        if (!mount || mount.mountRoot !== record.containment.mountRoot) return "unproven";
        directory = posix.join(mount.mountPoint, record.containment.cgroupPath);
        directoryFd = openSync(directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      const helper = linuxCgroupHelper(dirname(this.directory));
      const result = await new Promise<"retired" | "gone" | "unproven">((resolve) => {
        const child = spawn(helper, [record.containment ? "--retire-boundary" : "--retire-process"], {
          env: {}, stdio: ["pipe", "ignore", "ignore", ...(directoryFd === undefined ? [] : [directoryFd])],
        });
        child.stdin!.on("error", () => {});
        child.stdin!.end(`${record.bootId}\n${record.pid}\n${record.startTime}\n${record.uid}\n${record.runnerPid}\n${record.runnerStartTime}\n` +
          (record.containment ? `${record.containment.inode}\n${posix.join(record.containment.mountRoot, record.containment.cgroupPath)}\n` : ""));
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
        child.once("error", () => { clearTimeout(timer); resolve("unproven"); });
        child.once("close", (code) => { clearTimeout(timer); resolve(code === 0 ? "retired" : code === 4 ? "gone" : "unproven"); });
      });
      if (result === "retired" && directoryFd !== undefined && directory) {
        // Best-effort cleanup only after native recursive emptiness proof. A changed or
        // populated cgroup cannot be removed; empty nested cgroups can be left in place.
        try {
          const opened = fstatSync(directoryFd, { bigint: true });
          const named = lstatSync(directory, { bigint: true });
          if (named.ino === opened.ino && named.dev === opened.dev && !named.isSymbolicLink()) rmdirSync(directory);
        } catch { /* retain the empty kernel boundary */ }
      }
      return result;
    } catch { return "unproven"; }
    finally { if (directoryFd !== undefined) closeSync(directoryFd); }
  }
}
