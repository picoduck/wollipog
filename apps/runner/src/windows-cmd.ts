export interface WindowsCommandHost {
  platform: NodeJS.Platform;
  comspec?: string;
}

export interface WindowsCommandSpec {
  file: string;
  args: string[];
  argv0?: string;
  windowsVerbatimArguments?: boolean;
}

/** Quote one argv token for a `cmd.exe /s /c` tail that ultimately invokes a Windows process.
 *
 * Batch shims add a second parsing boundary before the target executable receives its argv. The
 * doubled quotes preserve literal quotes through cmd, while doubling a run of backslashes before
 * either an embedded or closing quote preserves that run through the target's Windows argv parser.
 */
export function quoteWindowsCmdToken(value: string, force = false): string {
  if (/[\r\n]/.test(value)) throw new Error("Windows command arguments cannot contain CR/LF");
  if (value.includes("%")) throw new Error("Windows command arguments cannot contain %, which cmd.exe would expand");
  if (value === "") return '""';
  if (!force && !/[ \t",;&|<>^()!=]/.test(value)) return value;
  const body = value
    .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}""`)
    .replace(/\\+$/, (slashes) => `${slashes}${slashes}`);
  return `"${body}"`;
}

/** Build a forced cmd.exe invocation for a caller, such as ConPTY, that needs cmd lookup. */
export function windowsCmdInvocationSpec(
  file: string,
  args: string[],
  host: WindowsCommandHost = { platform: process.platform, comspec: process.env.ComSpec },
): WindowsCommandSpec {
  if (host.platform !== "win32") return { file, args };
  const commandLine = [quoteWindowsCmdToken(file), ...args.map((arg) => quoteWindowsCmdToken(arg))].join(" ");
  const comspec = host.comspec || "cmd.exe";
  return {
    file: comspec,
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    argv0: quoteWindowsCmdToken(comspec),
    windowsVerbatimArguments: true,
  };
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
  return windowsCmdInvocationSpec(file, args, host);
}
