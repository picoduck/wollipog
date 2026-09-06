/** Git is an upstream only: inspect immutable objects without checking out or executing files. */
import { execFile } from "node:child_process";
import { lstat, mkdtemp, opendir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { SKILL_MAX_FILE_BYTES, SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES, type SkillFile } from "@wollipog/protocol";
import { readSkillFrontmatter, validateSkillPayload, type ValidatedSkillPayload } from "./skills.js";

const exec = promisify(execFile);
export interface SkillGitSource { url: string; ref: string; subdirectory: string }
export interface SkillGitCandidate extends ValidatedSkillPayload {
  path: string;
  commit: string;
  source: SkillGitSource;
  executablePaths: string[];
}

/** Bound fetch storage too, before any untrusted tree is inspected. No checkout is created. */
async function checkRepositoryBudget(directory: string): Promise<void> {
  const pending = [directory];
  let bytes = 0;
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for await (const entry of await opendir(current)) {
      if (++entries > 4096) throw new Error("Repository entry budget exceeded");
      const path = join(current, entry.name);
      let stat;
      try { stat = await lstat(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error("Unexpected repository symlink");
      if (stat.isDirectory()) pending.push(path);
      else bytes += stat.size;
      if (bytes > 128 * 1024 * 1024) throw new Error("Repository byte budget exceeded");
    }
  }
}

export function parseSkillGitSource(input: unknown): SkillGitSource {
  const value = input as Partial<SkillGitSource> | null;
  if (!value || typeof value.url !== "string" || value.url.length > 2048) throw new Error("A Git repository URL is required.");
  let remote = value.url.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(remote)) remote = `https://github.com/${remote}.git`;
  if (/^git@[\w.-]+:[\w./-]+$/.test(remote)) remote = remote.replace(/^git@([^:]+):/, "ssh://git@$1/");
  let url: URL;
  try { url = new URL(remote); } catch { throw new Error("Use an HTTPS or SSH Git URL, or owner/repository shorthand."); }
  if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname || url.password ||
      (url.username && !(url.protocol === "ssh:" && url.username === "git")) || url.search || url.hash ||
      /[\x00-\x20\x7f]/.test(remote)) {
    throw new Error("Use a credential-free HTTPS URL or an SSH URL with the git user.");
  }
  const ref = value.ref === undefined || value.ref === "" ? "HEAD" : value.ref;
  if (typeof ref !== "string" || ref.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
      ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")) {
    throw new Error("Use a branch, tag, or commit for the Git ref.");
  }
  const subdirectory = value.subdirectory ?? "";
  if (typeof subdirectory !== "string" || subdirectory.length > 512 ||
      (subdirectory !== "" && (subdirectory.startsWith("/") || subdirectory.split("/").some((part) =>
        !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))))) {
    throw new Error("Use a relative repository subdirectory without traversal.");
  }
  return { url: url.href, ref, subdirectory };
}

export async function discoverGitSkills(source: SkillGitSource): Promise<SkillGitCandidate[]> {
  const directory = await mkdtemp(join(tmpdir(), "wollipog-skill-git-"));
  const abort = new AbortController();
  let checking = false;
  const watchdog = setInterval(() => {
    if (checking) return;
    checking = true;
    void checkRepositoryBudget(directory).catch(() => abort.abort()).finally(() => { checking = false; });
  }, 250);
  watchdog.unref();
  const deadline = setTimeout(() => abort.abort(), 90_000);
  deadline.unref();
  const git = async (args: string[], maxBuffer = 2 * 1024 * 1024): Promise<Buffer> => {
    try {
      const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
        "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-C", directory, ...args], {
        encoding: "buffer", maxBuffer, timeout: 60_000, signal: abort.signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
      });
      return result.stdout;
    } catch {
      // Git errors may contain remote credentials or control-plane filesystem paths.
      throw new Error("Could not read the Git source within its limits. Check the URL, ref, access, and repository size.");
    }
  };
  try {
    await git(["init", "--bare", "--template=", "."]);
    await git(["-c", "fetch.unpackLimit=1", "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", source.url, source.ref]);
    await checkRepositoryBudget(directory);
    return await readGitSkillSnapshot(source, git);
  } finally {
    clearInterval(watchdog);
    clearTimeout(deadline);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Object-reader seam also exercises the importer against local Git fixtures without network. */
export async function readGitSkillSnapshot(source: SkillGitSource,
  git: (args: string[], maxBuffer?: number) => Promise<Buffer>): Promise<SkillGitCandidate[]> {
    const commit = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toString("utf8").trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("The source did not resolve to a commit.");
    const tree = (await git(["ls-tree", "-r", "-z", "-l", commit])).toString("utf8");
    const entries = tree.split("\0").filter(Boolean).map((line) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("Invalid Git tree entry.");
      return { mode: match[1]!, type: match[2]!, oid: match[3]!, size: Number(match[4]), path: match[5]! };
    });
    const roots = entries.filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
      .map((entry) => posix.dirname(entry.path) === "." ? "" : posix.dirname(entry.path))
      .filter((root) => !source.subdirectory || root === source.subdirectory || root.startsWith(`${source.subdirectory}/`));
    if (roots.length > 32) throw new Error("More than 32 skills found. Choose a narrower subdirectory.");
    const candidates: SkillGitCandidate[] = [];
    let aggregate = 0;
    for (const root of roots) {
      const children = entries.filter((entry) => root ? entry.path.startsWith(`${root}/`) : true);
      if (children.length > SKILL_MAX_FILES) throw new Error("A skill contains too many files. Choose a narrower skill directory.");
      let total = 0;
      const files: SkillFile[] = [];
      for (const entry of children) {
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
          throw new Error("Skill trees may not contain symlinks or submodules.");
        }
        total += entry.size;
        aggregate += entry.size;
        if (entry.size > SKILL_MAX_FILE_BYTES || total > SKILL_MAX_TOTAL_BYTES || aggregate > 8 * SKILL_MAX_TOTAL_BYTES) {
          throw new Error("Skill content exceeds the import limits. Choose a narrower subdirectory.");
        }
        const bytes = await git(["cat-file", "blob", entry.oid], SKILL_MAX_FILE_BYTES + 1);
        const utf8 = bytes.toString("utf8");
        const text = Buffer.from(utf8).equals(bytes) && !utf8.includes("\0");
        files.push({ path: root ? entry.path.slice(root.length + 1) : entry.path,
          encoding: text ? "utf8" : "base64", content: text ? utf8 : bytes.toString("base64") });
      }
      const md = files.find((file) => file.path === "SKILL.md")!;
      const name = readSkillFrontmatter(Buffer.from(md.content, md.encoding).toString("utf8")).name;
      if (root && name !== posix.basename(root)) throw new Error("A skill's directory and frontmatter name must match.");
      const validated = validateSkillPayload({ name, files });
      if (!validated.ok) throw new Error(validated.error);
      candidates.push({ ...validated, path: root, commit, source,
        executablePaths: children.filter((entry) => entry.mode === "100755").map((entry) => root ? entry.path.slice(root.length + 1) : entry.path) });
    }
    return candidates;
}
