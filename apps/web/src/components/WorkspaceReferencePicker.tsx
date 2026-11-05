import type { ReactNode } from "react";
import type { WorkspaceReferenceCandidate, WorkspaceReferenceSearchLimit } from "@wollipog/protocol";
import { fuzzyPathParts, type TextRange } from "../files-panel.js";
import { ComposerListbox, ComposerListboxState } from "./ComposerListbox.js";
import { ErrorIcon, FileIcon, FolderIcon, SearchIcon } from "./Icons.js";

export function workspaceReferenceOptionId(listboxId: string, index: number): string {
  return `${listboxId}-${index}`;
}

/** A search failure in one plain sentence; the raw message is for logs, not for this row. */
export function workspaceSearchErrorSentence(
  error: string,
  machine: { name: string; online: boolean },
): string {
  const message = error.toLowerCase();
  if (!machine.online || message.includes("runner is offline")) {
    return `${machine.name} is offline. Try again when it reconnects.`;
  }
  if (message.includes("searchable characters")) return "Type a shorter name to search.";
  if (message.includes("timed out") || message.includes("timeout")) {
    return `${machine.name} took too long to answer. Try again.`;
  }
  if (message.includes("session not found")) return "This session no longer exists.";
  if (message.includes("requires") || message.includes("update")) {
    return `Update ${machine.name} to search its workspace from here.`;
  }
  return "Couldn't search the workspace. Try again.";
}

function splitPath(candidate: WorkspaceReferenceCandidate): { name: string; folder: string } {
  const path = candidate.path.replace(/\/+$/u, "");
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

/** The first case-insensitive occurrence of the query, as a range to underline. */
function substringRanges(text: string, query: string): TextRange[] {
  const needle = query.trim().toLowerCase();
  const index = needle ? text.toLowerCase().indexOf(needle) : -1;
  return index < 0 ? [] : [{ start: index, end: index + needle.length }];
}

function underlined(text: string, ranges: readonly TextRange[]): ReactNode {
  if (!ranges.length) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const range of ranges) {
    parts.push(text.slice(at, range.start), <mark key={range.start}>{text.slice(range.start, range.end)}</mark>);
    at = range.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A row's name and folder with what matched underlined: every matched character for a fuzzy answer,
 * as Go to File marks them (#4129), else the first occurrence of the query in each. */
function rowParts(candidate: WorkspaceReferenceCandidate, query: string, fuzzy: boolean): { name: ReactNode; folder: ReactNode | null } {
  const { name, folder } = splitPath(candidate);
  const parts = fuzzy ? fuzzyPathParts(folder ? `${folder}/${name}` : name, query) : null;
  const nameRanges = fuzzy ? parts?.nameRanges ?? [] : substringRanges(name, query);
  const folderRanges = fuzzy ? parts?.folderRanges ?? [] : substringRanges(folder, query);
  return { name: underlined(name, nameRanges), folder: folder ? underlined(folder, folderRanges) : null };
}

/** Why a truncated answer is incomplete, by the cap that cut it (#4129), in Go to File's words. */
function truncatedNote(fuzzy: boolean, limit: WorkspaceReferenceSearchLimit | undefined): string {
  if (!fuzzy) return "More matches exist. Keep typing to narrow them.";
  return limit === "entries"
    ? "The workspace is too large to search in full, so some matches may be missing."
    : "Showing the best matches only. Type more to narrow them.";
}

export function WorkspaceReferencePicker({
  listboxId,
  results,
  activeIndex,
  busy,
  error,
  truncated,
  fuzzy = false,
  limit,
  query,
  resultsQuery = query,
  workspaceName,
  machineName,
  machineOnline,
  onSelect,
  onActiveIndexChange,
}: {
  listboxId: string;
  results: WorkspaceReferenceCandidate[];
  activeIndex: number;
  busy: boolean;
  error: string | null;
  truncated: boolean;
  /** The runner matched fuzzily and ranked best first (#4129); an older one matched substrings. */
  fuzzy?: boolean;
  /** The cap that cut a truncated fuzzy answer. */
  limit?: WorkspaceReferenceSearchLimit;
  query: string;
  /** The query the listed results answer, which trails `query` while a newer search runs. */
  resultsQuery?: string;
  workspaceName: string;
  machineName: string;
  machineOnline: boolean;
  onSelect: (candidate: WorkspaceReferenceCandidate) => void;
  onActiveIndexChange?: (index: number) => void;
}) {
  const indexByPath = new Map(results.map((candidate, index) => [candidate.path, index]));
  // One state at a time, in §12's order: error, loading, a prompt to type, no results. While a new
  // search runs, the previous results stay listed (and choosable) instead of flickering away.
  const showResults = !error && query !== "" && results.length > 0;
  const state = error
    ? (
      <ComposerListboxState icon={<ErrorIcon size={16} />} tone="danger" role="alert">
        {workspaceSearchErrorSentence(error, { name: machineName, online: machineOnline })}
      </ComposerListboxState>
    )
    : !query
      ? (
        <ComposerListboxState detail={`Searches ${workspaceName} on ${machineName}.`}>
          Type a file or folder name.
        </ComposerListboxState>
      )
      : showResults
        ? null
        : busy
          ? <ComposerListboxState role="status">Searching the workspace…</ComposerListboxState>
          : (
            <ComposerListboxState icon={<SearchIcon size={16} />} role="status">
              No files or folders match “{query}”.
            </ComposerListboxState>
          );
  return (
    <ComposerListbox
      listboxId={listboxId}
      label="Workspace Paths"
      sections={[{ key: "paths", items: showResults ? results : [] }]}
      getKey={(candidate) => candidate.path}
      getOptionId={(candidate) => workspaceReferenceOptionId(listboxId, indexByPath.get(candidate.path) ?? 0)}
      activeKey={results[activeIndex]?.path ?? null}
      getOptionProps={(candidate) => ({ "aria-label": candidate.path })}
      renderItem={(candidate) => {
        const { name, folder } = rowParts(candidate, resultsQuery, fuzzy);
        return (
          <span className="picker-line">
            {candidate.isDirectory ? <FolderIcon size={16} /> : <FileIcon size={16} />}
            <span className="picker-name">{name}</span>
            {folder && (
              // Long folders lose their start, not their end: "…/nested/directory".
              <span className="picker-path"><bdi>{folder}</bdi></span>
            )}
          </span>
        );
      }}
      onActiveChange={(candidate) => onActiveIndexChange?.(indexByPath.get(candidate.path) ?? 0)}
      onSelect={onSelect}
      states={state}
      note={showResults && truncated ? truncatedNote(fuzzy, limit) : undefined}
      enterLabel="Insert"
    />
  );
}
