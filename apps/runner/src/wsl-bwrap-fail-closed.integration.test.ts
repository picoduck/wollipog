import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { runContextCommand } from "./context-command.js";

const distro = process.env.WOLLIPOG_WSL_FAIL_CLOSED_DISTRO;

test("real WSL aliases remain unavailable to Direct bwrap launches", {
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
  } finally {
    await runContextCommand(context, "rm", ["-rf", "--", root], {
      cwd: "/", timeoutMs: 5_000,
    }).catch(() => {});
  }
});
