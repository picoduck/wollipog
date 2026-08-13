/**
 * Per-session shells: persistent shell processes in a session's root, with raw stdin passthrough
 * and streamed stdout/stderr. POSIX/WSL shells get a REAL PTY — allocated by util-linux `script`
 * inside the target context: full prompts, colors, readline, and TUIs. Windows-native shells use
 * the audited node-pty ConPTY addon embedded in the SEA. Other spawning rides spawnAgent, which
 * already solves WSL bridging (setsid + pidfile reaping) and Windows .cmd quoting.
 */

import { StringDecoder } from "node:string_decoder";
import type { AgentContext, ShellKind, ShellOutputChunk, ShellSnapshotMessage } from "@wollipog/protocol";
import { run } from "./discovery/resolve.js";
import { killTree, spawnAgent, type AgentProcess } from "./spawn.js";
import { openWindowsConpty, WindowsConptyProcess } from "./windows-conpty.js";

/** Upper bound on live shells per session — a forgotten tab shouldn't accumulate processes. */
export const MAX_SHELLS_PER_SESSION = 5;
export const MAX_RETAINED_SHELLS = 64;

/** Replayed after a CP/socket restart. This matches the dashboard's bounded terminal tail. */
export const SHELL_REPLAY_CAP = 200_000;

/** Chunks larger than this are split before the WS hop (keep frames small + fair). */
const CHUNK_CAP = 64 * 1024;

export interface ShellCallbacks {
  onOutput(shellId: string, sessionId: string, stream: "stdout" | "stderr", data: string, seq: number): void;
  onExit(shellId: string, sessionId: string, code: number | null, outputSeq: number): void;
}

interface LiveShell {
  sessionId: string;
  child: AgentProcess | WindowsConptyProcess;
  context: AgentContext;
  /** In-context path holding the PTY slave device name (`/dev/pts/N`), for external resize. */
  ttyFile: string | null;
  pty: boolean;
  exited: boolean;
  exitCode: number | null;
  name: string;
  createdAt: number;
  kind: ShellKind;
  output: ShellOutputChunk[];
  outputChars: number;
  outputSeq: number;
  outputTruncated: boolean;
  forgetAfterExit: boolean;
}

export interface ShellLaunch {
  command: string;
  args: string[];
  pty: boolean;
  /** Set for PTY launches — the in-context file the wrapper writes its tty device into. */
  ttyFile: string | null;
}

export interface ShellProcessLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  scrubInheritedEnv?: string[];
  verbatimCommandLine?: string;
}

export function agentTuiPlatformSupported(platform: NodeJS.Platform, context: AgentContext): boolean {
  return context.kind === "wsl" || platform === "linux" || (platform === "win32" && context.kind === "native");
}

/** Clamp requested terminal dimensions to sane bounds (and integers — they are embedded in the
 * `script -c` command string, so nothing non-numeric may ever pass). */
export function clampSize(cols: number | undefined, rows: number | undefined): { cols: number; rows: number } {
  const c = Math.floor(Number(cols));
  const r = Math.floor(Number(rows));
  return {
    cols: Number.isFinite(c) ? Math.min(500, Math.max(20, c)) : 120,
    rows: Number.isFinite(r) ? Math.min(300, Math.max(5, r)) : 30,
  };
}

let ttySeq = 0;

/** The shell launch for a context.
 *  - WSL / native Linux: util-linux `script -qefc` allocates a real PTY around the user's shell
 *    (verified: prompt + echo + colors appear, `stty rows/cols` sizes it, and an external
 *    `stty -F <pts>` resize is picked up live). The wrapper records its pts device into a
 *    runner-generated ttyFile so resize() can reach it. cols/rows are clamped integers and the
 *    ttyFile is runner-generated — the only interpolated values, both non-injectable.
 *  - Windows native: pipe-based `cmd /q` (no ConPTY without a native module — PR-C).
 *  - macOS native: pipe-based `sh` (BSD `script` has incompatible flags; boxes are Linux). */
export function shellLaunchFor(context: AgentContext, cols: number, rows: number): ShellLaunch {
  const posixPty = context.kind === "wsl" || process.platform === "linux";
  if (!posixPty) {
    return process.platform === "win32"
      ? { command: "cmd.exe", args: ["/q"], pty: true, ttyFile: null }
      : { command: "sh", args: [], pty: false, ttyFile: null };
  }
  const ttyFile = `/tmp/wollipog-shell-${process.pid}-${++ttySeq}.tty`;
  // script(1) parses its -c string with $SHELL, not sh — a fish/nushell/csh login shell would
  // choke on POSIX syntax and kill every shell open on arrival. Neutralize: capture the user's
  // real shell into both migration-window names, force SHELL=/bin/sh for script's parse, and exec it
  // inside the PTY. The inner command rides as $0 (never interpolated into the outer script);
  // rows/cols are clamped integers and ttyFile is runner-generated.
  const inner =
    `tty > ${ttyFile} 2>/dev/null; stty rows ${rows} cols ${cols} 2>/dev/null; ` +
    'exec "${WOLLIPOG_SHELL-${MAM_SHELL-/bin/bash}}"';
  // TERM guard: box runners often start from non-interactive SSH / service environments where
  // TERM is unset or "dumb" — the PTY would then be advertised while vim/less/tput degrade.
  // Only force a value when the inherited one is missing/dumb.
  const outer =
    'if [ -z "$TERM" ] || [ "$TERM" = dumb ]; then TERM=xterm-256color; export TERM; fi; ' +
    'WOLLIPOG_SHELL="${SHELL:-/bin/bash}"; export WOLLIPOG_SHELL; ' +
    'MAM_SHELL="$WOLLIPOG_SHELL"; export MAM_SHELL; SHELL=/bin/sh; export SHELL; ' +
    'exec script -qefc "$0" /dev/null';
  return { command: "sh", args: ["-c", outer, inner], pty: true, ttyFile };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Launch an exact provider argv inside the same real POSIX PTY wrapper as an ordinary shell. */
export function posixPtyCommandLaunch(
  cols: number,
  rows: number,
  launch: ShellProcessLaunch,
): ShellLaunch {
  const ttyFile = `/tmp/wollipog-shell-${process.pid}-${++ttySeq}.tty`;
  const inner =
    `tty > ${ttyFile} 2>/dev/null; stty rows ${rows} cols ${cols} 2>/dev/null; ` +
    `exec ${[launch.command, ...launch.args].map(shellQuote).join(" ")}`;
  const outer =
    'if [ -z "$TERM" ] || [ "$TERM" = dumb ]; then TERM=xterm-256color; export TERM; fi; ' +
    'SHELL=/bin/sh; export SHELL; exec script -qefc "$0" /dev/null';
  return { command: "sh", args: ["-c", outer, inner], pty: true, ttyFile };
}

/** argv for resizing a live PTY from outside: `stty -F <pts>` issues TIOCSWINSZ, which also
 * delivers SIGWINCH to the foreground process group (verified live). Positional args only.
 * The wrapper writes its pts device to the tty file ASYNCHRONOUSLY after spawn — the very first
 * corrective resize (fired by the terminal's initial fit) can race it, so wait briefly for the
 * file to be non-empty (up to ~2s) instead of silently losing the resize. */
export function resizeScriptArgs(ttyFile: string, cols: number, rows: number): string[] {
  const script =
    'i=0; while [ $i -lt 10 ] && [ ! -s "$1" ]; do sleep 0.2; i=$((i+1)); done; ' +
    'stty -F "$(cat "$1")" rows "$2" cols "$3"';
  return ["-c", script, "sh", ttyFile, String(rows), String(cols)];
}

export class ShellManager {
  private readonly shells = new Map<string, LiveShell>();

  constructor(private readonly cb: ShellCallbacks) {}

  count(sessionId: string): number {
    let n = 0;
    for (const s of this.shells.values()) if (s.sessionId === sessionId && !s.exited) n++;
    return n;
  }

  /** Spawn a shell in `cwd` (the session root). Throws on cap/duplicate/spawn failure.
   * Returns whether a real PTY backs it (dashboards pick renderer/input mode on this). */
  open(
    shellId: string,
    sessionId: string,
    cwd: string,
    context: AgentContext,
    size?: { cols?: number; rows?: number },
    meta?: { name?: string; createdAt?: number; kind?: ShellKind; launch?: ShellProcessLaunch },
  ): { pty: boolean } {
    if (this.shells.has(shellId)) throw new Error("shell already exists");
    if (this.count(sessionId) >= MAX_SHELLS_PER_SESSION) {
      throw new Error(`session already has ${MAX_SHELLS_PER_SESSION} shells`);
    }
    if (this.shells.size >= MAX_RETAINED_SHELLS) {
      throw new Error(`runner already retains ${MAX_RETAINED_SHELLS} shells`);
    }
    if (meta?.kind === "agent_tui" && [...this.shells.values()].some(
      (shell) => shell.sessionId === sessionId && shell.kind === "agent_tui" && !shell.exited,
    )) {
      throw new Error("session already has a running agent TUI");
    }
    const { cols, rows } = clampSize(size?.cols, size?.rows);
    if (meta?.kind === "agent_tui" && !meta.launch) throw new Error("agent TUI launch is unavailable");
    if (meta?.launch && !agentTuiPlatformSupported(process.platform, context)) {
      throw new Error("agent TUI is unavailable on this runner platform");
    }
    const selected = meta?.launch && (context.kind === "wsl" || process.platform === "linux")
      ? posixPtyCommandLaunch(cols, rows, meta.launch)
      : shellLaunchFor(context, cols, rows);
    const { command, args, pty, ttyFile } = selected;
    const child = process.platform === "win32" && context.kind === "native"
      ? openWindowsConpty({
          command: meta?.launch?.command ?? command,
          args: meta?.launch?.args ?? args,
          env: meta?.launch?.env,
          cwd,
          cols,
          rows,
          scrubInheritedEnv: meta?.launch?.scrubInheritedEnv,
          verbatimCommandLine: meta?.launch?.verbatimCommandLine,
        })
      : spawnAgent({
          command,
          args,
          cwd,
          context,
          env: meta?.launch?.env,
          scrubInheritedEnv: meta?.launch?.scrubInheritedEnv,
        });
    const live: LiveShell = {
      sessionId,
      child,
      context,
      ttyFile,
      pty,
      exited: false,
      exitCode: null,
      name: meta?.name?.slice(0, 80) || "Shell",
      createdAt: Number.isSafeInteger(meta?.createdAt) && meta!.createdAt! >= 0 ? meta!.createdAt! : Date.now(),
      kind: meta?.kind === "agent_tui" ? "agent_tui" : "shell",
      output: [],
      outputChars: 0,
      outputSeq: 0,
      outputTruncated: false,
      forgetAfterExit: false,
    };
    this.shells.set(shellId, live);

    // Stream chunks split on BYTE boundaries, not character boundaries — decoding each chunk
    // independently would corrupt any multibyte character straddling two chunks. A StringDecoder
    // per stream buffers the partial tail; flushed at exit so nothing is dropped.
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const emitText = (stream: "stdout" | "stderr", text: string) => {
      for (let i = 0; i < text.length; i += CHUNK_CAP) {
        const data = text.slice(i, i + CHUNK_CAP);
        const chunk: ShellOutputChunk = { seq: ++live.outputSeq, stream, data };
        live.output.push(chunk);
        live.outputChars += data.length;
        while (live.outputChars > SHELL_REPLAY_CAP && live.output.length > 0) {
          const first = live.output[0]!;
          const excess = live.outputChars - SHELL_REPLAY_CAP;
          live.outputTruncated = true;
          if (first.data.length <= excess) {
            live.output.shift();
            live.outputChars -= first.data.length;
          } else {
            first.data = first.data.slice(excess);
            live.outputChars -= excess;
          }
        }
        this.cb.onOutput(shellId, sessionId, stream, data, chunk.seq);
      }
    };
    const emit = (stream: "stdout" | "stderr") => (buf: Buffer) => emitText(stream, decoders[stream].write(buf));
    const flushDecoders = () => {
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = decoders[stream].end();
        if (tail) emitText(stream, tail);
      }
    };
    child.stdout.on("data", emit("stdout"));
    child.stderr.on("data", emit("stderr"));
    // A write into a just-died shell raises EPIPE asynchronously — without a listener it would
    // crash the whole runner (same hardening as the claude driver's stdin).
    child.stdin.on("error", () => {
      /* surfaced via exit below */
    });
    child.once("error", (err) => {
      // spawn failure (ENOENT etc.) — surface as stderr then a null exit.
      if (live.exited) return;
      live.exited = true;
      emitText("stderr", `shell failed to start: ${err.message}\n`);
      live.exitCode = null;
      this.cb.onExit(shellId, sessionId, null, live.outputSeq);
      if (live.forgetAfterExit) this.shells.delete(shellId);
    });
    // "close", not "exit": close fires only after stdio has fully drained, so no output chunk
    // can arrive after the exit notification (exit can fire with data still buffered).
    child.once("close", (code) => {
      if (live.exited) return;
      live.exited = true;
      flushDecoders(); // a trailing partial character must land before the exit
      this.removeTtyFile(live); // best-effort /tmp cleanup
      live.exitCode = code;
      this.cb.onExit(shellId, sessionId, code, live.outputSeq);
      if (live.forgetAfterExit) this.shells.delete(shellId);
    });
    return { pty };
  }

  /** Best-effort live resize of a PTY shell (no-op for pipe shells / unknown ids). `stty -F`
   * on the recorded pts issues TIOCSWINSZ; the kernel delivers SIGWINCH to the foreground
   * process group, so full-screen apps redraw. */
  resize(shellId: string, cols: number, rows: number): void {
    const s = this.shells.get(shellId);
    if (!s || s.exited || !s.pty) return;
    const clamped = clampSize(cols, rows);
    if (s.child instanceof WindowsConptyProcess) {
      s.child.resize(clamped.cols, clamped.rows);
      return;
    }
    if (!s.ttyFile) return;
    const args = resizeScriptArgs(s.ttyFile, clamped.cols, clamped.rows);
    if (s.context.kind === "wsl") {
      void run("wsl.exe", ["-d", s.context.distro, "--exec", "sh", ...args], { timeoutMs: 5000 });
    } else {
      void run("sh", args, { timeoutMs: 5000 });
    }
  }

  private removeTtyFile(live: LiveShell): void {
    if (!live.ttyFile) return;
    if (live.context.kind === "wsl") {
      void run("wsl.exe", ["-d", live.context.distro, "--exec", "rm", "-f", live.ttyFile], { timeoutMs: 5000 });
    } else {
      void run("rm", ["-f", live.ttyFile], { timeoutMs: 5000 });
    }
  }

  /** Raw stdin passthrough. False when the shell is unknown/dead (caller reports upstream). */
  input(shellId: string, data: string): boolean {
    const s = this.shells.get(shellId);
    if (!s || s.exited || !s.child.stdin.writable) return false;
    s.child.stdin.write(data);
    return true;
  }

  close(shellId: string): void {
    const s = this.shells.get(shellId);
    if (!s) return;
    s.forgetAfterExit = true;
    if (s.exited) {
      this.shells.delete(shellId);
      // A retained exited shell already emitted its process-exit frame. Emit a second idempotent
      // exit as the forget acknowledgement so an offline-close tombstone can clear immediately.
      this.cb.onExit(shellId, s.sessionId, s.exitCode, s.outputSeq);
      return;
    }
    this.kill(s); // exit handler emits onExit, then forgets the retained snapshot
  }

  /** Kill every shell belonging to a session (session deleted). */
  closeForSession(sessionId: string): void {
    for (const [shellId, s] of this.shells) {
      if (s.sessionId !== sessionId) continue;
      s.forgetAfterExit = true;
      if (s.exited) {
        this.shells.delete(shellId);
        this.cb.onExit(shellId, s.sessionId, s.exitCode, s.outputSeq);
      } else this.kill(s);
    }
  }

  /** Authoritative bounded replay, ordered by creation for deterministic reconciliation/tests. */
  snapshots(): ShellSnapshotMessage[] {
    return [...this.shells.entries()]
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .map(([shellId, shell]) => ({
        type: "shell_snapshot",
        sessionId: shell.sessionId,
        shellId,
        name: shell.name,
        createdAt: shell.createdAt,
        pty: shell.pty,
        kind: shell.kind,
        status: shell.exited ? "exited" : "running",
        exitCode: shell.exitCode,
        outputStartSeq: shell.output[0]?.seq ?? shell.outputSeq + 1,
        outputEndSeq: shell.outputSeq,
        outputTruncated: shell.outputTruncated,
        chunks: shell.output.map((chunk) => ({ ...chunk })),
      }));
  }

  /** Kill everything (runner shutdown). */
  dispose(): void {
    for (const s of this.shells.values()) this.kill(s);
  }

  private kill(shell: LiveShell): void {
    if (shell.child instanceof WindowsConptyProcess) shell.child.kill();
    else killTree(shell.child);
  }
}
