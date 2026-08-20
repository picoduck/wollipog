/**
 * Development-only runner bootstrap.
 *
 * The control plane accepts exact runner credentials, so the historical fixed
 * `dev-local-token` cannot register a new runner (and intentionally cannot be copied across a
 * fleet). This helper waits for the local control plane, issues or rotates one credential for the
 * runner id in runner.config.json, and passes the one-time secret only in the runner child's
 * environment. The secret is never written to disk, placed in argv, or logged.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCompatibleEnv } from "./env-compat.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const defaultControlPlaneRoot = resolve(repoRoot, "apps/control-plane");
export const LEGACY_CONTROL_PLANE_SERVICE = "misko-agent-manager-control-plane";
export const WOLLIPOG_CONTROL_PLANE_SERVICE = "wollipog-control-plane";
const LEGACY_RUNNER_CREDENTIAL_PREFIX = "mamr_";
const WOLLIPOG_RUNNER_CREDENTIAL_PREFIX = "wollipogr_";
const RUNNER_CREDENTIAL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isControlPlaneService(value) {
  return value === LEGACY_CONTROL_PLANE_SERVICE || value === WOLLIPOG_CONTROL_PLANE_SERVICE;
}

export function controlPlaneHttp(env = process.env, warn) {
  return readCompatibleEnv(
    env,
    "WOLLIPOG_DEV_CONTROL_PLANE_HTTP",
    "MAM_DEV_CONTROL_PLANE_HTTP",
    warn,
  )?.trim() ||
    `http://127.0.0.1:${env.CONTROL_PLANE_PORT?.trim() || "4317"}`;
}

export function runnerWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/runner";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function developmentConfigPath(root = repoRoot, env = process.env, pathExists = existsSync, warn) {
  const configured = readCompatibleEnv(
    env,
    "WOLLIPOG_DEV_RUNNER_CONFIG",
    "MAM_DEV_RUNNER_CONFIG",
    warn,
  )?.trim();
  if (configured) return resolve(root, configured);
  const localConfig = resolve(root, "runner.config.json");
  return pathExists(localConfig) ? localConfig : resolve(root, "runner.config.example.json");
}

export function developmentStartTimeout(env = process.env, warn) {
  return Number(readCompatibleEnv(
    env,
    "WOLLIPOG_DEV_START_TIMEOUT_MS",
    "MAM_DEV_START_TIMEOUT_MS",
    warn,
  ) || 30_000);
}

/** Keep development credentials and mutable runner state outside both the installed runner data
 * directory and the source checkout. Environment and file configuration remain authoritative. */
export function developmentDataDir(root = repoRoot, env = process.env, fileDataDir, home = homedir()) {
  const configured = env.RUNNER_DATA_DIR?.trim() || fileDataDir?.trim();
  if (configured) {
    if (configured.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(configured)) return configured;
    return resolve(root, configured);
  }
  const checkout = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12);
  return resolve(home, ".wollipog-dev", checkout);
}

/** Resolve relative control-plane coordinates from the package cwd used by pnpm --filter. */
export function localDeviceTokenPath(root = defaultControlPlaneRoot, env = process.env) {
  const configured = env.CONTROL_PLANE_LOCAL_TOKEN_FILE?.trim();
  if (configured) return resolve(root, configured);
  const database = env.CONTROL_PLANE_DB?.trim() || "data/control-plane.db";
  return `${resolve(root, database)}.local-device-token`;
}

export async function readLocalDeviceToken(path) {
  const raw = await readFile(path, "utf8");
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error(`local control-plane credential is invalid: ${path}`);
  }
  return token;
}

export async function waitForControlPlane(baseUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryMs = options.retryMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  let lastError = "control plane did not answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.json();
        if (isControlPlaneService(body?.service)) return;
        lastError = "another service is listening on the control-plane port";
      } else {
        lastError = `health check returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs));
  }
  throw new Error(`local control plane was not ready within ${timeoutMs}ms: ${lastError}`);
}

async function responseError(response) {
  try {
    const body = await response.json();
    if (typeof body?.error === "string" && body.error.trim()) return body.error;
  } catch {
    // Fall through to the status text without echoing a response body that might contain a secret.
  }
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

async function credentialRequest(fetchImpl, url, localDeviceToken, body) {
  return fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${localDeviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function isRunnerCredentialToken(value) {
  if (typeof value !== "string") return false;

  return [WOLLIPOG_RUNNER_CREDENTIAL_PREFIX, LEGACY_RUNNER_CREDENTIAL_PREFIX].some(
    (prefix) =>
      value.startsWith(prefix) &&
      RUNNER_CREDENTIAL_SECRET_PATTERN.test(value.slice(prefix.length)),
  );
}

/** Issue an exact-id credential, or rotate the existing active credential on later dev starts. */
export async function provisionDevelopmentCredential(baseUrl, runnerId, localDeviceToken, fetchImpl = fetch) {
  let response = await credentialRequest(fetchImpl, `${baseUrl}/api/runner-credentials`, localDeviceToken, {
    runnerId,
    label: "Local development runner",
  });
  if (response.status === 409) {
    response = await credentialRequest(
      fetchImpl,
      `${baseUrl}/api/runner-credentials/${encodeURIComponent(runnerId)}/rotate`,
      localDeviceToken,
      { label: "Local development runner" },
    );
  }
  if (!response.ok) throw new Error(`could not provision local runner credential: ${await responseError(response)}`);
  const body = await response.json();
  if (!isRunnerCredentialToken(body?.token)) {
    throw new Error("control plane returned an invalid local runner credential");
  }
  return body.token;
}

export async function configuredRunnerSettings(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${configPath}: ${detail}`);
  }
  const runnerId = typeof parsed?.runnerId === "string" ? parsed.runnerId.trim() : "";
  if (!runnerId) throw new Error(`${configPath} must contain a non-empty runnerId`);
  const dataDir = typeof parsed?.dataDir === "string" ? parsed.dataDir.trim() : "";
  return { runnerId, dataDir: dataDir || undefined };
}

export async function configuredRunnerId(configPath) {
  return (await configuredRunnerSettings(configPath)).runnerId;
}

/**
 * Watch mode is the development default, but a long-lived dogfooding stack wants it off: with a
 * watcher attached, an ordinary `git pull` that touches runner sources recycles the runner child
 * seconds later, killing live provider sessions that the stack is actively being used to run.
 *
 * `--no-watch` is the package-script path because npm scripts cannot set an environment variable
 * inline on every supported platform. The environment variable is the launcher path, for wrappers
 * that start the stack through `pnpm dev:all` and cannot inject argv.
 */
export function developmentRunnerWatch(env = process.env, argv = process.argv, warn) {
  if (argv.includes("--no-watch")) return false;
  const configured = readCompatibleEnv(
    env,
    "WOLLIPOG_DEV_RUNNER_WATCH",
    "MAM_DEV_RUNNER_WATCH",
    warn,
  )?.trim();
  return configured !== "0";
}

/** Runner argv for tsx, with or without the watcher. Split out so the shape stays testable. */
export function runnerLaunchArgs(tsxCli, configPath, watch) {
  const runner = ["apps/runner/src/cli.ts", "--config", configPath];
  return watch ? [tsxCli, "watch", ...runner] : [tsxCli, ...runner];
}

function startRunner(token, baseUrl, configPath, dataDir, watch) {
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  // Invoke Node + tsx by argv so config paths remain inert on every platform. The credential stays
  // exclusively in the child environment, never in argv or a shell command.
  return spawn(process.execPath, runnerLaunchArgs(tsxCli, configPath, watch), {
    cwd: repoRoot,
    env: {
      ...process.env,
      RUNNER_TOKEN: token,
      CONTROL_PLANE_URL: runnerWebSocketUrl(baseUrl),
      RUNNER_DATA_DIR: dataDir,
    },
    stdio: "inherit",
  });
}

export async function main() {
  const warnLegacyEnvironment = (warning) => console.warn(`[dev-runner] ${warning}`);
  const configPath = developmentConfigPath(repoRoot, process.env, existsSync, warnLegacyEnvironment);
  const configured = await configuredRunnerSettings(configPath);
  const runnerId = configured.runnerId;
  const baseUrl = controlPlaneHttp(process.env, warnLegacyEnvironment);
  await waitForControlPlane(baseUrl, {
    timeoutMs: developmentStartTimeout(process.env, warnLegacyEnvironment),
  });
  const localDeviceToken = await readLocalDeviceToken(localDeviceTokenPath());
  const token = await provisionDevelopmentCredential(baseUrl, runnerId, localDeviceToken);
  const dataDir = developmentDataDir(repoRoot, process.env, configured.dataDir);
  const watch = developmentRunnerWatch(process.env, process.argv, warnLegacyEnvironment);
  console.log(`[dev-runner] starting ${runnerId} with an ephemeral exact-id credential and isolated state at ${dataDir}`);
  if (!watch) console.log("[dev-runner] watch mode disabled; restart manually to pick up source changes");
  const child = startRunner(token, baseUrl, configPath, dataDir, watch);
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.on("error", (error) => {
    console.error(`[dev-runner] runner launch failed: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`[dev-runner] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
