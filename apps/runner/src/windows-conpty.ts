/** Native Windows pseudoconsole transport.
 *
 * node-pty publishes the small ConPTY N-API addon for win32 x64/arm64. We deliberately use only
 * that addon: its JS wrapper forks helper scripts and file-backed workers that cannot exist inside
 * a single-executable runner. This adapter keeps the output pipe drained in an eval worker, loads
 * the prebuild directly in development, and extracts the exact same bytes from a Node SEA asset in
 * the shipped binary.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { PassThrough } from "node:stream";
import { Socket } from "node:net";
import { Worker } from "node:worker_threads";
import { trackPendingKill } from "./spawn.js";

const requireFromHere = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
const CONPTY_ASSET = "node-pty/conpty.node";
const OUTPUT_DRAIN_MS = 1_000;

interface NativeConpty {
  startProcess(
    file: string,
    cols: number,
    rows: number,
    debug: boolean,
    pipeName: string,
    inheritCursor: boolean,
    useConptyDll: boolean,
  ): { conin: string; conout: string; fd: number; pty: number };
  connect(
    pty: number,
    commandLine: string,
    cwd: string,
    env: string[],
    useConptyDll: boolean,
    onExit: (code: number) => void,
  ): { pid: number };
  resize(pty: number, cols: number, rows: number, useConptyDll: boolean): void;
  kill(pty: number, useConptyDll: boolean): void;
}

let nativeConpty: NativeConpty | null = null;

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Validate the two Windows architectures for which node-pty publishes audited ConPTY assets. */
export function conptyPrebuildDirectory(platform = process.platform, arch = process.arch): string {
  if (platform !== "win32") throw new Error("ConPTY is available only on Windows");
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`ConPTY has no published Windows ${arch} addon; supported architectures are x64 and arm64`);
  }
  return `win32-${arch}`;
}

/** Resolve the published native addon. Exported for binary/packaging regression tests. */
export function resolveConptyAddonPath(): string {
  const prebuildDirectory = conptyPrebuildDirectory();
  if (!isSea()) {
    const packageJson = requireFromHere.resolve(`${["node", "pty"].join("-")}/package.json`);
    const target = join(dirname(packageJson), "prebuilds", prebuildDirectory, "conpty.node");
    if (!existsSync(target)) throw new Error(`ConPTY native addon is missing: ${target}`);
    return target;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getAsset(CONPTY_ASSET));
  } catch (cause) {
    throw new Error(`packaged ConPTY native addon is missing for ${prebuildDirectory}`, { cause });
  }
  const digest = sha256(bytes);
  const root = join(tmpdir(), "wollipog", "native", `node-pty-1.1.0-${process.arch}-${digest}`);
  const target = join(root, "conpty.node");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(target) || sha256(readFileSync(target)) !== digest) {
    const staged = join(root, `conpty-${process.pid}-${randomUUID()}.node`);
    writeFileSync(staged, bytes, { flag: "wx", mode: 0o600 });
    try {
      renameSync(staged, target);
    } catch (error) {
      rmSync(staged, { force: true });
      if (!existsSync(target) || sha256(readFileSync(target)) !== digest) throw error;
    }
  }
  if (sha256(readFileSync(target)) !== digest) throw new Error("extracted ConPTY addon failed integrity verification");
  return target;
}

function loadConpty(): NativeConpty {
  if (!nativeConpty) nativeConpty = requireFromHere(resolveConptyAddonPath()) as NativeConpty;
  return nativeConpty;
}

/** Windows CreateProcess argv quoting (the inverse of CommandLineToArgvW's common convention). */
export function windowsCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map((arg) => {
    if (arg.length > 0 && !/[\s"]/u.test(arg)) return arg;
    let out = '"';
    let slashes = 0;
    for (const char of arg) {
      if (char === "\\") {
        slashes++;
      } else if (char === '"') {
        out += "\\".repeat(slashes * 2 + 1) + '"';
        slashes = 0;
      } else {
        out += "\\".repeat(slashes) + char;
        slashes = 0;
      }
    }
    return out + "\\".repeat(slashes * 2) + '"';
  }).join(" ");
}

function windowsEnvironment(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].includes("=") && !entry[1].includes("\0"))
    .map(([key, value]) => `${key}=${value}`)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Match spawnAgent's inherited-secret policy for native ConPTY launches. Configured values win;
 * only same-named values inherited from the long-lived runner daemon are removed. */
export function windowsEnvironmentForLaunch(
  configured: Record<string, string> = {},
  scrubInheritedEnv: readonly string[] = [],
  inherited: NodeJS.ProcessEnv = process.env,
): string[] {
  const scrubbed = new Set(scrubInheritedEnv.map((key) => key.toLowerCase()));
  const merged = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || scrubbed.has(key.toLowerCase())) continue;
    merged.set(key.toLowerCase(), [key, value]);
  }
  // Windows treats environment names case-insensitively. Replacing by the folded name prevents
  // ambiguous Path/PATH duplicates while retaining the configured key's spelling and value.
  for (const [key, value] of Object.entries(configured)) {
    merged.set(key.toLowerCase(), [key, value]);
  }
  return windowsEnvironment(Object.fromEntries(merged.values()));
}

const CONOUT_WORKER = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const { Socket } = require('node:net');
  const socket = new Socket();
  socket.on('data', (data) => parentPort.postMessage({ type: 'data', data }));
  socket.on('error', (error) => parentPort.postMessage({ type: 'error', message: error.message }));
  socket.on('close', () => parentPort.postMessage({ type: 'closed' }));
  socket.connect(workerData.pipe, () => parentPort.postMessage({ type: 'ready' }));
`;

export interface WindowsConptyOptions {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  scrubInheritedEnv?: string[];
  /** Exact CreateProcess command line for cmd.exe wrappers. Its command tail follows cmd quoting,
   * not CommandLineToArgvW quoting, so it must bypass windowsCommandLine's second escaping pass. */
  verbatimCommandLine?: string;
}

/** Process-shaped ConPTY endpoint consumed by ShellManager. stderr is merged into the terminal's
 * VT output by Windows, so the stderr PassThrough intentionally remains empty. */
export class WindowsConptyProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Socket;
  readonly pid: number;
  private readonly native: NativeConpty;
  private readonly pty: number;
  private readonly worker: Worker;
  private exitCode: number | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private killing = false;

  constructor(opts: WindowsConptyOptions) {
    super();
    this.native = loadConpty();
    const term = this.native.startProcess(
      opts.command,
      opts.cols,
      opts.rows,
      false,
      `wollipog-conpty-${process.pid}-${randomUUID()}`,
      false,
      false,
    );
    this.pty = term.pty;
    let worker: Worker | undefined;
    let stdin: Socket | undefined;
    let connected: { pid: number } | undefined;
    try {
      worker = new Worker(CONOUT_WORKER, { eval: true, workerData: { pipe: term.conout } });
      const inputFd = openSync(term.conin, "w");
      stdin = new Socket({ fd: inputFd, readable: false, writable: true });
      connected = this.native.connect(
        this.pty,
        opts.verbatimCommandLine ?? windowsCommandLine(opts.command, opts.args),
        opts.cwd,
        windowsEnvironmentForLaunch(opts.env, opts.scrubInheritedEnv),
        false,
        (code) => {
          this.exitCode = code;
          this.scheduleClose();
        },
      );
    } catch (error) {
      stdin?.destroy();
      if (worker) void worker.terminate();
      try { this.native.kill(this.pty, false); } catch { /* partially initialized */ }
      throw error;
    }
    this.worker = worker;
    this.stdin = stdin;
    this.pid = connected.pid;
    this.worker.on("message", (message: { type?: string; data?: Uint8Array; message?: string }) => {
      this.handleWorkerMessage(message);
    });
    this.worker.on("error", (error) => {
      this.fail(error);
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  resize(cols: number, rows: number): void {
    if (this.closed || this.killing || this.exitCode !== null) return;
    try {
      this.native.resize(this.pty, cols, rows, false);
    } catch {
      // The process can exit and close the pseudoconsole between the state check and native call.
      // Resizing is best-effort, so a stale in-flight dashboard resize must not crash the runner.
    }
  }

  kill(): void {
    if (this.closed || this.killing) return;
    this.killing = true;
    this.stdin.destroy();
    if (this.pid > 0) {
      trackPendingKill(new Promise<void>((resolve) => {
        execFile("taskkill", ["/pid", String(this.pid), "/T", "/F"], (error) => {
          const code = (error as { code?: number } | null)?.code;
          if (error && code !== 128) console.error(`[runner] ConPTY taskkill failed for pid ${this.pid}: ${error.message}`);
          resolve();
        });
      }));
    }
    try {
      this.native.kill(this.pty, false);
    } catch {
      /* already exited */
    }
    this.scheduleClose();
  }

  private scheduleClose(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => this.finish(), OUTPUT_DRAIN_MS);
  }

  private handleWorkerMessage(message: { type?: string; data?: Uint8Array; message?: string }): void {
    // terminate() is asynchronous, so an already-queued worker message can arrive after finish()
    // ends stdout. Ignore it instead of risking ERR_STREAM_WRITE_AFTER_END on an unobserved stream.
    if (this.closed) return;
    if (message.type === "data" && message.data) {
      this.stdout.write(Buffer.from(message.data));
      if (this.exitCode !== null) this.scheduleClose();
    } else if (message.type === "error") {
      this.fail(new Error(`ConPTY output pipe failed: ${message.message ?? "unknown error"}`));
    } else if (message.type === "closed" && this.exitCode !== null) {
      this.finish();
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.kill();
    try {
      this.emit("error", error);
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    void this.worker.terminate();
    this.emit("close", this.exitCode);
  }
}

export function openWindowsConpty(opts: WindowsConptyOptions): WindowsConptyProcess {
  return new WindowsConptyProcess(opts);
}
