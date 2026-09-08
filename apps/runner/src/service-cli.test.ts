import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import type { McpFetch } from "./session-management-mcp.js";
import { runServiceCli, type ServiceHost, type ServiceIo } from "./service-cli.js";
import { CONTROL_PLANE_UNIT, RUNNER_UNIT, serviceLayout } from "./systemd-service.js";

const LOCAL_TOKEN = "L".repeat(43);
const RUNNER_TOKEN = `wollipogr_${"r".repeat(43)}`;

interface Fake {
  host: ServiceHost;
  io: ServiceIo;
  execs: string[];
  stdout(): string;
  stderr(): string;
  root: string;
  home: string;
  layout: ReturnType<typeof serviceLayout>;
}

function fake(t: { after(fn: () => void): void }, options: {
  home?: string; hostname?: string; platform?: NodeJS.Platform; uid?: number; isSea?: boolean; execPath?: string;
  units?: Record<string, string>; healthy?: () => boolean; runnerOnline?: () => boolean;
  systemctlFail?: string; lingerState?: "yes" | "no"; lingerFails?: boolean; stdinIsTTY?: boolean; confirm?: (q: string) => Promise<boolean>;
} = {}): Fake {
  const root = mkdtempSync(join(tmpdir(), "wollipog-svc-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = options.home ?? join(root, "home");
  mkdirSync(home, { recursive: true });
  const execs: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const layout = serviceLayout("user", { home, user: "op", env: {} });
  let cpRunning = false;
  let runnerRunning = false;
  let clock = 0;
  const unitState = (unit: string) => {
    const installed = existsSync(join(layout.unitDir, unit));
    const running = unit === CONTROL_PLANE_UNIT ? cpRunning : runnerRunning;
    return `LoadState=${installed ? "loaded" : "not-found"}\nActiveState=${running ? "active" : "inactive"}\nSubState=${running ? "running" : "dead"}\nUnitFileState=${installed ? "enabled" : ""}\nMainPID=${running ? 4242 : 0}\nNRestarts=0\nExecMainStartTimestamp=\n`;
  };
  const fetch: McpFetch = async (url, init) => {
    const respond = (statusCode: number, body: unknown) => ({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, text: async () => JSON.stringify(body) });
    const path = url.replace(/^https?:\/\/[^/]+/u, "");
    const healthy = cpRunning && (options.healthy?.() ?? true);
    if (path === "/healthz") return healthy ? respond(200, { ok: true, service: "wollipog-control-plane" }) : respond(503, { error: "down" });
    if (!healthy) throw new Error("ECONNREFUSED");
    if (init?.headers?.authorization !== `Bearer ${LOCAL_TOKEN}`) return respond(401, { error: "unauthorized" });
    if (path === "/api/compatibility") return respond(200, { protocolVersion: PROTOCOL_VERSION });
    if (path === "/api/admin/status") {
      const online = runnerRunning && (options.runnerOnline?.() ?? true);
      return respond(200, {
        service: "wollipog-control-plane", appVersion: "0.22.0", protocolVersion: PROTOCOL_VERSION, apiVersion: 1,
        health: { ok: true, startedAt: 0, uptimeMs: 1 },
        bind: { host: "127.0.0.1", port: 4400, mode: "loopback", tailnetOnly: false, boundBeyondLoopback: false },
        publicOrigin: null, dashboard: { webServed: true, pairingHosts: [] },
        database: { path: layout.controlPlaneDb, ready: true }, artifactStore: { path: layout.controlPlaneArtifactDir, ready: true },
        localCredential: { path: layout.controlPlaneLocalTokenFile, safe: true, issues: [] },
        runners: { registered: online ? 1 : 0, online: online ? 1 : 0, items: online ? [{ runnerId: "box-1", status: "online", version: "0.22.0", protocolVersion: PROTOCOL_VERSION }] : [] },
        devices: { paired: 0 }, warnings: [],
      });
    }
    if (path === "/api/runner-credentials" && init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { runnerId: string };
      return respond(201, { credential: { credentialId: `rc_${body.runnerId}`, runnerId: body.runnerId, status: "pending" }, token: RUNNER_TOKEN });
    }
    return respond(404, { error: `unexpected ${path}` });
  };
  const host: ServiceHost = {
    platform: options.platform ?? "linux",
    uid: options.uid ?? 1000,
    user: "op",
    home,
    hostname: options.hostname ?? "box-1",
    execPath: options.execPath ?? "/usr/bin/node",
    isSea: options.isSea ?? false,
    env: {},
    cwd: () => root,
    exec: async (command, args) => {
      const line = [command, ...args].join(" ");
      execs.push(line);
      if (command === "systemctl") {
        if (options.systemctlFail && line.includes(options.systemctlFail)) return { code: 1, stdout: "", stderr: `fake failure for ${options.systemctlFail}` };
        if (args.includes("--version")) return { code: 0, stdout: "systemd 255\n", stderr: "" };
        if (args.includes("show")) return { code: 0, stdout: unitState(args[args.length - 1]!), stderr: "" };
        if (args.includes("restart") || args.includes("start")) {
          const unit = args[args.length - 1]!;
          if (unit === CONTROL_PLANE_UNIT) {
            cpRunning = true;
            // The real control plane publishes its local credential on first start.
            mkdirSync(layout.controlPlaneDataDir, { recursive: true });
            if (!existsSync(layout.controlPlaneLocalTokenFile)) writeFileSync(layout.controlPlaneLocalTokenFile, `${LOCAL_TOKEN}\n`, { mode: 0o600 });
          }
          if (unit === RUNNER_UNIT) runnerRunning = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("disable")) { cpRunning = false; runnerRunning = false; }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "loginctl") {
        if (args[0] === "show-user") return { code: 0, stdout: `${options.lingerState ?? "no"}\n`, stderr: "" };
        if (args[0] === "enable-linger") return options.lingerFails ? { code: 1, stdout: "", stderr: "Interactive authentication required." } : { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnInherit: async (command, args) => { execs.push(`${command} ${args.join(" ")} (inherit)`); return 0; },
    fetch,
    sleep: async () => { clock += 1_000; },
    now: () => clock,
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
    ensureDir: (path, mode) => mkdirSync(path, { recursive: true, mode }),
    writeFile: (path, contents, mode) => writeFileSync(path, contents, { mode }),
    removeFile: (path) => rmSync(path, { force: true }),
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
  };
  const io: ServiceIo = {
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    stdinIsTTY: options.stdinIsTTY ?? false,
    confirm: options.confirm ?? (async () => false),
  };
  return { host, io, execs, stdout: () => out.join(""), stderr: () => err.join(""), root, home, layout };
}

function bins(f: Fake): string[] {
  const cp = join(f.root, "control-plane");
  const runner = join(f.root, "wollipog-runner");
  writeFileSync(cp, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(runner, "#!/bin/sh\n", { mode: 0o755 });
  return ["--control-plane-bin", cp, "--runner-bin", runner];
}

test("service install (user mode) writes units, env, config, mints the runner credential once, and verifies health", async (t) => {
  const f = fake(t);
  const code = await runServiceCli(["service", "install", ...bins(f), "--port", "4400", "--public-origin", "https://box.example.ts.net", "--json"], f.host, f.io);
  assert.equal(code, 0, f.stderr());
  const report = JSON.parse(f.stdout());
  assert.equal(report.mode, "user");
  assert.deepEqual(report.components, ["control-plane", "runner"]);
  assert.deepEqual(report.units, [CONTROL_PLANE_UNIT, RUNNER_UNIT]);
  const diagnostics = `${JSON.stringify(report.health)} ${report.warnings.join(" | ")}`;
  assert.equal(report.health.controlPlane.ok, true, diagnostics);
  assert.equal(report.health.runnerOnline, true, diagnostics);
  assert.equal(report.lingering, "enabled", diagnostics);
  assert.deepEqual(report.warnings, [], diagnostics);
  const cpUnit = readFileSync(join(f.layout.unitDir, CONTROL_PLANE_UNIT), "utf8");
  assert.ok(cpUnit.includes(`EnvironmentFile=${f.layout.controlPlaneEnvFile}`));
  assert.equal(statSync(f.layout.controlPlaneEnvFile).mode & 0o777, 0o600);
  assert.ok(readFileSync(f.layout.controlPlaneEnvFile, "utf8").includes("CONTROL_PLANE_PORT=4400"));
  assert.ok(readFileSync(f.layout.controlPlaneEnvFile, "utf8").includes('CONTROL_PLANE_PUBLIC_ORIGIN="https://box.example.ts.net"'));
  assert.equal(readFileSync(f.layout.runnerTokenFile, "utf8"), `${RUNNER_TOKEN}\n`);
  assert.equal(statSync(f.layout.runnerTokenFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f.layout.runnerConfigFile, "utf8")).controlPlaneUrl, "ws://127.0.0.1:4400/runner");
  assert.ok(!cpUnit.includes(RUNNER_TOKEN) && !readFileSync(join(f.layout.unitDir, RUNNER_UNIT), "utf8").includes(RUNNER_TOKEN));
  const order = f.execs.filter((line) => line.startsWith("systemctl --user"));
  assert.deepEqual(order, [
    "systemctl --user --version",
    "systemctl --user daemon-reload",
    `systemctl --user enable ${CONTROL_PLANE_UNIT} ${RUNNER_UNIT}`,
    `systemctl --user restart ${CONTROL_PLANE_UNIT}`,
    `systemctl --user restart ${RUNNER_UNIT}`,
  ]);
  assert.ok(f.execs.includes("loginctl enable-linger op"));

  // Reinstall keeps settings and credentials: env, config, and token are preserved; units are rewritten.
  // The preserved files also decide the effective port and runner id, so a reinstall with different
  // or missing flags still checks health on the right port and waits for the right runner.
  const again = fake(t, { home: f.home, hostname: "renamed-host" });
  const second = await runServiceCli(["service", "install", ...bins(f), "--port", "9999", "--json"], again.host, again.io);
  assert.equal(second, 0, again.stderr());
  const reinstall = JSON.parse(again.stdout());
  assert.deepEqual(reinstall.preserved.sort(), [f.layout.controlPlaneEnvFile, f.layout.runnerConfigFile, f.layout.runnerTokenFile].sort());
  assert.equal(reinstall.health.runnerOnline, true, reinstall.warnings.join(" | "));
  assert.match(reinstall.warnings.join("\n"), /--port 9999 ignored: .*CONTROL_PLANE_PORT=4400/u);
  assert.ok(again.execs.some((line) => line === `systemctl --user restart ${RUNNER_UNIT}`));
  assert.equal(readFileSync(f.layout.runnerTokenFile, "utf8"), `${RUNNER_TOKEN}\n`, "an existing runner credential is never rotated by reinstall");
  assert.ok(readFileSync(f.layout.controlPlaneEnvFile, "utf8").includes("https://box.example.ts.net"), "existing env survives even though the second install passed no origin");
});

test("service install warns about plain remote HTTP and lingering failures, and --no-linger skips lingering", async (t) => {
  const f = fake(t, { lingerFails: true });
  assert.equal(await runServiceCli(["service", "install", ...bins(f), "--host", "0.0.0.0", "--json"], f.host, f.io), 0, f.stderr());
  const report = JSON.parse(f.stdout());
  assert.equal(report.lingering, "failed");
  assert.match(report.warnings.join("\n"), /listen on 0\.0\.0\.0:4317 over plain HTTP/u);
  assert.match(report.warnings.join("\n"), /could not enable lingering for op/u);
  assert.match(f.stderr(), /warning: /u);

  const g = fake(t, { lingerState: "no" });
  assert.equal(await runServiceCli(["service", "install", ...bins(g), "--no-linger", "--json"], g.host, g.io), 0, g.stderr());
  assert.equal(JSON.parse(g.stdout()).lingering, "skipped");
  assert.ok(!g.execs.some((line) => line.startsWith("loginctl enable-linger")));

  const h = fake(t, { lingerState: "yes" });
  assert.equal(await runServiceCli(["service", "install", ...bins(h), "--public-origin", "http://100.64.0.10:4317", "--json"], h.host, h.io), 0, h.stderr());
  assert.equal(JSON.parse(h.stdout()).lingering, "already");
  assert.match(JSON.parse(h.stdout()).warnings.join("\n"), /plain HTTP beyond loopback/u);
});

test("service install fails closed on unsupported platforms, missing executables, bad options, and an unhealthy control plane", async (t) => {
  const mac = fake(t, { platform: "darwin" });
  assert.equal(await runServiceCli(["service", "install"], mac.host, mac.io), 2);
  assert.match(mac.stderr(), /Linux systemd only; darwin is not supported yet/u);

  const noBins = fake(t);
  assert.equal(await runServiceCli(["service", "install"], noBins.host, noBins.io), 2);
  assert.match(noBins.stderr(), /pass --control-plane-bin/u);
  assert.ok(!noBins.execs.some((line) => line.includes("daemon-reload")), "nothing is installed when inputs are invalid");

  const sysNoRoot = fake(t);
  assert.equal(await runServiceCli(["service", "install", "--system", ...bins(sysNoRoot)], sysNoRoot.host, sysNoRoot.io), 2);
  assert.match(sysNoRoot.stderr(), /--system requires root/u);

  const badPort = fake(t);
  assert.equal(await runServiceCli(["service", "install", ...bins(badPort), "--port", "70000"], badPort.host, badPort.io), 2);
  assert.match(badPort.stderr(), /--port must be 1-65535/u);
  const badId = fake(t);
  assert.equal(await runServiceCli(["service", "install", ...bins(badId), "--runner-id", "bad id"], badId.host, badId.io), 2);
  assert.match(badId.stderr(), /--runner-id must be/u);
  const both = fake(t);
  assert.equal(await runServiceCli(["service", "install", "--user", "--system"], both.host, both.io), 2);
  assert.match(both.stderr(), /either --user or --system/u);

  const sick = fake(t, { healthy: () => false });
  assert.equal(await runServiceCli(["service", "install", ...bins(sick), "--json"], sick.host, sick.io), 1);
  assert.match(JSON.parse(sick.stdout()).error, /did not become healthy .* inspect it with: wollipog service logs control-plane/u);
  assert.ok(!sick.execs.some((line) => line.includes(`restart ${RUNNER_UNIT}`)), "the runner is not started behind a sick control plane");
});

test("service install --runner without a SEA runner needs --runner-bin, and a SEA sibling is found automatically", async (t) => {
  const f = fake(t);
  writeFileSync(join(f.root, "control-plane"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(await runServiceCli(["service", "install", "--runner", "--control-plane-bin", join(f.root, "control-plane")], f.host, f.io), 2);
  assert.match(f.stderr(), /pass --runner-bin/u);

  const sibling = join(f.root, "bin", "wollipog-runner");
  mkdirSync(join(f.root, "bin"));
  writeFileSync(sibling, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(f.root, "bin", "wollipog"), "#!/bin/sh\n", { mode: 0o755 });
  const g = fake(t, { isSea: true, execPath: join(f.root, "bin", "wollipog") });
  assert.equal(await runServiceCli(["service", "install", "--runner", "--no-start", "--json"], g.host, g.io), 0, g.stderr());
  const unit = readFileSync(join(g.layout.unitDir, RUNNER_UNIT), "utf8");
  assert.ok(unit.includes(`ExecStart="${sibling}"`), unit);
  assert.deepEqual(JSON.parse(g.stdout()).started, []);
});

test("service status, restart, and logs drive systemctl and journalctl with the exact unit names", async (t) => {
  const f = fake(t);
  assert.equal(await runServiceCli(["service", "install", ...bins(f), "--json"], f.host, f.io), 0, f.stderr());
  const s = fake(t, { home: f.home });
  assert.equal(await runServiceCli(["service", "status"], s.host, s.io), 1, "the fresh fake host has nothing running");
  assert.match(s.stdout(), /wollipog-control-plane\.service\s+loaded\s+inactive\/dead\s+enabled/u);
  assert.match(s.stdout(), /settings from .*control-plane\.env/u);

  const r = fake(t, { home: f.home });
  assert.equal(await runServiceCli(["service", "restart", "control-plane", "--json"], r.host, r.io), 0, r.stderr());
  const restarted = JSON.parse(r.stdout());
  assert.equal(restarted.unit, CONTROL_PLANE_UNIT);
  assert.equal(restarted.health.ok, true);
  assert.ok(r.execs.includes(`systemctl --user restart ${CONTROL_PLANE_UNIT}`));
  const bad = fake(t);
  assert.equal(await runServiceCli(["service", "restart", "database"], bad.host, bad.io), 2);
  assert.match(bad.stderr(), /requires <control-plane \| runner>/u);

  const l = fake(t);
  assert.equal(await runServiceCli(["service", "logs", "runner", "--follow", "--lines", "50"], l.host, l.io), 0);
  assert.ok(l.execs.includes(`journalctl --user -u ${RUNNER_UNIT} -n 50 --no-pager -f (inherit)`), l.execs.join("\n"));
  const badLines = fake(t);
  assert.equal(await runServiceCli(["service", "logs", "runner", "--lines", "many"], badLines.host, badLines.io), 2);
});

test("service uninstall preserves data by default, purges only with a separate acknowledgement, and never touches other units", async (t) => {
  const f = fake(t);
  assert.equal(await runServiceCli(["service", "install", ...bins(f), "--json"], f.host, f.io), 0, f.stderr());
  const piped = fake(t, { home: f.home });
  assert.equal(await runServiceCli(["service", "uninstall"], piped.host, piped.io), 2);
  assert.match(piped.stderr(), /pass --yes/u);
  const purgeNoAck = fake(t, { home: f.home });
  assert.equal(await runServiceCli(["service", "uninstall", "--yes", "--purge"], purgeNoAck.host, purgeNoAck.io), 2);
  assert.match(purgeNoAck.stderr(), /pass --yes-purge/u);
  assert.ok(existsSync(f.layout.controlPlaneDb) || existsSync(f.layout.controlPlaneDataDir), "nothing was deleted");

  const u = fake(t, { home: f.home });
  assert.equal(await runServiceCli(["service", "uninstall", "--yes", "--json"], u.host, u.io), 0, u.stderr());
  const report = JSON.parse(u.stdout());
  assert.equal(report.purged, false);
  assert.deepEqual(report.removed.sort(), [join(f.layout.unitDir, CONTROL_PLANE_UNIT), join(f.layout.unitDir, RUNNER_UNIT)].sort());
  assert.deepEqual(report.preserved.sort(), [f.layout.configDir, f.layout.dataDir].sort());
  assert.ok(existsSync(f.layout.runnerTokenFile) && existsSync(f.layout.controlPlaneEnvFile), "credentials and config survive a plain uninstall");
  assert.ok(u.execs.includes(`systemctl --user disable --now ${RUNNER_UNIT} ${CONTROL_PLANE_UNIT}`));
  assert.ok(u.execs.every((line) => !/dogfood|watchdog/u.test(line)) && u.execs.filter((line) => line.includes("disable")).every((line) => line.endsWith(`${RUNNER_UNIT} ${CONTROL_PLANE_UNIT}`)));

  const declined = fake(t, { home: f.home, stdinIsTTY: true, confirm: async (q) => !q.includes("PERMANENTLY") });
  assert.equal(await runServiceCli(["service", "uninstall", "--purge"], declined.host, declined.io), 1);
  assert.match(declined.stdout(), /nothing was changed/u);
  assert.ok(existsSync(f.layout.dataDir));

  const p = fake(t, { home: f.home });
  assert.equal(await runServiceCli(["service", "uninstall", "--yes", "--purge", "--yes-purge", "--json"], p.host, p.io), 0, p.stderr());
  assert.equal(JSON.parse(p.stdout()).purged, true);
  assert.ok(!existsSync(f.layout.dataDir) && !existsSync(f.layout.configDir));
});

test("service usage and option errors", async (t) => {
  const f = fake(t);
  assert.equal(await runServiceCli(["service", "bogus"], f.host, f.io), 2);
  assert.match(f.stderr(), /Usage: wollipog service/u);
  const g = fake(t);
  assert.equal(await runServiceCli(["service", "install", "--port", "--json"], g.host, g.io), 2);
  assert.match(g.stdout(), /--port requires a value/u);
});
