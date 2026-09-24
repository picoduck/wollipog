import type { SkillGitAutoUpdate } from "../skills.js";
import { Checkbox } from "./ui/ChoiceControls.js";

export function formatUpdateInterval(ms: number | undefined): string {
  const minutes = Math.max(1, Math.round((ms ?? 60 * 60_000) / 60_000));
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString();
}

/** Opt-in unattended updates for a Git-imported skill. Held updates are reviewed through the
 * existing Check for Updates preview, which the caller opens. */
export function SkillGitAutoUpdateControls({ status, gitRef, busy, onChange }: {
  status: SkillGitAutoUpdate | undefined;
  gitRef: string;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const enabled = status?.enabled === true;
  const held = enabled ? status?.held : null;
  return <div className="skills-git-auto-update">
    <label className="field"><span><Checkbox label="Automatic Updates" checked={enabled} disabled={busy} onChange={onChange} /> Automatic Updates</span></label>
    <p className="skills-hint">{enabled
      ? `Checks ${gitRef} every ${formatUpdateInterval(status?.intervalMs)} and imports new commits as library versions. Updates that add or change scripts wait for review.`
      : "Off. Use Check for Updates to review new commits."}</p>
    {enabled && <p className="skills-hint">{status?.checkedAt
      ? `Last checked ${formatTime(status.checkedAt)}${status.checkedCommit ? ` · Commit ${status.checkedCommit.slice(0, 12)}` : ""}`
      : "Waiting for the first check."}</p>}
    {enabled && status?.error && <p className="form-error">Last check failed {formatTime(status.error.at)}: {status.error.message} Existing versions and deployments are unchanged.</p>}
    {held && <p className="skills-git-held" role="status">
      Update to commit {held.commit.slice(0, 12)} is held for review because {held.reason === "scripts"
        ? `it adds or changes scripts: ${held.scriptPaths.join(", ")}.`
        : held.reason === "untracked_modes"
          ? `the last import predates executable-file tracking, so changed files need one review: ${held.scriptPaths.join(", ")}.`
          : "the library has edits made since the last Git import."} Review it before it can deploy.
    </p>}
  </div>;
}
