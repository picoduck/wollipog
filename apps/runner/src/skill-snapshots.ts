import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from "node:fs";
import { SKILL_MAX_FILES, SKILL_MAX_FILE_BYTES, SKILL_MAX_TOTAL_BYTES, validSkillFilePath, validSkillName,
  type AgentDefinition, type MachineSkillCandidate, type SkillFile, type SkillSnapshotMessage,
  type SkillSnapshotResultMessage } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { listMacosSkillCandidates, readMacosSkillCandidate } from "./macos-skill-snapshots.js";
import { SKILL_DIRS } from "./skills.js";
import { listWindowsSkillCandidates, readWindowsSkillCandidate } from "./windows-skill-snapshots.js";
import { resolveWslHomeUnc } from "./wsl-skill-snapshots.js";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fingerprint = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}`;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;

/** Directory times can be coarse enough that a newly added entry has the same timestamp.
 * Include the bounded entry names/types, without reading any file contents during discovery. */
export function directoryGeneration(fd: number): string {
  const entries: string[] = [];
  const dir = opendirSync(fdPath(fd));
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (entries.length >= 256) throw new Error();
      entries.push(JSON.stringify([entry.name, entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"]));
    }
  } finally { dir.closeSync(); }
  return createHash("sha256").update(JSON.stringify([fingerprint(fstatSync(fd)), entries.sort()])).digest("hex");
}

/** Internal Linux primitive: resolve a fixed relative directory through pinned no-follow parents. */
export function openSkillDirectory(home: string, relative: string, durable = false): number {
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) throw new Error();
  let fd = openSync(realpathSync(home), directoryFlags);
  try {
    for (const segment of segments) {
      const next = openSync(`${fdPath(fd)}/${segment}`, directoryFlags);
      if (durable) {
        try { fsyncSync(fd); } catch (error) { closeSync(next); throw error; }
      }
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/** Linux descriptor-anchored traversal: every untrusted component is opened O_NOFOLLOW relative
 * to a pinned parent. A concurrent parent rename cannot redirect the read outside that parent.
 * No filesystem writes, subprocesses, script execution, or arbitrary client paths. */
export class MachineSkillSnapshots {
  private readonly candidates = new Map<string, { candidate: MachineSkillCandidate; expires: number; home?: string }>();
  constructor(private readonly options: { home: string; agents: () => AgentDefinition[]; platform?: NodeJS.Platform;
    now?: () => number; maxRawEntriesPerDirectory?: number;
    macosList?: typeof listMacosSkillCandidates; macosRead?: typeof readMacosSkillCandidate;
    windowsList?: typeof listWindowsSkillCandidates; windowsRead?: typeof readWindowsSkillCandidate;
    wslHome?: (distro: string) => string | null }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private platform() { return this.options.platform ?? process.platform; }
  private directories(): string[] {
    const dirs = new Set<string>([".agents/skills"]);
    for (const agent of this.options.agents()) {
      if ((agent.context?.kind ?? "native") !== "native" || agent.id === "conductor") continue;
      const dir = SKILL_DIRS[agent.driver ?? "acp"];
      if (dir) dirs.add(dir);
    }
    return [...dirs];
  }
  private wslDirectories(distro: string): string[] {
    const dirs = new Set<string>([".agents/skills"]);
    for (const agent of this.options.agents()) {
      if (agent.id === "conductor" || agent.context?.kind !== "wsl" || agent.context.distro !== distro) continue;
      const dir = SKILL_DIRS[agent.driver ?? "acp"];
      if (dir) dirs.add(dir);
    }
    return [...dirs];
  }
  private wslDistros(): string[] {
    return [...new Set(this.options.agents().flatMap((agent) =>
      agent.context?.kind === "wsl" && SKILL_DIRS[agent.driver ?? "acp"] ? [agent.context.distro] : []))];
  }
  private openDirectory(relative: string): number {
    return openSkillDirectory(this.options.home, relative);
  }
  /** Resolve only an exact, still-live candidate minted by this runner process. */
  resolveCandidate(expected: MachineSkillCandidate): MachineSkillCandidate | null {
    for (const [id, entry] of this.candidates) if (entry.expires <= this.now()) this.candidates.delete(id);
    const current = this.candidates.get(expected.id)?.candidate;
    return current && current.name === expected.name && current.sourceDirectory === expected.sourceDirectory &&
      current.generation === expected.generation && current.context?.kind === expected.context?.kind &&
      (current.context?.kind !== "wsl" || (expected.context?.kind === "wsl" &&
        current.context.distro === expected.context.distro && this.wslDistros().includes(current.context.distro))) &&
      (current.context?.kind === "wsl"
        ? this.wslDirectories(current.context.distro).includes(current.sourceDirectory)
        : this.directories().includes(current.sourceDirectory))
      ? current : null;
  }
  handle(message: SkillSnapshotMessage): SkillSnapshotResultMessage {
    const result: SkillSnapshotResultMessage = { type: "skill_snapshot_result", runnerId: message.runnerId, requestId: message.requestId };
    if (!new Set<NodeJS.Platform>(["darwin", "linux", "win32"]).has(this.platform())) {
      return { ...result, error: "Machine skill snapshots currently require a Linux, macOS, or Windows runner." };
    }
    for (const [id, entry] of this.candidates) if (entry.expires <= this.now()) this.candidates.delete(id);
    try {
      if (message.operation === "list") return { ...result, candidates: this.list() };
      if (message.operation !== "read") throw new Error();
      const entry = typeof message.candidateId === "string" ? this.candidates.get(message.candidateId) : undefined;
      if (!entry) throw new Error();
      const candidate = entry.candidate;
      if (candidate.context?.kind === "wsl") {
        if (this.platform() !== "win32" || !entry.home ||
            !this.wslDirectories(candidate.context.distro).includes(candidate.sourceDirectory)) throw new Error();
        const files = (this.options.windowsRead ?? readWindowsSkillCandidate)(entry.home, candidate);
        return { ...result, snapshot: { candidate, files, digest: skillVersionDigest(files), executablePaths: [] } };
      }
      if (!this.directories().includes(candidate.sourceDirectory)) throw new Error();
      if (this.platform() === "darwin") {
        const snapshot = (this.options.macosRead ?? readMacosSkillCandidate)(this.options.home, candidate);
        return { ...result, snapshot: { candidate, ...snapshot, digest: skillVersionDigest(snapshot.files) } };
      }
      if (this.platform() === "win32") {
        const files = (this.options.windowsRead ?? readWindowsSkillCandidate)(this.options.home, candidate);
        return { ...result, snapshot: { candidate, files, digest: skillVersionDigest(files), executablePaths: [] } };
      }
      const fd = this.openDirectory(`${candidate.sourceDirectory}/${candidate.name}`);
      try {
        if (directoryGeneration(fd) !== candidate.generation) throw new Error();
        const first = inspectSkillTree(fd);
        const digest = skillVersionDigest(first.files);
        // A second bounded pass rejects concurrent edits to content or the manifest. The returned
        // bytes are an immutable snapshot, not a promise that the source remains unchanged later.
        const second = inspectSkillTree(fd);
        if (skillVersionDigest(second.files) !== digest ||
            JSON.stringify(second.executablePaths) !== JSON.stringify(first.executablePaths) ||
            directoryGeneration(fd) !== candidate.generation) throw new Error();
        return { ...result, snapshot: { candidate, files: first.files, digest, executablePaths: first.executablePaths } };
      } finally { closeSync(fd); }
    } catch {
      return { ...result, error: "The skill changed, expired, or contains unsupported files. Discover it again; symlinks, special files, and oversized trees cannot be imported." };
    }
  }
  private list(): MachineSkillCandidate[] {
    if (this.platform() === "darwin") {
      const found = (this.options.macosList ?? listMacosSkillCandidates)(this.options.home, this.directories())
        .map((entry) => ({ id: randomUUID(), ...entry }));
      for (const candidate of found) this.candidates.set(candidate.id, { candidate, expires: this.now() + 600_000 });
      while (this.candidates.size > 256) this.candidates.delete(this.candidates.keys().next().value!);
      return found;
    }
    if (this.platform() === "win32") {
      const native = (this.options.windowsList ?? listWindowsSkillCandidates)(this.options.home, this.directories())
        .map((entry) => ({ id: randomUUID(), ...entry }));
      const found: MachineSkillCandidate[] = [...native];
      for (const candidate of native) {
        this.candidates.set(candidate.id, { candidate, expires: this.now() + 600_000 });
      }
      for (const distro of this.wslDistros()) {
        if (found.length >= 64) break;
        try {
          const home = (this.options.wslHome ?? resolveWslHomeUnc)(distro);
          if (!home) continue;
          const remaining = 64 - found.length;
          const candidates = (this.options.windowsList ?? listWindowsSkillCandidates)(home, this.wslDirectories(distro))
            .slice(0, remaining)
            .map((entry): MachineSkillCandidate => ({ id: randomUUID(), ...entry, context: { kind: "wsl", distro } }));
          for (const candidate of candidates) {
            found.push(candidate);
            this.candidates.set(candidate.id, { candidate, expires: this.now() + 600_000, home });
          }
        } catch {
          // One stopped, wedged, or malformed distro must not hide native or other WSL candidates.
        }
      }
      while (this.candidates.size > 256) this.candidates.delete(this.candidates.keys().next().value!);
      return found;
    }
    const found: MachineSkillCandidate[] = [];
    for (const relative of this.directories()) {
      let fd: number;
      try { fd = this.openDirectory(relative); } catch { continue; }
      try {
        const dir = opendirSync(fdPath(fd));
        try {
          for (let count = 0, raw = 0; count < 256 && found.length < 64;) {
            const entry = dir.readSync();
            if (!entry) break;
            if (++raw > (this.options.maxRawEntriesPerDirectory ?? 4096)) break;
            // Private recovery journals are never candidates and must not crowd user skills out
            // of the bounded discovery budget. Recovery inspection has its own bounded path.
            if (entry.name.startsWith(".wollipog-adoption-")) continue;
            count++;
            if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
            let child: number | undefined;
            let manifest: number | undefined;
            try {
              child = openSync(`${fdPath(fd)}/${entry.name}`, directoryFlags);
              manifest = openSync(`${fdPath(child)}/SKILL.md`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              if (!fstatSync(manifest).isFile()) continue;
              const candidate = { id: randomUUID(), name: entry.name, sourceDirectory: relative,
                generation: directoryGeneration(child) };
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
}

/** Bounded no-follow content validation; adoption may additionally flush files/directories before
 * preserving them. Snapshot discovery/read never opts into these durability operations. */
export function inspectSkillTree(root: number, durable = false): { files: SkillFile[]; executablePaths: string[] } {
    const files: SkillFile[] = [];
    const executablePaths: string[] = [];
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
            if (durable) fsyncSync(child);
            if ((before.mode & 0o111) !== 0) executablePaths.push(path);
            total += length;
            const content = bytes.subarray(0, length);
            const utf8 = content.toString("utf8");
            files.push(Buffer.from(utf8).equals(content)
              ? { path, encoding: "utf8", content: utf8 }
              : { path, encoding: "base64", content: content.toString("base64") });
          } finally { closeSync(child); }
        }
      } finally { dir.closeSync(); }
      if (durable) fsyncSync(fd);
    };
    visit(root, "", 0);
    if (!files.some((file) => file.path === "SKILL.md")) throw new Error();
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), executablePaths: executablePaths.sort() };
}

export function readSkillTree(root: number, durable = false): SkillFile[] {
  return inspectSkillTree(root, durable).files;
}
