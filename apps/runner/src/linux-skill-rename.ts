/** Linux no-replace rename for guarded skill adoption. Node's renameSync silently replaces an empty
 * directory at its destination, so moves into a recovery journal go through a fixed native helper
 * that makes one renameat2(RENAME_NOREPLACE) call on the two directories the runner already holds. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";

const LINUX_RENAME_ASSET = "wollipog/linux-skill-rename";
/** The helper's exit status for a usage error, which proves that a staged copy can execute. */
const USAGE_STATUS = 2;
let stagedHelper: string | null = null;

/** Moves `fromName` in `fromParent` to `toName` in `toParent`, or throws with nothing moved when the
 * destination exists or the kernel or filesystem cannot refuse to replace it. */
export type NoReplaceRename = (fromParent: number, fromName: string, toParent: number, toName: string) => void;

/** Resolve the fixed helper. Shipped SEA runners extract the build-time static binary; source
 * checkouts compile the same checked-in C file. The copy is staged in a private process-owned
 * directory under the temporary directory or, when that cannot run it (a `noexec` mount), under the
 * runner's data directory, and is used only once a probe proves it executes there. */
export function resolveLinuxSkillRenameHelper(dataDir: string, platform = process.platform): string {
  if (platform !== "linux") throw new Error("the Linux skill rename helper requires Linux");
  if (stagedHelper && existsSync(stagedHelper)) return stagedHelper;
  stagedHelper = stageLinuxSkillRenameHelper([tmpdir(), dataDir], isSea() ? packagedWriter() : compileHelper);
  return stagedHelper;
}

/** Stage the helper under the first root where it can run. Exported for tests. */
export function stageLinuxSkillRenameHelper(roots: string[], write: (target: string) => void): string {
  for (const root of roots) {
    let directory: string | undefined;
    try {
      directory = mkdtempSync(join(root, "wollipog-linux-skill-rename-"));
      chmodSync(directory, 0o700);
      const target = join(directory, "rename-helper");
      write(target);
      chmodSync(target, 0o700);
      // A `noexec` mount accepts the file but refuses to run it.
      if (spawnSync(target, [], { env: {}, stdio: "ignore", timeout: 10_000 }).status === USAGE_STATUS) {
        const staged = directory;
        process.once("exit", () => rmSync(staged, { recursive: true, force: true }));
        return target;
      }
    } catch { /* try the next root */ }
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  throw new Error("the fixed Linux skill rename helper cannot run from the temporary or data directory");
}

function compileHelper(target: string): void {
  const source = fileURLToPath(new URL("../native/linux-skill-rename.c", import.meta.url));
  const compiled = spawnSync("/usr/bin/cc", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", target],
    { encoding: "utf8", timeout: 30_000 });
  if (compiled.error || compiled.status !== 0) throw new Error("the fixed Linux skill rename helper could not be compiled");
}

function packagedWriter(): (target: string) => void {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getAsset(LINUX_RENAME_ASSET));
  } catch (cause) {
    throw new Error("the packaged Linux skill rename helper is missing", { cause });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  return (target) => {
    writeFileSync(target, bytes, { flag: "wx", mode: 0o700 });
    if (createHash("sha256").update(readFileSync(target)).digest("hex") !== digest) {
      throw new Error("the extracted Linux skill rename helper failed integrity verification");
    }
  };
}

/** Resolves the helper up front, so a runner that cannot refuse to replace fails before any journal
 * or source is touched. */
export function linuxNoReplaceRename(dataDir: string): NoReplaceRename {
  const helper = resolveLinuxSkillRenameHelper(dataDir);
  return (fromParent, fromName, toParent, toName) => {
    const result = spawnSync(helper, [fromName, toName], { env: {}, timeout: 30_000,
      stdio: ["ignore", "ignore", "ignore", fromParent, toParent] });
    if (result.error || result.status !== 0) throw new Error("the no-replace rename did not complete");
  };
}
