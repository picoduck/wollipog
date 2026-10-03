import type { ReactNode } from "react";
import type { WorkspaceReferenceCandidate } from "@wollipog/protocol";
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

/** The first case-insensitive occurrence of the query, underlined; fuzzy matches mark nothing. */
function highlight(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  const index = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (index < 0) return text;
  return <>
    {text.slice(0, index)}
    <mark>{text.slice(index, index + needle.length)}</mark>
    {text.slice(index + needle.length)}
  </>;
}

export function WorkspaceReferencePicker({
  listboxId,
  results,
  activeIndex,
  busy,
  error,
  truncated,
  query,
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
  query: string;
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
        const { name, folder } = splitPath(candidate);
        return (
          <span className="picker-line">
            {candidate.isDirectory ? <FolderIcon size={16} /> : <FileIcon size={16} />}
            <span className="picker-name">{highlight(name, query)}</span>
            {folder && (
              // Long folders lose their start, not their end: "…/nested/directory".
              <span className="picker-path"><bdi>{highlight(folder, query)}</bdi></span>
            )}
          </span>
        );
      }}
      onActiveChange={(candidate) => onActiveIndexChange?.(indexByPath.get(candidate.path) ?? 0)}
      onSelect={onSelect}
      states={state}
      note={showResults && truncated ? "More matches exist. Keep typing to narrow them." : undefined}
      enterLabel="Insert"
    />
  );
}
