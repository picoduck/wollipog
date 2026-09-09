import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { serveSessionManagementMcp, type McpFetch } from "./session-management-mcp.js";
import { runWollipogCli } from "./wollipog-cli.js";

export const WSL_AGENT_CONTROL_PROTOCOL = 1 as const;
export const WSL_AGENT_CONTROL_HELPER_PATH = "/usr/local/lib/wollipog/wsl-agent-control-v1.mjs";
export const WSL_AGENT_CONTROL_PRIVATE_DIR = "/tmp/wollipog-agent-control";
export const WSL_AGENT_CONTROL_PRIVATE_TOKEN = `${WSL_AGENT_CONTROL_PRIVATE_DIR}/token`;
export const WSL_AGENT_CONTROL_PRIVATE_MCP = `${WSL_AGENT_CONTROL_PRIVATE_DIR}/mcp.json`;
export const WSL_AGENT_CONTROL_PRIVATE_SOCKET = `${WSL_AGENT_CONTROL_PRIVATE_DIR}/control.sock`;
const MAX_FRAME = 1024 * 1024;
const MAX_CONNECTIONS = 16;
const MAX_ARGS = 128;
const MAX_ARG_LENGTH = 16 * 1024;

/** Dependency-free target-local relay. It can only connect to the runner-created AF_UNIX socket
 * or serve that socket over two inherited pipes; it never spawns a process or opens a network
 * connection. The runner remains the sole authorization and HTTP boundary. */
export const WSL_AGENT_CONTROL_HELPER_SOURCE = String.raw`#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
const MAX=1048576, VERSION=1;
const fail=(message)=>{process.stderr.write(message+"\n");process.exit(1)};
const lineReader=(stream,onLine)=>{let pending="";stream.setEncoding("utf8");stream.on("data",chunk=>{pending+=chunk;if(pending.length>MAX)fail("bridge frame too large");for(;;){const at=pending.indexOf("\n");if(at<0)break;const line=pending.slice(0,at);pending=pending.slice(at+1);if(line)onLine(line)}})};
const token=()=>fs.readFileSync(process.env.WOLLIPOG_SESSION_TOKEN_FILE,"utf8").trim();
const client=(kind,args=[])=>{const socketPath=process.env.WOLLIPOG_AGENT_CONTROL_SOCKET;if(!socketPath)fail("bridge socket is unavailable");let attempts=0;const connect=()=>{const socket=net.createConnection(socketPath);let accepted=false,pending="";socket.setEncoding("utf8");socket.on("connect",()=>socket.write(JSON.stringify({v:VERSION,kind,sessionId:process.env.WOLLIPOG_SESSION_ID,token:token(),args})+"\n"));socket.on("data",chunk=>{pending+=chunk;if(pending.length>MAX)fail("bridge response too large");for(;;){const at=pending.indexOf("\n");if(at<0)break;const raw=pending.slice(0,at);pending=pending.slice(at+1);if(!raw)continue;const msg=JSON.parse(raw);if(msg.accepted){accepted=true;if(kind==="mcp"){process.stdin.on("data",data=>socket.write(JSON.stringify({data:Buffer.from(data).toString("base64")})+"\n"));process.stdin.on("end",()=>socket.write('{"end":true}\n'))}}else if(msg.data){(msg.stream==="stderr"?process.stderr:process.stdout).write(Buffer.from(msg.data,"base64"))}else if(Number.isInteger(msg.exit)){socket.end();process.exitCode=msg.exit}}});socket.on("error",()=>{if(!accepted&&++attempts<200)setTimeout(connect,50);else fail("bridge connection failed")});socket.on("close",()=>{if(accepted&&kind==="mcp")process.exit()})};connect()};
const serve=(socketPath)=>{try{fs.unlinkSync(socketPath)}catch{}const dir=socketPath.slice(0,socketPath.lastIndexOf("/")),tokenPath=dir+"/token",mcpPath=dir+"/mcp.json";const peers=new Map();let next=0,bootstrapped=false;const output=msg=>process.stdout.write(JSON.stringify(msg)+"\n");const server=net.createServer(socket=>{if(!bootstrapped||peers.size>=16){socket.destroy();return}const id=String(++next);peers.set(id,socket);let opened=false,pending="";socket.setEncoding("utf8");socket.on("data",chunk=>{pending+=chunk;if(pending.length>MAX){socket.destroy();return}for(;;){const at=pending.indexOf("\n");if(at<0)break;const raw=pending.slice(0,at);pending=pending.slice(at+1);if(!raw)continue;let msg;try{msg=JSON.parse(raw)}catch{socket.destroy();return}if(!opened){opened=true;output({...msg,type:"open",id})}else if(typeof msg.data==="string")output({type:"data",id,data:msg.data});else if(msg.end===true)output({type:"end",id})}});socket.on("close",()=>{peers.delete(id);if(opened)output({type:"close",id})})});lineReader(process.stdin,raw=>{let msg;try{msg=JSON.parse(raw)}catch{return}if(!bootstrapped){if(msg.type!=="bootstrap"||typeof msg.token!=="string"||typeof msg.mcp!=="string")fail("invalid bridge bootstrap");fs.writeFileSync(tokenPath,Buffer.from(msg.token,"base64"),{mode:0o600,flag:"wx"});fs.writeFileSync(mcpPath,Buffer.from(msg.mcp,"base64"),{mode:0o600,flag:"wx"});bootstrapped=true;return}const socket=peers.get(msg.id);if(socket)socket.write(JSON.stringify(msg)+"\n")});const cleanup=()=>{try{server.close()}catch{}for(const file of [socketPath,tokenPath,mcpPath])try{fs.unlinkSync(file)}catch{}};process.on("SIGTERM",()=>{cleanup();process.exit()});process.on("SIGINT",()=>{cleanup();process.exit()});process.stdin.on("end",()=>{cleanup();process.exit()});server.listen(socketPath,()=>{fs.chmodSync(socketPath,0o600)})};
const [mode,...args]=process.argv.slice(2);if(mode==="serve"&&args.length===1)serve(args[0]);else if(mode==="mcp"&&args.length===0)client("mcp");else if(mode==="cli")client("cli",args);else fail("unsupported bridge mode");
`;

export const WSL_AGENT_CONTROL_HELPER_SHA256 = createHash("sha256")
  .update(WSL_AGENT_CONTROL_HELPER_SOURCE)
  .digest("hex");

export interface WslAgentControlLaunch {
  protocolVersion: typeof WSL_AGENT_CONTROL_PROTOCOL;
  distro: string;
  nodeRuntime: string;
  helperPath: typeof WSL_AGENT_CONTROL_HELPER_PATH;
  sessionId: string;
  token: string;
  tokenFile: string;
  readyFile: string;
  cpUrl: string;
  /** Per-process socket assigned only while constructing one spawn. */
  socketPath?: string;
}

interface BridgeFrame {
  type?: "open" | "data" | "end" | "close";
  id?: string;
  v?: number;
  kind?: "cli" | "mcp";
  sessionId?: string;
  token?: string;
  args?: unknown;
  data?: unknown;
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateWslAgentControlCliArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_ARGS ||
      value.some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || /[\0\r\n]/u.test(arg))) {
    throw new Error("invalid bridge CLI arguments");
  }
  const args = value as string[];
  if (!new Set(["session", "sessions", "worktree", "worktrees"]).has(args[0]!)) {
    throw new Error("bridge CLI command is outside the Agent Control allowlist");
  }
  if (args.some((arg) => arg === "--url" || arg.startsWith("--url=") ||
      arg === "--token-file" || arg.startsWith("--token-file="))) {
    throw new Error("bridge CLI cannot override its authenticated endpoint or credential");
  }
  return args;
}

function credentialReady(config: WslAgentControlLaunch): boolean {
  try {
    const token = readFileSync(config.tokenFile, "utf8").trim();
    const ready = readFileSync(config.readyFile, "utf8").trim();
    return sameSecret(token, config.token) &&
      sameSecret(ready, createHash("sha256").update(config.token).digest("hex"));
  } catch {
    return false;
  }
}

/** Attach the Windows-side authenticated broker to the helper relay's dedicated stdio pair. */
export function attachWslAgentControlBroker(
  input: Readable,
  output: Writable,
  config: WslAgentControlLaunch,
  fetchImpl: McpFetch = globalThis.fetch,
): () => void {
  const connections = new Map<string, { input?: PassThrough; closed: boolean }>();
  let pending = "";
  let disposed = false;
  const send = (message: Record<string, unknown>) => {
    if (!disposed && !output.destroyed && !("writableEnded" in output && output.writableEnded)) {
      output.write(`${JSON.stringify(message)}\n`);
    }
  };
  const close = (id: string, exit = 1, message?: string) => {
    const connection = connections.get(id);
    if (connection?.closed) return;
    if (connection) connection.closed = true;
    if (message) send({ id, stream: "stderr", data: Buffer.from(`${message}\n`).toString("base64") });
    send({ id, exit });
    connection?.input?.end();
    connections.delete(id);
  };
  const open = (frame: BridgeFrame) => {
    const id = frame.id;
    if (!id || connections.has(id) || connections.size >= MAX_CONNECTIONS ||
        frame.v !== WSL_AGENT_CONTROL_PROTOCOL || frame.sessionId !== config.sessionId ||
        typeof frame.token !== "string" || !sameSecret(frame.token, config.token) || !credentialReady(config) ||
        (frame.kind !== "cli" && frame.kind !== "mcp")) {
      if (id) close(id, 1, "Agent Control authentication failed");
      return;
    }
    const connection: { input?: PassThrough; closed: boolean } = { closed: false };
    connections.set(id, connection);
    send({ id, accepted: true });
    if (frame.kind === "mcp") {
      const request = new PassThrough();
      const response = new PassThrough();
      connection.input = request;
      response.on("data", (data: Buffer) => send({ id, stream: "stdout", data: data.toString("base64") }));
      response.on("end", () => close(id, 0));
      serveSessionManagementMcp(request, response, {
        fetch: fetchImpl,
        cpUrl: config.cpUrl,
        selfSessionId: config.sessionId,
        token: config.token,
        actorHeader: "x-wollipog-agent-session",
        orchestrator: true,
      });
      return;
    }
    let args: string[];
    try { args = validateWslAgentControlCliArgs(frame.args); }
    catch (error) { close(id, 2, (error as Error).message); return; }
    void runWollipogCli(["wollipog", ...args], {
      WOLLIPOG_CONTROL_PLANE_URL: config.cpUrl,
      WOLLIPOG_SESSION_ID: config.sessionId,
      WOLLIPOG_SESSION_TOKEN_FILE: config.tokenFile,
      WOLLIPOG_SESSION_CREDENTIAL_READY_FILE: config.readyFile,
      WOLLIPOG_PERMISSION_PRESET: "orchestrator",
    }, {
      stdout: (text) => send({ id, stream: "stdout", data: Buffer.from(text).toString("base64") }),
      stderr: (text) => send({ id, stream: "stderr", data: Buffer.from(text).toString("base64") }),
    }, fetchImpl).then((code) => close(id, code), (error) => close(id, 1, (error as Error).message));
  };
  const onData = (chunk: Buffer | string) => {
    pending += chunk.toString();
    if (pending.length > MAX_FRAME) { dispose(); return; }
    for (;;) {
      const at = pending.indexOf("\n");
      if (at < 0) break;
      const raw = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (!raw) continue;
      let frame: BridgeFrame;
      try { frame = JSON.parse(raw) as BridgeFrame; }
      catch { dispose(); return; }
      if (frame.type === "open") open(frame);
      else if (typeof frame.id === "string" && frame.type === "data" && typeof frame.data === "string") {
        const connection = connections.get(frame.id);
        if (!connection?.input || frame.data.length > MAX_FRAME * 2) close(frame.id, 1, "invalid bridge data");
        else connection.input.write(Buffer.from(frame.data, "base64"));
      } else if (typeof frame.id === "string" && (frame.type === "end" || frame.type === "close")) {
        connections.get(frame.id)?.input?.end();
        if (frame.type === "close") connections.delete(frame.id);
      }
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.off("data", onData);
    for (const id of [...connections.keys()]) close(id, 1);
    if (!output.destroyed && !("writableEnded" in output && output.writableEnded)) output.end();
  };
  input.on("data", onData);
  input.once("error", dispose);
  input.once("end", dispose);
  output.once("error", dispose);
  send({
    type: "bootstrap",
    token: Buffer.from(config.token).toString("base64"),
    mcp: Buffer.from(JSON.stringify({ mcpServers: { wollipog: {
      type: "stdio",
      command: config.nodeRuntime,
      args: [config.helperPath, "mcp"],
      env: {
        WOLLIPOG_SESSION_ID: config.sessionId,
        WOLLIPOG_SESSION_TOKEN_FILE: WSL_AGENT_CONTROL_PRIVATE_TOKEN,
        WOLLIPOG_AGENT_CONTROL_SOCKET: WSL_AGENT_CONTROL_PRIVATE_SOCKET,
      },
    } } })).toString("base64"),
  });
  return dispose;
}
