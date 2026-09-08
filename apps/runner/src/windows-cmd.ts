export interface WindowsCommandHost {
  platform: NodeJS.Platform;
  comspec?: string;
}

export interface WindowsCommandSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

function quoteCmdToken(value: string, command = false): string {
  if (/[\r\n]/.test(value)) throw new Error("Windows command arguments cannot contain CR/LF");
  if (value.includes("%")) throw new Error("Windows command arguments cannot contain %, which cmd.exe would expand");
  if (value === "") return '""';
  if (!/[ \t"&|<>^()!]/.test(value)) return value;
  return `"${value.replace(command ? /["^]/g : /["&|<>^()]/g, "^$&")}"`;
}

/**
 * Build an injection-resistant execFile/spawn spec for Windows batch shims. Node cannot execute
 * .cmd/.bat files directly, while shell:true concatenates unescaped argv. Route only those shims
 * through an explicit cmd.exe /c tail and reject the two expansions that remain active in quotes.
 */
export function windowsCommandSpec(
  file: string,
  args: string[],
  host: WindowsCommandHost = { platform: process.platform, comspec: process.env.ComSpec },
): WindowsCommandSpec {
  if (host.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(file)) return { file, args };
  const commandLine = [quoteCmdToken(file, true), ...args.map((arg) => quoteCmdToken(arg))].join(" ");
  return {
    file: host.comspec || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
