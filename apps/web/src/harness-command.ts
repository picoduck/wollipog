import type { AgentContext, RunnerView } from "@wollipog/protocol";

type MachineOs = RunnerView["os"];

export type HarnessLaunchGuidance =
  | { command: string; shell: string; referenceOnly: false }
  | { command: null; shell: null; referenceOnly: true };

const posixWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const powerShellWord = (value: string): string => `'${value.replace(/['\u2018-\u201B]/gu, "$&$&")}'`;
const nativeWindowsCommand = (command: string): boolean =>
  /(?:^|[\\/])[^\\/]+\.(?:exe|com)$/i.test(command) &&
  // PowerShell's Windows mode uses legacy argv passing for these executable names.
  !/(?:^|[\\/])(?:cmd|cscript|wscript|find|sqlcmd)\.exe$/i.test(command);

/** A displayed command is for the named interactive shell, never a serialized spawn argv. */
export function formatHarnessLaunchCommand(
  command: string,
  args: readonly string[],
  context: AgentContext | undefined,
  os: MachineOs,
): HarnessLaunchGuidance {
  if (context?.kind === "wsl") {
    return {
      command: [command, ...args].map(posixWord).join(" "),
      shell: `a POSIX shell inside WSL: ${context.distro}`,
      referenceOnly: false,
    };
  }
  if (os === "windows") {
    // Extensionless and dotted names may resolve through PATHEXT to batch wrappers.
    if (!nativeWindowsCommand(command)) {
      return { command: null, shell: null, referenceOnly: true };
    }
    return {
      command: `& ${[command, ...args].map(powerShellWord).join(" ")}`,
      shell: "PowerShell 7.3 or later on this Machine",
      referenceOnly: false,
    };
  }
  return {
    command: [command, ...args].map(posixWord).join(" "),
    shell: "a POSIX shell on this Machine",
    referenceOnly: false,
  };
}
