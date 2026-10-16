import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { connect, createServer as netServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "./local-device-credential.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
async function port() {
  const server = netServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

export async function remoteAccessFixture(options: { webDist?: string } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-https-integration-"));
  const backendPort = await port();
  const database = join(temp, "control-plane.db");
  const owner = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(database));
  const web = options.webDist ?? join(temp, "web");
  if (!options.webDist) {
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
  }
  const key = join(temp, "key.pem"), cert = join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const sockets = new Set<Socket>();
  const probeTokens: string[] = [];
  let forwarded = 0;
  const proxy = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.headers.authorization) probeTokens.push(req.headers.authorization);
    const upstream = httpRequest({ hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method,
      headers: { ...req.headers, "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "https" } }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  proxy.on("upgrade", (req, socket, head) => {
    forwarded++;
    const upstream = connect(backendPort, "127.0.0.1", () => {
      const headers = { ...req.headers, "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "https" };
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const external = proxy.address(); assert.ok(external && typeof external === "object");
  const origin = `https://localhost:${external.port}`;
  let child: ChildProcess | null = null;
  let log = "";
  const stop = async () => {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>((done) => child!.once("exit", () => done())); }
    child = null;
  };
  const close = async () => {
    await stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => proxy.close(() => done()));
    rmSync(temp, { recursive: true, force: true });
  };
  const launch = async (trust: boolean) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(WOLLIPOG_|CONTROL_PLANE_|RUNNER_)/u.test(key)) delete env[key];
    child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: ROOT, env: { ...env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(backendPort),
        CONTROL_PLANE_DB: database, CONTROL_PLANE_USAGE_PRICING_URL: "off", WOLLIPOG_WEB_DIST: web,
        ...(trust ? { NODE_EXTRA_CA_CERTS: cert } : {}) }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data) => { log = (log + data).slice(-16_384); });
    child.stderr?.on("data", (data) => { log = (log + data).slice(-16_384); });
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, log);
      try { if ((await fetch(`http://127.0.0.1:${backendPort}/healthz`)).ok) return; } catch { /* startup */ }
      await delay(50);
    }
    assert.fail("control plane did not start");
  };
  const api = (path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${backendPort}${path}`, {
    method, headers: { authorization: `Bearer ${owner}`, "content-type": "application/json", ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { root: temp, database, owner, origin, base: `http://127.0.0.1:${backendPort}`, api, launch, stop, close,
    probeTokens, get forwarded() { return forwarded; }, log: () => log };
}
