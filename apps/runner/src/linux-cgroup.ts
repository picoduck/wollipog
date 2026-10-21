import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { linuxCgroupHelper } from "./linux-cgroup-helper.js";

export type ProviderProcessProofStandard = "linux-cgroup-v2" | "marker-parent-links";

/** Recordable identity, independent of the creating runner's PID and resilient to reboot and
 * path reuse. cgroupPath is relative to the cgroup2 mount whose hierarchy root is mountRoot.
 * Persistence and abandoned-lease authority belong to the lease journal, not this module. */
export interface LinuxCgroupIdentity {
  kind: "linux-cgroup-v2";
  bootId: string;
  mountRoot: string;
  cgroupPath: string;
  inode: string;
}

export interface ProviderContainmentStatus {
  proofStandard: ProviderProcessProofStandard;
  reason: "not-probed" | "available" | "unsupported-platform" | "cgroup-unavailable" | "boundary-creation-failed";
}

let status: ProviderContainmentStatus = { proofStandard: "marker-parent-links", reason: "not-probed" };
export function providerContainmentStatus(): Readonly<ProviderContainmentStatus> { return { ...status }; }

function report(next: ProviderContainmentStatus): void {
  if (next.proofStandard === status.proofStandard && next.reason === status.reason) return;
  status = next;
  console.info(`[runner] provider_process_containment proofStandard=${next.proofStandard} reason=${next.reason}`);
}

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Resolve the current cgroup through the actual mount table, including a namespaced mount root.
 * Never walk up to a sibling delegation or move the runner to enable containment. */
export function currentCgroupDirectory(mountinfo: string, membership: string): { directory: string; mountRoot: string; mountPoint: string } | undefined {
  const cgroup = /^0::(\/.*)$/mu.exec(membership)?.[1];
  if (!cgroup || cgroup.includes("\0") || cgroup.split("/").includes("..")) return undefined;
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - ");
    if (right?.split(" ")[0] !== "cgroup2") continue;
    const fields = left!.split(" ");
    const mountRoot = unescapeMount(fields[3] ?? "");
    const mountPoint = unescapeMount(fields[4] ?? "");
    if (!posix.isAbsolute(mountPoint) || !posix.isAbsolute(mountRoot)) continue;
    const relative = posix.relative(mountRoot, cgroup);
    if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) continue;
    return { directory: posix.join(mountPoint, relative), mountRoot, mountPoint };
  }
  return undefined;
}

/** Internal deterministic I/O seam. Production operations remain anchored to an open cgroup fd. */
export interface LinuxCgroupBoundaryIo {
  populated(): boolean;
  kill(): void;
  remove(): void;
  close(): void;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

export class LinuxCgroupBoundary {
  private admitted: Promise<boolean>;
  private admit!: (value: boolean) => void;
  private removed = false;
  private root?: ChildProcess;
  private rootExited = false;

  constructor(readonly identity: Readonly<LinuxCgroupIdentity>, private readonly io: LinuxCgroupBoundaryIo) {
    this.admitted = new Promise((resolve) => { this.admit = resolve; });
  }

  /** The helper's private pipe is closed before exec. Empty-before-join is never an empty-tree
   * proof, even if the caller disposes synchronously immediately after spawn returns. */
  bind(child: ChildProcess): void {
    this.root = child;
    child.once("exit", () => { this.rootExited = true; });
    const pipe = child.stdio[4] as Readable | null;
    const timer = setTimeout(() => this.admit(false), 5_000);
    timer.unref();
    const settle = (accepted: boolean) => { clearTimeout(timer); this.admit(accepted); };
    if (!pipe) { settle(false); return; }
    let received = false;
    pipe.on("data", (chunk: Buffer) => {
      if (!received) { received = true; settle(chunk.equals(Buffer.from("1"))); }
    });
    pipe.once("end", () => { if (!received) settle(false); });
    pipe.once("error", () => settle(false));
    child.once("error", () => {
      settle(false);
      if (!child.pid) this.cancelSpawn();
    });
  }

  private finish(): boolean {
    // populated=0 is recursive, unlike cgroup.procs, and cannot miss a child cgroup. A failed
    // rmdir (e.g. retained empty child cgroups) keeps the identity available but not the fd.
    try { this.io.remove(); } catch { /* empty boundary retained for later recovery */ }
    this.removed = true;
    this.io.close();
    return true;
  }

  async releaseIfEmpty(): Promise<boolean> {
    if (this.removed) return true;
    if (!await this.admitted) return false;
    if (this.removed) return true;
    try { return this.io.populated() ? false : this.finish(); } catch { return false; }
  }

  async terminate(): Promise<boolean> {
    if (this.removed) return true;
    if (!await this.admitted) return false;
    if (this.removed) return true;
    try {
      // cgroup.kill is recursive and kernel-serialized against forks and migration. No numeric
      // PID is signalled, so an unreadable environment or reused PID cannot change ownership.
      if (!this.io.populated()) return this.finish();
      // Preserve the provider root's TERM grace (including handlers that fork). Node still owns
      // its unreaped child handle, so kill() cannot target a recycled PID. Descendant cleanup
      // below uses only the cgroup and covers anything that handler starts with a cleared env.
      if (this.root && !this.rootExited && typeof this.root.kill === "function") {
        this.root.kill("SIGTERM");
        this.root.kill("SIGCONT");
        const gracefulDeadline = this.io.now() + 2_000;
        while (this.io.now() < gracefulDeadline) {
          if (this.removed) return true;
          if (!this.io.populated()) return this.finish();
          await this.io.sleep(20);
        }
      }
      this.io.kill();
      const deadline = this.io.now() + 4_000;
      while (this.io.now() < deadline) {
        if (this.removed) return true;
        if (!this.io.populated()) return this.finish();
        await this.io.sleep(20);
      }
    } catch { if (this.removed) return true; /* missing/replaced/unreadable identity is never evidence of emptiness */ }
    console.error("[runner] provider cgroup cleanup unproved; retaining provider-home lease");
    return false;
  }

  /** Spawn failed synchronously, before a process or admission pipe existed. */
  cancelSpawn(): void {
    if (this.removed) return;
    this.admit(false);
    this.removed = true;
    try { this.io.remove(); } catch { /* preserve unexpected evidence */ }
    this.io.close();
  }
}

export interface LinuxCgroupLaunch {
  helper: string;
  directoryFd: number;
  boundary: LinuxCgroupBoundary;
}

interface CgroupLocation { directory: string; mountRoot: string; mountPoint: string }

function openCgroup(path: string, mount: CgroupLocation, bootId: string): {
  directoryFd: number; identity: Readonly<LinuxCgroupIdentity>; io: LinuxCgroupBoundaryIo;
} {
  const directoryFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(directoryFd, { bigint: true });
    const anchored = `/proc/self/fd/${directoryFd}`;
    const verify = () => {
      const current = lstatSync(path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== initial.ino || current.dev !== initial.dev ||
          fstatSync(directoryFd, { bigint: true }).nlink === 0n) throw new Error("cgroup identity changed");
    };
    accessSync(`${anchored}/cgroup.procs`, constants.W_OK);
    accessSync(`${anchored}/cgroup.kill`, constants.W_OK);
    const populated = () => {
      verify();
      const match = /^populated ([01])$/mu.exec(readFileSync(`${anchored}/cgroup.events`, "utf8"));
      if (!match) throw new Error("unverifiable cgroup events");
      return match[1] === "1";
    };
    if (populated()) throw new Error("new cgroup populated");
    const identity = Object.freeze({ kind: "linux-cgroup-v2" as const, bootId,
      mountRoot: mount.mountRoot, cgroupPath: posix.relative(mount.mountPoint, path), inode: initial.ino.toString() });
    const io: LinuxCgroupBoundaryIo = {
      populated,
      kill: () => { verify(); writeFileSync(`${anchored}/cgroup.kill`, "1"); },
      remove: () => { verify(); rmdirSync(path); },
      close: () => closeSync(directoryFd),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: () => performance.now(),
    };
    return { directoryFd, identity, io };
  } catch (error) { closeSync(directoryFd); throw error; }
}

let instance: { mount: CgroupLocation; bootId: string; helper: string; identity: Readonly<LinuxCgroupIdentity>; io: LinuxCgroupBoundaryIo } | null | undefined;

/** One instance parent contains all launch leaves. Call before acquiring a lease to obtain the
 * identity a future journal may record. This issue does not persist it or change lease authority.
 * Availability is chosen once; after choosing cgroups, later launch failures refuse execution
 * instead of silently invalidating the instance's recordable containment claim. */
export function providerContainmentIdentity(): Readonly<LinuxCgroupIdentity> | undefined {
  if (instance !== undefined) return instance?.identity;
  instance = null;
  if (process.platform !== "linux") {
    report({ proofStandard: "marker-parent-links", reason: "unsupported-platform" });
    return undefined;
  }
  let directory: string | undefined;
  let opened: ReturnType<typeof openCgroup> | undefined;
  try {
    const mount = currentCgroupDirectory(readFileSync("/proc/self/mountinfo", "utf8"), readFileSync("/proc/self/cgroup", "utf8"));
    if (!mount || statfsSync(mount.directory).type !== 0x63677270) throw new Error("no cgroup2 mount");
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[0-9a-f-]{36}$/u.test(bootId)) throw new Error("no boot identity");
    directory = posix.join(mount.directory, `wollipog-providers-${randomUUID()}`);
    mkdirSync(directory, { mode: 0o700 });
    opened = openCgroup(directory, mount, bootId);
    const helper = linuxCgroupHelper();
    instance = { mount: { ...mount, directory }, bootId, helper, identity: opened.identity, io: opened.io };
    const root = instance;
    process.once("exit", () => {
      // A crash leaves populated boundaries in place. Normal exit only removes an empty parent;
      // never kill processes from an exit hook or clear evidence of surviving providers.
      try { if (!root.io.populated()) root.io.remove(); } catch { /* retain evidence */ }
      root.io.close();
    });
    report({ proofStandard: "linux-cgroup-v2", reason: "available" });
    return instance.identity;
  } catch {
    opened?.io.close();
    if (directory) { try { rmdirSync(directory); } catch { /* preserve unexpected evidence */ } }
    report({ proofStandard: "marker-parent-links", reason: "cgroup-unavailable" });
    return undefined;
  }
}

export function prepareLinuxCgroupLaunch(): LinuxCgroupLaunch | undefined {
  providerContainmentIdentity();
  if (!instance) return undefined;
  const directory = posix.join(instance.mount.directory, `provider-${randomUUID()}`);
  try {
    // Verify the retained parent identity before creating anything below it.
    instance.io.populated();
    const helper = linuxCgroupHelper();
    mkdirSync(directory, { mode: 0o700 });
    const opened = openCgroup(directory, instance.mount, instance.bootId);
    return { helper, directoryFd: opened.directoryFd,
      boundary: new LinuxCgroupBoundary(opened.identity, opened.io) };
  } catch (cause) {
    try { rmdirSync(directory); } catch { /* preserve unexpected evidence */ }
    report({ proofStandard: "linux-cgroup-v2", reason: "boundary-creation-failed" });
    throw new Error("provider containment unavailable; provider was not executed", { cause });
  }
}

/** Native launch primitive shared by spawnAgent. Passing an fd prevents path replacement between
 * parent preparation and child admission; the provider receives none of the cgroup handles. */
export function spawnWithLinuxCgroup(command: string, args: string[], options: SpawnOptionsWithoutStdio): {
  child: ChildProcessWithoutNullStreams; containment?: LinuxCgroupBoundary;
} {
  const launch = prepareLinuxCgroupLaunch();
  if (!launch) return { child: spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }) };
  try {
    const child = spawn(launch.helper, [command, ...args], {
      ...options, shell: false, stdio: ["pipe", "pipe", "pipe", launch.directoryFd, "pipe"],
    }) as ChildProcessWithoutNullStreams;
    launch.boundary.bind(child);
    return { child, containment: launch.boundary };
  } catch (error) {
    launch.boundary.cancelSpawn();
    throw error;
  }
}
