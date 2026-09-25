import { useEffect, useState } from "react";
import type { RunnerView } from "@wollipog/protocol";
import { skillRecommended, type SkillSummary } from "../skills.js";
import { Select } from "./ui/ChoiceControls.js";

/**
 * A built-in skill's release, recommendation, and held update; or, on a same-name user-managed
 * skill, the offer to review and adopt the release's version. Assigning here is the ordinary
 * instance-wide or per-machine assignment for every agent, so it deploys through the normal sync.
 */
export function SkillBuiltInSection({ skill, runners, machineLabels, busy, onAssign, onDismiss, onReview }: {
  skill: SkillSummary;
  runners: RunnerView[];
  machineLabels: Map<string, string>;
  busy: boolean;
  /** `null` assigns the skill to all machines. */
  onAssign: (runnerId: string | null) => void;
  onDismiss: (dismissed: boolean) => void;
  onReview: () => void;
}) {
  const [runnerId, setRunnerId] = useState<string | null>(runners[0]?.runnerId ?? null);
  useEffect(() => {
    if (!runnerId || !runners.some((runner) => runner.runnerId === runnerId)) setRunnerId(runners[0]?.runnerId ?? null);
  }, [runnerId, runners]);

  if (skill.builtInOffer) {
    return (
      <section className="skills-section skills-built-in" aria-label="Built-In Version Available">
        <h4>Built-In Version Available</h4>
        <p className="skills-hint">
          Wollipog {skill.builtInOffer.release} ships a built-in skill with this name. This library skill stays exactly as it
          is unless you review and accept the built-in version. Accepting adds it as a new version and makes this a built-in
          skill that later Wollipog releases update. Assignments and machine pins stay.
          {skill.gitAutoUpdate?.enabled ? " Accepting also turns off this skill's automatic Git updates." : ""}
        </p>
        <div className="skills-built-in-actions">
          <button type="button" className="btn sm" disabled={busy} onClick={onReview}>Review Built-In Version</button>
        </div>
      </section>
    );
  }
  if (!skill.builtIn) return null;
  const recommended = skillRecommended(skill);
  const held = skill.builtIn.heldUpdate;
  return (
    <section className="skills-section skills-built-in" aria-label="Built-In Skill">
      <div className="skills-section-heading">
        <h4>Built-In Skill</h4>
        {recommended && <span className="status-badge st-running">Recommended</span>}
      </div>
      <p className="skills-hint">
        Ships with Wollipog {skill.builtIn.release}. Each release updates it on machines that track the latest version;
        pinned machines keep their version.
      </p>
      {recommended && (
        <>
          <p>
            Wollipog recommends this skill for agents in Wollipog sessions. It is not deployed until you assign it; assigning
            deploys it to every supported agent on the machines you choose.
          </p>
          <div className="skills-built-in-actions">
            <button type="button" className="btn primary sm" disabled={busy} onClick={() => onAssign(null)}>
              Assign to All Machines
            </button>
            {runners.length > 0 && (
              <>
                <Select<string>
                  label="Machine"
                  value={runnerId}
                  disabled={busy}
                  options={runners.map((runner) => ({ value: runner.runnerId, label: machineLabels.get(runner.runnerId) ?? runner.runnerId }))}
                  onChange={setRunnerId}
                />
                <button type="button" className="btn sm" disabled={busy || !runnerId} onClick={() => runnerId && onAssign(runnerId)}>
                  Assign to Machine
                </button>
              </>
            )}
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onDismiss(true)}>
              Dismiss Recommendation
            </button>
          </div>
        </>
      )}
      {skill.recommendation?.dismissed && !skill.assignmentCount && (
        <div className="skills-built-in-actions">
          <p className="skills-hint">You dismissed this recommendation.</p>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onDismiss(false)}>
            Show Recommendation
          </button>
        </div>
      )}
      {held && (
        <div className="skills-built-in-held" role="status">
          <p>
            Wollipog {held.release} includes an updated version of this skill. The library's latest version has changes made
            here, so the update waits for your review instead of replacing them.
          </p>
          <button type="button" className="btn sm" disabled={busy} onClick={onReview}>Review Built-In Update</button>
        </div>
      )}
    </section>
  );
}
