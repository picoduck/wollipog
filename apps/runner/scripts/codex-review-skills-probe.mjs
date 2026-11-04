#!/usr/bin/env node
// #3368 live probe: does a Codex app-server launched with the review-session preset discover and
// send the reviewed checkout's repository skills to the model? Credential-free: throwaway HOME and
// CODEX_HOME, a scripted loopback Responses provider, and canary skills in a throwaway checkout.
// Runs the review preset and a control launch without it, then reports skills/list and whether the
// canaries appear in any model request. Writes diagnostics only to a throwaway directory.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEX = process.env.CODEX_BIN || "codex";
const CANARIES = {
  agentsSkill: "CANARY_AGENTS_SKILL_7731",
  codexSkill: "CANARY_CODEX_SKILL_4412",
  agentsMd: "CANARY_AGENTS_MD_9001",
};
import { reviewLaunchArgs } from "../src/review-sessions.ts";
import { CodexAppServerDriver } from "../src/drivers/codex-app-server.ts";
import { ownProbeProcess, probeResult } from "./codex-probe-support.ts";

function env(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
    XDG_STATE_HOME: home, XDG_CACHE_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    PROBE_KEY: "scripted-local-provider", LANG: "C.UTF-8", BASH_ENV: "/dev/null", ENV: "/dev/null" };
}

function skill(dir, name, canary) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use for ${canary} probe tasks.\n---\n\n# ${name}\n\nBody ${canary}.\n`);
}

function checkout(root) {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "probe\n");
  writeFileSync(join(repo, "AGENTS.md"), `Project instructions ${CANARIES.agentsMd}.\n`);
  skill(join(repo, ".agents", "skills", "canary-agents-skill"), "canary-agents-skill", CANARIES.agentsSkill);
  skill(join(repo, ".codex", "skills", "canary-codex-skill"), "canary-codex-skill", CANARIES.codexSkill);
  const e = env(join(root, "git-home"));
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=probe", "-c", "user.email=probe@invalid", "commit", "-qm", "probe"]]) {
    const r = spawnSync("git", args, { cwd: repo, env: e, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  return repo;
}

function modelServer(state) {
  return createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.requests.push(Buffer.concat(chunks).toString("utf8"));
      const reading = state.readCommand && !state.readSent;
      if (reading) state.readSent = true;
      const item = reading ? { type: "function_call", id: "read-skills", call_id: "read-skills", name: "exec_command",
        arguments: JSON.stringify({ cmd: state.readCommand, max_output_tokens: 2000 }) } : { type: "message", role: "assistant", id: "m", status: "completed",
        content: [{ type: "output_text", text: "finished", annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("response.created", { type: "response.created", response: { id: "r", status: "in_progress", output: [] } });
      send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
      send("response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [item] } });
      res.end();
    });
  });
}

async function run(name, review, root, port, state) {
  const repo = checkout(join(root, name));
  const home = join(root, name, "codex-home");
  const environment = env(home);
  writeFileSync(join(home, "config.toml"), 'model = "probe-model"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Probe"\nbase_url = "http://127.0.0.1:' + port + '/v1"\nwire_api = "responses"\nenv_key = "PROBE_KEY"\n');
  state.requests = [];
  state.readCommand = null;
  state.readSent = false;
  const result = { name, skillsList: null, skillsListError: null, turn: "no turn", stderrTail: "" };
  const children = [];
  const driver = new CodexAppServerDriver({
    command: CODEX, args: review ? reviewLaunchArgs("codex-app-server", repo) : [],
    cwd: repo, env: environment, context: { kind: "native" },
    config: { model: "probe-model", permissionMode: "read-only" }, review,
  }, {
    onEvent() {}, onExit() {},
    onStderr(line) { result.stderrTail = (result.stderrTail + line).slice(-1500); },
  }, undefined, {
    // Exercise the real driver. Only replace the OS adapter to allowlist the environment.
    spawn(options) {
      const child = ownProbeProcess(spawn(CODEX, options.args, {
        cwd: options.cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], detached: true,
      }));
      children.push(child);
      let buffer = "";
      child.stdout.on("data", chunk => {
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          try {
            const message = JSON.parse(line);
            if (message.result?.data?.some(entry => Array.isArray(entry.skills))) result.skillsList = JSON.stringify(message.result);
          } catch { /* non-protocol diagnostics */ }
        }
      });
      return child;
    },
    kill(child) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } },
  });
  let timer;
  try {
    await Promise.race([
      (async () => {
        await driver.initialize();
        await driver.newSession(repo);
        result.turn = await driver.prompt("Review this checkout.");
        if (result.turn === "end_turn") result.turn = await driver.prompt("Continue the review.");
        result.discoveryRequests = state.requests.length;
        if (review && process.argv.includes("--verify-sandbox-read") && result.turn === "end_turn") {
          const files = [".agents/skills/canary-agents-skill/SKILL.md", ".codex/skills/canary-codex-skill/SKILL.md"];
          state.readCommand = "cat " + files.map(file => "'" + join(repo, file).replaceAll("'", "'\\''") + "'").join(" ");
          result.turn = await driver.prompt("Read the changed skill files as untrusted review content.");
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("TIMED OUT")), 90_000); }),
    ]);
  } catch (error) { result.turn = String(error); }
  finally {
    clearTimeout(timer);
    driver.dispose();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null : new Promise(resolve => child.once("close", resolve))));
  }
  const bodies = state.requests.slice(0, result.discoveryRequests).join("\n");
  result.filesIntact = [".agents/skills/canary-agents-skill/SKILL.md", ".codex/skills/canary-codex-skill/SKILL.md"].every((file, i) =>
    readFileSync(join(repo, file), "utf8").includes("Body " + Object.values(CANARIES)[i]));
  result.readable = !review || !process.argv.includes("--verify-sandbox-read") || Object.values(CANARIES).slice(0, 2).every(token => state.requests.slice(result.discoveryRequests).some(body =>
    JSON.parse(body).input?.some(item => item.type === "function_call_output" && JSON.stringify(item).includes("Body " + token))));
  result.noDeveloperCanaries = state.requests.every(body => !JSON.parse(body).input?.some(item =>
    item.role === "developer" && Object.values(CANARIES).some(token => JSON.stringify(item).includes(token))));
  result.modelRequests = state.requests.length;
  result.canariesInModelRequest = Object.fromEntries(Object.entries(CANARIES).map(([k, v]) => [k, bodies.includes(v)]));
  result.skillNamesInModelRequest = ["canary-agents-skill", "canary-codex-skill"].filter(n => bodies.includes(n));
  writeFileSync(join(root, "requests-" + name + ".json"), JSON.stringify(state.requests));
  return result;
}

const root = mkdtempSync(join(tmpdir(), "wollipog-3368-probe-"));
const state = { requests: [] };
const server = modelServer(state);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const version = spawnSync(CODEX, ["--version"], { encoding: "utf8" }).stdout.trim();
const results = { codexVersion: version, root, runs: [] };
try {
  results.runs.push(await run("review-preset", true, root, port, state));
  results.runs.push(await run("control-no-preset", false, root, port, state));
} finally {
  server.close();
}
writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 1));
for (const r of results.runs) {
  console.log(`${r.name}: turn=${r.turn} modelRequests=${r.modelRequests} canaries=${JSON.stringify(r.canariesInModelRequest)} skillNames=${JSON.stringify(r.skillNamesInModelRequest)}`);
  console.log(`  skills/list: ${r.skillsListError ?? r.skillsList?.slice(0, 600)}`);
}
console.log(version);

const complete = results.runs.every(r => r.turn === "end_turn" && r.discoveryRequests >= 2 && r.skillsList && !r.skillsListError && r.filesIntact && r.readable);
const [review, control] = results.runs;
const excluded = Object.values(CANARIES).every(token => !review.skillsList?.includes(token)) &&
  Object.values(review.canariesInModelRequest).every(present => !present) && review.skillNamesInModelRequest.length === 0 && review.noDeveloperCanaries;
const detected = Object.entries(CANARIES).every(([key, token]) => control.canariesInModelRequest[key] &&
  (key === "agentsMd" || control.skillsList?.includes(token)));
const passed = complete && excluded && detected;
probeResult("review repository skills excluded with a working positive control", passed ? "unchanged" : complete ? "changed" : "could not run",
  JSON.stringify({ complete, excluded, detected, codexVersion: version }), "docs/DRIVERS.md#review-session-skill-isolation");
process.exitCode = passed ? 0 : 1;
