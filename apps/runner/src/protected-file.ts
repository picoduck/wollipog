/**
 * Owner-only atomic write shared by the runner-owned per-session launch files.
 *
 * A symlinked target is refused rather than followed: these files are read back by sidecars that
 * run before every provider tool call, so an attacker-planted link must never redirect the write.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export function protectedWrite(
  file: string,
  contents: string,
  description = "runner-owned session file",
): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error(`refusing to replace a symlinked ${description}`);
  }
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  try { chmodSync(file, 0o600); } catch { /* Windows ACLs are owned by the runner account */ }
}
