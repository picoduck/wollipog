import type { ReactNode } from "react";
import { relativeTime } from "../format.js";
import type { SkillGitAutoUpdate } from "../skills.js";
import { Notice } from "./Notice.js";
import { SwitchRow } from "./ui/SettingsRows.js";

export function formatUpdateInterval(ms: number | undefined): string {
  const minutes = Math.max(1, Math.round((ms ?? 60 * 60_000) / 60_000));
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

/** The row's one description line, which carries the setting's state (#1980). `heldElsewhere` is
 * true while the notice slot shows this skill's held update, so the row still says one waits. */
export function gitAutoUpdateDescription(status: SkillGitAutoUpdate | undefined, gitRef: string, heldElsewhere = false): ReactNode {
  if (status?.enabled !== true) return "Off. Use Check for Updates to review new commits.";
  const checked = status.checkedAt
    ? <>Last checked {relativeTime(status.checkedAt)}{status.checkedCommit
      ? <> at commit <span className="mono">{status.checkedCommit.slice(0, 12)}</span></> : null}.</>
    : "Waiting for the first check.";
  return <>Checks {gitRef} every {formatUpdateInterval(status.intervalMs)}. {checked}{heldElsewhere && status.held ? " An update is held for review." : null}</>;
}

/**
 * Opt-in unattended updates for a Git-imported skill, as an instant setting (§8.2, §8.6): one click
 * applies it, and "Saved" shows for 2s once the server confirms. `checked` stays the confirmed
 * value while the request runs.
 */
export function SkillGitAutoUpdateRow({ status, gitRef, heldElsewhere, disabled, saving, saved, onChange }: {
  status: SkillGitAutoUpdate | undefined;
  gitRef: string;
  heldElsewhere: boolean;
  /** Another change to the skill is saving. */
  disabled: boolean;
  /** This setting's own request is in flight. */
  saving: boolean;
  saved: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const enabled = status?.enabled === true;
  return (
    <SwitchRow
      title="Automatic Updates"
      description={gitAutoUpdateDescription(status, gitRef, heldElsewhere)}
      checked={enabled}
      disabled={disabled && !saving}
      busy={saving}
      saved={saved}
      onClick={() => onChange(!enabled)}
    />
  );
}

/** The last automatic check failed. Nothing changed because of it; the server's words are behind
 * Show Details. */
export function GitCheckFailedNotice({ error, busy, onCheck }: {
  error: NonNullable<SkillGitAutoUpdate["error"]>;
  busy: boolean;
  onCheck: () => void;
}) {
  return (
    <Notice
      as="section"
      tone="danger"
      title="Couldn't Check for Updates"
      ariaLabel="Couldn't Check for Updates"
      details={<p>{error.message}</p>}
      actions={<button type="button" className="btn sm" disabled={busy} onClick={onCheck}>Check for Updates…</button>}
    >
      <p>
        The automatic check failed <time dateTime={new Date(error.at).toISOString()} title={new Date(error.at).toLocaleString()}>
          {relativeTime(error.at)}</time>. Existing versions and deployments are unchanged.
      </p>
    </Notice>
  );
}
