import React, { forwardRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  SESSIONS_SEARCH_LABEL,
  SESSIONS_SEARCH_SCOPE,
  sessionsNoMatchesMessage,
} from "../sessions-search.js";
import type { InboxSplit } from "../inbox.js";
import { SearchIcon, SearchOffIcon } from "./Icons.js";
import { State } from "./State.js";

/**
 * The Sessions search field (#2200, §8.4): an `.input-affix` field that is always open and never
 * changes width, so focusing or typing in it moves nothing around it. The `/` keycap that focuses
 * it shows on fine pointers (§11.5); its tooltip says what it matches.
 */
export const SessionsSearchField = forwardRef<HTMLInputElement, {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}>(function SessionsSearchField({ value, onChange, onKeyDown }, ref) {
  return (
    <label className="input-affix inbox-search">
      <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
      <input
        ref={ref}
        value={value}
        aria-label={SESSIONS_SEARCH_LABEL}
        title={SESSIONS_SEARCH_SCOPE}
        placeholder="Search sessions"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="input-affix-text" aria-hidden="true"><kbd>/</kbd></span>
    </label>
  );
});

/**
 * No Matches (#2200, §12.2): what was searched and where, with the two ways on. Clear Search
 * empties the field (Escape does the same); Search Transcripts hands the query to the command
 * palette, which searches what the field cannot. Without a palette (a harness page) that action
 * is left out.
 */
export function SessionsNoMatches({
  query,
  group,
  onClearSearch,
  onSearchTranscripts,
}: {
  query: string;
  group: Pick<InboxSplit, "kind" | "name">;
  onClearSearch: () => void;
  onSearchTranscripts?: () => void;
}) {
  return (
    <State
      variant="no-results"
      icon={<SearchOffIcon />}
      title="No Matches"
      actions={(
        <>
          <button type="button" className="btn" onClick={onClearSearch}>Clear Search</button>
          {onSearchTranscripts && (
            <button type="button" className="btn ghost" onClick={onSearchTranscripts}>Search Transcripts</button>
          )}
        </>
      )}
    >
      {sessionsNoMatchesMessage(query, group)}
    </State>
  );
}
