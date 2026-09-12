import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command with captured output; never throws (spawn errors become `code: null`). */
export function execCapture(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolvePromise({ code: null, stdout: "", stderr: (error as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : null;
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { if (timer) clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}
