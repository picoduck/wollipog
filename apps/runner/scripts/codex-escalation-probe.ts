/**
 * Measure what a Codex permission-profile deny entry costs an APPROVED sandbox escalation (#1464).
 *
 *   pnpm probe:codex-escalation            # needs a real `codex` on PATH; nothing else
 *   CODEX_BIN=/path/to/codex pnpm probe:codex-escalation
 *
 * This is NOT part of `pnpm test`: it spawns a real `codex app-server` and takes about a minute.
 * It is the evidence behind `codexPermissionProfileEscalationLoss` and behind ADR 0012's
 * "A deny entry disables approved network escalation" section, kept runnable so a future codex-cli
 * can be re-measured instead of re-argued.
 *
 * Nothing here reaches the real network or a real model:
 *
 *   - "the network" is a loopback HTTP server this script starts. Measured: Codex's Linux sandbox
 *     blocks loopback exactly as it blocks the internet, so a 7-byte local reply is a faithful
 *     stand-in for `gh` reaching api.github.com, with no credentials and no outbound traffic.
 *   - "the model" is a scripted OpenAI Responses-API server this script starts, selected through a
 *     throwaway `CODEX_HOME`. It emits one `exec_command` tool call with the exact arguments the
 *     case wants and then one final message, so each case is one deterministic turn. It also
 *     answers Codex's own `codex-auto-review` Guardian requests with a scripted verdict, which is
 *     how the Guardian-approved path is measured without a Guardian model.
 *   - the hook state directory is a throwaway directory holding a random marker, never the
 *     runner's real one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPermissionProfileOverrides } from "../src/codex-permission-profile.js";

const CODEX = process.env.CODEX_BIN || "codex";
const TURN_TIMEOUT_MS = 90_000;

type Json = Record<string, unknown>;
type Decision = "accept" | "acceptForSession" | "decline";

interface Case {
  name: string;
  /** What the scripted model runs. */
  command: "network" | "hookState";
  /** Whether the tool call asks for `sandbox_permissions: "require_escalated"`. */
  escalate: boolean;
  /** The runner's deny-carrying profile on argv, or the legacy `sandboxPolicy` in the turn. */
  sandbox: "profile" | "legacy";
  decision: Decision;
  /** Route the approval through Codex's own Guardian rather than the client. */
  guardian?: "allow" | "deny";
  /** What the command must print. */
  expect: "network" | "noNetwork" | "markerRead" | "denied" | "declined";
}

const CASES: Case[] = [
  // The regression itself: the same approved escalation, on each sandbox.
  { name: "legacy · escalation accepted · network", command: "network", escalate: true, sandbox: "legacy", decision: "accept", expect: "network" },
  { name: "profile · escalation accepted · network", command: "network", escalate: true, sandbox: "profile", decision: "accept", expect: "noNetwork" },
  // "Allow for Session" is the same grant with a wider scope, and costs the same.
  { name: "profile · Allow for Session · network", command: "network", escalate: true, sandbox: "profile", decision: "acceptForSession", expect: "noNetwork" },
  // Guardian-approved, under auto-review, never reaches the client at all.
  { name: "legacy · Guardian allowed · network", command: "network", escalate: true, sandbox: "legacy", decision: "accept", guardian: "allow", expect: "network" },
  { name: "profile · Guardian allowed · network", command: "network", escalate: true, sandbox: "profile", decision: "accept", guardian: "allow", expect: "noNetwork" },
  // Before any approval, and after a refused one, the sandbox holds on both.
  { name: "profile · no escalation · network", command: "network", escalate: false, sandbox: "profile", decision: "accept", expect: "noNetwork" },
  { name: "legacy · no escalation · network", command: "network", escalate: false, sandbox: "legacy", decision: "accept", expect: "noNetwork" },
  { name: "profile · escalation declined", command: "network", escalate: true, sandbox: "profile", decision: "decline", expect: "declined" },
  { name: "legacy · escalation declined", command: "network", escalate: true, sandbox: "legacy", decision: "decline", expect: "declined" },
  { name: "profile · Guardian denied", command: "network", escalate: true, sandbox: "profile", decision: "accept", guardian: "deny", expect: "declined" },
  // The security objective of #1464: the hook state directory, before and after an approval.
  { name: "profile · no escalation · hook state", command: "hookState", escalate: false, sandbox: "profile", decision: "accept", expect: "denied" },
  { name: "profile · escalation accepted · hook state", command: "hookState", escalate: true, sandbox: "profile", decision: "accept", expect: "denied" },
  // …and what it costs to keep it: without the profile, the approved escalation reads the marker.
  { name: "legacy · escalation accepted · hook state", command: "hookState", escalate: true, sandbox: "legacy", decision: "accept", expect: "markerRead" },
];

/* --------------------------------------------------------------------------------------------
 * The two local servers.
 * ----------------------------------------------------------------------------------------- */

const NETWORK_BODY = "NETOK!!";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

/** Stands in for the network: reachable outside the sandbox, refused inside it. */
function networkServer(): Server {
  return createServer((_request, response) => {
    response.writeHead(200, { "content-length": String(NETWORK_BODY.length) });
    response.end(NETWORK_BODY);
  });
}

/** One scripted model turn, plus scripted Guardian verdicts. */
function modelServer(state: { tool: Json | null; guardian: "allow" | "deny"; calls: number }): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Json = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json; } catch { /* keep {} */ }
      const isGuardian = String(body.model ?? "").startsWith("codex-auto-review");
      // The Guardian runs inside the same turn; only the agent's own calls advance the script.
      const step = isGuardian ? -1 : state.calls++;
      const item: Json = isGuardian
        ? message(JSON.stringify({ outcome: state.guardian, risk_level: "low", user_authorization: "high", rationale: "scripted" }))
        : step === 0 && state.tool
          ? { type: "function_call", id: "fc", call_id: "call", name: "exec_command", arguments: JSON.stringify(state.tool), status: "completed" }
          : message("finished");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event: string, data: Json) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("response.created", { type: "response.created", response: { id: "r", status: "in_progress", output: [] } });
      send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
      send("response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [item] } });
      response.end();
    });
  });
}

function message(text: string): Json {
  return { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
}

/* --------------------------------------------------------------------------------------------
 * One case: a real `codex app-server`, one turn, one command.
 * ----------------------------------------------------------------------------------------- */

interface Fixture { repo: string; codexHome: string; hookDir: string; marker: string; networkPort: number }

function runCase(testCase: Case, fixture: Fixture, model: { tool: Json | null; guardian: "allow" | "deny"; calls: number }): Promise<string> {
  const command = testCase.command === "network"
    ? `curl -s --max-time 3 http://127.0.0.1:${fixture.networkPort}/ || echo NETBLOCKED`
    : `cat ${join(fixture.hookDir, "verdict.json")} 2>&1 | head -1`;
  model.tool = {
    cmd: command,
    yield_time_ms: 5000,
    ...(testCase.escalate ? { sandbox_permissions: "require_escalated", justification: "the probe needs it" } : {}),
  };
  model.guardian = testCase.guardian ?? "allow";
  model.calls = 0;

  const args = testCase.sandbox === "profile"
    ? ["-c", codexPermissionProfileOverrides(":workspace", fixture.hookDir)[0],
       "-c", codexPermissionProfileOverrides(":workspace", fixture.hookDir)[1]]
    : [];
  const child = spawn(CODEX, [...args, "app-server"], {
    cwd: fixture.repo,
    env: { ...process.env, CODEX_HOME: fixture.codexHome, PROBE_KEY: "x" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise<string>((resolve) => {
    let settled = false;
    let outcome = "no command ran";
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(value);
    };
    const timer = setTimeout(() => finish("TIMED OUT"), TURN_TIMEOUT_MS);
    const send = (payload: Json) => child.stdin.write(`${JSON.stringify(payload)}\n`);

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let msg: Json & { id?: unknown; method?: string; params?: Json; result?: Json };
        try { msg = JSON.parse(line); } catch { continue; }
        handle(msg);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (process.env.PROBE_DEBUG) process.stderr.write(chunk); });
    child.on("error", (error) => finish(`SPAWN FAILED: ${error.message}`));
    child.on("close", () => finish(outcome));

    const handle = (msg: Json & { id?: unknown; method?: string; params?: Json; result?: Json }) => {
      // Server -> client approval: answer it the way the case says the user or Guardian did.
      if (msg.method?.endsWith("/requestApproval") && msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, result: { decision: testCase.decision } });
        return;
      }
      if (msg.method === "item/completed") {
        const completed = (msg.params?.item ?? {}) as Json;
        if (completed.type === "commandExecution") {
          outcome = completed.status === "declined"
            ? "declined"
            : String(completed.aggregatedOutput ?? completed.output ?? "").trim();
        }
        return;
      }
      if (msg.method === "turn/completed" || msg.method === "turn/failed") return finish(outcome);
      if (msg.id === 1) {
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: fixture.repo } });
        return;
      }
      if (msg.id === 2) {
        const threadId = ((msg.result?.thread ?? {}) as Json).id;
        send({ jsonrpc: "2.0", id: 3, method: "turn/start", params: {
          threadId,
          input: [{ type: "text", text: "run it" }],
          approvalPolicy: "on-request",
          cwd: fixture.repo,
          // Exactly what `buildCodexTurnParams` sends for this sandbox, and nothing else.
          ...(testCase.sandbox === "legacy" ? { sandboxPolicy: { type: "workspaceWrite" } } : {}),
          ...(testCase.guardian ? { approvalsReviewer: "auto_review" } : {}),
        } });
      }
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "wollipog-escalation-probe", version: "0" } } });
  });
}

function verdict(testCase: Case, output: string, marker: string): boolean {
  switch (testCase.expect) {
    case "network": return output.includes(NETWORK_BODY);
    case "noNetwork": return output.includes("NETBLOCKED") && !output.includes(NETWORK_BODY);
    case "declined": return output === "declined";
    case "denied": return /Permission denied|Operation not permitted/.test(output) && !output.includes(marker);
    case "markerRead": return output.includes(marker);
  }
}

/* --------------------------------------------------------------------------------------------
 * Driver.
 * ----------------------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "wollipog-escalation-probe-"));
  const fixture: Fixture = {
    repo: join(root, "repo"),
    codexHome: join(root, "codex-home"),
    hookDir: join(root, "hook-state"),
    marker: randomBytes(16).toString("hex"),
    networkPort: 0,
  };
  const net = networkServer();
  const model = { tool: null as Json | null, guardian: "allow" as "allow" | "deny", calls: 0 };
  const models = modelServer(model);
  let failures = 0;
  try {
    mkdirSync(fixture.repo, { recursive: true });
    mkdirSync(fixture.codexHome, { recursive: true });
    mkdirSync(fixture.hookDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(fixture.hookDir, "verdict.json"), fixture.marker, { mode: 0o600 });
    await gitInit(fixture.repo);

    fixture.networkPort = await listen(net);
    const modelPort = await listen(models);
    writeFileSync(join(fixture.codexHome, "config.toml"),
      'model = "probe-model"\nmodel_provider = "probe"\napproval_policy = "on-request"\n\n' +
      '[model_providers.probe]\nname = "Probe"\n' +
      `base_url = "http://127.0.0.1:${modelPort}/v1"\n` +
      'wire_api = "responses"\nenv_key = "PROBE_KEY"\n');

    for (const testCase of CASES) {
      const output = await runCase(testCase, fixture, model);
      const ok = verdict(testCase, output, fixture.marker);
      if (!ok) failures++;
      const shown = output.replace(fixture.marker, "<MARKER>").slice(0, 60);
      process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${testCase.name.padEnd(44)} ${testCase.expect.padEnd(11)} ${JSON.stringify(shown)}\n`);
    }
  } finally {
    net.close();
    models.close();
    rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(failures === 0
    ? `\nAll ${CASES.length} cases matched the recorded measurement.\n`
    : `\n${failures} of ${CASES.length} cases did NOT match. Codex's behaviour has moved; re-read ADR 0012 before changing code.\n`);
  return failures === 0 ? 0 : 1;
}

function gitInit(repo: string): Promise<void> {
  const run = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("git", args, { cwd: repo, stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited ${String(code)}`))));
    child.on("error", reject);
  });
  writeFileSync(join(repo, "file.txt"), "hello\n");
  return run(["init", "-q", "."])
    .then(() => run(["add", "-A"]))
    .then(() => run(["-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-qm", "init"]));
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
