import { type SkillSummary } from "../skills.js";

/**
 * A built-in skill's release and a dismissed recommendation's way back; or, on a same-name
 * user-managed skill, the offer to review and adopt the release's version. The recommendation and
 * a held built-in update are the notice slot's (#1972); #1980 moves the rest into Source.
 */
export function SkillBuiltInSection({ skill, busy, onDismiss, onReview }: {
  skill: SkillSummary;
  busy: boolean;
  onDismiss: (dismissed: boolean) => void;
  onReview: () => void;
}) {
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
        <button type="button" className="btn sm" disabled={busy} onClick={onReview}>Review Built-In Version</button>
      </section>
    );
  }
  if (!skill.builtIn) return null;
  return (
    <section className="skills-section skills-built-in" aria-label="Built-In Skill">
      <h4>Built-In Skill</h4>
      <p className="skills-hint">
        Ships with Wollipog {skill.builtIn.release}. Each release updates it on machines that track the latest version;
        pinned machines keep their version.
      </p>
      {skill.recommendation?.dismissed && !skill.assignmentCount && (
        <>
          <p className="skills-hint">You dismissed this recommendation.</p>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onDismiss(false)}>
            Show Recommendation
          </button>
        </>
      )}
    </section>
  );
}
