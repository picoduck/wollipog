import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";

const ASSET = "wollipog/landlock-special-files";
const NAME = "landlock-special-files";
/** Where buildBwrapArgs mounts the helper inside the sandbox. */
export const LANDLOCK_SPECIAL_FILES_TARGET = "/tmp/wollipog-landlock-special-files";

export interface LandlockSpecialFilesHelper {
  path: string;
  verify(): void;
}

let staged: { helper: LandlockSpecialFilesHelper | null; reason?: string } | undefined;
let override: (() => LandlockSpecialFilesHelper | null) | undefined;

/**
 * The fixed helper that keeps symlinks, FIFOs, sockets and device nodes out of the relocated
 * packed-refs directory (#3316), or null when this host cannot enforce that. Null is the fail-closed
 * answer: the caller then neither relocates packed-refs nor binds the directory. The result is
 * staged and probed once; a staged helper is re-attested on every call.
 */
export function landlockSpecialFilesHelper(dataDir?: string): LandlockSpecialFilesHelper | null {
  if (override) return override();
  if (process.platform !== "linux") return null;
  if (staged) {
    staged.helper?.verify();
    return staged.helper;
  }
  try {
    staged = { helper: stageLandlockSpecialFilesHelper([...new Set([tmpdir(), ...(dataDir ? [dataDir] : [])])]) };
  } catch (error) {
    staged = { helper: null, reason: (error as Error).message };
  }
  return staged.helper;
}

/** Why the helper is unavailable, for one launch warning. */
export function landlockSpecialFilesUnavailableReason(): string | undefined {
  return staged?.helper ? undefined : staged?.reason ?? "Landlock enforcement is unavailable on this host";
}

/** Test-only: replace the staged helper. Pass no argument to restore staging. */
export function setLandlockSpecialFilesHelperForTests(helper?: () => LandlockSpecialFilesHelper | null): void {
  override = helper;
  staged = undefined;
}

/** Try each runner-owned root until the helper executes there and proves Landlock enforcement. */
export function stageLandlockSpecialFilesHelper(roots: string[]): LandlockSpecialFilesHelper & { directory: string } {
  let lastError: unknown;
  for (const root of roots) {
    let directory: string | undefined;
    try {
      directory = mkdtempSync(join(root, "wollipog-landlock-"));
      const helper = stageInDirectory(directory);
      const stagedDirectory = directory;
      process.once("exit", () => rmSync(stagedDirectory, { recursive: true, force: true }));
      return helper;
    } catch (error) {
      lastError = error;
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }
  throw new Error("Landlock special-file helper cannot prove enforcement from the temporary or runner data directory", { cause: lastError });
}

function stageInDirectory(directory: string): LandlockSpecialFilesHelper & { directory: string } {
  const path = join(directory, NAME);
  chmodSync(directory, 0o700);
  if (isSea()) {
    writeFileSync(path, new Uint8Array(getAsset(ASSET)), { flag: "wx", mode: 0o700 });
  } else {
    const source = fileURLToPath(new URL("../native/landlock-special-files.c", import.meta.url ?? pathToFileURL(__filename).href));
    const built = spawnSync("/usr/bin/cc", [
      "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static", source, "-o", path,
    ], { timeout: 30_000, encoding: "utf8", maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin" } });
    if (built.error || built.status !== 0) throw new Error(
      `Landlock special-file helper could not be compiled: ${(built.error?.message ?? built.stderr ?? "").slice(0, 512)}`,
    );
    chmodSync(path, 0o700);
  }
  const initialParent = lstatSync(directory);
  const initial = lstatSync(path);
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  const verify = () => {
    const parent = lstatSync(directory);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 ||
        parent.dev !== initialParent.dev || parent.ino !== initialParent.ino ||
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        (current.mode & 0o777) !== 0o700 || current.dev !== initial.dev || current.ino !== initial.ino ||
        current.size !== initial.size ||
        (uid != null && (parent.uid !== uid || current.uid !== uid)) ||
        createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) {
      throw new Error("Landlock special-file helper changed after staging");
    }
  };
  verify();
  // The probe restricts a child with no allowed roots and requires its symlink in an empty
  // directory to be refused, so availability means enforcement on this kernel, not just an ABI.
  const probeDirectory = join(directory, "probe");
  mkdirSync(probeDirectory, { mode: 0o700 });
  const probe = spawnSync(path, ["--probe", probeDirectory], { timeout: 5_000, maxBuffer: 4096, encoding: "utf8", env: {} });
  rmSync(probeDirectory, { recursive: true, force: true });
  if (probe.error || probe.status !== 0) {
    throw new Error(`Landlock special-file helper probe failed: ${(probe.error?.message ?? probe.stderr ?? "").trim().slice(0, 256)}`);
  }
  verify();
  return { directory, path, verify };
}
