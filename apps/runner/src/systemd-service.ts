/**
 * Pure layout and rendering for the headless Linux systemd deployment (`wollipog service`).
 * Nothing here touches the filesystem or runs commands; service-cli.ts does that through an
 * injectable host so the generated units, env files, and configs are snapshot-testable.
 */

import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type ServiceMode = "user" | "system";
export type ServiceComponent = "control-plane" | "runner";

export const CONTROL_PLANE_UNIT = "wollipog-control-plane.service";
export const RUNNER_UNIT = "wollipog-runner.service";
export const DEFAULT_SYSTEM_ACCOUNT = "wollipog";
export const DEFAULT_PORT = 4317;
/** Runner descendant containment needs at least 20s (docs/ssh-runner-lifecycle.md). */
export const STOP_TIMEOUT_SECONDS = 30;

export interface ServiceLayout {
  mode: ServiceMode;
  /** OS account the units run as (system mode) or the invoking user (user mode). */
  account: string;
  unitDir: string;
  configDir: string;
  dataDir: string;
  controlPlaneDataDir: string;
  controlPlaneDb: string;
  controlPlaneArtifactDir: string;
  controlPlaneLocalTokenFile: string;
  controlPlaneEnvFile: string;
  runnerDataDir: string;
  runnerConfigFile: string;
  runnerTokenFile: string;
  workspaceDir: string;
  units: { controlPlane: string; runner: string };
  /** Absolute directory the system layout was relocated under (`WOLLIPOG_SYSTEM_PREFIX`), or null for the real FHS paths. */
  relocatedPrefix: string | null;
}

export function unitFor(component: ServiceComponent): string {
  return component === "control-plane" ? CONTROL_PLANE_UNIT : RUNNER_UNIT;
}

export function parseComponent(value: string | undefined): ServiceComponent | null {
  return value === "control-plane" || value === "runner" ? value : null;
}

/**
 * User mode follows the XDG base directories of the invoking account; system mode uses the
 * conventional FHS locations owned by a dedicated unprivileged account. The unit directory in
 * user mode is always `~/.config/systemd/user`, which is where the user's systemd manager looks
 * regardless of the shell's XDG variables.
 */
export function serviceLayout(
  mode: ServiceMode,
  input: { home: string; user: string; env: NodeJS.ProcessEnv; account?: string; workspaceDir?: string },
): ServiceLayout {
  if (mode === "system") {
    const account = input.account ?? DEFAULT_SYSTEM_ACCOUNT;
    // WOLLIPOG_SYSTEM_PREFIX relocates the whole system layout (tests, image builds); production
    // installs leave it unset so the FHS paths are used verbatim. It is never applied silently: it
    // must be an absolute path, and every command reports the relocation (`relocatedPrefix`).
    const rawPrefix = input.env.WOLLIPOG_SYSTEM_PREFIX?.trim() ?? "";
    if (rawPrefix && !isAbsolute(rawPrefix)) {
      throw new Error(`WOLLIPOG_SYSTEM_PREFIX must be an absolute directory, got ${JSON.stringify(rawPrefix)}; unset it for a real system install`);
    }
    const prefix = rawPrefix ? resolve(rawPrefix) : "";
    const dataDir = `${prefix}/var/lib/wollipog`;
    const configDir = `${prefix}/etc/wollipog`;
    return finishLayout({
      mode, account, dataDir, configDir,
      unitDir: `${prefix}/etc/systemd/system`,
      workspaceDir: input.workspaceDir ?? join(dataDir, "workspaces"),
      relocatedPrefix: prefix || null,
    });
  }
  const xdgData = input.env.XDG_DATA_HOME?.trim() || join(input.home, ".local", "share");
  const xdgConfig = input.env.XDG_CONFIG_HOME?.trim() || join(input.home, ".config");
  return finishLayout({
    mode, account: input.user,
    dataDir: join(xdgData, "wollipog"),
    configDir: join(xdgConfig, "wollipog"),
    unitDir: join(input.home, ".config", "systemd", "user"),
    workspaceDir: input.workspaceDir ?? input.home,
    relocatedPrefix: null,
  });
}

function finishLayout(base: {
  mode: ServiceMode; account: string; dataDir: string; configDir: string; unitDir: string; workspaceDir: string; relocatedPrefix: string | null;
}): ServiceLayout {
  const controlPlaneDataDir = join(base.dataDir, "control-plane");
  const controlPlaneDb = join(controlPlaneDataDir, "control-plane.db");
  return {
    ...base,
    controlPlaneDataDir,
    controlPlaneDb,
    controlPlaneArtifactDir: `${controlPlaneDb}.artifacts`,
    controlPlaneLocalTokenFile: `${controlPlaneDb}.local-device-token`,
    controlPlaneEnvFile: join(base.configDir, "control-plane.env"),
    runnerDataDir: join(base.dataDir, "runner"),
    runnerConfigFile: join(base.configDir, "runner.config.json"),
    runnerTokenFile: join(base.configDir, "runner.token"),
    workspaceDir: resolve(base.workspaceDir),
    units: { controlPlane: CONTROL_PLANE_UNIT, runner: RUNNER_UNIT },
  };
}

export interface ControlPlaneServiceOptions {
  executable: string;
  host: string;
  port: number;
  publicOrigin: string | null;
  tailnetOnly: boolean;
  webDist: string | null;
}

function assertUnitSafe(label: string, value: string): void {
  if (/[\n\r\0]/u.test(value)) throw new Error(`${label} must not contain newlines or NUL`);
}

/**
 * A literal path for a single-value directive (WorkingDirectory=, EnvironmentFile=). systemd expands
 * `%` specifiers in these values, so a literal percent sign must be doubled; the value is otherwise
 * taken to the end of the line, so spaces need no quoting.
 */
export function unitPath(value: string): string {
  assertUnitSafe("unit path", value);
  return value.replace(/%/gu, "%%");
}

/** Quote one word for a split directive (ReadWritePaths=, Environment= values): `%` doubled, no `$` expansion there. */
export function unitQuote(value: string): string {
  assertUnitSafe("unit value", value);
  return `"${value.replace(/%/gu, "%%").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/** Quote one ExecStart= word: like unitQuote, plus `$` doubled because systemd expands `${VAR}` even inside quotes. */
export function execQuote(value: string): string {
  assertUnitSafe("ExecStart word", value);
  return `"${value.replace(/%/gu, "%%").replace(/\$/gu, "$$$$").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * Control-plane unit. Bounded restart backoff, graceful stop, control-group kill so SSH box
 * children never outlive the process, and a writable set limited to its own data. The env file
 * (mode 0600, EnvironmentFile) carries every setting; nothing secret lives in the unit itself.
 */
export function renderControlPlaneUnit(layout: ServiceLayout, options: ControlPlaneServiceOptions): string {
  assertUnitSafe("control-plane executable", options.executable);
  // systemd --user managers have no network-online.target by default; the control plane binds
  // loopback anyway, so only system units order themselves after the network.
  const network = layout.mode === "system" ? ["After=network-online.target", "Wants=network-online.target"] : [];
  const lines = [
    "# Generated by `wollipog service install`. Re-run install to regenerate; edit control-plane.env for settings.",
    "[Unit]",
    "Description=Wollipog control plane",
    "Documentation=https://github.com/picoduck/wollipog/blob/main/docs/headless-deployment.md",
    ...network,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=simple",
    ...(layout.mode === "system" ? [`User=${layout.account}`, `Group=${layout.account}`] : []),
    `WorkingDirectory=${unitPath(layout.controlPlaneDataDir)}`,
    `EnvironmentFile=${unitPath(layout.controlPlaneEnvFile)}`,
    `ExecStart=${execQuote(options.executable)}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "KillMode=control-group",
    "KillSignal=SIGTERM",
    "SendSIGKILL=yes",
    `TimeoutStopSec=${STOP_TIMEOUT_SECONDS}s`,
    "NoNewPrivileges=yes",
    ...(layout.mode === "system"
      ? [
          "ProtectSystem=strict",
          "ProtectHome=read-only",
          `ReadWritePaths=${unitQuote(layout.controlPlaneDataDir)}`,
          "PrivateTmp=yes",
        ]
      : []),
    "",
    "[Install]",
    `WantedBy=${layout.mode === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Runner unit. It connects outbound to the colocated control plane over loopback, so no inbound
 * port is exposed. The token is read from a 0600 file by path; it never appears in the unit.
 * Hardening is deliberately lighter than the control plane's because the runner launches agent
 * processes that need the account's provider homes and workspaces.
 */
export function renderRunnerUnit(layout: ServiceLayout, options: { executable: string }): string {
  assertUnitSafe("runner executable", options.executable);
  const network = layout.mode === "system" ? "network-online.target " : "";
  const lines = [
    "# Generated by `wollipog service install`. Re-run install to regenerate; edit runner.config.json for settings.",
    "[Unit]",
    "Description=Wollipog runner",
    "Documentation=https://github.com/picoduck/wollipog/blob/main/docs/headless-deployment.md",
    `After=${network}${layout.units.controlPlane}`,
    `Wants=${network}${layout.units.controlPlane}`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=simple",
    ...(layout.mode === "system" ? [`User=${layout.account}`, `Group=${layout.account}`] : []),
    `WorkingDirectory=${unitPath(layout.runnerDataDir)}`,
    `Environment=RUNNER_TOKEN_FILE=${unitQuote(layout.runnerTokenFile)}`,
    `Environment=RUNNER_DATA_DIR=${unitQuote(layout.runnerDataDir)}`,
    `ExecStart=${execQuote(options.executable)} --config ${execQuote(layout.runnerConfigFile)}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "KillMode=control-group",
    "KillSignal=SIGTERM",
    "SendSIGKILL=yes",
    `TimeoutStopSec=${STOP_TIMEOUT_SECONDS}s`,
    "NoNewPrivileges=yes",
    "",
    "[Install]",
    `WantedBy=${layout.mode === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ];
  return lines.join("\n");
}

/** systemd EnvironmentFile value quoting: double quotes with backslash escapes. */
function envQuote(value: string): string {
  assertUnitSafe("environment value", value);
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

export function renderControlPlaneEnv(layout: ServiceLayout, options: ControlPlaneServiceOptions): string {
  const lines = [
    "# Generated by `wollipog service install`. Mode 0600: it may reference credential locations.",
    "# Edit and run `wollipog service restart control-plane` to apply.",
    `CONTROL_PLANE_HOST=${envQuote(options.host)}`,
    `CONTROL_PLANE_PORT=${options.port}`,
    `CONTROL_PLANE_DB=${envQuote(layout.controlPlaneDb)}`,
    `CONTROL_PLANE_ARTIFACT_DIR=${envQuote(layout.controlPlaneArtifactDir)}`,
    `CONTROL_PLANE_LOCAL_TOKEN_FILE=${envQuote(layout.controlPlaneLocalTokenFile)}`,
  ];
  if (options.publicOrigin) lines.push(`CONTROL_PLANE_PUBLIC_ORIGIN=${envQuote(options.publicOrigin)}`);
  if (options.tailnetOnly) lines.push("CONTROL_PLANE_TAILNET_ONLY=1");
  if (options.webDist) lines.push(`WOLLIPOG_WEB_DIST=${envQuote(options.webDist)}`);
  lines.push("");
  return lines.join("\n");
}

export function renderRunnerConfig(layout: ServiceLayout, options: { runnerId: string; port: number }): string {
  return `${JSON.stringify(
    {
      runnerId: options.runnerId,
      controlPlaneUrl: `ws://127.0.0.1:${options.port}/runner`,
      // The token is supplied by RUNNER_TOKEN_FILE from the unit; it never lives in this file.
      token: "",
      workspaces: [{ id: "home", name: options.runnerId, path: layout.workspaceDir }],
      agents: [],
    },
    null,
    2,
  )}\n`;
}

/** Parse `KEY=VALUE` lines as systemd's EnvironmentFile does for the subset this tool writes. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["\\])/gu, "$1");
    }
    out[key] = value;
  }
  return out;
}

export interface InstalledControlPlaneEnv {
  file: string;
  db?: string;
  port?: number;
  localTokenFile?: string;
  host?: string;
  publicOrigin?: string;
}

/**
 * The control-plane env file written by `wollipog service install`, so `wollipog admin` and
 * `wollipog service` find the installed database and port without the operator exporting anything.
 * With an explicit mode only that deployment is consulted; otherwise root prefers the system
 * deployment and other accounts their own user deployment. Only a regular, non-symlink file is
 * honoured, and only the documented keys are read.
 */
export function readInstalledControlPlaneEnv(
  input: { home: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; uid?: number | null; mode?: ServiceMode },
): InstalledControlPlaneEnv | null {
  if (input.platform !== "linux") return null;
  const userFile = serviceLayout("user", { home: input.home, user: "", env: input.env }).controlPlaneEnvFile;
  const systemFile = serviceLayout("system", { home: input.home, user: "", env: input.env }).controlPlaneEnvFile;
  const candidates = input.mode === "user" ? [userFile]
    : input.mode === "system" ? [systemFile]
      : input.uid === 0 ? [systemFile, userFile] : [userFile, systemFile];
  for (const file of candidates) {
    let contents: string;
    try {
      const before = lstatSync(file);
      if (!before.isFile()) continue;
      const fd = openSync(file, constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0));
      try {
        if (!fstatSync(fd).isFile()) continue;
        contents = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    const values = parseEnvFile(contents);
    const port = values.CONTROL_PLANE_PORT !== undefined ? Number(values.CONTROL_PLANE_PORT) : undefined;
    return {
      file,
      ...(values.CONTROL_PLANE_DB ? { db: values.CONTROL_PLANE_DB } : {}),
      ...(Number.isInteger(port) && port! > 0 ? { port } : {}),
      ...(values.CONTROL_PLANE_LOCAL_TOKEN_FILE ? { localTokenFile: values.CONTROL_PLANE_LOCAL_TOKEN_FILE } : {}),
      ...(values.CONTROL_PLANE_HOST ? { host: values.CONTROL_PLANE_HOST } : {}),
      ...(values.CONTROL_PLANE_PUBLIC_ORIGIN ? { publicOrigin: values.CONTROL_PLANE_PUBLIC_ORIGIN } : {}),
    };
  }
  return null;
}

export interface UnitState {
  unit: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  mainPid: number | null;
  restarts: number | null;
  startedAt: string | null;
}

/** Parse `systemctl show -p ...` `KEY=VALUE` output. */
export function parseSystemctlShow(unit: string, output: string): UnitState {
  const values = parseEnvFile(output);
  const pid = Number(values.MainPID ?? "0");
  const restarts = values.NRestarts !== undefined ? Number(values.NRestarts) : NaN;
  return {
    unit,
    loadState: values.LoadState ?? "unknown",
    activeState: values.ActiveState ?? "unknown",
    subState: values.SubState ?? "unknown",
    unitFileState: values.UnitFileState ?? "unknown",
    mainPid: Number.isInteger(pid) && pid > 0 ? pid : null,
    restarts: Number.isInteger(restarts) ? restarts : null,
    startedAt: values.ExecMainStartTimestamp || null,
  };
}

export const SYSTEMCTL_SHOW_PROPERTIES = [
  "LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID", "NRestarts", "ExecMainStartTimestamp",
];
