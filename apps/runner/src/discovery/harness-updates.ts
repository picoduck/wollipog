import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentContext, HarnessUpdateAssessment } from "@wollipog/protocol";
import { run, type ExecResult, type ResolvedBinary } from "./resolve.js";

const PACKAGES = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  pi: "@earendil-works/pi-coding-agent",
} as const;

type Harness = keyof typeof PACKAGES;

/** A PATH hit alone does not prove which package manager owns the executable. Only a launch
 * resolving inside the expected npm package is eligible for the registry comparison. */
export function npmPackageForInstallation(harness: Harness, binary: ResolvedBinary): string | null {
  const packageName = PACKAGES[harness];
  const paths = [binary.path, binary.launch.command, ...binary.launch.args, binary.identity ?? ""];
  try { paths.push(realpathSync(binary.path)); } catch { /* WSL paths are not host paths. */ }
  return paths.some((path) => path.replace(/\\/g, "/").includes(`/node_modules/${packageName}/`))
    ? packageName : null;
}

function versionTuple(value: string): [number, number, number] | null {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function classifyNpmHarnessUpdate(
  installedVersion: string | undefined,
  result: ExecResult,
  packageName: string,
  checkedAt: number,
  installedCompatible = true,
): HarnessUpdateAssessment {
  const preview = !!installedVersion && /-/.test(installedVersion);
  const base = {
    installedVersion,
    latestKnownCompatibleVersion: installedCompatible ? installedVersion : undefined,
    checkedAt,
    channel: preview ? "preview" as const : "stable" as const,
    evidenceSource: `npm dist-tags for ${packageName}`,
    managedExternally: true as const,
    guidance: "A newer published release has not been compatibility-tested on this Machine. Use the installation's original package or version manager, then restart idle sessions and rediscover.",
  };
  if (result.code !== 0 || result.timedOut) return { ...base, status: "check_failed" };
  let tags: Record<string, unknown>;
  try { tags = JSON.parse(result.stdout) as Record<string, unknown>; }
  catch { return { ...base, status: "check_failed" }; }
  const latest = tags[preview && typeof tags.next === "string" ? "next" : "latest"];
  if (typeof latest !== "string" || !versionTuple(latest)) return { ...base, status: "check_failed" };
  if (!installedVersion || !versionTuple(installedVersion)) {
    return { ...base, status: "version_unknown", latestPublishedVersion: latest };
  }
  if (preview) return { ...base, status: "preview_channel", latestPublishedVersion: latest };
  const installed = versionTuple(installedVersion)!;
  const published = versionTuple(latest)!;
  const newer = published[0] > installed[0] ||
    (published[0] === installed[0] && published[1] > installed[1]) ||
    (published[0] === installed[0] && published[1] === installed[1] && published[2] > installed[2]);
  return { ...base, status: newer ? "update_available" : "up_to_date", latestPublishedVersion: latest };
}

/** Bounded, non-interactive check. npm handles its configured proxy and registry; failures are
 * reduced to a content-free status so tokens, proxy diagnostics, and policy details stay local. */
export async function checkHarnessUpdate(
  harness: Harness,
  binary: ResolvedBinary,
  context: AgentContext,
  installedVersion: string | undefined,
  installedCompatible: boolean,
): Promise<HarnessUpdateAssessment> {
  const checkedAt = Date.now();
  if (process.env.WOLLIPOG_HARNESS_UPDATE_CHECKS === "off") return {
    status: !installedVersion ? "version_unknown" : "managed_externally",
    installedVersion,
    latestKnownCompatibleVersion: installedCompatible ? installedVersion : undefined,
    checkedAt,
    channel: installedVersion?.includes("-") ? "preview" : installedVersion ? "stable" : "unknown",
    evidenceSource: "Machine update-check policy",
    managedExternally: true,
    guidance: "Version checks are disabled by this Machine's policy. Use the original installation manager and rediscover after an upgrade.",
  };
  const packageName = npmPackageForInstallation(harness, binary);
  if (!packageName) return {
    status: !installedVersion ? "version_unknown" : installedVersion.includes("-")
      ? "preview_channel" : "managed_externally",
    installedVersion,
    latestKnownCompatibleVersion: installedCompatible ? installedVersion : undefined,
    checkedAt,
    channel: installedVersion?.includes("-") ? "preview" : installedVersion ? "stable" : "unknown",
    evidenceSource: "Executable installation provenance",
    managedExternally: true,
    guidance: "Use the original installation manager to check for upgrades, then rediscover this Machine.",
  };
  const args = ["view", packageName, "dist-tags", "--json"];
  let result: ExecResult | null = null;
  if (context.kind === "wsl") {
    const node = binary.launch.command;
    if (basename(node) === "node") {
      const inspected = await run("wsl.exe", ["-d", context.distro, "--exec", "sh", "-c",
        'readlink -f "$1"', "sh", `${dirname(node)}/npm`], { timeoutMs: 3000 });
      const npmScript = inspected.stdout.trim();
      if (inspected.code === 0 && /\/node_modules\/npm\/bin\/npm-cli\.js$/.test(npmScript)) {
        result = await run("wsl.exe", ["-d", context.distro, "--exec", node, npmScript, ...args],
          { timeoutMs: 8000 });
      }
    }
  } else {
    const node = /(\b|[\\/])node(?:\.exe)?$/i.test(binary.launch.command)
      ? binary.launch.command : join(dirname(binary.path), "node");
    const npm = join(dirname(node), "npm");
    if (existsSync(node) && existsSync(npm)) {
      try {
        const script = realpathSync(npm);
        if (/[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(script)) {
          result = await run(realpathSync(node), [script, ...args], { timeoutMs: 8000 });
        }
      } catch { /* The original installation manager cannot be verified. */ }
    }
  }
  if (!result) return {
    status: "managed_externally",
    installedVersion,
    latestKnownCompatibleVersion: installedCompatible ? installedVersion : undefined,
    checkedAt,
    channel: installedVersion?.includes("-") ? "preview" : installedVersion ? "stable" : "unknown",
    evidenceSource: `Installed npm package ${packageName}; exact npm runtime unavailable`,
    managedExternally: true,
    guidance: "Use this installation's original package or version manager to check and apply upgrades, then rediscover.",
  };
  return classifyNpmHarnessUpdate(installedVersion, result, packageName, checkedAt, installedCompatible);
}
