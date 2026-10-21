import childProcess, { type SpawnSyncOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { withDefaultTimeout } from "@wollipog/test-support/bounded-child-process";

/** Test fixture for replacing only delegation evidence. Every real synchronous forward uses
 * the shared timeout and non-ignorable kill defaults; tests never receive the raw process API. */
export function installDelegationProbeFixture(
  intercept: (command: string, args: readonly string[], options: SpawnSyncOptions | undefined) => unknown,
): () => void {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = ((command: string, argsOrOptions?: readonly string[] | SpawnSyncOptions, options?: SpawnSyncOptions) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const supplied = Array.isArray(argsOrOptions) ? options : argsOrOptions as SpawnSyncOptions | undefined;
    const intercepted = intercept(command, args, supplied);
    return intercepted === undefined ? original(command, args, withDefaultTimeout(supplied)) : intercepted;
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  return () => { childProcess.spawnSync = original; syncBuiltinESMExports(); };
}
