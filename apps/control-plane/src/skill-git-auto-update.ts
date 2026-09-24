/** Opt-in unattended Git skill updates. Each check reuses the preview importer's hardened fetch and
 * the library's latest-version fence; script changes and local edits wait for a reviewed import. */
import { isSkillScriptFile, type SkillFile } from "@wollipog/protocol";
import { SkillImportConflictError, type ControlPlaneDb, type SkillGitAutoUpdateView } from "./db.js";
import { discoverGitSkills, parseSkillGitSource, type SkillGitCandidate, type SkillGitSource } from "./skill-git.js";

export const SKILL_GIT_AUTO_UPDATE_DEFAULT_INTERVAL_MS = 60 * 60_000;
export const SKILL_GIT_AUTO_UPDATE_MIN_INTERVAL_MS = 60_000;
/** How often due skills are looked for; a check lands within one interval plus this sweep. */
export const SKILL_GIT_AUTO_UPDATE_SWEEP_MS = 60_000;

export function skillGitAutoUpdateIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return SKILL_GIT_AUTO_UPDATE_DEFAULT_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return SKILL_GIT_AUTO_UPDATE_DEFAULT_INTERVAL_MS;
  return Math.max(SKILL_GIT_AUTO_UPDATE_MIN_INTERVAL_MS, Math.floor(parsed));
}

function sameContent(a: SkillFile, b: SkillFile): boolean {
  return a.encoding === b.encoding && a.content === b.content;
}

/** Paths the candidate adds or changes that are script-like now or were before, so dropping an
 * executable bit or shebang in the same commit cannot hide a changed script. Removals are not
 * held: they never execute anything new. */
export function changedSkillScripts(previous: SkillFile[], previousExecutablePaths: string[], candidate: SkillGitCandidate): string[] {
  const before = new Map(previous.map((file) => [file.path, file]));
  return candidate.files
    .filter((file) => {
      const prior = before.get(file.path);
      if (prior && sameContent(prior, file)) return false;
      return isSkillScriptFile(file, candidate.executablePaths.includes(file.path)) ||
        (!!prior && isSkillScriptFile(prior, previousExecutablePaths.includes(file.path)));
    })
    .map((file) => file.path)
    .sort();
}

function changedExistingFiles(previous: SkillFile[], candidate: SkillGitCandidate): string[] {
  const before = new Map(previous.map((file) => [file.path, file]));
  return candidate.files
    .filter((file) => { const prior = before.get(file.path); return !!prior && !sameContent(prior, file); })
    .map((file) => file.path)
    .sort();
}

export type SkillGitAutoUpdateOutcome ="unchanged" | "imported" | "held" | "failed" | "skipped";

export class SkillGitAutoUpdater {
  private active: Promise<void> | null = null;
  private readonly discover: (source: SkillGitSource) => Promise<SkillGitCandidate[]>;
  private readonly now: () => number;

  constructor(private readonly options: {
    db: ControlPlaneDb;
    intervalMs: number;
    pushSkillsSync: (runnerId: string) => void;
    discover?: (source: SkillGitSource) => Promise<SkillGitCandidate[]>;
    now?: () => number;
  }) {
    this.discover = options.discover ?? discoverGitSkills;
    this.now = options.now ?? Date.now;
  }

  get intervalMs(): number { return this.options.intervalMs; }

  /** Single-flight sweep. Checks run one at a time so unattended fetches never compete with each
   * other for the control plane's credentials, bandwidth, or temporary-repository budget. */
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      for (const skillId of this.options.db.listDueSkillGitAutoUpdates(this.now(), this.options.intervalMs)) {
        await this.check(skillId);
      }
    })().finally(() => { this.active = null; });
    return this.active;
  }

  async check(skillId: string): Promise<SkillGitAutoUpdateOutcome> {
    const { db } = this.options;
    const skill = db.getSkill(skillId);
    const state = db.getSkillGitAutoUpdate(skillId);
    const revision = db.getSkillGitAutoUpdateRevision(skillId);
    const fail = (error: string): SkillGitAutoUpdateOutcome => {
      // A failure from a fetch that outlived a setting change or reviewed import is stale too.
      if (db.getSkillGitAutoUpdateRevision(skillId) !== revision) return "skipped";
      db.recordSkillGitAutoUpdateCheck(skillId, { kind: "failed", error, at: this.now() });
      return "failed";
    };
    if (!skill || !state.enabled) return "skipped";
    const upstream = skill.gitSource;
    if (!upstream) return fail("The skill no longer records a Git source.");
    const expectedVersionId = skill.latestVersion?.id ?? null;
    const latest = expectedVersionId ? db.getSkillVersion(expectedVersionId) : null;
    if (!latest) return fail("The skill has no library version to update.");

    let request: SkillGitSource;
    // Recorded provenance passes the same validation as a preview before ambient credentials are used.
    try { request = parseSkillGitSource({ url: upstream.url, ref: upstream.ref, subdirectory: upstream.path }); }
    catch (error) { return fail((error as Error).message); }
    let candidates: SkillGitCandidate[];
    try {
      candidates = await this.discover(request);
    } catch (error) {
      // Transport errors are already sanitized; system errors could name control-plane paths.
      return fail(error instanceof Error && !("code" in error) ? error.message : "Could not read the Git source.");
    }
    const candidate = candidates.find((entry) => entry.path === upstream.path);
    if (!candidate) return fail(`The fetched commit has no skill at ${upstream.path || "the repository root"}.`);
    if (candidate.name !== skill.name) return fail(`The fetched skill is named ${candidate.name}, not ${skill.name}.`);
    // The library may have changed while the fetch ran; a stale result is simply re-checked.
    const current = db.getSkill(skillId);
    const fresh = db.getSkillGitAutoUpdate(skillId);
    if (!fresh.enabled || (current?.latestVersion?.id ?? null) !== expectedVersionId ||
        db.getSkillGitAutoUpdateRevision(skillId) !== revision) return "skipped";
    // Only commits after the recorded baseline are updates; a local edit alone is not.
    if (candidate.commit === (fresh.checkedCommit ?? upstream.commit)) {
      db.recordSkillGitAutoUpdateCheck(skillId, { kind: "handled", commit: candidate.commit, at: this.now(), held: fresh.held });
      return "unchanged";
    }

    const source = { ...upstream, path: candidate.path, commit: candidate.commit, executablePaths: candidate.executablePaths };
    let held: SkillGitAutoUpdateView["held"] = null;
    if (latest.digest !== candidate.digest) {
      const scriptPaths = changedSkillScripts(latest.files, latest.gitSource?.executablePaths ?? [], candidate);
      // Imports that predate executable tracking cannot prove a changed file was not executable,
      // so their first changing update is reviewed once; that import then records the modes.
      const untracked = latest.gitSource && !Array.isArray(latest.gitSource.executablePaths)
        ? changedExistingFiles(latest.files, candidate) : [];
      // Edits made in the library since the last import would be overwritten; a human decides.
      if (!latest.gitSource) held = { commit: candidate.commit, reason: "local_changes", scriptPaths, heldAt: this.now() };
      else if (scriptPaths.length) held = { commit: candidate.commit, reason: "scripts", scriptPaths, heldAt: this.now() };
      else if (untracked.length) held = { commit: candidate.commit, reason: "untracked_modes", scriptPaths: untracked, heldAt: this.now() };
    }
    if (held) {
      db.recordSkillGitAutoUpdateCheck(skillId, { kind: "handled", commit: candidate.commit, at: this.now(), held });
      return "held";
    }
    let applied;
    try {
      applied = db.applySkillGitAutoUpdate({ skillId, files: candidate.files, manifest: candidate.manifest,
        digest: candidate.digest, source, expectedVersionId, expectedRevision: revision, at: this.now() });
    } catch (error) {
      if (error instanceof SkillImportConflictError) return fail(error.message);
      return fail("The update could not be recorded. It is retried at the next check.");
    }
    if (!applied) return "skipped";
    if (applied.changed) for (const runner of db.listRunners()) this.options.pushSkillsSync(runner.runnerId);
    return applied.changed ? "imported" : "unchanged";
  }
}
