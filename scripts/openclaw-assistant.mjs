import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const TESTED_OPENCLAW_VERSION = "2026.11.3";

/** Build a separate runtime config; credentials stay in the child environment. */
export function connectionConfig(connections) {
  const servers = {};
  for (const { name, url, tokenEnv } of connections) {
    if (!/^[a-z][a-z0-9-]{0,29}$/.test(name) || Object.hasOwn(servers, name)) {
      throw new Error("Use unique lowercase MCP names of at most 30 characters.");
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) throw new Error("Use an environment variable name for each credential.");
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
  if (!connections.length) throw new Error("At least one named connection is required.");
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
  for (const directory of [home, state, workspace]) await mkdir(directory, { mode: 0o700 });
  const configPath = path.join(state, "openclaw.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_WORKSPACE_DIR: workspace,
      OPENCLAW_PROFILE: "wollipog-assistant-test",
      NO_COLOR: "1",
    },
  };
}

/** Capture diagnostics privately; never surface provider output or auth headers. */
export function runOpenClaw(binary, args, profile, credentials = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: profile.cwd, env: { ...profile.env, ...credentials }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let bytes = 0;
    let exceeded = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45000);
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { exceeded = true; child.kill("SIGKILL"); return; }
      if (stdout) output += chunk.toString();
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.on("error", () => { clearTimeout(timeout); reject(new Error("OpenClaw could not start. Check the executable path and runtime prerequisites.")); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code: exceeded ? -1 : code, output }); });
  });
}

export async function checkOpenClawVersion(binary, profile) {
  const result = await runOpenClaw(binary, ["--version"], profile);
  const version = result.output.match(/\b(\d{4}\.\d+\.\d+)\b/)?.[1];
  if (result.code !== 0 || version !== TESTED_OPENCLAW_VERSION) {
    throw new Error(`Unsupported OpenClaw runtime. This smoke test requires tested version ${TESTED_OPENCLAW_VERSION}; verify a newer runtime in isolated state before extending compatibility. Do not upgrade owner state automatically.`);
  }
  return version;
}
