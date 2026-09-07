import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from "node:fs";
import { SKILL_MAX_FILES, SKILL_MAX_FILE_BYTES, SKILL_MAX_TOTAL_BYTES, validSkillFilePath, validSkillName,
  type AgentDefinition, type MachineSkillCandidate, type SkillFile, type SkillSnapshotMessage,
  type SkillSnapshotResultMessage } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { SKILL_DIRS } from "./skills.js";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fingerprint = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}`;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;

/** Linux descriptor-anchored traversal: every untrusted component is opened O_NOFOLLOW relative
 * to a pinned parent. A concurrent parent rename cannot redirect the read outside that parent.
 * No filesystem writes, subprocesses, script execution, or arbitrary client paths. */
export class MachineSkillSnapshots {
  private readonly candidates = new Map<string, { candidate: MachineSkillCandidate; expires: number }>();
  constructor(private readonly options: { home: string; agents: () => AgentDefinition[]; platform?: NodeJS.Platform; now?: () => number }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private directories(): string[] {
    const dirs = new Set<string>([".agents/skills"]);
    for (const agent of this.options.agents()) {
      if ((agent.context?.kind ?? "native") !== "native" || agent.id === "conductor") continue;
      const dir = SKILL_DIRS[agent.driver ?? "acp"];
      if (dir) dirs.add(dir);
    }
    return [...dirs];
  }
  private openDirectory(relative: string): number {
    let fd = openSync(realpathSync(this.options.home), directoryFlags);
    try {
      for (const segment of relative.split("/")) {
        const next = openSync(`${fdPath(fd)}/${segment}`, directoryFlags);
        closeSync(fd); fd = next;
      }
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  handle(message: SkillSnapshotMessage): SkillSnapshotResultMessage {
    const result: SkillSnapshotResultMessage = { type: "skill_snapshot_result", runnerId: message.runnerId, requestId: message.requestId };
    if ((this.options.platform ?? process.platform) !== "linux") return { ...result, error: "Machine skill snapshots currently require a Linux runner." };
    for (const [id, entry] of this.candidates) if (entry.expires <= this.now()) this.candidates.delete(id);
    try {
      if (message.operation === "list") return { ...result, candidates: this.list() };
      if (message.operation !== "read") throw new Error();
      const entry = typeof message.candidateId === "string" ? this.candidates.get(message.candidateId) : undefined;
      if (!entry || !this.directories().includes(entry.candidate.sourceDirectory)) throw new Error();
      const candidate = entry.candidate;
      const fd = this.openDirectory(`${candidate.sourceDirectory}/${candidate.name}`);
      try {
        if (fingerprint(fstatSync(fd)) !== candidate.generation) throw new Error();
        const files = this.readTree(fd);
        const digest = skillVersionDigest(files);
        // A second bounded pass rejects concurrent edits to content or the manifest. The returned
        // bytes are an immutable snapshot, not a promise that the source remains unchanged later.
        if (skillVersionDigest(this.readTree(fd)) !== digest || fingerprint(fstatSync(fd)) !== candidate.generation) throw new Error();
        return { ...result, snapshot: { candidate, files, digest } };
      } finally { closeSync(fd); }
    } catch {
      return { ...result, error: "The skill changed, expired, or contains unsupported files. Discover it again; symlinks, special files, and oversized trees cannot be imported." };
    }
  }
  private list(): MachineSkillCandidate[] {
    const found: MachineSkillCandidate[] = [];
    for (const relative of this.directories()) {
      let fd: number;
      try { fd = this.openDirectory(relative); } catch { continue; }
      try {
        const dir = opendirSync(fdPath(fd));
        try {
          for (let count = 0; count < 256 && found.length < 64; count++) {
            const entry = dir.readSync();
            if (!entry) break;
            if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
            let child: number | undefined;
            let manifest: number | undefined;
            try {
              child = openSync(`${fdPath(fd)}/${entry.name}`, directoryFlags);
              manifest = openSync(`${fdPath(child)}/SKILL.md`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              if (!fstatSync(manifest).isFile()) continue;
              const candidate = { id: randomUUID(), name: entry.name, sourceDirectory: relative, generation: fingerprint(fstatSync(child)) };
              found.push(candidate);
              this.candidates.set(candidate.id, { candidate, expires: this.now() + 600_000 });
            } catch { /* Unsupported or concurrently removed candidates are not offered. */ }
            finally { if (manifest !== undefined) closeSync(manifest); if (child !== undefined) closeSync(child); }
          }
        } finally { dir.closeSync(); }
      } finally { closeSync(fd); }
    }
    while (this.candidates.size > 256) this.candidates.delete(this.candidates.keys().next().value!);
    return found;
  }
  private readTree(root: number): SkillFile[] {
    const files: SkillFile[] = [];
    let total = 0;
    let entries = 0;
    const visit = (fd: number, prefix: string, depth: number) => {
      if (depth > 16) throw new Error();
      const dir = opendirSync(fdPath(fd));
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          const path = prefix + entry.name;
          if (++entries > 256 || !validSkillFilePath(path)) throw new Error();
          if (entry.isDirectory()) {
            const child = openSync(`${fdPath(fd)}/${entry.name}`, directoryFlags);
            try { visit(child, `${path}/`, depth + 1); } finally { closeSync(child); }
            continue;
          }
          if (!entry.isFile() || files.length >= SKILL_MAX_FILES) throw new Error();
          const child = openSync(`${fdPath(fd)}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const before = fstatSync(child);
            if (!before.isFile() || before.nlink !== 1 || before.size > SKILL_MAX_FILE_BYTES || total + before.size > SKILL_MAX_TOTAL_BYTES) throw new Error();
            const bytes = Buffer.alloc(before.size + 1);
            let length = 0;
            while (length < bytes.length) {
              const read = readSync(child, bytes, length, bytes.length - length, length);
              if (!read) break;
              length += read;
            }
            if (length !== before.size || fingerprint(fstatSync(child)) !== fingerprint(before)) throw new Error();
            total += length;
            const content = bytes.subarray(0, length);
            const utf8 = content.toString("utf8");
            files.push(Buffer.from(utf8).equals(content) ? { path, encoding: "utf8", content: utf8 } : { path, encoding: "base64", content: content.toString("base64") });
          } finally { closeSync(child); }
        }
      } finally { dir.closeSync(); }
    };
    visit(root, "", 0);
    if (!files.some((file) => file.path === "SKILL.md")) throw new Error();
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
