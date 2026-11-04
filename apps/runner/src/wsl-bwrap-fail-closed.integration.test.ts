import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { runContextCommand } from "./context-command.js";
import {
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
    const wsl = (args: string[]) => new Promise<{
      code: number; stdout: string; stderr: string;
    }>((resolve, reject) => {
      execFile("wsl.exe", args, { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
        else reject(error);
      });
    });
    const cmd = (await runContextCommand(context, "sh", ["-c", "command -v cmd.exe"], {
      cwd: "/", timeoutMs: 5_000,
    })).stdout.trim();
    assert.match(cmd, /^\//u);
    const registration = (await runContextCommand(context, "sh", ["-c",
      "if test -r /proc/sys/fs/binfmt_misc/WSLInterop; then printf present; else printf absent; fi",
    ], { cwd: "/", timeoutMs: 5_000 })).stdout.trim();
    const outside = await wsl(["-d", distro!, "--", "cmd.exe", "/d", "/c", "exit", "0"]);
    if (outside.code !== 0) assert.match(`${outside.stdout}${outside.stderr}`, /Exec format error/u);
    console.log(`WSLInterop control file outside: ${registration}; PE executable outside: ${outside.code === 0}`);

    // Assert the transport restriction even on hosted images whose baseline PE execution is off.
    // This fixture performs no connection or process-creation request.
    const transportProbe = `${root}/transport-probe`;
    await runContextCommand(context, "/usr/bin/cc", ["-x", "c", "-o", transportProbe, "-"], {
      cwd: root, timeoutMs: 15_000, stdin: `#include <errno.h>
#include <sys/socket.h>
#include <unistd.h>
int main(void) {
  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd != -1 || errno != EPERM) return 1;
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return 2;
  close(pair[0]); close(pair[1]);
  return 0;
}
`,
    });
    for (const network of ["inherit", "deny"] as const) {
      const launch = (command: string, args: string[]) => wsl(buildWslBwrapLaunchArgs({
        distro: distro!, bwrap: "/usr/bin/bwrap", preparation, network,
        pidfile: `${root}/provider.pgid`, command, args,
      }));
      const smoke = await launch("/bin/true", []);
      assert.equal(smoke.code, 0, `native launcher smoke (${network}): ${smoke.stderr}`);
      const visibility = await launch("/bin/sh", ["-ec",
        'test ! -e /proc/sys/fs/binfmt_misc/WSLInterop; test -z "${WSL_INTEROP+x}"; test ! -s /init',
      ]);
      assert.equal(visibility.code, 0, `interop masks (${network}): ${visibility.stderr}`);
      const transport = await launch(transportProbe, []);
      assert.equal(transport.code, 0, `VM socket must be denied while Unix sockets work (${network}): ${transport.stderr}`);
      const pe = await launch(cmd, ["/d", "/c", "exit", "0"]);
      assert.notEqual(pe.code, 0, `WSL Direct native launcher must reject Windows PE execution (${network}): ${pe.stdout}${pe.stderr}`);
      assert.doesNotMatch(`${pe.stdout}${pe.stderr}`, /CMD\.EXE was started/u);
      console.log(`PE launch remained fail-closed through the native WSL launcher (${network}, exit ${pe.code}).`);
    }
  } finally {
    await runContextCommand(context, "rm", ["-rf", "--", root], {
      cwd: "/", timeoutMs: 5_000,
    }).catch(() => {});
  }
});
