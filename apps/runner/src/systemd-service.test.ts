import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PLANE_UNIT,
  RUNNER_UNIT,
  parseEnvFile,
  parseSystemctlShow,
  readInstalledControlPlaneEnv,
  renderControlPlaneEnv,
  renderControlPlaneUnit,
  renderRunnerConfig,
  renderRunnerUnit,
  serviceLayout,
  execQuote,
  unitPath,
  unitQuote,
} from "./systemd-service.js";

const USER_LAYOUT = serviceLayout("user", { home: "/home/op", user: "op", env: {} });
const SYSTEM_LAYOUT = serviceLayout("system", { home: "/root", user: "root", env: {} });

test("service layout follows XDG in user mode and FHS with a dedicated account in system mode", () => {
  assert.equal(USER_LAYOUT.unitDir, "/home/op/.config/systemd/user");
  assert.equal(USER_LAYOUT.dataDir, "/home/op/.local/share/wollipog");
  assert.equal(USER_LAYOUT.configDir, "/home/op/.config/wollipog");
  assert.equal(USER_LAYOUT.controlPlaneDb, "/home/op/.local/share/wollipog/control-plane/control-plane.db");
  assert.equal(USER_LAYOUT.controlPlaneLocalTokenFile, `${USER_LAYOUT.controlPlaneDb}.local-device-token`);
  assert.equal(USER_LAYOUT.runnerTokenFile, "/home/op/.config/wollipog/runner.token");
  assert.equal(USER_LAYOUT.workspaceDir, "/home/op");
  const xdg = serviceLayout("user", { home: "/home/op", user: "op", env: { XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/cfg" }, workspaceDir: "/srv/work" });
  assert.equal(xdg.dataDir, "/data/wollipog");
  assert.equal(xdg.configDir, "/cfg/wollipog");
  assert.equal(xdg.unitDir, "/home/op/.config/systemd/user", "the user manager reads ~/.config/systemd/user regardless of the shell's XDG_CONFIG_HOME");
  assert.equal(xdg.workspaceDir, "/srv/work");
  assert.equal(SYSTEM_LAYOUT.account, "wollipog");
  assert.equal(SYSTEM_LAYOUT.unitDir, "/etc/systemd/system");
  assert.equal(SYSTEM_LAYOUT.dataDir, "/var/lib/wollipog");
  assert.equal(SYSTEM_LAYOUT.configDir, "/etc/wollipog");
  assert.equal(SYSTEM_LAYOUT.workspaceDir, "/var/lib/wollipog/workspaces");
  assert.equal(serviceLayout("system", { home: "/root", user: "root", env: {}, account: "svc" }).account, "svc");
  const relocated = serviceLayout("system", { home: "/root", user: "root", env: { WOLLIPOG_SYSTEM_PREFIX: "/tmp/sysroot/" } });
  assert.equal(relocated.dataDir, "/tmp/sysroot/var/lib/wollipog");
  assert.equal(relocated.unitDir, "/tmp/sysroot/etc/systemd/system");
});

test("control-plane unit has bounded restarts, graceful control-group stop, and no secrets", () => {
  const unit = renderControlPlaneUnit(SYSTEM_LAYOUT, { executable: "/opt/wollipog/control-plane", host: "127.0.0.1", port: 4317, publicOrigin: null, tailnetOnly: false, webDist: null });
  for (const line of [
    "User=wollipog", "Group=wollipog", "WorkingDirectory=/var/lib/wollipog/control-plane",
    "EnvironmentFile=/etc/wollipog/control-plane.env", 'ExecStart="/opt/wollipog/control-plane"',
    "Restart=on-failure", "RestartSec=5s", "StartLimitIntervalSec=300", "StartLimitBurst=10",
    "KillMode=control-group", "KillSignal=SIGTERM", "SendSIGKILL=yes", "TimeoutStopSec=30s",
    "NoNewPrivileges=yes", "ProtectSystem=strict", 'ReadWritePaths="/var/lib/wollipog/control-plane"', "WantedBy=multi-user.target",
  ]) assert.ok(unit.includes(`\n${line}\n`), line);
  assert.ok(!/token|secret/iu.test(unit));
  const userUnit = renderControlPlaneUnit(USER_LAYOUT, { executable: "/home/op/.local/bin/wollipog-control-plane", host: "127.0.0.1", port: 4317, publicOrigin: null, tailnetOnly: false, webDist: null });
  assert.ok(!userUnit.includes("User="), "user units run as the invoking account");
  assert.ok(!userUnit.includes("ProtectSystem="), "user units skip system-level sandboxing");
  assert.ok(userUnit.includes("WantedBy=default.target"));
  assert.throws(() => renderControlPlaneUnit(USER_LAYOUT, { executable: "/bin/x\nExecStart=/bin/evil", host: "127.0.0.1", port: 1, publicOrigin: null, tailnetOnly: false, webDist: null }), /newlines/u);
});

test("runner unit depends on the control plane, reads its token by path, and keeps the descendant-containment settings", () => {
  const unit = renderRunnerUnit(USER_LAYOUT, { executable: "/home/op/.local/bin/wollipog-runner" });
  for (const line of [
    `After=${CONTROL_PLANE_UNIT}`, `Wants=${CONTROL_PLANE_UNIT}`,
    'Environment=RUNNER_TOKEN_FILE="/home/op/.config/wollipog/runner.token"',
    'Environment=RUNNER_DATA_DIR="/home/op/.local/share/wollipog/runner"',
    'ExecStart="/home/op/.local/bin/wollipog-runner" --config "/home/op/.config/wollipog/runner.config.json"',
    "KillMode=control-group", "SendSIGKILL=yes", "TimeoutStopSec=30s", "Restart=on-failure",
  ]) assert.ok(unit.includes(`\n${line}\n`), line);
  assert.ok(!unit.includes("ProtectHome"), "the runner needs the account's provider homes");
  assert.equal(unitQuote('a"b\\c'), '"a\\"b\\\\c"');
});

test("control-plane env file carries every setting and is parsed back identically", () => {
  const env = renderControlPlaneEnv(USER_LAYOUT, { executable: "/x", host: "0.0.0.0", port: 4400, publicOrigin: "https://box.example.ts.net", tailnetOnly: true, webDist: "/opt/wollipog/web" });
  const parsed = parseEnvFile(env);
  assert.deepEqual(parsed, {
    CONTROL_PLANE_HOST: "0.0.0.0",
    CONTROL_PLANE_PORT: "4400",
    CONTROL_PLANE_DB: USER_LAYOUT.controlPlaneDb,
    CONTROL_PLANE_ARTIFACT_DIR: USER_LAYOUT.controlPlaneArtifactDir,
    CONTROL_PLANE_LOCAL_TOKEN_FILE: USER_LAYOUT.controlPlaneLocalTokenFile,
    CONTROL_PLANE_PUBLIC_ORIGIN: "https://box.example.ts.net",
    CONTROL_PLANE_TAILNET_ONLY: "1",
    WOLLIPOG_WEB_DIST: "/opt/wollipog/web",
  });
  const minimal = parseEnvFile(renderControlPlaneEnv(USER_LAYOUT, { executable: "/x", host: "127.0.0.1", port: 4317, publicOrigin: null, tailnetOnly: false, webDist: null }));
  assert.equal(minimal.CONTROL_PLANE_PUBLIC_ORIGIN, undefined);
  assert.equal(minimal.CONTROL_PLANE_TAILNET_ONLY, undefined);
  assert.deepEqual(parseEnvFile('# c\nA="x \\"y\\" z"\nB=\'lit\'\nC=plain\n\nbad line\n'), { A: 'x "y" z', B: "lit", C: "plain" });
});

test("runner config keeps the token out and points at the loopback control plane", () => {
  const config = JSON.parse(renderRunnerConfig(USER_LAYOUT, { runnerId: "box-1", port: 4317 }));
  assert.equal(config.runnerId, "box-1");
  assert.equal(config.controlPlaneUrl, "ws://127.0.0.1:4317/runner");
  assert.equal(config.token, "");
  assert.deepEqual(config.workspaces, [{ id: "home", name: "box-1", path: "/home/op" }]);
});

test("systemctl show output is parsed into a unit state", () => {
  const state = parseSystemctlShow(RUNNER_UNIT, "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=4242\nNRestarts=2\nExecMainStartTimestamp=Tue 2026-09-08 10:00:00 CDT\n");
  assert.deepEqual(state, { unit: RUNNER_UNIT, loadState: "loaded", activeState: "active", subState: "running", unitFileState: "enabled", mainPid: 4242, restarts: 2, startedAt: "Tue 2026-09-08 10:00:00 CDT" });
  const missing = parseSystemctlShow(RUNNER_UNIT, "LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nMainPID=0\n");
  assert.equal(missing.mainPid, null);
  assert.equal(missing.restarts, null);
  assert.equal(missing.unitFileState, "");
});

test("readInstalledControlPlaneEnv finds the user env file, ignores symlinks, and is Linux-only", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-svc-"));
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "wollipog"), { recursive: true });
    assert.equal(readInstalledControlPlaneEnv({ home, env: {}, platform: "linux" }), null);
    const file = join(home, ".config", "wollipog", "control-plane.env");
    writeFileSync(file, 'CONTROL_PLANE_PORT=4400\nCONTROL_PLANE_DB="/data/cp.db"\nCONTROL_PLANE_PUBLIC_ORIGIN="https://x.example"\n', { mode: 0o600 });
    assert.deepEqual(readInstalledControlPlaneEnv({ home, env: {}, platform: "linux" }), { file, db: "/data/cp.db", port: 4400, publicOrigin: "https://x.example" });
    assert.equal(readInstalledControlPlaneEnv({ home, env: {}, platform: "darwin" }), null);
    rmSync(file);
    symlinkSync("/etc/passwd", file);
    assert.equal(readInstalledControlPlaneEnv({ home, env: {}, platform: "linux" }), null, "a symlinked env file is not trusted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unit rendering doubles systemd specifiers and only system units wait for the network", () => {
  const weird = serviceLayout("user", { home: "/home/od d%n", user: "odd", env: {} });
  const unit = renderControlPlaneUnit(weird, { executable: "/opt/w%N/control plane", host: "127.0.0.1", port: 4317, publicOrigin: null, tailnetOnly: false, webDist: null });
  assert.ok(unit.includes("WorkingDirectory=/home/od d%%n/.local/share/wollipog/control-plane\n"), unit);
  assert.ok(unit.includes("EnvironmentFile=/home/od d%%n/.config/wollipog/control-plane.env\n"));
  assert.ok(unit.includes('ExecStart="/opt/w%%N/control plane"\n'));
  const dollar = renderControlPlaneUnit(weird, { executable: "/opt/${release}/control-plane", host: "127.0.0.1", port: 4317, publicOrigin: null, tailnetOnly: false, webDist: null });
  assert.ok(dollar.includes('ExecStart="/opt/$${release}/control-plane"\n'), "ExecStart words double $ so systemd does not expand them");
  assert.equal(execQuote("/a$b"), '"/a$$b"');
  assert.equal(unitQuote("/a$b"), '"/a$b"', "Environment= values are not expanded, so $ stays literal");
  assert.ok(!unit.includes("network-online.target"), "user managers have no network-online.target");
  const runner = renderRunnerUnit(weird, { executable: "/opt/w%N/wollipog-runner" });
  assert.ok(runner.includes(`After=${CONTROL_PLANE_UNIT}\n`) && runner.includes(`Wants=${CONTROL_PLANE_UNIT}\n`));
  assert.ok(runner.includes('Environment=RUNNER_TOKEN_FILE="/home/od d%%n/.config/wollipog/runner.token"\n'));
  const system = renderControlPlaneUnit(SYSTEM_LAYOUT, { executable: "/opt/wollipog/control-plane", host: "127.0.0.1", port: 4317, publicOrigin: null, tailnetOnly: false, webDist: null });
  assert.ok(system.includes("After=network-online.target\nWants=network-online.target\n"));
  assert.ok(system.includes('ReadWritePaths="/var/lib/wollipog/control-plane"\n'));
  assert.equal(unitPath("/a%b"), "/a%%b");
  assert.equal(unitQuote("/a%b \"c\""), '"/a%%b \\"c\\""');
  assert.throws(() => unitPath("/a\nb"), /newlines/u);
});

test("readInstalledControlPlaneEnv honours the requested mode and root's system-first preference", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-svc-mode-"));
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "wollipog"), { recursive: true });
    const userFile = join(home, ".config", "wollipog", "control-plane.env");
    writeFileSync(userFile, "CONTROL_PLANE_PORT=4401\n", { mode: 0o600 });
    assert.equal(readInstalledControlPlaneEnv({ home, env: {}, platform: "linux", mode: "system" }), null, "system mode never falls back to the user file");
    assert.equal(readInstalledControlPlaneEnv({ home, env: {}, platform: "linux", mode: "user" })?.port, 4401);
    assert.equal(readInstalledControlPlaneEnv({ home, env: {}, platform: "linux", uid: 1000 })?.port, 4401);
    // Root prefers /etc/wollipog when present; here it is absent, so the user file still answers.
    assert.equal(readInstalledControlPlaneEnv({ home, env: {}, platform: "linux", uid: 0 })?.port, 4401);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
