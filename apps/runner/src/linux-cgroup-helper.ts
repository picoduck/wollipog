import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";

let staged: { path: string; verify(): void } | undefined;

/** Fixed join-before-exec worker. A shipped runner uses the exact build-time static binary. */
export function linuxCgroupHelper(dataDirectory?: string): string {
  if (staged) {
    try { staged.verify(); return staged.path; }
    catch (error) {
      // A temporary-file cleaner may remove a perfectly valid copy. Restage the fixed asset in
      // a new private directory; a changed or substituted existing copy still fails closed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      staged = undefined;
    }
  }
  staged = stageLinuxCgroupHelper([...new Set([tmpdir(), ...(dataDirectory ? [dataDirectory] : [])])]);
  return staged.path;
}

/** The test callback may reject a working root, but cannot accept an unexecutable helper. */
export function stageLinuxCgroupHelper(roots: string[], acceptRootForTest: (path: string) => boolean = () => true): {
  path: string; verify(): void;
} {
  let cause: unknown;
  for (const root of roots) {
    let directory: string | undefined;
    try {
      directory = mkdtempSync(join(root, "wollipog-cgroup-launch-"));
      const helper = stageInDirectory(directory);
      if (!acceptRootForTest(helper.path)) throw new Error("cgroup helper root rejected");
      const retained = directory;
      process.once("exit", () => rmSync(retained, { recursive: true, force: true }));
      return helper;
    } catch (error) {
      cause = error;
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }
  throw new Error("cgroup launch worker cannot execute in temporary or runner data directory", { cause });
}

function stageInDirectory(directory: string): { path: string; verify(): void } {
  const path = join(directory, "launch");
  try {
    chmodSync(directory, 0o700);
    if (isSea()) {
      writeFileSync(path, new Uint8Array(getAsset("wollipog/linux-cgroup-launch")), { flag: "wx", mode: 0o700 });
    } else {
      const source = fileURLToPath(new URL("../native/linux-cgroup-launch.c", import.meta.url ?? pathToFileURL(__filename).href));
      const built = spawnSync("/usr/bin/cc", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static", source, "-o", path],
        { timeout: 30_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin" } });
      if (built.error || built.status !== 0) throw new Error("cgroup launch worker could not be compiled");
      chmodSync(path, 0o700);
    }
    const parent = lstatSync(directory);
    const initial = lstatSync(path);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    const verify = () => {
      const nowParent = lstatSync(directory);
      const now = lstatSync(path);
      const uid = process.getuid?.();
      if (!nowParent.isDirectory() || nowParent.isSymbolicLink() || (nowParent.mode & 0o777) !== 0o700 ||
          nowParent.dev !== parent.dev || nowParent.ino !== parent.ino ||
          !now.isFile() || now.isSymbolicLink() || now.nlink !== 1 || (now.mode & 0o777) !== 0o700 ||
          now.dev !== initial.dev || now.ino !== initial.ino || now.size !== initial.size ||
          (uid !== undefined && (now.uid !== uid || nowParent.uid !== uid)) ||
          createHash("sha256").update(readFileSync(path)).digest("hex") !== digest) {
        throw new Error("cgroup launch worker changed after staging");
      }
    };
    verify();
    const probe = spawnSync(path, [], { env: {}, timeout: 5_000, maxBuffer: 1024 });
    if (probe.error || probe.status !== 125) throw new Error("cgroup launch worker cannot execute");
    return { path, verify };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
