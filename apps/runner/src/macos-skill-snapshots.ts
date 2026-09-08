import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAsset, isSea } from "node:sea";
import {
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  validSkillFilePath,
  validSkillName,
  type MachineSkillCandidate,
  type SkillFile,
} from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";

const MACOS_SNAPSHOT_ASSET = "wollipog/macos-skill-snapshots";
const DIGEST = /^[0-9a-f]{64}$/u;
let developmentHelper: string | null = null;
let packagedHelper: string | null = null;

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Resolve the fixed native helper. Shipped SEA runners extract build-time compiled bytes;
 * source checkouts compile the same checked-in C file into a private process-owned directory. */
export function resolveMacosSkillSnapshotHelper(platform = process.platform): string {
  if (platform !== "darwin") throw new Error("the macOS skill snapshot helper requires native macOS");
  if (!isSea()) {
    if (developmentHelper) return developmentHelper;
    const source = fileURLToPath(new URL("../native/macos-skill-snapshots.c", import.meta.url));
    const root = mkdtempSync(join(tmpdir(), "wollipog-macos-skill-snapshots-"));
    chmodSync(root, 0o700);
    const target = join(root, "snapshot-helper");
    const compiled = spawnSync("/usr/bin/clang", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-Wno-deprecated-declarations", source, "-o", target], { encoding: "utf8", timeout: 30_000 });
    if (compiled.error || compiled.status !== 0) {
      rmSync(root, { recursive: true, force: true });
      throw new Error("the fixed macOS skill snapshot helper could not be compiled");
    }
    chmodSync(target, 0o700);
    developmentHelper = target;
    return target;
  }
  if (packagedHelper) return packagedHelper;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getAsset(MACOS_SNAPSHOT_ASSET));
  } catch (cause) {
    throw new Error("the packaged macOS skill snapshot helper is missing", { cause });
  }
  const digest = sha256(bytes);
  const root = mkdtempSync(join(tmpdir(), "wollipog-macos-skill-snapshots-"));
  chmodSync(root, 0o700);
  const target = join(root, "snapshot-helper");
  writeFileSync(target, bytes, { flag: "wx", mode: 0o700 });
  if (sha256(readFileSync(target)) !== digest) throw new Error("the extracted macOS snapshot helper failed integrity verification");
  chmodSync(target, 0o700);
  packagedHelper = target;
  return packagedHelper;
}

class Reader {
  private offset = 0;
  constructor(private readonly value: Buffer) {}
  magic(expected: string): void {
    if (this.value.subarray(0, expected.length).toString("ascii") !== expected) throw new Error();
    this.offset = expected.length;
  }
  u8(): number {
    if (this.offset >= this.value.length) throw new Error();
    return this.value[this.offset++]!;
  }
  u32(): number {
    if (this.offset + 4 > this.value.length) throw new Error();
    const value = this.value.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }
  blob(maximum: number): Buffer {
    const length = this.u32();
    if (length > maximum || this.offset + length > this.value.length) throw new Error();
    const value = this.value.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  text(maximum: number): string {
    const bytes = this.blob(maximum);
    const value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error();
    return value;
  }
  end(): void {
    if (this.offset !== this.value.length) throw new Error();
  }
}

function runHelper(args: string[], helper = resolveMacosSkillSnapshotHelper()): Buffer {
  const result = spawnSync(helper, args, { encoding: "buffer", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal || !Buffer.isBuffer(result.stdout)) throw new Error();
  return result.stdout;
}

export function parseMacosSkillCandidates(
  output: Buffer,
  directories: readonly string[],
): Array<Omit<MachineSkillCandidate, "id">> {
  const reader = new Reader(output);
  reader.magic("WMS1L");
  const count = reader.u32();
  if (count > 64) throw new Error();
  const candidates: Array<Omit<MachineSkillCandidate, "id">> = [];
  for (let index = 0; index < count; index++) {
    const sourceDirectory = reader.text(1024);
    const name = reader.text(256);
    const generation = reader.text(64);
    if (!directories.includes(sourceDirectory) || !validSkillName(name) || !DIGEST.test(generation)) throw new Error();
    candidates.push({ sourceDirectory, name, generation });
  }
  reader.end();
  return candidates;
}

export function listMacosSkillCandidates(
  home: string,
  directories: readonly string[],
  helper?: string,
): Array<Omit<MachineSkillCandidate, "id">> {
  return parseMacosSkillCandidates(runHelper(["list", home, ...directories], helper), directories);
}

export function parseMacosSkillSnapshot(output: Buffer): {
  generation: string;
  files: SkillFile[];
  executablePaths: string[];
} {
  const reader = new Reader(output);
  reader.magic("WMS1R");
  const generation = reader.text(64);
  const count = reader.u32();
  if (!DIGEST.test(generation) || count === 0 || count > SKILL_MAX_FILES) throw new Error();
  const files: SkillFile[] = [];
  const executablePaths: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    const path = reader.text(1024);
    const executable = reader.u8();
    const content = reader.blob(SKILL_MAX_FILE_BYTES);
    if (!validSkillFilePath(path) || seen.has(path) || (executable !== 0 && executable !== 1)) throw new Error();
    total += content.length;
    if (total > SKILL_MAX_TOTAL_BYTES) throw new Error();
    seen.add(path);
    files.push({ path, encoding: "base64", content: content.toString("base64") });
    if (executable === 1) executablePaths.push(path);
  }
  reader.end();
  if (!seen.has("SKILL.md")) throw new Error();
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  executablePaths.sort();
  return { generation, files, executablePaths };
}

export function readMacosSkillCandidate(
  home: string,
  candidate: MachineSkillCandidate,
  helper?: string,
): { files: SkillFile[]; executablePaths: string[] } {
  const read = () => parseMacosSkillSnapshot(runHelper(
    ["read", home, candidate.sourceDirectory, candidate.name], helper,
  ));
  const first = read();
  const second = read();
  if (first.generation !== candidate.generation || second.generation !== candidate.generation ||
      skillVersionDigest(first.files) !== skillVersionDigest(second.files) ||
      JSON.stringify(first.executablePaths) !== JSON.stringify(second.executablePaths)) throw new Error();
  return { files: first.files, executablePaths: first.executablePaths };
}
