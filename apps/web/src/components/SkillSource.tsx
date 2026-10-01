import type { ReactNode } from "react";
import { skillSourceKind, type SkillSummary } from "../skills.js";
import { CopyButton } from "./common.js";
import { Notice } from "./Notice.js";
import { SkillDetailSection } from "./SkillDetailHeader.js";
import { GitCheckFailedNotice, SkillGitAutoUpdateRow } from "./SkillGitAutoUpdate.js";
import { GitHeldNotice } from "./SkillNoticeSlot.js";

/** A hash at 12 characters, with a button that copies all of it; the full hash is never shown (§11.3). */
function Hash({ value, label }: { value: string; label: string }) {
  return (
    <span className="skill-source-hash">
      <span className="mono">{value.slice(0, 12)}</span>
      <CopyButton text={value} iconOnly ariaLabel={`Copy ${label}`} className="icon-btn sm" />
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

export interface SkillSourceProps {
  skill: SkillSummary;
  machineLabels: ReadonlyMap<string, string>;
  busy: boolean;
  /** The notice slot is showing this skill's held Git update, so Source does not show it again. */
  heldInSlot: boolean;
  /** Automatic Updates' own request is in flight, and whether its "Saved" check shows. */
  autoUpdate: { saving: boolean; saved: boolean };
  onCheckForUpdates: () => void;
  /** Review Update… on the held update Source shows, with the commit it names. */
  onReviewHeldUpdate: (commit: string) => void;
  onSetAutoUpdate: (enabled: boolean) => void;
  onShowRecommendation: () => void;
  onReviewBuiltIn: () => void;
}

/**
 * Where the skill came from (#1980): labeled facts on one Surface, with the notices about its source
 * flush at the top of it. Git skills add Check for Updates… in the title row and Automatic Updates
 * as a setting row; a built-in skill names its release and its recommendation; a same-name skill is
 * offered the built-in version. A skill made here, with no offer, has no Source.
 */
export function SkillSource(props: SkillSourceProps) {
  const { skill, busy } = props;
  const kind = skillSourceKind(skill);
  const latest = skill.latestVersion;
  const git = kind === "git" ? skill.gitSource ?? latest?.gitSource : undefined;
  const machine = kind === "machine" ? latest?.machineSource : undefined;
  const builtIn = kind === "built_in" ? skill.builtIn : undefined;
  const offer = skill.builtInOffer;
  if (!git && !machine && !builtIn && !offer) return null;

  const auto = git ? skill.gitAutoUpdate : undefined;
  const enabled = auto?.enabled === true;
  const held = enabled && !props.heldInSlot ? auto?.held : null;
  const failed = enabled ? auto?.error : null;
  const recommendation = builtIn && skill.recommendation && !skill.assignmentCount ? skill.recommendation : null;

  return (
    <SkillDetailSection
      title="Source"
      actions={git && <button type="button" className="btn ghost sm" onClick={props.onCheckForUpdates}>Check for Updates…</button>}
    >
      <div className="surface skill-source">
        {held && <GitHeldNotice held={held} busy={busy} onReview={props.onReviewHeldUpdate} />}
        {failed && <GitCheckFailedNotice error={failed} busy={busy} onCheck={props.onCheckForUpdates} />}
        {offer && (
          <Notice
            as="section"
            tone="info"
            title="Built-In Version Available"
            ariaLabel="Built-In Version Available"
            actions={<button type="button" className="btn sm" disabled={busy} onClick={props.onReviewBuiltIn}>Review Built-In Version…</button>}
          >
            <p>
              Wollipog {offer.release} includes a built-in skill with this name; this one stays as it is unless you accept
              that version.{skill.gitAutoUpdate?.enabled ? " Accepting also turns off this skill's automatic Git updates." : ""}
            </p>
          </Notice>
        )}
        {(git || machine || builtIn) && (
          <div className="skill-source-facts">
            <dl className="facts">
              {git && <>
                <Fact label="Repository"><span className="mono">{git.url}</span></Fact>
                <Fact label="Folder"><span className="mono">{git.path || "/"}</span></Fact>
                <Fact label="Branch or Tag"><span className="mono">{git.ref}</span></Fact>
                <Fact label="Commit"><Hash value={git.commit} label="Commit" /></Fact>
              </>}
              {machine && <>
                <Fact label="Machine">
                  {props.machineLabels.get(machine.runnerId) ?? machine.runnerId}
                  {machine.context?.kind === "wsl" ? ` (WSL: ${machine.context.distro})` : ""}
                </Fact>
                <Fact label="Folder"><span className="mono">{machine.sourceDirectory}/{machine.name}</span></Fact>
                <Fact label="Imported">
                  <time dateTime={new Date(machine.importedAt).toISOString()} title={new Date(machine.importedAt).toLocaleString()}>
                    {new Date(machine.importedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                  </time>
                </Fact>
                <Fact label="Fingerprint"><Hash value={machine.digest} label="Fingerprint" /></Fact>
              </>}
              {builtIn && <>
                <Fact label="Source">Built into Wollipog {builtIn.release}</Fact>
                <Fact label="Updates">With each Wollipog release; pinned machines keep their version</Fact>
                {recommendation && (
                  <Fact label="Recommendation">
                    {recommendation.dismissed ? (
                      <span className="skill-source-value-action">
                        Dismissed
                        <button type="button" className="btn ghost sm" disabled={busy} onClick={props.onShowRecommendation}>
                          Show Recommendation
                        </button>
                      </span>
                    ) : "Shown until you assign or dismiss it"}
                  </Fact>
                )}
              </>}
            </dl>
            {machine && <p className="skills-hint">A copy of the folder was imported; the folder on the machine wasn't changed.</p>}
          </div>
        )}
        {git && (
          <SkillGitAutoUpdateRow
            status={auto}
            gitRef={git.ref}
            heldElsewhere={props.heldInSlot}
            disabled={busy}
            saving={props.autoUpdate.saving}
            saved={props.autoUpdate.saved}
            onChange={props.onSetAutoUpdate}
          />
        )}
      </div>
    </SkillDetailSection>
  );
}
