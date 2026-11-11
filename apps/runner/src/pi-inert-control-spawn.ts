/** Node-spawn-shaped adapter used only by the dormant generated-extension experiment.
 * It owns one prebuilt launcher. Calls cannot choose another executable, policy or environment. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { createPiInertControlLauncher } from "./pi-inert-control-launcher.js";

export function piInertControlSpawnAdapter(launcher: ReturnType<typeof createPiInertControlLauncher>, captured: {
  command: string; args: readonly string[]; environment: Readonly<Record<string, string>>;
}) {
  const command = captured.command, args = [...captured.args], environment = { ...captured.environment };
  const keys = Object.keys(environment).sort();
  return Object.freeze({ spawn(file: string, argv: readonly string[], options: {
    env: NodeJS.ProcessEnv; stdio: readonly string[]; windowsHide: boolean;
  }) {
    if (file !== command || !Array.isArray(argv) || argv.length !== args.length || argv.some((arg, i) => arg !== args[i]) ||
        !options || Object.keys(options).sort().join(",") !== "env,stdio,windowsHide" || options.windowsHide !== true ||
        options.stdio?.join(",") !== "pipe,pipe,pipe" || !options.env ||
        Object.keys(options.env).sort().join("\0") !== keys.join("\0") || keys.some(key => options.env[key] !== environment[key])) {
      throw new Error("Pi inert control child selection refused.");
    }
    const controller = new AbortController();
    let finished = false;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { if (finished) return false; child.killed = true; controller.abort(); return true; },
    });
    const close = (code: number | null) => {
      finished = true;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      child.emit("close", code);
    };
    // Pi installs its listeners synchronously after spawn returns. No env/command is copied into
    // a generated script or diagnostic; this adapter only forwards its private RPC streams.
    queueMicrotask(() => {
      void launcher.run(child.stdin, child.stdout, child.stderr, { signal: controller.signal }).then(
        result => close(result.exitCode),
        () => { child.emit("error", new Error("Pi inert control child failed.")); close(null); },
      );
    });
    return child;
  } });
}
