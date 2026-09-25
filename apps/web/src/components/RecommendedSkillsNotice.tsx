import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import { viewPath } from "../navigation.js";
import { skillRecommended, skillsFromPayload, type SkillSummary } from "../skills.js";

/**
 * Built-in skills the signed-in user has neither assigned nor dismissed, as an Inbox notice. It applies
 * the Skills view's recommendation rule to the same library listing and writes the same per-user
 * dismissal as Dismiss Recommendation there, so the two surfaces never disagree. Dismiss All dismisses
 * each listed skill; a later release's new built-in skill has no dismissal and appears again. Hidden
 * when none remain, and when the library cannot be read. It offers no assignment, which a viewer
 * could not make: Open in Skills leads to it.
 */
export function RecommendedSkillsNotice({ onOpen }: { onOpen: (skillId: string) => void }) {
  const api = useApi();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A listing that started before a dismissal must not bring the dismissed skills back.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const started = ++generation.current;
    try {
      const recommended = skillsFromPayload(await api.listSkills()).filter(skillRecommended);
      if (started === generation.current) setSkills(recommended);
    } catch {
      // A pointer never gets in the way of the Inbox; the Skills view reports library errors.
    }
  }, [api]);

  useEffect(() => {
    void load();
    // Assignments and dismissals made in another tab or device show up when this one is revisited.
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current++;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const dismiss = async (targets: SkillSummary[]) => {
    generation.current++;
    setBusy(true);
    setError(null);
    const results = await Promise.allSettled(targets.map((skill) => api.setSkillRecommendationDismissed(skill.id, true)));
    generation.current++;
    const dismissed = new Set(targets.filter((_, index) => results[index]!.status === "fulfilled").map((skill) => skill.id));
    const failed = targets.filter((skill) => !dismissed.has(skill.id)).map((skill) => skill.name);
    // Only what the server recorded leaves the notice, so a partial failure keeps the rest listed.
    setSkills((current) => current.filter((skill) => !dismissed.has(skill.id)));
    if (failed.length > 0) setError(`Could not dismiss ${failed.join(", ")}. Try again.`);
    setBusy(false);
  };

  if (skills.length === 0) return null;
  return (
    <section className="recommended-skills-notice" aria-label="Recommended Skills">
      <div className="recommended-skills-notice-copy">
        <strong>Recommended Skills</strong>
        <span>
          Wollipog includes skills that teach agents in Wollipog sessions to use its tools. They are not on any machine
          until they are assigned in Skills.
        </span>
        {error && <span className="recommended-skills-notice-error" role="alert">{error}</span>}
      </div>
      <ul className="recommended-skills-notice-list">
        {skills.map((skill) => (
          <li key={skill.id}>
            <a
              href={viewPath({ name: "skills", id: skill.id })}
              title="Open in Skills"
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onOpen(skill.id);
              }}
            >
              {skill.name}
            </a>
            <button type="button" className="btn ghost sm" disabled={busy} aria-label={`Dismiss ${skill.name}`}
              title={`Dismiss ${skill.name}`} onClick={() => void dismiss([skill])}>
              Dismiss
            </button>
          </li>
        ))}
      </ul>
      <div className="recommended-skills-notice-actions">
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void dismiss(skills)}>
          Dismiss All
        </button>
      </div>
    </section>
  );
}
