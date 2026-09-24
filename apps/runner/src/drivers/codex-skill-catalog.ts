import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Codex skill identity from the app-server protocol.
 *
 * The app-server has no thread item for a skill invocation. Codex offers the model a list of
 * skills and the model uses one by reading its `SKILL.md` with an ordinary shell command, which
 * arrives as a `commandExecution` whose parsed `commandActions` are `read`s. The only structured
 * skill signals are `skills/list` (each registered skill's name and absolute `SKILL.md` path) and
 * an explicit `{ type: "skill", name, path }` user-input entry. A command is therefore labeled as a
 * skill only when every action reads the `SKILL.md` of one registered skill; a read made to
 * inspect such a file is indistinguishable and is labeled the same way.
 */
export interface CodexSkill {
  name: string;
  path: string;
}

/** Enabled skills from a `skills/list` response, first registration winning per path. */
export function codexSkillsFromList(response: unknown): CodexSkill[] {
  const data = (response as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const skills: CodexSkill[] = [];
  for (const entry of data) {
    const listed = (entry as { skills?: unknown } | null | undefined)?.skills;
    if (!Array.isArray(listed)) continue;
    for (const skill of listed) {
      const { name, path, enabled } = (skill ?? {}) as { name?: unknown; path?: unknown; enabled?: unknown };
      if (typeof name !== "string" || !name || typeof path !== "string" || !path || enabled === false) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      skills.push({ name, path });
    }
  }
  return skills;
}

/** Skill name keyed by its exact `SKILL.md` path. */
export function codexSkillPathIndex(skills: readonly CodexSkill[]): ReadonlyMap<string, string> {
  return new Map(skills.map((skill) => [skill.path, skill.name]));
}

/** Names of explicit skill entries in a `userMessage` item's content. */
export function codexSkillInputNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((input) => {
    const { type, name } = (input ?? {}) as { type?: unknown; name?: unknown };
    return type === "skill" && typeof name === "string" && name ? [name] : [];
  });
}

function absoluteReadPath(path: string, cwd: unknown): string | undefined {
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return path;
  if (typeof cwd !== "string" || !cwd) return undefined;
  return cwd.startsWith("/") ? posix.resolve(cwd, path) : win32.resolve(cwd, path);
}

const SKILL_FILE = /[\\/]SKILL\.md$/u;

function hostRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * The registered skill whose `SKILL.md` a `commandExecution` only reads. `skills/list` reports
 * canonical paths while the model reads through the skill roots it was shown, which are commonly
 * symlinks, so a `SKILL.md` path that misses exactly is compared again after resolving it on this
 * host. Enable `canonicalizeOnHost` only when the provider shares the runner's filesystem view.
 */
export function codexCommandSkillName(
  commandActions: unknown,
  cwd: unknown,
  index: ReadonlyMap<string, string>,
  canonicalizeOnHost: boolean,
): string | undefined {
  if (!index.size || !Array.isArray(commandActions) || !commandActions.length) return undefined;
  let skill: string | undefined;
  for (const action of commandActions) {
    const { type, path } = (action ?? {}) as { type?: unknown; path?: unknown };
    if (type !== "read" || typeof path !== "string") return undefined;
    const absolute = absoluteReadPath(path, cwd);
    if (!absolute) return undefined;
    let name = index.get(absolute);
    if (name == null && canonicalizeOnHost && SKILL_FILE.test(absolute)) {
      const canonical = hostRealpath(absolute);
      if (canonical) name = index.get(canonical);
    }
    if (name == null || (skill != null && skill !== name)) return undefined;
    skill = name;
  }
  return skill;
}
