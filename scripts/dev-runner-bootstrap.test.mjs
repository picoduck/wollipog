import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  controlPlaneHttp,
  developmentConfigPath,
  developmentDataDir,
  isControlPlaneService,
  isRunnerCredentialToken,
  developmentRunnerWatch,
  developmentStartTimeout,
  runnerLaunchArgs,
  localDeviceTokenPath,
  provisionDevelopmentCredential,
  readLocalDeviceToken,
  runnerWebSocketUrl,
  waitForControlPlane,
} from "./dev-runner-bootstrap.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controlPlaneRoot = resolve(repoRoot, "apps/control-plane");

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(3_000)]);
}

function response(status, body = {}, statusText = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

test("development credential issuance keeps the token out of request bodies and rotates on conflict", async () => {
  const calls = [];
  const localDeviceToken = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1_";
  const runnerToken = `wollipogr_${"a".repeat(43)}`;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response(409, { error: "registered runner already has an active credential; rotate it instead" })
      : response(200, { token: runnerToken, credential: { runnerId: "local/dev" } });
  };

  assert.equal(
    await provisionDevelopmentCredential("http://127.0.0.1:4317", "local/dev", localDeviceToken, fetchImpl),
    runnerToken,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:4317/api/runner-credentials");
  assert.equal(calls[1].url, "http://127.0.0.1:4317/api/runner-credentials/local%2Fdev/rotate");
  assert.deepEqual(JSON.parse(calls[0].init.body), { runnerId: "local/dev", label: "Local development runner" });
  assert.equal(calls.every((call) => !call.init.body.includes(runnerToken)), true);
  assert.equal(calls.every((call) => call.init.headers.authorization === `Bearer ${localDeviceToken}`), true);
  assert.equal(calls.every((call) => !call.init.body.includes(localDeviceToken)), true);
});

test("runner credential validation accepts exact legacy and Wollipog generations", () => {
  const secret = "a".repeat(43);

  assert.equal(isRunnerCredentialToken(`mamr_${secret}`), true);
  assert.equal(isRunnerCredentialToken(`wollipogr_${secret}`), true);

  for (const invalidToken of [
    `mamr_${"a".repeat(42)}`,
    `mamr_${"a".repeat(44)}`,
    `wollipogr_${"a".repeat(42)}`,
    `wollipogr_${"a".repeat(44)}`,
    `mamr_${"a".repeat(41)}+/`,
    `wollipogr_${"a".repeat(41)}+/`,
    `wollipog_${secret}`,
    `wpr_${secret}`,
    `mamr_${"é".repeat(21)}a`,
    `wollipogr_${"\u{1F600}".repeat(21)}a`,
    "",
    null,
  ]) {
    assert.equal(isRunnerCredentialToken(invalidToken), false);
  }
});

test("development credential provisioning accepts the Wollipog generation", async () => {
  const runnerToken = `wollipogr_${"a".repeat(43)}`;

  const credential = await provisionDevelopmentCredential(
    "http://127.0.0.1:4317",
    "local",
    "a".repeat(43),
    async () => response(201, { token: runnerToken }),
  );

  assert.equal(credential, runnerToken);
});

test("development credential failures stay precise without accepting malformed secrets", async () => {
  await assert.rejects(
    provisionDevelopmentCredential(
      "http://127.0.0.1:4317",
      "local",
      "a".repeat(43),
      async () => response(403, { error: "owner required" }),
    ),
    /could not provision local runner credential: owner required/,
  );
  await assert.rejects(
    provisionDevelopmentCredential(
      "http://127.0.0.1:4317",
      "local",
      "a".repeat(43),
      async () => response(201, { token: "legacy" }),
    ),
    /invalid local runner credential/,
  );
});

test("development bootstrap reads the protected control-plane credential from matching coordinates", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-dev-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = "b".repeat(43);
  const defaultPath = localDeviceTokenPath(root, { CONTROL_PLANE_DB: "state/custom.db" });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(defaultPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  assert.equal(await readLocalDeviceToken(defaultPath), token);
  assert.equal(
    localDeviceTokenPath(root, { CONTROL_PLANE_LOCAL_TOKEN_FILE: "secure/override.token" }),
    join(root, "secure", "override.token"),
  );
  writeFileSync(defaultPath, "short\n");
  await assert.rejects(readLocalDeviceToken(defaultPath), /credential is invalid/);
});

test("filtered control-plane startup and development bootstrap share relative coordinate bases", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-dev-bootstrap-live-"));
  const database = join(root, "control-plane.db");
  const port = await reservePort();
  const relativeDatabase = relative(controlPlaneRoot, database);
  const env = {
    ...process.env,
    CONTROL_PLANE_HOST: "127.0.0.1",
    CONTROL_PLANE_PORT: String(port),
    CONTROL_PLANE_DB: relativeDatabase,
    CONTROL_PLANE_LOCAL_TOKEN_FILE: "",
  };
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: controlPlaneRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += String(chunk); });
  child.stderr.on("data", (chunk) => { logs += String(chunk); });
  t.after(async () => {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForControlPlane(baseUrl, { timeoutMs: 20_000, retryMs: 50 });
  } catch (error) {
    assert.fail(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  }
  const expectedPath = `${resolve(controlPlaneRoot, relativeDatabase)}.local-device-token`;
  assert.equal(localDeviceTokenPath(undefined, env), expectedPath);
  const localToken = await readLocalDeviceToken(expectedPath);
  const runnerToken = await provisionDevelopmentCredential(baseUrl, "dev-path-contract", localToken);
  assert.match(runnerToken, /^wollipogr_[A-Za-z0-9_-]{43}$/u);
});

test("health wait verifies the service marker and honors custom dev coordinates", async () => {
  let calls = 0;
  await waitForControlPlane("http://127.0.0.1:9999", {
    timeoutMs: 100,
    retryMs: 1,
    fetchImpl: async () => response(200, { service: ++calls === 1 ? "other" : "wollipog-control-plane" }),
  });
  assert.equal(calls, 2);
  assert.equal(isControlPlaneService("misko-agent-manager-control-plane"), true);
  assert.equal(isControlPlaneService("wollipog-control-plane"), true);
  assert.equal(isControlPlaneService("other"), false);
  assert.equal(controlPlaneHttp({ CONTROL_PLANE_PORT: "4444" }), "http://127.0.0.1:4444");
  assert.equal(controlPlaneHttp({ WOLLIPOG_DEV_CONTROL_PLANE_HTTP: "http://localhost:5555" }), "http://localhost:5555");
  assert.equal(runnerWebSocketUrl("http://localhost:5555"), "ws://localhost:5555/runner");
  assert.equal(runnerWebSocketUrl("https://manager.example/base?old=1"), "wss://manager.example/runner");
  assert.match(developmentConfigPath("C:/repo", {}, () => true), /runner\.config\.json$/);
  assert.match(developmentConfigPath("C:/repo", {}, () => false), /runner\.config\.example\.json$/);
  assert.match(developmentConfigPath("C:/repo", { WOLLIPOG_DEV_RUNNER_CONFIG: "custom.json" }, () => false), /custom\.json$/);
  const defaultDataDir = developmentDataDir("/repo", {}, undefined, "/home/dev");
  assert.match(defaultDataDir, /^\/home\/dev\/\.wollipog-dev\/[a-f0-9]{12}$/);
  assert.notEqual(defaultDataDir, developmentDataDir("/other-repo", {}, undefined, "/home/dev"));
  assert.equal(developmentDataDir("/repo", {}, "config/runner", "/home/dev"), resolve("/repo", "config/runner"));
  assert.equal(developmentDataDir("/repo", { RUNNER_DATA_DIR: "scratch/runner" }, "config/runner"), resolve("/repo", "scratch/runner"));
  assert.equal(developmentDataDir("/repo", { RUNNER_DATA_DIR: "/var/lib/wollipog-dev" }), "/var/lib/wollipog-dev");
  assert.equal(developmentDataDir("C:/repo", { RUNNER_DATA_DIR: "D:\\wollipog-dev" }), "D:\\wollipog-dev");
});

test("development bootstrap aliases prefer Wollipog names and warn only on legacy fallback", () => {
  const warnings = [];
  assert.equal(
    controlPlaneHttp(
      {
        WOLLIPOG_DEV_CONTROL_PLANE_HTTP: "http://current:5555",
        MAM_DEV_CONTROL_PLANE_HTTP: "http://legacy:5555",
      },
      (warning) => warnings.push(warning),
    ),
    "http://current:5555",
  );
  assert.match(
    developmentConfigPath(
      "C:/repo",
      { WOLLIPOG_DEV_RUNNER_CONFIG: "current.json", MAM_DEV_RUNNER_CONFIG: "legacy.json" },
      () => false,
      (warning) => warnings.push(warning),
    ),
    /current\.json$/,
  );
  assert.equal(
    developmentStartTimeout(
      { WOLLIPOG_DEV_START_TIMEOUT_MS: "123", MAM_DEV_START_TIMEOUT_MS: "456" },
      (warning) => warnings.push(warning),
    ),
    123,
  );
  assert.deepEqual(warnings, []);

  assert.equal(
    controlPlaneHttp({ MAM_DEV_CONTROL_PLANE_HTTP: "http://legacy:5555" }, (warning) => warnings.push(warning)),
    "http://legacy:5555",
  );
  assert.match(
    developmentConfigPath(
      "C:/repo",
      { MAM_DEV_RUNNER_CONFIG: "legacy.json" },
      () => false,
      (warning) => warnings.push(warning),
    ),
    /legacy\.json$/,
  );
  assert.equal(
    developmentStartTimeout({ MAM_DEV_START_TIMEOUT_MS: "456" }, (warning) => warnings.push(warning)),
    456,
  );
  assert.deepEqual(warnings, [
    "MAM_DEV_CONTROL_PLANE_HTTP is deprecated; use WOLLIPOG_DEV_CONTROL_PLANE_HTTP",
    "MAM_DEV_RUNNER_CONFIG is deprecated; use WOLLIPOG_DEV_RUNNER_CONFIG",
    "MAM_DEV_START_TIMEOUT_MS is deprecated; use WOLLIPOG_DEV_START_TIMEOUT_MS",
  ]);

  assert.equal(
    controlPlaneHttp({ WOLLIPOG_DEV_CONTROL_PLANE_HTTP: "", MAM_DEV_CONTROL_PLANE_HTTP: "http://legacy:5555" }),
    "http://127.0.0.1:4317",
  );
});

test("runner watch mode defaults on and can be disabled by argv or environment", () => {
  assert.equal(developmentRunnerWatch({}, ["node", "bootstrap.mjs"]), true);
  assert.equal(developmentRunnerWatch({}, ["node", "bootstrap.mjs", "--no-watch"]), false);
  assert.equal(developmentRunnerWatch({ WOLLIPOG_DEV_RUNNER_WATCH: "0" }, []), false);
  // Padding is trimmed on purpose, matching how every other development variable here is read:
  // an operator who wrote 0 in an env file meant 0, and ignoring them would leave a watcher
  // running that they explicitly asked to turn off.
  assert.equal(developmentRunnerWatch({ WOLLIPOG_DEV_RUNNER_WATCH: " 0 " }, []), false);
  // Only an exact opt-out disables it: an unrecognized value must not silently drop the watcher
  // that ordinary development depends on.
  assert.equal(developmentRunnerWatch({ WOLLIPOG_DEV_RUNNER_WATCH: "1" }, []), true);
  assert.equal(developmentRunnerWatch({ WOLLIPOG_DEV_RUNNER_WATCH: "false" }, []), true);
  // argv wins over an environment that leaves watching enabled.
  assert.equal(developmentRunnerWatch({ WOLLIPOG_DEV_RUNNER_WATCH: "1" }, ["--no-watch"]), false);
});

test("runner watch mode honors the legacy alias and warns only on that fallback", () => {
  const warnings = [];
  assert.equal(developmentRunnerWatch({ MAM_DEV_RUNNER_WATCH: "0" }, [], (w) => warnings.push(w)), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MAM_DEV_RUNNER_WATCH is deprecated; use WOLLIPOG_DEV_RUNNER_WATCH/u);

  const quiet = [];
  assert.equal(
    developmentRunnerWatch(
      { WOLLIPOG_DEV_RUNNER_WATCH: "0", MAM_DEV_RUNNER_WATCH: "1" },
      [],
      (w) => quiet.push(w),
    ),
    false,
  );
  assert.deepEqual(quiet, []);
});

test("runner launch argv drops only the watcher and keeps the config pairing intact", () => {
  const watched = runnerLaunchArgs("/tsx/cli.mjs", "/repo/runner.config.json", true);
  assert.deepEqual(watched, [
    "/tsx/cli.mjs", "watch", "apps/runner/src/cli.ts", "--config", "/repo/runner.config.json",
  ]);

  const unwatched = runnerLaunchArgs("/tsx/cli.mjs", "/repo/runner.config.json", false);
  assert.deepEqual(unwatched, [
    "/tsx/cli.mjs", "apps/runner/src/cli.ts", "--config", "/repo/runner.config.json",
  ]);
  assert.ok(!unwatched.includes("watch"));
  // The config path must stay adjacent to its flag, and must never be parsed as the entrypoint.
  assert.equal(unwatched[unwatched.indexOf("--config") + 1], "/repo/runner.config.json");
  assert.equal(unwatched[1], "apps/runner/src/cli.ts");
});
