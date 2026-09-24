import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PrivateConfig {
  directory: string;
  directoryDevice: number;
  directoryInode: number;
  fileDevice: number;
  fileInode: number;
}

let privateConfig: PrivateConfig | undefined;
let cleanupRegistered = false;

function configIntact(config: PrivateConfig): boolean {
  try {
    const directory = lstatSync(config.directory);
    const file = lstatSync(join(config.directory, "config.json"));
    const uid = process.getuid?.();
    return directory.isDirectory() && !directory.isSymbolicLink() &&
      file.isFile() && !file.isSymbolicLink() &&
      directory.dev === config.directoryDevice && directory.ino === config.directoryInode &&
      file.dev === config.fileDevice && file.ino === config.fileInode &&
      (uid === undefined || (directory.uid === uid && file.uid === uid &&
        (directory.mode & 0o077) === 0 && (file.mode & 0o077) === 0)) &&
      readFileSync(join(config.directory, "config.json"), "utf8") === "{}\n";
  } catch {
    return false;
  }
}

/** Docker CLI config.json can inject proxy values into containers. Keep every target client on
 * an empty, runner-owned config while a separately verified local endpoint selects the engine. */
export function dockerTargetClientConfig(): string {
  if (privateConfig && configIntact(privateConfig)) return privateConfig.directory;
  const directory = mkdtempSync(join(tmpdir(), "wollipog-docker-client-"));
  try {
    writeFileSync(join(directory, "config.json"), "{}\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const directoryStat = lstatSync(directory);
  const fileStat = lstatSync(join(directory, "config.json"));
  privateConfig = {
    directory,
    directoryDevice: directoryStat.dev,
    directoryInode: directoryStat.ino,
    fileDevice: fileStat.dev,
    fileInode: fileStat.ino,
  };
  if (!cleanupRegistered) {
    process.once("exit", () => {
      try {
        if (privateConfig && configIntact(privateConfig)) {
          rmSync(privateConfig.directory, { recursive: true, force: true });
        }
      } catch { /* A hard stop may leave this empty directory behind. */ }
    });
    cleanupRegistered = true;
  }
  return directory;
}
