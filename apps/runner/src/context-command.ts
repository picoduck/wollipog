import { execFile } from "node:child_process";
import type { AgentContext } from "@wollipog/protocol";
import { windowsCommandSpec } from "./windows-cmd.js";

export interface ContextCommandOptions {
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface ContextCommandResult {
  stdout: string;
  stderr: string;
}

export function contextCommandSpec(
  context: AgentContext,
  command: string,
  args: string[],
  options: Pick<ContextCommandOptions, "cwd" | "env">,
): { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean } {
  if (context.kind === "wsl") {
    const values = options.env ?? {};
    const existing = (process.env.WSLENV ?? "").split(":").filter(Boolean);
    const known = new Set(existing.map((entry) => entry.split("/")[0]?.toLowerCase()));
    const additions = Object.keys(values).filter((name) => !known.has(name.toLowerCase()));
    return {
      file: "wsl.exe",
      args: [
        "-d", context.distro, "--cd", options.cwd, "--exec",
        command, ...args,
      ],
      env: Object.keys(values).length > 0
        ? { ...process.env, ...values, WSLENV: [...existing, ...additions].join(":") }
        : undefined,
    };
  }
  const spec = windowsCommandSpec(command, args);
  return {
    file: spec.file,
    args: spec.args,
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}

/** Run a command in the filesystem/process namespace named by an agent context. */
export function runContextCommand(
  context: AgentContext,
  command: string,
  args: string[],
  options: ContextCommandOptions,
): Promise<ContextCommandResult> {
  const timeout = options.timeoutMs ?? 30_000;
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let spec;
    try {
      spec = contextCommandSpec(context, command, args, options);
    } catch (error) {
      reject(error);
      return;
    }
    const child = execFile(
      spec.file,
      spec.args,
      {
        cwd: spec.cwd,
        env: spec.env,
        timeout,
        killSignal: "SIGKILL",
        maxBuffer,
        windowsHide: true,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          if (context.kind === "wsl") {
            const normalize = (value: string) => value.includes("\0")
              ? Buffer.from(value, "latin1").toString("utf16le").trim()
              : value.trim();
            const detail = normalize(stderr) || normalize(stdout);
            const wrapped = new Error(
              `${command} failed in WSL distro ${context.distro}${detail ? `: ${detail}` : ""}`,
            );
            reject(Object.assign(wrapped, { cause: error, stdout, stderr, code: (error as NodeJS.ErrnoException).code }));
          } else {
            reject(Object.assign(error, { stdout, stderr }));
          }
        }
        else resolve({ stdout, stderr });
      },
    );
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin ?? "");
    }
  });
}
