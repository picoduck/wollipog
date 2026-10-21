import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { getSystemErrorName } from "node:util";
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
  reason: "not-probed" | "available" | "unsupported-platform" | "cgroup-not-delegated" | "cgroup-unavailable" | "boundary-creation-failed";
}

let status: ProviderContainmentStatus = { proofStandard: "marker-parent-links", reason: "not-probed" };
export function providerContainmentStatus(): Readonly<ProviderContainmentStatus> { return { ...status }; }

function report(next: ProviderContainmentStatus): void {
  if (next.proofStandard === status.proofStandard && next.reason === status.reason) return;
  status = next;
  console.error(`[runner] provider_process_containment proofStandard=${next.proofStandard} reason=${next.reason}`);
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
  term(): Promise<void>;
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

  constructor(readonly identity: Readonly<LinuxCgroupIdentity>, private readonly io: LinuxCgroupBoundaryIo) {
    this.admitted = new Promise((resolve) => { this.admit = resolve; });
  }

  /** The helper's private pipe is closed before exec. Empty-before-join is never an empty-tree
   * proof, even if the caller disposes synchronously immediately after spawn returns. */
  bind(child: ChildProcess): void {
    this.root = child;
    const pipe = child.stdio[4] as Readable | null;
    const settle = (accepted: boolean) => this.admit(accepted);
    if (!pipe) { settle(false); return; }
    let received = false;
    pipe.on("data", (chunk: Buffer) => {
      if (!received) { received = true; settle(chunk.equals(Buffer.from("1"))); }
    });
    pipe.once("end", () => { if (!received) settle(false); });
    pipe.once("error", () => settle(false));
    child.once("error", () => {
      if (!child.pid) { settle(false); this.cancelSpawn(); }
    });
  }

  private async waitForAdmission(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Timing out one waiter must not erase a successful acknowledgement already queued in
      // the poll phase behind a stalled event loop. A later waiter can consume that same ack.
      return await Promise.race([this.admitted, new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
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
    if (!await this.waitForAdmission()) return false;
    if (this.removed) return true;
    try { return this.io.populated() ? false : this.finish(); } catch { return false; }
  }

  async terminate(): Promise<boolean> {
    if (this.removed) return true;
    if (!await this.waitForAdmission()) {
      // The leaf is ours even when acknowledgement is uncertain. Kill the unreaped launcher
      // first, then any admitted descendants; uncertainty must never disable kernel cleanup.
      try { if (this.root && typeof this.root.kill === "function") this.root.kill("SIGKILL"); } catch { /* already gone */ }
      try { if (!this.removed) this.io.kill(); } catch { /* retain an unproved result */ }
      return false;
    }
    if (this.removed) return true;
    try {
      // TERM uses cgroup-local pidfds; final cgroup.kill is recursive and serialized against
      // forks/migration. No environment or unrelated process table participates in the proof.
      if (!this.io.populated()) return this.finish();
      try { await this.io.term(); } catch { /* kernel KILL still provides survivor cleanup */ }
      const gracefulDeadline = this.io.now() + 2_000;
      while (this.io.now() < gracefulDeadline) {
        if (this.removed) return true;
        if (!this.io.populated()) return this.finish();
        await this.io.sleep(20);
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

/** Never inherit user@.service's delegation across a non-delegated child scope/service. The
 * documented systemd user.delegate marker must be on the nearest containing unit. */
export function cgroupDelegationDirectory(mount: CgroupLocation): string | undefined {
  const hierarchy = posix.join(mount.mountRoot, posix.relative(mount.mountPoint, mount.directory));
  const parts = hierarchy.split("/").filter(Boolean);
  let unit = -1;
  for (let index = 0; index < parts.length; index++) if (/\.(?:service|scope)$/u.test(parts[index]!)) unit = index;
  if (unit < 0) return mount.directory; // Non-systemd delegation still needs an explicit marker.
  const relative = posix.relative(mount.mountRoot, "/" + parts.slice(0, unit + 1).join("/"));
  if (relative === ".." || relative.startsWith("../")) return undefined;
  return posix.join(mount.mountPoint, relative);
}

function hasDelegation(mount: CgroupLocation, helper: string): boolean {
  const directory = cgroupDelegationDirectory(mount);
  if (!directory) return false;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return spawnSync(helper, ["--delegation-probe"], { env: {}, timeout: 2_000,
      stdio: ["ignore", "ignore", "ignore", fd] }).status === 0;
  } finally { closeSync(fd); }
}

let helperDataDirectory: string | undefined;

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
      term: () => {
        verify();
        const helper = linuxCgroupHelper(helperDataDirectory);
        return new Promise<void>((resolve) => {
          const child = spawn(helper, ["--term", posix.join(identity.mountRoot, identity.cgroupPath)], {
            env: {}, stdio: ["ignore", "ignore", "ignore", directoryFd],
          });
          const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
          child.once("error", () => { clearTimeout(timer); resolve(); });
          child.once("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) console.error("[runner] provider cgroup TERM incomplete; kernel survivor cleanup remains required");
            resolve();
          });
        });
      },
      kill: () => { verify(); writeFileSync(`${anchored}/cgroup.kill`, "1"); },
      remove: () => { verify(); rmdirSync(path); },
      close: () => closeSync(directoryFd),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: () => performance.now(),
    };
    return { directoryFd, identity, io };
  } catch (error) { closeSync(directoryFd); throw error; }
}

let instance: { mount: CgroupLocation; bootId: string; identity: Readonly<LinuxCgroupIdentity>; io: LinuxCgroupBoundaryIo } | null | undefined;

/** One instance parent contains all launch leaves. Call before acquiring a lease to obtain the
 * identity a future journal may record. This issue does not persist it or change lease authority.
 * Availability is chosen once; after choosing cgroups, later launch failures refuse execution
 * instead of silently invalidating the instance's recordable containment claim. */
export function providerContainmentIdentity(dataDirectory?: string): Readonly<LinuxCgroupIdentity> | undefined {
  if (dataDirectory) helperDataDirectory = dataDirectory;
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
    const helper = linuxCgroupHelper(helperDataDirectory);
    if (!hasDelegation(mount, helper)) {
      report({ proofStandard: "marker-parent-links", reason: "cgroup-not-delegated" });
      return undefined;
    }
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[0-9a-f-]{36}$/u.test(bootId)) throw new Error("no boot identity");
    directory = posix.join(mount.directory, `wollipog-providers-${randomUUID()}`);
    mkdirSync(directory, { mode: 0o700 });
    opened = openCgroup(directory, mount, bootId);
    instance = { mount: { ...mount, directory }, bootId, identity: opened.identity, io: opened.io };
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
    const helper = linuxCgroupHelper(helperDataDirectory);
    mkdirSync(directory, { mode: 0o700 });
    const opened = openCgroup(directory, instance.mount, instance.bootId);
    report({ proofStandard: "linux-cgroup-v2", reason: "available" });
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
    const child = spawn(launch.helper, ["--exec", command, ...args], {
      ...options, shell: false, stdio: ["pipe", "pipe", "pipe", launch.directoryFd, "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    launch.boundary.bind(child);
    // Node's declaration enumerates only fds 0..4, although spawn accepts additional pipes.
    const errors = (child.stdio as unknown[])[5] as Readable;
    let errorBytes = Buffer.alloc(0);
    let reported = false;
    errors.on("data", (chunk: Buffer) => {
      if (reported) return;
      errorBytes = Buffer.concat([errorBytes, chunk]);
      if (errorBytes.length !== 4) return;
      reported = true;
      const errno = -errorBytes.readUInt32LE();
      const code = getSystemErrorName(errno);
      child.emit("error", Object.assign(new Error(`spawn ${command} ${code}`), {
        errno, code, syscall: `spawn ${command}`, path: command, spawnargs: args,
      }));
    });
    errors.on("error", () => { /* the helper's stderr/exit still reports failure */ });
    return { child, containment: launch.boundary };
  } catch (error) {
    launch.boundary.cancelSpawn();
    throw error;
  }
}
