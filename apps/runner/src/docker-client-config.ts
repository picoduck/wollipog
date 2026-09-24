import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let privateConfigDirectory: string | undefined;

/** Docker CLI config.json can inject proxy values into containers. Keep every target client on
 * an empty, runner-owned config while a separately verified local endpoint selects the engine. */
export function dockerTargetClientConfig(): string {
  if (privateConfigDirectory) return privateConfigDirectory;
  const directory = mkdtempSync(join(tmpdir(), "wollipog-docker-client-"));
  try {
    writeFileSync(join(directory, "config.json"), "{}\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  privateConfigDirectory = directory;
  process.once("exit", () => {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* A hard stop may leave this empty directory behind. */ }
  });
  return directory;
}
