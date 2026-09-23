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

/** A Machine operator may pin a harness independently of network-check policy. Unknown names
 * are ignored so a typo cannot authorize any update behavior. */
export function harnessVersionPinned(harness: Harness, value: string | undefined): boolean {
  return (value ?? "").split(",").some((entry) => entry.trim() === harness);
}

const REDISCOVER = "Stop sessions using this executable before upgrading. Restart and Rediscover before treating the new version as ready.";

const posixWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const powerShellWord = (value: string): string => `'${value.replace(/['\u2018-\u201B]/gu, "$&$&")}'`;

/** Manual instructions name the shell explicitly. WSL launch paths belong inside the distro,
 * while a native Windows launch is copied into PowerShell on the Machine. */
export function manualCodexUpdateCommand(
  binary: ResolvedBinary,
  context: AgentContext,
  platform: NodeJS.Platform = process.platform,
): { command: string; shell: string } | null {
  const words = [binary.launch.command, ...binary.launch.args, "update"];
  if (context.kind === "wsl") return {
    command: words.map(posixWord).join(" "),
    shell: `a POSIX shell inside WSL: ${context.distro}`,
  };
  // A batch wrapper adds cmd.exe and the wrapper's own parsing after PowerShell. Neither
  // embedded quotes nor percent signs can be promised intact for an arbitrary wrapper.
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(binary.launch.command)) return null;
  if (platform === "win32") return {
    command: `& ${words.map(powerShellWord).join(" ")}`,
    shell: "PowerShell 7.3 or later on this Machine",
  };
  return { command: words.map(posixWord).join(" "), shell: "a POSIX shell on this Machine" };
}

/** Only the discovered launch is probed. A same-name CLI later on PATH cannot establish support
 * for this installation's built-in updater. Help output is deliberately discarded. */
export async function codexOffersSelfUpdate(
  binary: ResolvedBinary,
  context: AgentContext,
  execute: typeof run = run,
): Promise<boolean> {
  const command = context.kind === "wsl" ? "wsl.exe" : binary.launch.command;
  const args = context.kind === "wsl"
    ? ["-d", context.distro, "--exec", binary.launch.command, ...binary.launch.args, "--help"]
    : [...binary.launch.args, "--help"];
  const result = await execute(command, args, { timeoutMs: context.kind === "wsl" ? 8000 : 3000 });
  return result.code === 0 && !result.timedOut &&
    /^\s*update\s+Update Codex to the latest version\b/im.test(`${result.stdout}\n${result.stderr}`);
}

function originalManagerGuidance(
  packageName: string | null,
  codexSelfUpdate: boolean,
  binary?: ResolvedBinary,
  context?: AgentContext,
): string {
  if (codexSelfUpdate && binary && context) {
    const manual = manualCodexUpdateCommand(binary, context);
    if (!manual) return `This installation advertises its built-in \`codex update\` command, but its selected launch is a Windows batch wrapper. PowerShell passes batch arguments through cmd.exe, which can change quotes or expand percent signs. No copyable update command is available for this wrapper; use the package or version manager that installed this exact copy after stopping sessions using it. A bare \`codex\` on PATH may be another installation. Restart and Rediscover before treating the new version as ready.`;
    return `This installation advertises its built-in \`codex update\` command. Run \`${manual.command}\` in ${manual.shell} after stopping sessions using this executable. A bare \`codex\` on PATH may be another installation. Restart and Rediscover before treating the new version as ready.`;
  }
  if (packageName) return `This launch target is inside the ${packageName} package tree. Use the package or version manager that installed this exact copy in the same execution context. ${REDISCOVER}`;
  return "Use this installation's original package or version manager. If its manager is unknown, inspect this installation in Machine settings before upgrading. " + REDISCOVER;
}

/** A PATH hit alone does not prove which package manager owns the executable. Only a launch
 * resolving inside the expected npm package is eligible for the registry comparison. */
export function npmPackageForInstallation(harness: Harness, binary: ResolvedBinary): string | null {
  const packageName = PACKAGES[harness];
  // Only the executable actually launched (or its Node entry script) can establish ownership.
  // The discovered path may be an alias, or another CLI argument may mention an npm package.
  const target = /(?:^|[\\/])node(?:\.exe)?$/i.test(binary.launch.command)
    ? binary.launch.args[0] : binary.launch.command;
  if (!target) return null;
  const paths = [target];
  try { paths.push(realpathSync(target)); } catch { /* WSL paths are not host paths. */ }
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
  managerGuidance = originalManagerGuidance(packageName, false),
): HarnessUpdateAssessment {
  const preview = !!installedVersion && /-/.test(installedVersion);
  const base = {
    installedVersion,
    latestKnownCompatibleVersion: installedCompatible ? installedVersion : undefined,
    checkedAt,
    channel: preview ? "preview" as const : "stable" as const,
    evidenceSource: `npm dist-tags for ${packageName}`,
    managedExternally: true as const,
    guidance: `${managerGuidance} Published releases are not automatically known compatible with this Machine.`,
  };
  const checkFailure = "The release check could not complete, so no current release status was established. The Machine may be offline, behind a proxy, or rate limited. After resolving the problem, have an organization owner or admin rediscover this installation in Connections. Select Rediscover for a native Machine, or Reconnect for an SSH Machine after active sessions finish.";
  if (result.code !== 0 || result.timedOut) return { ...base, status: "check_failed", guidance: checkFailure };
  let tags: Record<string, unknown>;
  try { tags = JSON.parse(result.stdout) as Record<string, unknown>; }
  catch { return { ...base, status: "check_failed", guidance: checkFailure }; }
  const latest = tags[preview && typeof tags.next === "string" ? "next" : "latest"];
  if (typeof latest !== "string" || !versionTuple(latest)) return { ...base, status: "check_failed", guidance: checkFailure };
  if (!installedVersion || !versionTuple(installedVersion)) {
    return { ...base, status: "version_unknown", latestPublishedVersion: latest };
  }
  if (preview) return { ...base, status: "preview_channel", latestPublishedVersion: latest,
    guidance: `This installation is on a preview channel. Verify its release policy with the original manager before changing channels. ${managerGuidance}` };
  const installed = versionTuple(installedVersion)!;
  const published = versionTuple(latest)!;
  const newer = published[0] > installed[0] ||
    (published[0] === installed[0] && published[1] > installed[1]) ||
    (published[0] === installed[0] && published[1] === installed[1] && published[2] > installed[2]);
  return { ...base, status: newer ? "update_available" : "up_to_date", latestPublishedVersion: latest,
    guidance: newer
      ? `A newer release is published, but compatibility with this Machine has not been verified. ${managerGuidance}`
      : managerGuidance };
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
  const packageName = npmPackageForInstallation(harness, binary);
  if (harnessVersionPinned(harness, process.env.WOLLIPOG_HARNESS_UPDATE_PINNED)) return {
    status: "managed_externally",
    installedVersion,
    latestKnownCompatibleVersion: installedCompatible ? installedVersion : undefined,
    checkedAt,
    channel: installedVersion?.includes("-") ? "preview" : installedVersion ? "stable" : "unknown",
    evidenceSource: "Machine pinned-version policy",
    managedExternally: true,
    guidance: "This harness installation is pinned by Machine policy. Release checks are suppressed, so no current release status was established. Ask the Machine operator to change the pin before planning an upgrade. " + REDISCOVER,
  };
  if (process.env.WOLLIPOG_HARNESS_UPDATE_CHECKS === "off") return {
    status: !installedVersion ? "version_unknown" : "managed_externally",
    installedVersion,
    latestKnownCompatibleVersion: installedCompatible ? installedVersion : undefined,
    checkedAt,
    channel: installedVersion?.includes("-") ? "preview" : installedVersion ? "stable" : "unknown",
    evidenceSource: "Machine update-check policy",
    managedExternally: true,
    guidance: "Release checks are disabled by this Machine's policy, so no current release status was established. Ask the Machine operator whether manual upgrades are permitted. " + REDISCOVER,
  };
  const selfUpdate = harness === "codex" && await codexOffersSelfUpdate(binary, context);
  const managerGuidance = originalManagerGuidance(packageName, selfUpdate, binary, context);
  if (!packageName) return {
    status: !installedVersion ? "version_unknown" : installedVersion.includes("-")
      ? "preview_channel" : "managed_externally",
    installedVersion,
    latestKnownCompatibleVersion: installedCompatible ? installedVersion : undefined,
    checkedAt,
    channel: installedVersion?.includes("-") ? "preview" : installedVersion ? "stable" : "unknown",
    evidenceSource: "Executable installation provenance",
    managedExternally: true,
    guidance: managerGuidance,
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
    evidenceSource: `Package tree for ${packageName}; exact npm runtime unavailable`,
    managedExternally: true,
    guidance: managerGuidance,
  };
  return classifyNpmHarnessUpdate(installedVersion, result, packageName, checkedAt, installedCompatible, managerGuidance);
}
