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
let developmentHelper: string | null = null;
let packagedHelper: string | null = null;

/** Moves `fromName` in `fromParent` to `toName` in `toParent`, or throws with nothing moved when the
 * destination exists or the kernel or filesystem cannot refuse to replace it. */
export type NoReplaceRename = (fromParent: number, fromName: string, toParent: number, toName: string) => void;

/** Resolve the fixed helper. Shipped SEA runners extract the build-time static binary; source
 * checkouts compile the same checked-in C file into a private process-owned directory. */
export function resolveLinuxSkillRenameHelper(platform = process.platform): string {
  if (platform !== "linux") throw new Error("the Linux skill rename helper requires Linux");
  if (!isSea()) {
    if (developmentHelper && existsSync(developmentHelper)) return developmentHelper;
    developmentHelper = null;
    const source = fileURLToPath(new URL("../native/linux-skill-rename.c", import.meta.url));
    const root = mkdtempSync(join(tmpdir(), "wollipog-linux-skill-rename-"));
    chmodSync(root, 0o700);
    const target = join(root, "rename-helper");
    const compiled = spawnSync("/usr/bin/cc", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", target],
      { encoding: "utf8", timeout: 30_000 });
    if (compiled.error || compiled.status !== 0) {
      rmSync(root, { recursive: true, force: true });
      throw new Error("the fixed Linux skill rename helper could not be compiled");
    }
    chmodSync(target, 0o700);
    developmentHelper = target;
    return target;
  }
  if (packagedHelper && existsSync(packagedHelper)) return packagedHelper;
  packagedHelper = null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getAsset(LINUX_RENAME_ASSET));
  } catch (cause) {
    throw new Error("the packaged Linux skill rename helper is missing", { cause });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const root = mkdtempSync(join(tmpdir(), "wollipog-linux-skill-rename-"));
  chmodSync(root, 0o700);
  const target = join(root, "rename-helper");
  writeFileSync(target, bytes, { flag: "wx", mode: 0o700 });
  if (createHash("sha256").update(readFileSync(target)).digest("hex") !== digest) {
    throw new Error("the extracted Linux skill rename helper failed integrity verification");
  }
  chmodSync(target, 0o700);
  packagedHelper = target;
  return packagedHelper;
}

/** Resolves the helper up front, so a runner that cannot refuse to replace fails before any journal
 * or source is touched. */
export function linuxNoReplaceRename(helper = resolveLinuxSkillRenameHelper()): NoReplaceRename {
  return (fromParent, fromName, toParent, toName) => {
    const result = spawnSync(helper, [fromName, toName], { env: {}, timeout: 30_000,
      stdio: ["ignore", "ignore", "ignore", fromParent, toParent] });
    if (result.error || result.status !== 0) throw new Error("the no-replace rename did not complete");
  };
}
