import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";

const ASSET = "wollipog/claude-provider-pipe";
const NAME = "provider-pipe";

export interface ClaudeProviderPipeHelper {
  path: string;
  verify(): void;
}

let staged: (ClaudeProviderPipeHelper & { directory: string }) | undefined;

/** Materialize the fixed Linux worker once, and attest it before every sandbox launch. */
export function claudeProviderPipeHelper(dataDir?: string): ClaudeProviderPipeHelper {
  if (process.platform !== "linux") throw new Error("Claude provider pipe worker requires Linux");
  if (staged) { staged.verify(); return staged; }
  staged = stageClaudeProviderPipeHelper([...new Set([tmpdir(), ...(dataDir ? [dataDir] : [])])]);
  return staged;
}

/** Try each runner-owned root until the fixed worker actually executes there. */
export function stageClaudeProviderPipeHelper(
  roots: string[],
  acceptExecutableForTest: (path: string) => boolean = () => true,
): ClaudeProviderPipeHelper & { directory: string } {
  let lastError: unknown;
  for (const root of roots) {
    let directory: string | undefined;
    try {
      directory = mkdtempSync(join(root, "wollipog-claude-pipe-"));
      const helper = stageInDirectory(directory);
      // Tests may reject a working first root to exercise the fallback. They cannot
      // accept an unexecutable worker: stageInDirectory always performs the real probe.
      if (!acceptExecutableForTest(helper.path)) throw new Error("fixed Claude provider pipe worker root rejected");
      const stagedDirectory = directory;
      process.once("exit", () => rmSync(stagedDirectory, { recursive: true, force: true }));
      return helper;
    } catch (error) {
      lastError = error;
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }
  throw new Error("fixed Claude provider pipe worker cannot execute from the temporary or runner data directory", { cause: lastError });
}

function stageInDirectory(directory: string): ClaudeProviderPipeHelper & { directory: string } {
  const path = join(directory, NAME);
  chmodSync(directory, 0o700);
  if (isSea()) {
    const asset = new Uint8Array(getAsset(ASSET));
    writeFileSync(path, asset, { flag: "wx", mode: 0o700 });
  } else {
    const source = fileURLToPath(new URL("../native/claude-provider-pipe.c", import.meta.url ?? pathToFileURL(__filename).href));
    const built = spawnSync("/usr/bin/cc", [
      "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static", source, "-o", path,
    ], { timeout: 30_000, encoding: "utf8", maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin" } });
    if (built.error || built.status !== 0) throw new Error(
      `fixed Claude provider pipe worker could not be compiled: ${(built.error?.message ?? built.stderr ?? "").slice(0, 512)}`,
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
      throw new Error("fixed Claude provider pipe worker changed after staging");
    }
  };
  verify();
  // argc < 2 is an intentional, side-effect-free refusal. This proves the
  // staged file is executable before it is mounted into a protected namespace.
  const probe = spawnSync(path, [], { timeout: 5_000, maxBuffer: 1024, env: {} });
  if (probe.error || probe.status !== 125) throw new Error("fixed Claude provider pipe worker probe failed");
  verify();
  return { directory, path, verify };
}
