import type { AgentContext, RunnerView } from "@wollipog/protocol";

type MachineOs = RunnerView["os"];

const posixWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const powerShellWord = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** A displayed command is for the named interactive shell, never a serialized spawn argv. */
export function formatHarnessLaunchCommand(
  command: string,
  args: readonly string[],
  context: AgentContext | undefined,
  os: MachineOs,
): { command: string; shell: string } {
  if (context?.kind === "wsl") {
    return {
      command: [command, ...args].map(posixWord).join(" "),
      shell: `POSIX shell inside WSL: ${context.distro}`,
    };
  }
  if (os === "windows") {
    return {
      command: `& ${[command, ...args].map(powerShellWord).join(" ")}`,
      shell: "PowerShell on this Machine",
    };
  }
  return {
    command: [command, ...args].map(posixWord).join(" "),
    shell: "POSIX shell on this Machine",
  };
}
