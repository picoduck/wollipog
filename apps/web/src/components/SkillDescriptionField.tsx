import { useId } from "react";
import { SKILL_DESCRIPTION_MAX_CHARS } from "@wollipog/protocol";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea.js";

/** The counter turns amber with this many characters or fewer left. */
export const SKILL_DESCRIPTION_NEAR_LIMIT = 100;

const count = new Intl.NumberFormat("en-US");

/** "812 / 1,024". The length is UTF-16 units, the unit `maxLength` and the library API both limit. */
export function skillDescriptionCount(value: string): string {
  return `${count.format(value.length)} / ${count.format(SKILL_DESCRIPTION_MAX_CHARS)}`;
}

/**
 * A skill's description (docs/design-system.md §8.1, §8.4): a textarea that starts at 3 rows, grows
 * to 12 and then scrolls, limited to the Agent Skills 1,024 characters, with a helper and a
 * counter under it. Enter inserts a line break; nothing here submits. New Skill uses it, and an
 * Edit Description surface can reuse it unchanged.
 */
export function SkillDescriptionField({ value, onChange, disabled = false, label = "Description", helper }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  /** Replaces the usual helper, when the field's meaning differs (in New Skill's upload, agents
   * read the folder's own SKILL.md, and an empty field keeps its description). */
  helper?: string;
}) {
  const id = useId();
  const helperId = `${id}-helper`;
  const counterId = `${id}-counter`;
  const growRef = useAutoGrowTextarea(value);
  const nearLimit = SKILL_DESCRIPTION_MAX_CHARS - value.length <= SKILL_DESCRIPTION_NEAR_LIMIT;
  return (
    <div className="field">
      <div className="field-head"><label htmlFor={id}>{label}</label></div>
      <textarea
        ref={growRef}
        id={id}
        rows={3}
        value={value}
        maxLength={SKILL_DESCRIPTION_MAX_CHARS}
        disabled={disabled}
        placeholder="e.g. Reviews a pull request for correctness. Use when asked to review a diff."
        aria-describedby={`${helperId} ${counterId}`}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="field-foot">
        <p className="field-helper" id={helperId}>
          {helper ?? "Agents read this to decide when the skill applies. Say what it does and when to use it."}
        </p>
        {/* Not a live region: announcing every keystroke's count would drown out the typing. */}
        <span className={`field-counter${nearLimit ? " is-near-limit" : ""}`} id={counterId}>
          {skillDescriptionCount(value)}
        </span>
      </div>
    </div>
  );
}
