import { useId, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { useStore } from "../store.js";
import { POD_SESSION_RULE, podSessionChoices, podSessionMatches } from "../pod-session-choices.js";
import { SearchIcon } from "./Icons.js";
import { State } from "./State.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

/**
 * The sessions a pod can take, as one multiple `ChoiceRows` list under a Filter Sessions field
 * (#2982), shared by New Pod and Add Member (#2983). The list grows inside the dialog's body, which
 * is its only scroller; on a phone the filter stays at the top while the rows scroll under it. Each
 * row is the session's title over "<Agent> · <Project> · <Machine>", by display name only, ending
 * "· Worktree starting…" on a row whose worktree is not ready yet. The rule is said once, under the
 * list. A caller with no eligible sessions shows its own empty state instead.
 */
export function PodSessionChoices({ sessions, value, onToggle, label = "Sessions" }: {
  /** The eligible sessions, in order (`podEligibleSessions`). */
  sessions: readonly SessionView[];
  value: readonly string[];
  onToggle: (sessionId: string) => void;
  /** The field's Title Case label. */
  label?: string;
}) {
  const { runners, boxes, projects, projectsSupported } = useStore();
  const ids = useId();
  const [query, setQuery] = useState("");
  const choices = podSessionChoices(sessions, { runners, boxes, projects: projectsSupported ? projects : undefined });
  const shown = choices.filter((choice) => podSessionMatches(choice, query));
  const trimmed = query.trim();
  const labelId = `${ids}-label`;
  const ruleId = `${ids}-rule`;
  return (
    <div className="field">
      <span id={labelId}>{label}</span>
      <label className="input-affix pod-session-filter">
        <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
        <input
          type="search"
          aria-label="Filter Sessions"
          placeholder="Filter sessions"
          title="Matches session titles and agents."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears a filter before it closes the dialog (§8.4).
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
      </label>
      {shown.length === 0 ? (
        <State
          variant="no-results"
          compact
          className="pod-session-no-results"
          actions={<button type="button" className="btn sm" onClick={() => setQuery("")}>Clear Filter</button>}
        >
          <SearchIcon size={16} aria-hidden="true" />
          <span>{`No sessions match “${trimmed}”.`}</span>
        </State>
      ) : (
        <ChoiceRows<string>
          multiple
          className="pod-session-list"
          label={label}
          labelledBy={labelId}
          describedBy={ruleId}
          value={value}
          onChange={onToggle}
          options={shown.map((choice) => ({
            value: choice.sessionId,
            title: choice.title,
            // On the second line rather than as trailing meta, which would squeeze the title on a phone.
            description: choice.worktreeStarting ? `${choice.description} · Worktree starting…` : choice.description,
          }))}
        />
      )}
      <p className="field-helper" id={ruleId}>{POD_SESSION_RULE}</p>
    </div>
  );
}
