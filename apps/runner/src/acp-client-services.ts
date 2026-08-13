import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, basename, dirname, join, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import { sensitiveEnvironmentName } from "./env-security.js";
import { killTree, spawnAgent, type AgentProcess, type SpawnIsolation } from "./spawn.js";

export const ACP_FILE_BYTE_LIMIT = 8 * 1024 * 1024;
export const ACP_TERMINAL_DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
export const ACP_TERMINAL_MAX_OUTPUT_LIMIT = 8 * 1024 * 1024;
export const ACP_TERMINALS_PER_SESSION = 8;

const nativeContext: AgentContext = { kind: "native" };
let tempSequence = 0;

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function assertTextPath(path: unknown, context: AgentContext): asserts path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 32_768 || path.includes("\0")) {
    throw new Error("ACP filesystem path is invalid");
  }
  const absolute = context.kind === "wsl" ? posix.isAbsolute(path) : isAbsolute(path);
  if (!absolute) throw new Error("ACP filesystem paths must be absolute");
}

function sliceLines(content: string, line: unknown, limit: unknown): string {
  const startLine = line === undefined ? 1 : Number(line);
  const count = limit === undefined ? undefined : Number(limit);
  if (!Number.isSafeInteger(startLine) || startLine < 1) throw new Error("ACP read line must be a positive integer");
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
    throw new Error("ACP read limit must be a non-negative integer");
  }
  if (line === undefined && limit === undefined) return content;
  const lines = content.split("\n");
  const start = startLine - 1;
  return lines.slice(start, count === undefined ? lines.length : start + count).join("\n");
}

/** Session-root filesystem service used only for ACP agent->client requests. */
export class AcpFilesystemService {
  private additionalRoots: string[] = [];
  constructor(
    private root: string,
    private readonly context: AgentContext = nativeContext,
  ) {}

  setRoot(root: string): void {
    this.root = root;
  }

  setAdditionalRoots(roots: string[]): void {
    this.additionalRoots = [...roots];
  }

  directoryRoot(): Promise<string> {
    return this.directory(this.root);
  }

  async read(path: string, line?: number, limit?: number): Promise<string> {
    assertTextPath(path, this.context);
    const content = this.context.kind === "wsl"
      ? await this.readWsl(path)
      : await this.readNative(path);
    return sliceLines(content, line, limit);
  }

  async write(path: string, content: string): Promise<void> {
    assertTextPath(path, this.context);
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > ACP_FILE_BYTE_LIMIT) {
      throw new Error(`ACP filesystem writes are limited to ${ACP_FILE_BYTE_LIMIT} bytes`);
    }
    if (this.context.kind === "wsl") await this.writeWsl(path, content);
    else await this.writeNative(path, content);
  }

  async directory(path: string): Promise<string> {
    assertTextPath(path, this.context);
    if (this.context.kind === "wsl") {
      const script = wslPathGuardScript("directory");
      const root = this.requestedRoot(path);
      const result = await runContextCommand(this.context, "sh", ["-c", script, "sh", root, path], {
        cwd: "/",
        timeoutMs: 10_000,
      });
      return result.stdout.trim();
    }
    const target = await realpath(path);
    await this.canonicalRoot(target);
    if (!(await stat(target)).isDirectory()) throw new Error("ACP terminal cwd is not a directory");
    return target;
  }

  private async readNative(path: string): Promise<string> {
    const target = await realpath(path);
    await this.canonicalRoot(target);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("ACP filesystem reads require a regular file");
    if (info.size > ACP_FILE_BYTE_LIMIT) {
      throw new Error(`ACP filesystem reads are limited to ${ACP_FILE_BYTE_LIMIT} bytes`);
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  private async writeNative(path: string, content: string): Promise<void> {
    const requested = this.requestedRoot(path);
    const root = await realpath(requested);
    const requestedRoot = resolve(requested);
    const requestedPath = resolve(path);
    const rel = inside(requestedRoot, requestedPath)
      ? relative(requestedRoot, requestedPath)
      : inside(root, requestedPath)
        ? relative(root, requestedPath)
        : null;
    if (rel === null) throw new Error("ACP path is outside the session root");
    const lexical = join(root, rel);

    const parent = await this.ensureNativeParent(root, dirname(lexical));
    let destination = join(parent, basename(lexical));
    let existingMode: number | undefined;
    try {
      destination = await realpath(destination);
      if (!inside(root, destination)) throw new Error("ACP symlink escapes the session root");
      const info = await stat(destination);
      if (!info.isFile()) throw new Error("ACP filesystem writes require a regular file");
      existingMode = info.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporary = join(dirname(destination), `.wollipog-acp-${process.pid}-${++tempSequence}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, existingMode ?? 0o600);
    try {
      await handle.writeFile(content, "utf8");
      if (existingMode !== undefined) await handle.chmod(existingMode);
      await handle.close();
      await rename(temporary, destination);
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async ensureNativeParent(root: string, requested: string): Promise<string> {
    const rel = relative(root, requested);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("ACP path is outside the session root");
    }
    let current = root;
    for (const segment of rel.split(sep).filter(Boolean)) {
      const next = join(current, segment);
      try {
        const entry = await lstat(next);
        if (entry.isSymbolicLink()) {
          const resolved = await realpath(next);
          if (!inside(root, resolved)) throw new Error("ACP symlink escapes the session root");
          if (!(await stat(resolved)).isDirectory()) throw new Error("ACP write parent is not a directory");
          current = resolved;
        } else {
          if (!entry.isDirectory()) throw new Error("ACP write parent is not a directory");
          current = next;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(next);
        current = await realpath(next);
      }
      if (!inside(root, current)) throw new Error("ACP symlink escapes the session root");
    }
    return current;
  }

  private async readWsl(path: string): Promise<string> {
    const result = await runContextCommand(this.context, "sh", ["-c", wslPathGuardScript("read"), "sh", this.requestedRoot(path), path, String(ACP_FILE_BYTE_LIMIT)], {
      cwd: "/",
      timeoutMs: 15_000,
      maxBuffer: ACP_FILE_BYTE_LIMIT + 64 * 1024,
    });
    return result.stdout;
  }

  private async writeWsl(path: string, content: string): Promise<void> {
    await runContextCommand(this.context, "sh", ["-c", wslPathGuardScript("write"), "sh", this.requestedRoot(path), path], {
      cwd: "/",
      stdin: content,
      timeoutMs: 15_000,
      maxBuffer: 64 * 1024,
    });
  }

  private requestedRoot(path: string): string {
    const roots = [this.root, ...this.additionalRoots];
    const pathApi = this.context.kind === "wsl" ? posix : { isAbsolute, relative, resolve };
    const requested = pathApi.resolve(path);
    const match = roots.find((candidate) => {
      const root = pathApi.resolve(candidate);
      const rel = pathApi.relative(root, requested);
      return rel === "" || (!pathApi.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${this.context.kind === "wsl" ? "/" : sep}`));
    });
    if (!match) throw new Error("ACP path is outside the session roots");
    return match;
  }

  private async canonicalRoot(target: string): Promise<string> {
    for (const candidate of [this.root, ...this.additionalRoots]) {
      try {
        const root = await realpath(candidate);
        if (inside(root, target)) return root;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error("ACP path is outside the session roots");
  }
}

function wslPathGuardScript(operation: "read" | "write" | "directory"): string {
  const prefix = [
    "set -eu",
    'root=$(realpath -e -- "$1")',
    'target=$(realpath -m -- "$2")',
    'case "$target" in "$root"|"$root"/*) ;; *) echo "ACP path is outside the session root" >&2; exit 73;; esac',
  ].join("; ");
  if (operation === "read") {
    return `${prefix}; target=$(realpath -e -- "$target"); case "$target" in "$root"|"$root"/*) ;; *) exit 73;; esac; test -f "$target"; size=$(wc -c < "$target"); test "$size" -le "$3"; cat -- "$target"`;
  }
  if (operation === "directory") {
    return `${prefix}; target=$(realpath -e -- "$target"); case "$target" in "$root"|"$root"/*) ;; *) exit 73;; esac; test -d "$target"; printf %s "$target"`;
  }
  return `${prefix}; parent=$(dirname -- "$target"); mkdir -p -- "$parent"; parent=$(realpath -e -- "$parent"); case "$parent" in "$root"|"$root"/*) ;; *) exit 73;; esac; name=$(basename -- "$target"); dest="$parent/$name"; existing=0; if test -e "$dest" || test -L "$dest"; then dest=$(realpath -e -- "$dest"); case "$dest" in "$root"|"$root"/*) ;; *) exit 73;; esac; test -f "$dest"; existing=1; fi; tmp=$(mktemp "$parent/.wollipog-acp.XXXXXX"); trap 'rm -f -- "$tmp"' EXIT HUP INT TERM; cat > "$tmp"; if test "$existing" -eq 1; then chmod --reference="$dest" "$tmp"; fi; mv -f -- "$tmp" "$dest"; trap - EXIT HUP INT TERM`;
}

interface LiveTerminal {
  sessionId: string;
  child: AgentProcess;
  output: string;
  outputBytes: number;
  outputCursor: number;
  outputLimit: number;
  truncated: boolean;
  exited: boolean;
  closed: boolean;
  exitCode: number | null;
  signal: string | null;
  wait: Promise<void>;
  settle: () => void;
}

/** ACP command terminals, deliberately separate from the interactive ShellManager pool. */
export class AcpTerminalService {
  private readonly terminals = new Map<string, LiveTerminal>();
  private readonly pendingBySession = new Map<string, number>();
  private readonly sessionEpoch = new Map<string, number>();
  private sequence = 0;
  private disposed = false;

  constructor(
    private readonly fs: AcpFilesystemService,
    private readonly context: AgentContext = nativeContext,
    private readonly isolation?: SpawnIsolation,
  ) {}

  async create(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const sessionId = requiredId(params.sessionId, "session");
    if (this.disposed) throw new Error("ACP terminal service is disposed");
    const epoch = this.sessionEpoch.get(sessionId) ?? 0;
    const command = requiredCommand(params.command);
    const args = normalizeArgs(params.args);
    const env = normalizeEnvironment(params.env);
    const pending = this.pendingBySession.get(sessionId) ?? 0;
    if (this.count(sessionId) + pending >= ACP_TERMINALS_PER_SESSION) {
      throw new Error(`ACP session already has ${ACP_TERMINALS_PER_SESSION} terminals`);
    }
    this.pendingBySession.set(sessionId, pending + 1);
    const terminalId = `acp_term_${++this.sequence}`;
    try {
      const cwd = await this.fs.directory(params.cwd ?? await this.fs.directoryRoot());
      const launch = await resolveTerminalLaunch(command, cwd, env, this.context);
      if (this.disposed || (this.sessionEpoch.get(sessionId) ?? 0) !== epoch) {
        throw new Error("ACP terminal session is no longer active");
      }
      if (launch.windowsShell && args.some((arg) => /[\r\n]/.test(arg))) {
        throw new Error("ACP terminal arguments cannot contain newlines for Windows command shims");
      }
      const outputLimit = normalizeOutputLimit(params.outputByteLimit);
      const child = spawnAgent({
        command: launch.command,
        args,
        cwd,
        env,
        context: this.context,
        scrubInheritedEnv: sensitiveInheritedEnvironment(),
        windowsShell: launch.windowsShell,
        isolation: this.isolation,
      });
      let settle!: () => void;
      const wait = new Promise<void>((resolve) => { settle = resolve; });
      const live: LiveTerminal = {
        sessionId, child, output: "", outputBytes: 0, outputCursor: 0,
        outputLimit, truncated: false, exited: false, closed: false,
        exitCode: null, signal: null, wait, settle,
      };
      this.terminals.set(terminalId, live);
      const outputDone = Promise.all([
        this.consume(terminalId, live, child.stdout),
        this.consume(terminalId, live, child.stderr),
      ]);
      child.stdin.on("error", () => {});
      child.stdin.end();
      child.once("error", (error) => {
        this.append(live, `terminal failed to start: ${error.message}\n`);
        live.closed = true;
        this.finish(live, null, null);
      });
      child.once("exit", (code, signal) => {
        void settleAfterDrain(outputDone, 250).finally(() => this.finish(live, code, signal));
      });
      child.once("close", (code, signal) => {
        live.closed = true;
        void outputDone.finally(() => this.finish(live, code, signal));
      });
      return { terminalId };
    } finally {
      const remaining = (this.pendingBySession.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.pendingBySession.set(sessionId, remaining);
      else this.pendingBySession.delete(sessionId);
    }
  }

  output(sessionId: string, terminalId: string): TerminalOutputResponse {
    const { cursor: _cursor, ...response } = this.snapshot(sessionId, terminalId);
    return response;
  }

  snapshot(sessionId: string, terminalId: string): TerminalOutputResponse & { cursor: number } {
    const terminal = this.get(sessionId, terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      cursor: terminal.outputCursor,
      ...(terminal.exited ? { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } } : {}),
    };
  }

  async wait(sessionId: string, terminalId: string): Promise<WaitForTerminalExitResponse> {
    const terminal = this.get(sessionId, terminalId);
    await terminal.wait;
    return { exitCode: terminal.exitCode, signal: terminal.signal };
  }

  kill(sessionId: string, terminalId: string): void {
    const terminal = this.get(sessionId, terminalId);
    if (!terminal.closed) killTree(terminal.child);
  }

  release(sessionId: string, terminalId: string): void {
    const terminal = this.get(sessionId, terminalId);
    this.terminals.delete(terminalId);
    if (!terminal.closed) killTree(terminal.child);
  }

  releaseSession(sessionId: string): void {
    this.sessionEpoch.set(sessionId, (this.sessionEpoch.get(sessionId) ?? 0) + 1);
    for (const [id, terminal] of this.terminals) {
      if (terminal.sessionId === sessionId) this.release(sessionId, id);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const terminal of this.terminals.values()) if (!terminal.closed) killTree(terminal.child);
    this.terminals.clear();
    this.pendingBySession.clear();
    this.sessionEpoch.clear();
  }

  private count(sessionId: string): number {
    let count = 0;
    for (const terminal of this.terminals.values()) if (terminal.sessionId === sessionId) count += 1;
    return count;
  }

  private get(sessionId: string, terminalId: string): LiveTerminal {
    requiredId(sessionId, "session");
    requiredId(terminalId, "terminal");
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.sessionId !== sessionId) throw new Error("Unknown ACP terminal");
    return terminal;
  }

  private consume(id: string, terminal: LiveTerminal, stream: Readable): Promise<void> {
    const decoder = new StringDecoder("utf8");
    return (async () => {
      for await (const chunk of stream) {
        if (!this.terminals.has(id)) break;
        this.append(terminal, decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      }
      const tail = decoder.end();
      if (tail && this.terminals.has(id)) this.append(terminal, tail);
    })().catch(() => {});
  }

  private append(terminal: LiveTerminal, text: string): void {
    const textBytes = Buffer.byteLength(text, "utf8");
    terminal.outputCursor = Math.min(Number.MAX_SAFE_INTEGER, terminal.outputCursor + textBytes);
    if (!text || terminal.outputLimit === 0) {
      if (text) terminal.truncated = true;
      return;
    }
    if (terminal.outputBytes + textBytes <= terminal.outputLimit) {
      terminal.output += text;
      terminal.outputBytes += textBytes;
      return;
    }
    const bytes = Buffer.from(terminal.output + text, "utf8");
    let start = bytes.length - terminal.outputLimit;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
    terminal.output = bytes.subarray(start).toString("utf8");
    terminal.outputBytes = bytes.length - start;
    terminal.truncated = true;
  }

  private finish(terminal: LiveTerminal, code: number | null, signal: NodeJS.Signals | null): void {
    if (terminal.exited) return;
    terminal.exited = true;
    terminal.exitCode = code;
    terminal.signal = signal;
    terminal.settle();
  }
}

async function settleAfterDrain(outputDone: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      outputDone,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requiredId(value: unknown, kind: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) {
    throw new Error(`ACP ${kind} id is invalid`);
  }
  return value;
}

function requiredCommand(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || /[\r\n\0]/.test(value)) {
    throw new Error("ACP terminal command is invalid");
  }
  return value;
}

function normalizeArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1024 || value.some((arg) => typeof arg !== "string" || arg.length > 128 * 1024 || arg.includes("\0"))) {
    throw new Error("ACP terminal arguments are invalid");
  }
  return [...value];
}

async function resolveTerminalLaunch(
  command: string,
  cwd: string,
  env: Record<string, string>,
  context: AgentContext,
): Promise<{ command: string; windowsShell: boolean | undefined }> {
  if (process.platform !== "win32" || context.kind === "wsl") {
    return { command, windowsShell: undefined };
  }
  let resolved = command;
  if (isAbsolute(command)) {
    try {
      resolved = await realpath(command);
      if (!(await stat(resolved)).isFile()) throw new Error("not a file");
    } catch {
      throw new Error("ACP terminal command was not found");
    }
  } else {
    try {
      const result = await runContextCommand(context, "where.exe", [command], { cwd, env, timeoutMs: 5_000 });
      resolved = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? command;
    } catch {
      throw new Error("ACP terminal command was not found");
    }
  }
  if (/\.ps1$/i.test(resolved)) throw new Error("ACP terminal PowerShell scripts require an explicit powershell executable");
  return { command: resolved, windowsShell: /\.(?:cmd|bat)$/i.test(resolved) };
}

function normalizeEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 128) throw new Error("ACP terminal environment is invalid");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let bytes = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new Error("ACP terminal environment is invalid");
    const { name, value: itemValue } = entry as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof itemValue !== "string" || itemValue.includes("\0")) {
      throw new Error("ACP terminal environment is invalid");
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(itemValue);
    if (bytes > 256 * 1024) throw new Error("ACP terminal environment is too large");
    result[name] = itemValue;
  }
  return result;
}

function normalizeOutputLimit(value: unknown): number {
  if (value === undefined || value === null) return ACP_TERMINAL_DEFAULT_OUTPUT_LIMIT;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("ACP terminal outputByteLimit is invalid");
  return Math.min(Number(value), ACP_TERMINAL_MAX_OUTPUT_LIMIT);
}

function sensitiveInheritedEnvironment(): string[] {
  const fixed = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ];
  return [...new Set([...fixed, ...Object.keys(process.env).filter(sensitiveEnvironmentName)])];
}
