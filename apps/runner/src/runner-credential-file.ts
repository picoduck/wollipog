/** Protected runner credential rotation. */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scopedRunnerCredentialFile, type RunnerDataDirIdentity } from "./runner-data-dir.js";
export { deriveControlPlaneHttpUrl as deriveCpHttpUrl } from "./control-plane-transport.js";

export interface StagedRunnerCredentialFile {
  activePath: string;
  promote(): string;
  discard(): void;
}

/** Stage a replacement beside the protected active credential without changing what runner
 * consumers read. The WebSocket `registered` acknowledgement is the cutover boundary: only then
 * does promote atomically replace the active file. Rejection/disconnect can leave the old active
 * credential untouched. */
export function stageRunnerCredentialFile(
  dataDir: string,
  token: string,
  identity?: RunnerDataDirIdentity,
): StagedRunnerCredentialFile {
  const activePath = identity
    ? scopedRunnerCredentialFile(dataDir, identity)
    : join(dataDir, "credentials", "active-runner-token");
  const dir = dirname(activePath);
  const stagedPath = join(dir, `.pending-runner-token-${process.pid}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stagedPath, token, { mode: 0o600, flag: "wx" });
  try { chmodSync(stagedPath, 0o600); } catch { /* Windows ACLs are managed by the owning account */ }
  let staged = true;
  return {
    activePath,
    promote() {
      if (!staged) return activePath;
      renameSync(stagedPath, activePath);
      try { chmodSync(activePath, 0o600); } catch { /* Windows ACLs are managed by the owning account */ }
      staged = false;
      return activePath;
    },
    discard() {
      if (!staged) return;
      rmSync(stagedPath, { force: true });
      staged = false;
    },
  };
}

/** One protected runner-local source for the active runner credential. Per-session MCP configs
 * reference this path and therefore never duplicate plaintext secrets. Direct callers opt into an
 * immediate cutover; the runner daemon uses stageRunnerCredentialFile and waits for registration. */
export function writeRunnerCredentialFile(dataDir: string, token: string): string {
  return stageRunnerCredentialFile(dataDir, token).promote();
}
