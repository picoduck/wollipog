import type { CodexAppServerCapabilities } from "@wollipog/protocol";
import { run, type ResolvedLaunch } from "./resolve.js";

/** Oldest Codex build whose generated v2 schema is pinned in this repository. Official docs do
 * not publish a CLI minimum, so older builds remain an explicit exec fallback until verified. */
export const MIN_VERIFIED_CODEX_APP_SERVER_VERSION = "0.147.0";
export const CODEX_APP_SERVER_CONTRACT_FINGERPRINT = "codex-app-server-v2-subagents-reasoning-consumed-surface-2026-08-25";

export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  errorCode?: string;
}

function semverParts(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function versionAtLeast(version: string, minimum = MIN_VERIFIED_CODEX_APP_SERVER_VERSION): boolean {
  const actual = semverParts(version);
  const floor = semverParts(minimum);
  if (!actual || !floor) return false;
  const numeric = actual[0] - floor[0] || actual[1] - floor[1] || actual[2] - floor[2];
  if (numeric !== 0) return numeric > 0;
  // A prerelease of the verified stable floor is semantically older than the release itself.
  return !/^\d+\.\d+\.\d+-/.test(version) || /^\d+\.\d+\.\d+-/.test(minimum);
}

/** Convert the bounded `codex app-server --help` probe into a stable, secret-safe result. */
export function interpretCodexAppServerProbe(version: string | undefined, result: ProbeResult): CodexAppServerCapabilities {
  if (result.timedOut) {
    return {
      status: "unsupported",
      installedVersion: version,
      appServerAvailable: false,
      failure: { code: "probe_timeout", message: "The Codex App Server capability check timed out.", retryable: true },
    };
  }
  if (result.errorCode) {
    return {
      status: "unsupported",
      installedVersion: version,
      appServerAvailable: false,
      failure: { code: "probe_failed", message: "The Codex App Server capability check could not run.", retryable: true },
    };
  }
  if (result.code !== 0) {
    return {
      status: "unsupported",
      installedVersion: version,
      appServerAvailable: false,
      failure: { code: "app_server_unavailable", message: "This Codex installation does not expose app-server.", retryable: false },
    };
  }

  const help = `${result.stdout}\n${result.stderr}`;
  const missing = [
    ["app-server command", /Usage:\s+codex(?:\.exe)?\s+app-server/i],
    ["stdio transport", /stdio:\/\//i],
    ["schema generator", /generate-json-schema/i],
  ].filter(([, pattern]) => !(pattern as RegExp).test(help)).map(([name]) => name as string);
  if (missing.length) {
    return {
      status: "unsupported",
      installedVersion: version,
      appServerAvailable: true,
      failure: {
        code: "contract_mismatch",
        message: `Codex app-server is missing required contract markers: ${missing.join(", ")}.`,
        retryable: false,
      },
    };
  }
  if (!version || !versionAtLeast(version)) {
    return {
      status: "unsupported",
      installedVersion: version,
      appServerAvailable: true,
      transport: "stdio",
      failure: {
        code: "version_unverified",
        message: version
          ? `Codex ${version} is older than the verified app-server floor ${MIN_VERIFIED_CODEX_APP_SERVER_VERSION}.`
          : `Codex version could not be verified; app-server requires ${MIN_VERIFIED_CODEX_APP_SERVER_VERSION} or newer.`,
        retryable: false,
      },
    };
  }
  return {
    status: "supported",
    installedVersion: version,
    appServerAvailable: true,
    transport: "stdio",
    verification: "help-and-version",
    contractFingerprint: CODEX_APP_SERVER_CONTRACT_FINGERPRINT,
  };
}

export function unavailableCodexAppServer(): CodexAppServerCapabilities {
  return {
    status: "unavailable",
    appServerAvailable: false,
    failure: { code: "codex_unavailable", message: "Codex is not installed in this runner context.", retryable: false },
  };
}

export function nativeCodexAppServerProbeArgs(launch: ResolvedLaunch): { command: string; args: string[] } {
  return { command: launch.command, args: [...launch.args, "app-server", "--help"] };
}

export function wslCodexAppServerProbeArgs(distro: string, launch: ResolvedLaunch): { command: "wsl.exe"; args: string[] } {
  return { command: "wsl.exe", args: ["-d", distro, "--exec", launch.command, ...launch.args, "app-server", "--help"] };
}

export async function probeNativeCodexAppServer(
  launch: ResolvedLaunch,
  version: string | undefined,
): Promise<CodexAppServerCapabilities> {
  const probe = nativeCodexAppServerProbeArgs(launch);
  const result = await run(probe.command, probe.args, { timeoutMs: 8000, maxBuffer: 256 * 1024 });
  return interpretCodexAppServerProbe(version, result);
}

export async function probeWslCodexAppServer(
  distro: string,
  launch: ResolvedLaunch,
  version: string | undefined,
): Promise<CodexAppServerCapabilities> {
  const probe = wslCodexAppServerProbeArgs(distro, launch);
  const result = await run(probe.command, probe.args, { timeoutMs: 10000, maxBuffer: 256 * 1024 });
  return interpretCodexAppServerProbe(version, result);
}
