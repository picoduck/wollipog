import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const TESTED_OPENCLAW_VERSION = "2026.11.3";
export class OpenClawSetupError extends Error {}

/** Build a separate runtime config; credentials stay in the child environment. */
export function connectionConfig(connections) {
  if (!Array.isArray(connections) || !connections.length) throw new Error("At least one named connection is required.");
  const servers = {};
  for (const entry of connections) {
    const { name, url, tokenEnv } = entry ?? {};
    if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,29}$/.test(name) || Object.hasOwn(servers, name)) {
      throw new Error("Use unique lowercase MCP names of at most 30 characters.");
    }
    if (typeof tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) throw new Error("Use an environment variable name for each credential.");
    if (typeof url !== "string") throw new Error("Use a string endpoint URL.");
    const endpoint = new URL(url);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        endpoint.pathname !== "/assistant/mcp" ||
        (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))) {
      throw new Error("Use an HTTPS /assistant/mcp endpoint without credentials, query or fragment; HTTP is for literal loopback testing only.");
    }
    servers[name] = {
      transport: "streamable-http", url: endpoint.href,
      headers: { Authorization: `Bearer \${${tokenEnv}}` },
      connectionTimeoutMs: 10000, requestTimeoutMs: 30000,
    };
  }
  return { mcp: { servers } };
}

export async function writeIsolatedProfile(root, connections) {
  if (!path.isAbsolute(root)) throw new Error("Choose an absolute dedicated profile directory.");
  const config = connectionConfig(connections);
  // Exclusive creation prevents accidentally selecting or overwriting existing owner state.
  await mkdir(root, { mode: 0o700 });
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const configHome = path.join(root, "config");
  const cacheHome = path.join(root, "cache");
  const dataHome = path.join(root, "data");
  const temp = path.join(root, "tmp");
  for (const directory of [home, state, workspace, configHome, cacheHome, dataHome, temp]) await mkdir(directory, { mode: 0o700 });
  const configPath = path.join(state, "openclaw.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: configHome, XDG_CACHE_HOME: cacheHome, XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: state, TMPDIR: temp, TMP: temp, TEMP: temp,
      OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_WORKSPACE_DIR: workspace,
      OPENCLAW_PROFILE: "wollipog-assistant",
      NO_COLOR: "1",
    },
  };
}

/** Capture diagnostics privately; never surface provider output or auth headers. */
export function runOpenClaw(binary, args, profile, credentials = {}, { timeoutMs = 45000, maxOutputBytes = 1024 * 1024 } = {}) {
  if (process.platform === "win32") throw new OpenClawSetupError("The process-group smoke runner requires a POSIX host. Windows runtime integration has not been validated.");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: profile.cwd, env: { ...profile.env, ...credentials }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let bytes = 0;
    let failure = null;
    let settled = false;
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") failure = "cleanup-failed"; }
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, output, outcome: failure ?? (signal ? "signal" : "exit") });
    };
    const stop = reason => {
      failure = reason;
      killGroup();
      // Even an escaped descendant holding a pipe cannot extend our deadline.
      child.stdout.destroy(); child.stderr.destroy();
      finish(null, null);
    };
    const timeout = setTimeout(() => stop("timeout"), timeoutMs);
    const interrupt = signal => {
      if (settled) return;
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      killGroup();
      child.stdout.destroy(); child.stderr.destroy();
      settled = true;
      cleanup();
      reject(new OpenClawSetupError("OpenClaw probe interrupted; the child process group was stopped. Reconcile accepted work before retrying."));
    };
    const onInterrupt = () => interrupt("SIGINT");
    const onTerminate = () => interrupt("SIGTERM");
    const cleanup = () => {
      clearTimeout(timeout);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { stop("output-limit"); return; }
      if (stdout) output += chunk.toString();
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.on("error", () => { if (settled) return; cleanup(); settled = true; reject(new OpenClawSetupError("OpenClaw could not start. Check the executable path and runtime prerequisites.")); });
    child.on("exit", () => killGroup());
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export async function checkOpenClawVersion(binary, profile) {
  const result = await runOpenClaw(binary, ["--version"], profile);
  const version = result.output.match(/\b(\d{4}\.\d+\.\d+)\b/)?.[1];
  if (result.outcome !== "exit" || result.code !== 0 || version !== TESTED_OPENCLAW_VERSION) {
    throw new OpenClawSetupError(`Unsupported OpenClaw runtime. This smoke test requires tested version ${TESTED_OPENCLAW_VERSION}; verify a newer runtime in isolated state before extending compatibility. Do not upgrade owner state automatically.`);
  }
  return version;
}

export function isConnectionRefusal(result, name) {
  if (result.outcome !== "exit" || result.code === 0) return false;
  try {
    const report = JSON.parse(result.output);
    return Array.isArray(report.diagnostics) && report.diagnostics.some(item =>
      item.serverName === name && typeof item.message === "string" && /\bECONNREFUSED\b/.test(item.message));
  } catch { return false; }
}
