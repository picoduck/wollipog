import type { WorkspaceReferenceCandidate } from "@wollipog/protocol";
import { InlineListbox } from "./ui/ChoiceControls.js";

export function WorkspaceReferencePicker({
  listboxId,
  results,
  activeIndex,
  busy,
  error,
  truncated,
  query,
  onSelect,
}: {
  listboxId: string;
  results: WorkspaceReferenceCandidate[];
  activeIndex: number;
  busy: boolean;
  error: string | null;
  truncated: boolean;
  query: string;
  onSelect: (candidate: WorkspaceReferenceCandidate) => void;
}) {
  return (
    <InlineListbox
      id={listboxId}
      label="Workspace Paths"
      options={results}
      activeIndex={activeIndex}
      getKey={(candidate) => candidate.path}
      onSelect={onSelect}
      className="workspace-reference-picker"
      before={<>
        {!query && <div className="workspace-reference-empty">Type a file or folder name.</div>}
        {busy && <div className="workspace-reference-empty" role="status">Searching Workspace…</div>}
        {error && <div className="workspace-reference-empty warn" role="alert">{error}</div>}
        {!busy && query && !error && results.length === 0 && (
          <div className="workspace-reference-empty">No matching files or folders.</div>
        )}
      </>}
      renderOption={(candidate) => <>
          <span aria-hidden="true">{candidate.isDirectory ? "📁" : "📄"}</span>
          <span>{candidate.path}</span>
      </>}
      after={truncated
        ? <div className="workspace-reference-empty">More matches exist. Refine your search.</div>
        : undefined}
    />
  );
}
