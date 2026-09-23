import type { AgentContext, RunnerView } from "@wollipog/protocol";

type MachineOs = RunnerView["os"];

export type HarnessLaunchGuidance =
  | { command: string; shell: string; batchWrapper: false }
  | { command: null; shell: null; batchWrapper: true };

const posixWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const powerShellWord = (value: string): string => `'${value.replace(/['\u2018-\u201B]/gu, "$&$&")}'`;

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
      batchWrapper: false,
    };
  }
  if (os === "windows") {
    // PowerShell routes batch files through cmd.exe, where % expansion and wrapper-specific
    // parsing can change argv. Keep the exact target visible as data, never as a copyable command.
    if (/\.(?:cmd|bat)$/i.test(command)) return { command: null, shell: null, batchWrapper: true };
    return {
      command: `& ${[command, ...args].map(powerShellWord).join(" ")}`,
      shell: "PowerShell 7.3 or later on this Machine",
      batchWrapper: false,
    };
  }
  return {
    command: [command, ...args].map(posixWord).join(" "),
    shell: "a POSIX shell on this Machine",
    batchWrapper: false,
  };
}
