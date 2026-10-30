import assert from "node:assert/strict";
import { type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexAppServerDriver } from "./drivers/codex-app-server.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { buildBwrapArgs } from "./spawn.js";

const RUN = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 } satisfies SpawnSyncOptionsWithStringEncoding;
const installed = process.env.CODEX_BIN ?? "codex";
const version = spawnSync(installed, ["--version"], RUN);
const skip = process.platform !== "linux" || process.getuid?.() === 0
  ? "requires a non-root Linux host"
  : version.status !== 0 ? "Codex is not installed"
    // Outside a runner boundary, a Codex that cannot sandbox commands refuses to launch (#3843).
    : spawnSync(installed, ["sandbox", "--", "true"], RUN).status !== 0 ? "Codex cannot sandbox commands on this host" : false;

test("a real Codex App completes turns after its standalone installer cannot write packages", { skip, timeout: 90_000 }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-codex-update-")));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const packages = join(codexHome, "packages");
  const standalone = join(packages, "standalone");
  const release = join(standalone, "releases", "test-release");
  const bin = join(release, "bin");
  const tools = join(root, "tools");
  const cwd = join(root, "work");
  mkdirSync(bin, { recursive: true });
  mkdirSync(tools);
  mkdirSync(cwd);
  const source = installed.includes("/") ? installed : spawnSync("sh", ["-c", "command -v codex"], RUN).stdout.trim();
  const codex = join(bin, "codex");
  copyFileSync(realpathSync(source), codex, constants.COPYFILE_FICLONE);
  chmodSync(codex, 0o700);
  symlinkSync("releases/test-release", join(standalone, "current"));
  // Exercise Codex's actual standalone update action with a local installer response. It cannot
  // download or replace an operator install: this copied binary and CODEX_HOME are disposable.
  writeFileSync(join(tools, "curl"), '#!/bin/sh\ncat <<\'INSTALLER\'\n' +
    'echo package-write-probe >&2\nmkdir "$CODEX_HOME/packages/update-probe"\nINSTALLER\n', { mode: 0o700 });
  const env = { HOME: home, CODEX_HOME: codexHome, PATH: `${tools}:/usr/bin:/bin`, PROBE_KEY: "local" };
  chmodSync(packages, 0o500);
  t.after(() => { chmodSync(packages, 0o700); rmSync(root, { recursive: true, force: true }); });
  const update = spawnSync(codex, ["update"], { ...RUN, env });
  assert.notEqual(update.status, 0);
  assert.match(`${update.stdout}${update.stderr}`, /package-write-probe/,
    "the real updater must reach the local installer rather than fail install detection");
  assert.match(update.stderr, /Permission denied|Read-only file system/i);
  assert.equal(existsSync(join(packages, "update-probe")), false);

  let requests = 0;
  const model = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      const item = { type: "message", id: `message-${requests}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "turn completed" }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `response-${requests}`, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `response-${requests}`, status: "completed", output: [item] } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(() => model.close());
  const port = (model.address() as { port: number }).port;
  writeFileSync(join(codexHome, "config.toml"), 'model = "probe-model"\nmodel_provider = "probe"\n' +
    '[model_providers.probe]\nname = "Probe"\n' +
    `base_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "PROBE_KEY"\n`);
  const errors: string[] = [];
  const driver = new CodexAppServerDriver({ command: codex, args: [], cwd, env,
    config: { permissionMode: "on-request" }, context: { kind: "native" } }, {
    onEvent: () => {}, onStderr: (text) => errors.push(text), onExit: () => {},
  });
  try {
    await driver.initialize();
    await driver.newSession(cwd);
    assert.equal(await driver.prompt("Run the first local smoke turn."), "end_turn", errors.join("\n"));
    assert.equal(await driver.prompt("Run the second local smoke turn."), "end_turn", errors.join("\n"));
    assert.equal(requests, 2);
    assert.equal(existsSync(join(packages, "update-probe")), false);
  } finally {
    driver.dispose();
  }
});

const bwrapWorks = process.platform === "linux" && spawnSync("bwrap", [
  "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--", "/bin/true",
], RUN).status === 0;

test("a real package overlay prevents binary, current-link, and package-directory replacement", {
  skip: bwrapWorks ? false : "bubblewrap cannot create a user namespace on this host",
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-package-overlay-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const packages = join(codexHome, "packages");
  const release = join(packages, "standalone", "release");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "codex"), "original");
  symlinkSync("release", join(packages, "standalone", "current"));
  const isolation = await resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
    driver: "codex-app-server", env: { HOME: home, CODEX_HOME: codexHome }, sessionId: "s_overlay",
    dataDir: join(root, "state"), cwd: root, additionalWritableRoots: [codexHome],
  });
  assert.ok(isolation?.backend === "bwrap");
  const script = [
    'test ! -w "$CODEX_HOME/packages"',
    'if echo corrupt > "$CODEX_HOME/packages/standalone/release/codex"; then exit 11; fi',
    'if rm "$CODEX_HOME/packages/standalone/current"; then exit 12; fi',
    'if mv "$CODEX_HOME/packages" "$CODEX_HOME/stolen"; then exit 13; fi',
    'echo credential > "$CODEX_HOME/auth.json"',
  ].join("\n");
  const result = spawnSync(isolation.command, buildBwrapArgs({ command: "/bin/sh", args: ["-ec", script], cwd: root }, isolation),
    { ...RUN, env: { ...process.env, HOME: home, CODEX_HOME: codexHome } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(release, "codex"), "utf8"), "original");
  assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), "credential\n");
});
