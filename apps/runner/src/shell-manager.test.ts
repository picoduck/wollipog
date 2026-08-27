import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
  MAX_SHELLS_PER_SESSION,
  ShellManager,
  agentTuiPlatformSupported,
  clampSize,
  posixPtyCommandLaunch,
  resizeScriptArgs,
  shellLaunchFor,
  type ShellCallbacks,
} from "./shell-manager.js";

const NATIVE = { kind: "native" } as const;
const ENTER = process.platform === "win32" ? "\r" : "\n";

function collector() {
  const out: { shellId: string; stream: string; data: string; seq: number }[] = [];
  const exits: { shellId: string; code: number | null; outputSeq: number }[] = [];
  const cb: ShellCallbacks = {
    onOutput: (shellId, _sessionId, stream, data, seq) => out.push({ shellId, stream, data, seq }),
    onExit: (shellId, _sessionId, code, outputSeq) => exits.push({ shellId, code, outputSeq }),
  };
  return { out, exits, cb };
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("clampSize: integers within bounds; garbage falls back to defaults", () => {
  assert.deepEqual(clampSize(120, 30), { cols: 120, rows: 30 });
  assert.deepEqual(clampSize(5, 1), { cols: 20, rows: 5 }, "floors");
  assert.deepEqual(clampSize(9999, 9999), { cols: 500, rows: 300 }, "ceilings");
  assert.deepEqual(clampSize(80.9, 24.2), { cols: 80, rows: 24 }, "floored to integers");
  assert.deepEqual(clampSize(undefined, undefined), { cols: 120, rows: 30 });
  assert.deepEqual(clampSize(NaN, Infinity), { cols: 120, rows: 30 }, "non-finite → defaults");
});

test("shellLaunchFor: WSL gets a script-PTY and Windows native selects ConPTY cmd /q", () => {
  const wsl = shellLaunchFor({ kind: "wsl", distro: "Ubuntu" }, 121, 31);
  assert.equal(wsl.command, "sh", "sh parses the wrapper — script(1) would use $SHELL (breaks fish/csh)");
  assert.equal(wsl.pty, true);
  assert.ok(wsl.ttyFile?.startsWith("/tmp/wollipog-shell-"), "in-context tty file for resize");
  assert.equal(wsl.args[0], "-c");
  const outer = wsl.args[1]!;
  assert.ok(outer.includes("SHELL=/bin/sh"), "script's -c parse shell forced to sh");
  assert.ok(outer.includes('WOLLIPOG_SHELL="${SHELL:-/bin/bash}"'), "user's real shell captured first");
  assert.ok(outer.includes('MAM_SHELL="$WOLLIPOG_SHELL"'), "legacy shell name remains exported during migration");
  assert.ok(outer.includes('script -qefc "$0" /dev/null'), "inner rides as $0, never interpolated");
  // TERM guard: service/SSH environments often have TERM unset or dumb — force a sane value
  // only then (a real inherited TERM must win).
  assert.ok(outer.includes('[ -z "$TERM" ] || [ "$TERM" = dumb ]'), "TERM guarded, not clobbered");
  assert.ok(outer.includes("TERM=xterm-256color; export TERM"), "sane TERM for the PTY");
  const inner = wsl.args[2]!;
  assert.ok(inner.includes(`tty > ${wsl.ttyFile}`), "records its pts device");
  assert.ok(inner.includes("stty rows 31 cols 121"), "initial size applied (clamped ints only)");
  assert.ok(
    inner.includes('exec "${WOLLIPOG_SHELL-${MAM_SHELL-/bin/bash}}"'),
    "the PTY uses presence-based precedence so an explicitly empty Wollipog name cannot fall through",
  );

  const native = shellLaunchFor(NATIVE, 120, 30);
  if (process.platform === "win32") {
    assert.deepEqual(native, { command: "cmd.exe", args: ["/q"], pty: true, ttyFile: null });
  } else if (process.platform === "linux") {
    assert.equal(native.command, "sh");
    assert.equal(native.pty, true);
  } else {
    assert.deepEqual(native, { command: "sh", args: [], pty: false, ttyFile: null }); // macOS: BSD script
  }
});

test("POSIX shell compatibility treats an explicitly empty Wollipog name as authoritative", {
  skip: process.platform === "win32",
}, () => {
  const result = spawnSync("sh", ["-c", 'test "${WOLLIPOG_SHELL-${MAM_SHELL-/bin/bash}}" = ""'], {
    env: { ...process.env, WOLLIPOG_SHELL: "", MAM_SHELL: "/legacy/shell" },
  });
  assert.equal(result.status, 0);
});

test("provider TUI argv is quoted into a separate POSIX PTY launch", () => {
  const launch = posixPtyCommandLaunch(100, 25, {
    command: "/opt/Agent CLI/bin/agent",
    args: ["--profile", "it's mine", "$(touch nope)"],
  });
  assert.equal(launch.pty, true);
  assert.ok(launch.args[2]?.includes("exec '/opt/Agent CLI/bin/agent' '--profile' 'it'\"'\"'s mine' '$(touch nope)'"));
  assert.ok(launch.args[2]?.includes("stty rows 25 cols 100"));
});

test("agent TUI platform gate fails closed instead of opening a macOS pipe shell", () => {
  assert.equal(agentTuiPlatformSupported("linux", NATIVE), true);
  assert.equal(agentTuiPlatformSupported("win32", NATIVE), true);
  assert.equal(agentTuiPlatformSupported("win32", { kind: "wsl", distro: "Ubuntu" }), true);
  assert.equal(agentTuiPlatformSupported("darwin", NATIVE), false);
});

test("resizeScriptArgs: tty file + dimensions ride as positional args, with a tty-file wait", () => {
  const args = resizeScriptArgs("/tmp/wollipog-shell-1-2.tty", 132, 45);
  assert.equal(args[0], "-c");
  assert.ok(args[1]!.includes('"$1"') && args[1]!.includes('"$2"') && args[1]!.includes('"$3"'));
  assert.ok(!args[1]!.includes("/tmp/wollipog-shell"), "path not interpolated into the script");
  // The wrapper writes the pts device asynchronously — the first corrective resize (fired by
  // the terminal's initial fit) must wait for the file instead of silently losing.
  assert.ok(args[1]!.includes('[ ! -s "$1" ]') && args[1]!.includes("sleep 0.2"), "bounded wait for the tty file");
  assert.deepEqual(args.slice(2), ["sh", "/tmp/wollipog-shell-1-2.tty", "45", "132"]);
});

test("shell round-trip: echo streams back, exit fires the callback", async () => {
  const { out, exits, cb } = collector();
  const mgr = new ShellManager(cb);
  mgr.open("s1", "sess", tmpdir(), NATIVE);
  if (process.platform !== "win32") {
    const child = (mgr as unknown as { shells: Map<string, { child: { posixBoundary?: unknown } }> })
      .shells.get("s1")!.child;
    assert.equal(child.posixBoundary, undefined, "ordinary user terminals do not own daemonized descendants");
  }
  await waitFor(() => mgr.input("s1", `echo wollipog_shell_ok${ENTER}`));
  await waitFor(() => out.some((o) => o.data.includes("wollipog_shell_ok")));
  assert.ok(mgr.input("s1", `exit${ENTER}`), "input accepted while alive");
  await waitFor(() => exits.length === 1);
  assert.equal(exits[0]!.shellId, "s1");
  assert.equal(exits[0]!.code, 0);
  assert.equal(exits[0]!.outputSeq, out.at(-1)!.seq, "exit fences all previously emitted output");
  assert.equal(mgr.input("s1", "echo dead\n"), false, "dead shell refuses input");
  const snapshot = mgr.snapshots().find((s) => s.shellId === "s1")!;
  assert.equal(snapshot.status, "exited");
  assert.equal(snapshot.outputEndSeq, exits[0]!.outputSeq);
  assert.ok(snapshot.chunks.some((chunk) => chunk.data.includes("wollipog_shell_ok")), "bounded replay retained");
  mgr.close("s1");
  assert.equal(exits.length, 2, "forgetting an exited shell acknowledges an offline-close tombstone");
  assert.equal(mgr.snapshots().some((s) => s.shellId === "s1"), false);
});

test("close kills the shell and the map entry; per-session cap enforced", async () => {
  const { exits, cb } = collector();
  const mgr = new ShellManager(cb);
  for (let i = 0; i < MAX_SHELLS_PER_SESSION; i++) mgr.open(`c${i}`, "sess", tmpdir(), NATIVE);
  assert.throws(() => mgr.open("over", "sess", tmpdir(), NATIVE), /already has/);
  assert.throws(() => mgr.open("c0", "other", tmpdir(), NATIVE), /already exists/);
  mgr.open("other1", "other-session", tmpdir(), NATIVE); // cap is per session

  mgr.close("c0");
  await waitFor(() => exits.some((e) => e.shellId === "c0"));
  assert.equal(mgr.count("sess"), MAX_SHELLS_PER_SESSION - 1, "closed shell freed its slot");

  mgr.dispose();
  await waitFor(() => mgr.count("sess") === 0 && mgr.count("other-session") === 0);
});

test("closeForSession kills only that session's shells", async () => {
  const { exits, cb } = collector();
  const mgr = new ShellManager(cb);
  mgr.open("a1", "sess-a", tmpdir(), NATIVE);
  mgr.open("b1", "sess-b", tmpdir(), NATIVE);
  mgr.closeForSession("sess-a");
  await waitFor(() => exits.some((e) => e.shellId === "a1"));
  assert.equal(mgr.count("sess-b"), 1, "other session's shell untouched");
  mgr.dispose();
  await waitFor(() => mgr.count("sess-b") === 0);
});

test("spawn failure surfaces as stderr + null exit instead of throwing later", async () => {
  const { out, exits } = collector();
  const mgr = new ShellManager({
    onOutput: (shellId, _s, stream, data, seq) => out.push({ shellId, stream, data, seq }),
    onExit: (shellId, _s, code, outputSeq) => exits.push({ shellId, code, outputSeq }),
  });
  // Force a spawn error with an unlaunchable command by opening in a nonexistent cwd.
  try {
    mgr.open("bad", "sess", `${tmpdir()}/definitely-missing-${process.pid}`, NATIVE);
  } catch {
    return; // sync throw is also acceptable (Windows shell:true spawns lazily; POSIX may throw)
  }
  await waitFor(() => exits.some((e) => e.shellId === "bad") || out.some((o) => o.stream === "stderr"), 20_000);
});

test("agent TUI is a separately spawned durable ConPTY process", { skip: process.platform !== "win32" }, async () => {
  const { out, exits, cb } = collector();
  const mgr = new ShellManager(cb);
  const opened = mgr.open("tui-1", "sess", tmpdir(), NATIVE, { cols: 100, rows: 25 }, {
    name: "Agent TUI",
    kind: "agent_tui",
    launch: { command: "cmd.exe", args: ["/q"] },
  });
  assert.equal(opened.pty, true);
  assert.equal(mgr.snapshots()[0]?.kind, "agent_tui");
  assert.throws(() => mgr.open("tui-2", "sess", tmpdir(), NATIVE, undefined, {
    kind: "agent_tui",
    launch: { command: "cmd.exe", args: ["/q"] },
  }), /already has a running agent TUI/);
  assert.ok(mgr.input("tui-1", `echo WOLLIPOG_SEPARATE_TUI${ENTER}`));
  await waitFor(() => out.some((chunk) => chunk.data.includes("WOLLIPOG_SEPARATE_TUI")));
  mgr.close("tui-1");
  assert.doesNotThrow(() => mgr.resize("tui-1", 120, 40), "an in-flight resize after close is harmless");
  await waitFor(() => exits.some((entry) => entry.shellId === "tui-1"));
});
