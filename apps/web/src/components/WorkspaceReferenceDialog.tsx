import type { GitDiffScope, WorkspaceReference } from "@wollipog/protocol";
import { CopyButton, Modal } from "./common.js";
import { FolderOpenIcon } from "./Icons.js";

/** The row naming the reference's content hash, and its Copy button's noun. */
export const REFERENCE_HASH_LABEL = "Fingerprint";

const SCOPE_LABELS: Record<GitDiffScope, string> = {
  uncommitted: "Uncommitted",
  all_branch: "Branch",
  last_turn: "Last Turn",
};

function dialogTitle(kind: WorkspaceReference["kind"]): string {
  if (kind === "directory") return "Folder Reference";
  if (kind === "diff") return "Diff Reference";
  return "File Reference";
}

/** "Before sending, Wollipog checks that these lines haven't changed on Studio Mac." (#2177) */
export function workspaceReferenceCheckSentence(reference: WorkspaceReference, machineName: string | null): string {
  const what = reference.startLine !== undefined
    ? "these lines haven't"
    : reference.kind === "directory" ? "this folder hasn't" : "this file hasn't";
  return `Before sending, Wollipog checks that ${what} changed${machineName ? ` on ${machineName}` : ""}.`;
}

/**
 * What a reference chip in the composer points at (#2177): its facts, Remove from Message (the chip's
 * remove) and, for a file or its lines, Open in Files. It only shows and acts, so there is no Done;
 * × and Escape close it, and focus returns to the chip.
 */
export function WorkspaceReferenceDialog({
  reference,
  machineName,
  onClose,
  onRemove,
  onOpenInFiles,
  returnFocusRef,
}: {
  reference: WorkspaceReference;
  /** The machine the runner checks the reference on, or null when it has no name. */
  machineName: string | null;
  onClose: () => void;
  onRemove: () => void;
  /** Absent for a folder or diff reference, which the Files panel can't show at a line. */
  onOpenInFiles?: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const hash = reference.targetFingerprint.slice(0, 12);
  const lines = reference.startLine === undefined
    ? null
    : reference.endLine === undefined || reference.endLine === reference.startLine
      ? `${reference.startLine}`
      : `${reference.startLine}–${reference.endLine}`;
  return (
    <Modal
      title={dialogTitle(reference.kind)}
      size="sm"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          <button className="btn ghost danger ref-dialog-remove" type="button" onClick={onRemove}>
            Remove from Message
          </button>
          {onOpenInFiles && (
            <button className="btn" type="button" onClick={onOpenInFiles}>
              <FolderOpenIcon size={16} />
              Open in Files
            </button>
          )}
        </>
      )}
    >
      <dl className="facts ref-dialog-facts">
        <div>
          <dt>Path</dt>
          <dd className="ref-dialog-value">
            <span className="mono">{reference.path}</span>
            <CopyButton text={reference.path} iconOnly ariaLabel="Copy Path" className="icon-btn sm" />
          </dd>
        </div>
        {lines && <div><dt>Lines</dt><dd>{lines}</dd></div>}
        {reference.kind === "diff" && reference.side && (
          <div><dt>Side</dt><dd>{reference.side === "left" ? "Base" : "Worktree"}</dd></div>
        )}
        {reference.kind === "diff" && reference.diffScope && (
          <div><dt>Scope</dt><dd>{SCOPE_LABELS[reference.diffScope] ?? reference.diffScope}</dd></div>
        )}
        <div>
          <dt>{REFERENCE_HASH_LABEL}</dt>
          <dd className="ref-dialog-value">
            <span className="mono">{hash}</span>
            <CopyButton text={hash} iconOnly ariaLabel={`Copy ${REFERENCE_HASH_LABEL}`} className="icon-btn sm" />
          </dd>
        </div>
      </dl>
      <p className="muted">{workspaceReferenceCheckSentence(reference, machineName)}</p>
    </Modal>
  );
}
