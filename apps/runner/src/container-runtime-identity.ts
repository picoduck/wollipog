import { spawnSync } from "node:child_process";
import type { ExecResult, ResolvedLaunch } from "./discovery/resolve.js";
import { windowsCommandSpec } from "./windows-cmd.js";

export type ContainerRuntimeName = "docker" | "podman";

export const RUNTIME_IDENTITY_UNKNOWN_REASON = "container runtime identity could not be verified";

export function dockerVersionBanner(result: ExecResult): boolean {
  return result.code === 0 && !result.timedOut && !result.errorCode &&
    /^Docker version\s+\S+/iu.test(result.stdout.trim());
}

/** The same decision is used during registration and immediately before each client spawn. */
export function containerRuntimeIdentityReason(
  configured: ContainerRuntimeName,
  version: ExecResult,
  details?: ExecResult,
): string | null {
  if (version.code !== 0 || version.timedOut || version.errorCode) return RUNTIME_IDENTITY_UNKNOWN_REASON;
  const banner = version.stdout.trim();
  if (/^podman version\s+\S+/iu.test(banner)) {
    return configured === "podman" ? null : "Docker command resolves to Podman; configure a Podman target";
  }
  if (!dockerVersionBanner(version)) return RUNTIME_IDENTITY_UNKNOWN_REASON;
  if (configured === "podman") return "Podman command resolves to Docker; configure a Docker target";
  if (!details || details.code !== 0 || details.timedOut || details.errorCode) return RUNTIME_IDENTITY_UNKNOWN_REASON;
  try {
    const report = JSON.parse(details.stdout) as {
      Server?: { Platform?: { Name?: unknown }; Components?: Array<{ Name?: unknown }> };
    };
    const names = [report.Server?.Platform?.Name,
      ...(Array.isArray(report.Server?.Components) ? report.Server.Components.map((component) => component.Name) : [])]
      .filter((name): name is string => typeof name === "string");
    if (names.some((name) => /\bPodman\b/iu.test(name))) {
      return "Docker command uses a Podman engine; configure a Podman target";
    }
    if (names.some((name) => name === "Engine" || /^Docker Engine\b/iu.test(name))) return null;
  } catch {
    // An unknown or malformed version report cannot substantiate a secret-free target.
  }
  return RUNTIME_IDENTITY_UNKNOWN_REASON;
}

function runIdentityProbe(
  launch: ResolvedLaunch,
  args: string[],
  env: NodeJS.ProcessEnv,
  maxBuffer: number,
): ExecResult {
  try {
    const spec = windowsCommandSpec(launch.command, [...launch.args, ...args]);
    const result = spawnSync(spec.file, spec.args, {
      env,
      timeout: 5_000,
      maxBuffer,
      encoding: "utf8",
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? {
        windowsVerbatimArguments: true,
        argv0: spec.argv0,
      } : {}),
    });
    return {
      code: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { errorCode: (result.error as NodeJS.ErrnoException).code ?? "EUNKNOWN" } : {}),
    };
  } catch {
    return { code: 1, stdout: "", stderr: "", errorCode: "EUNKNOWN" };
  }
}

/** Synchronous because spawnAgent is synchronous. Pass the exact environment used by spawn. */
export function verifyContainerRuntimeIdentity(
  configured: ContainerRuntimeName,
  launch: ResolvedLaunch,
  env: NodeJS.ProcessEnv,
): void {
  const version = runIdentityProbe(launch, ["--version"], env, 4_096);
  const details = configured === "docker" && dockerVersionBanner(version)
    ? runIdentityProbe(launch, ["version", "--format", "{{json .}}"], env, 64 * 1024)
    : undefined;
  const reason = containerRuntimeIdentityReason(configured, version, details);
  if (reason) throw new Error(reason);
}
