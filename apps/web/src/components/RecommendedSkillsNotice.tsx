import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Notice } from "./Notice.js";
import { useApi } from "../api-context.js";
import { viewPath } from "../navigation.js";
import { skillRecommended, skillsFromPayload, type SkillSummary } from "../skills.js";

export interface SkillRecommendations {
  skills: SkillSummary[];
  /** A dismissal is in flight; every button waits for it. */
  busy: boolean;
  /** The partial failure's sentence, or null. */
  error: string | null;
  dismiss: (targets: SkillSummary[]) => Promise<void>;
}

/**
 * Built-in skills the signed-in user has neither assigned nor dismissed. It applies the Skills view's
 * recommendation rule to the same library listing and writes the same per-user dismissal as Dismiss
 * Recommendation there, so the two surfaces never disagree. Dismiss All dismisses each listed skill;
 * a later release's new built-in skill has no dismissal and appears again. Empty when none remain,
 * and when the library cannot be read.
 */
export function useSkillRecommendations(): SkillRecommendations {
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
      // A pointer never gets in the way of the Sessions list; the Skills view reports library errors.
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

  const dismiss = useCallback(async (targets: SkillSummary[]) => {
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
  }, [api]);

  return { skills, busy, error, dismiss };
}

/**
 * The Recommended Skills notice in the Sessions list's notice slot (#1768, #2221): the body, then
 * the skills as one short list, each a link to the skill with its own Dismiss, and Dismiss All as the
 * notice's one action. Where the list is 600px or wider the skills and Dismiss All share one line;
 * narrower, one skill per line. It offers no assignment, which a viewer could not make: the link
 * leads to it. No confirmation: Show Recommendation in Skills undoes a dismissal.
 */
export function RecommendedSkillsNotice({ recommendations, trailing, onOpen }: {
  recommendations: SkillRecommendations;
  /** The slot's "+N More". */
  trailing?: ReactNode;
  onOpen: (skillId: string) => void;
}) {
  const { skills, busy, error, dismiss } = recommendations;
  if (skills.length === 0) return null;
  return (
    <Notice as="section" tone="info" ariaLabel="Recommended Skills" title="Recommended Skills" trailing={trailing}>
      <p>
        Wollipog includes skills that teach agents in Wollipog sessions to use its tools. They are not on any machine
        until they are assigned in Skills.
      </p>
      {error && <p className="notice-error" role="alert">{error}</p>}
      <div className="skill-recommendations-row">
        <ul className="skill-recommendations-list" aria-label="Skills">
          {skills.map((skill) => (
            <li key={skill.id}>
              <a
                className="link"
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
                onClick={() => void dismiss([skill])}>
                Dismiss
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn sm skill-recommendations-all" disabled={busy}
          onClick={() => void dismiss(skills)}>
          Dismiss All
        </button>
      </div>
    </Notice>
  );
}
