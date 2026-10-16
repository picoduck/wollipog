import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { runContextCommand } from "./context-command.js";
import {
  WSL_BWRAP_LAUNCHER_PATH,
  buildWslBwrapLaunchArgs,
  installWslBwrapLauncher,
  prepareWslBwrapIsolation,
} from "./wsl-bwrap-launcher.js";

const distro = process.env.WOLLIPOG_WSL_FAIL_CLOSED_DISTRO;

test("real WSL Direct launcher rejects aliases and Windows PE execution", {
  skip: process.platform !== "win32" || !distro,
}, async () => {
  const context = { kind: "wsl" as const, distro: distro! };
  const root = (await runContextCommand(
    context,
    "mktemp",
    ["-d", "/tmp/wollipog-wsl-path-boundary-XXXXXX"],
    { cwd: "/", timeoutMs: 5_000 },
  )).stdout.trim();
  assert.match(root, /^\/tmp\/wollipog-wsl-path-boundary-[A-Za-z0-9]+$/u);
  try {
    await runContextCommand(context, "mkdir", ["--", `${root}/protected`], {
      cwd: "/", timeoutMs: 5_000,
    });
    await runContextCommand(context, "ln", ["-s", "--", `${root}/protected`, `${root}/alias`], {
      cwd: "/", timeoutMs: 5_000,
    });
    const resolved = (await runContextCommand(
      context,
      "readlink",
      ["-f", "--", `${root}/alias`],
      { cwd: "/", timeoutMs: 5_000 },
    )).stdout.trim();
    assert.equal(resolved, `${root}/protected`, "the fixture must be a real target-local alias");

    for (const driver of ["claude-code", "codex", "codex-app-server", "acp"] as const) {
      await assert.rejects(() => resolveExecutionIsolation(
        { mode: "bwrap", network: "deny" },
        context,
        {},
        {
          driver,
          dataDir: "C:/runner",
          env: {},
          sessionId: `real-${driver}`,
          cwd: `${root}/alias`,
          // Pre-fix resolution recursively created every additional writable root. Through this
          // alias that would create protected/escaped, making the final assertion revert-sensitive.
          additionalWritableRoots: [`${root}/alias/escaped`],
        },
      ), /cannot hold target-local no-follow path handles/);
    }
    await assert.rejects(() => runContextCommand(
      context,
      "test",
      ["-e", `${root}/protected/escaped`],
      { cwd: "/", timeoutMs: 5_000 },
    ));

    await installWslBwrapLauncher(distro!);
    const preparation = await prepareWslBwrapIsolation(context, {
      bwrap: "/usr/bin/bwrap", home: root, cwd: root,
    });
    // Keep the Windows-side stdin pipe open until exit, as the real provider transport does.
    const launch = (command: string, args: string[], trace = false) => new Promise<{
      code: number; stdout: string; stderr: string;
    }>((resolve, reject) => {
      const outer = buildWslBwrapLaunchArgs({
        distro: distro!, bwrap: "/usr/bin/bwrap", preparation, network: "inherit",
        pidfile: `${root}/provider.pgid`, command, args,
      });
      if (trace) outer.splice(outer.indexOf(WSL_BWRAP_LAUNCHER_PATH), 0,
        "/usr/bin/strace", "-f", "-e", "trace=execve,execveat,socket,connect", "-o", `${root}/interop.trace`);
      execFile("wsl.exe", outer, { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: error?.code ?? 0, stdout, stderr });
      });
    });
    const smoke = await launch("/bin/true", []);
    assert.equal(smoke.code, 0, smoke.stderr);
    const cmd = (await runContextCommand(context, "sh", ["-c", "command -v cmd.exe"], {
      cwd: "/", timeoutMs: 5_000,
    })).stdout.trim();
    assert.match(cmd, /^\//u);
    // [DEBUG-1503] Temporary CI-only diagnostics of the existing benign probe's runtime route.
    await new Promise<void>((resolve, reject) => execFile("wsl.exe", ["-d", distro!, "-u", "root",
      "--exec", "/bin/sh", "-c", "apt-get install -y strace"],
    { timeout: 60_000, windowsHide: true }, (error) => error ? reject(error) : resolve()));
    console.log("[DEBUG-1503]", (await runContextCommand(context, "sh", ["-c",
      'uname -r; cat /proc/sys/fs/binfmt_misc/WSLInterop; if test -S "$WSL_INTEROP"; then printf "interop socket present\\n"; fi',
    ], { cwd: "/", timeoutMs: 5_000 })).stdout);
    const pe = await launch(cmd, ["/d", "/c", "exit", "0"], true);
    console.log("[DEBUG-1503]", (await runContextCommand(context, "cat", [`${root}/interop.trace`], {
      cwd: "/", timeoutMs: 5_000,
    })).stdout);
    assert.notEqual(pe.code, 0, `WSL Direct native launcher must reject Windows PE execution: ${pe.stdout}${pe.stderr}`);
  } finally {
    await runContextCommand(context, "rm", ["-rf", "--", root], {
      cwd: "/", timeoutMs: 5_000,
    }).catch(() => {});
  }
});
