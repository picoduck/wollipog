/** Exercise the packaged SEA through the same invocation name as install-runner.ps1. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "");
assert.match(basename(binary), /^wollipog-runner-/u, "pass the packaged runner binary");
const root = mkdtempSync(join(tmpdir(), "wollipog-cli-binary-"));
const cli = join(root, process.platform === "win32" ? "wollipog.exe" : "wollipog");
const tokenFile = join(root, "local-token");
const token = "A".repeat(43);
copyFileSync(binary, cli);
writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

let doctorStatus = "pass";
const requests = [];
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push(path);
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const body = path === "/api/compatibility" ? { protocolVersion: 1000 }
    : path === "/api/admin/status" ? { service: "smoke-control-plane" }
    : path === "/api/admin/doctor" ? {
      generatedAt: Date.now(),
      status: { appVersion: "smoke" },
      checks: [{ id: "control-plane", status: doctorStatus, summary: "smoke check" }],
    }
    : path === "/api/devices" ? { devices: [] }
    : null;
  response.writeHead(body === null ? 404 : 200, { "content-type": "application/json" })
    .end(JSON.stringify(body ?? { error: "unexpected route" }));
});

function run(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cli, args, { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

try {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  const options = ["--url", `http://127.0.0.1:${port}`, "--token-file", tokenFile, "--json"];

  assert.match((await run(["--version"])).stdout, /protocol v\d+/u);
  const help = await run(["help", "admin"]);
  assert.equal(help.code, 0, "admin topic help must dispatch");
  assert.match(help.stdout, /^Usage: wollipog admin/u);

  const status = await run(["admin", "status", ...options]);
  assert.equal(status.code, 0, "admin status must reach the loopback control plane");
  assert.equal(JSON.parse(status.stdout).service, "smoke-control-plane");

  const pairing = await run(["admin", "pairing-url", ...options]);
  assert.equal(pairing.code, 0, "admin pairing-url must read the local credential");
  assert.equal(JSON.parse(pairing.stdout).pairingUrl, `http://127.0.0.1:${port}/#pair=${token}`);

  const devices = await run(["pair", "list", ...options]);
  assert.equal(devices.code, 0, "pair list must reach the loopback control plane");
  assert.deepEqual(JSON.parse(devices.stdout), { devices: [] });

  const doctor = await run(["doctor", ...options]);
  assert.equal(doctor.code, 0, "doctor must pass when all checks pass");
  assert.equal(JSON.parse(doctor.stdout).ok, true);
  doctorStatus = "fail";
  const failingDoctor = await run(["doctor", ...options]);
  assert.equal(failingDoctor.code, 1, "doctor must fail when a check fails");
  assert.equal(JSON.parse(failingDoctor.stdout).ok, false);

  const unknown = await run(["unknown-subcommand"]);
  assert.equal(unknown.code, 2, "unknown commands must reach the root-help fallback");
  assert.match(unknown.stderr, /^Wollipog CLI\n/u);
  assert.deepEqual(requests, [
    "/api/compatibility", "/api/admin/status",
    "/api/compatibility", "/api/devices",
    "/api/compatibility", "/api/admin/doctor",
    "/api/compatibility", "/api/admin/doctor",
  ]);
  console.log("Packaged CLI dispatch smoke passed");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(root, { recursive: true, force: true });
}
