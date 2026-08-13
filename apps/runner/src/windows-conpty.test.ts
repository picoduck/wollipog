import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { waitForPendingKills } from "./spawn.js";
import {
  conptyPrebuildDirectory,
  openWindowsConpty,
  resolveConptyAddonPath,
  windowsCommandLine,
  windowsEnvironmentForLaunch,
} from "./windows-conpty.js";

test("windowsCommandLine preserves empty, quoted, and trailing-backslash argv", () => {
  assert.equal(
    windowsCommandLine("C:\\Program Files\\agent.exe", ["", "plain", "two words", 'say "yes"', "C:\\tail\\"]),
    '"C:\\Program Files\\agent.exe" "" plain "two words" "say \\"yes\\"" C:\\tail\\',
  );
});

test("published ConPTY prebuild matches the current Windows architecture", { skip: process.platform !== "win32" }, () => {
  const path = resolveConptyAddonPath();
  assert.equal(existsSync(path), true);
  assert.ok(path.includes(`win32-${process.arch}`));
  const prebuilds = dirname(dirname(path));
  assert.equal(existsSync(join(prebuilds, "win32-arm64", "conpty.node")), true);
  assert.equal(existsSync(join(prebuilds, "win32-x64", "conpty.node")), true);
});

test("ConPTY asset selection fails clearly outside its published Windows architectures", () => {
  assert.equal(conptyPrebuildDirectory("win32", "x64"), "win32-x64");
  assert.equal(conptyPrebuildDirectory("win32", "arm64"), "win32-arm64");
  assert.throws(() => conptyPrebuildDirectory("win32", "ia32"), /no published Windows ia32 addon.*x64 and arm64/i);
  assert.throws(() => conptyPrebuildDirectory("linux", "x64"), /only on Windows/i);
});

test("ConPTY environment scrubs inherited provider keys but preserves explicit configuration", () => {
  assert.deepEqual(
    windowsEnvironmentForLaunch({}, ["OPENAI_API_KEY"], { OpenAI_Api_Key: "stray", KEEP: "yes" }),
    ["KEEP=yes"],
  );
  assert.deepEqual(
    windowsEnvironmentForLaunch({ OPENAI_API_KEY: "configured" }, ["OPENAI_API_KEY"], {
      OpenAI_Api_Key: "stray",
      KEEP: "yes",
    }),
    ["KEEP=yes", "OPENAI_API_KEY=configured"],
  );
  assert.deepEqual(
    windowsEnvironmentForLaunch({ PATH: "configured-path" }, [], { Path: "inherited-path", KEEP: "yes" }),
    ["KEEP=yes", "PATH=configured-path"],
    "configured values replace case-colliding inherited Windows environment names",
  );
});

test("native ConPTY failed setup is cleaned before the next process opens", { skip: process.platform !== "win32" }, async () => {
  assert.throws(() => openWindowsConpty({
    command: `wollipog-missing-conpty-command-${process.pid}.exe`,
    args: [],
    cwd: tmpdir(),
    cols: 80,
    rows: 24,
  }), Error);

  const child = openWindowsConpty({ command: "cmd.exe", args: ["/q"], cwd: tmpdir(), cols: 80, rows: 24 });
  child.kill();
  await waitForPendingKills(5_000);
});

test("native ConPTY ignores resize after kill begins", { skip: process.platform !== "win32" }, async () => {
  const child = openWindowsConpty({ command: "cmd.exe", args: ["/q"], cwd: tmpdir(), cols: 80, rows: 24 });
  child.kill();
  assert.doesNotThrow(() => child.resize(100, 40));
  await waitForPendingKills(5_000);
});

test("native ConPTY supports interactive input, output, resize, and exit", { skip: process.platform !== "win32" }, async () => {
  const child = openWindowsConpty({ command: "cmd.exe", args: ["/q"], cwd: tmpdir(), cols: 90, rows: 28 });
  let output = "";
  let closeCount = 0;
  const streamErrors: Error[] = [];
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stdout.on("error", (error) => { streamErrors.push(error); });
  child.on("close", () => { closeCount++; });
  try {
    child.stdin.write("echo WOLLIPOG_CONPTY_OK\r\n");
    const started = Date.now();
    while (!output.includes("WOLLIPOG_CONPTY_OK")) {
      if (Date.now() - started > 10_000) throw new Error(`ConPTY output timed out: ${JSON.stringify(output)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.resize(111, 37);
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    child.stdin.write("exit\r\n");
    assert.equal(await closed, 0);
    const outputAtClose = output;
    (child as unknown as {
      handleWorkerMessage(message: { type: "data"; data: Uint8Array }): void;
    }).handleWorkerMessage({ type: "data", data: Buffer.from("WOLLIPOG_LATE_CONPTY_OUTPUT") });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(output, outputAtClose, "queued worker output is ignored after stdout has ended");
    assert.deepEqual(streamErrors, []);
    assert.equal(closeCount, 1);
  } finally {
    child.kill();
  }
});
